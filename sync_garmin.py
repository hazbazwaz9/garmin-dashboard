#!/usr/bin/env python3
"""Pull your own Garmin data into plain markdown notes (or your own endpoint).

Read-only. Nothing is ever written back to your Garmin account.

Built on the open-source python-garminconnect library by cyberjunky:
https://github.com/cyberjunky/python-garminconnect

Security notes:
  * Your password is typed once into a hidden prompt. It is never stored,
    never read from an environment variable, never written to disk, and
    never printed. The script refuses to run the login flow anywhere the
    prompt cannot actually hide what you type.
  * The login token (roughly a year of access) is saved under
    ~/.garmin-ai/tokens with owner-only permissions and is never printed.

Usage:
  python sync_garmin.py --login
  python sync_garmin.py --days 3 --dry-run
  python sync_garmin.py --days 3 --sink files --out ./garmin
  python sync_garmin.py --days 3 --sink supabase
  python sync_garmin.py --export-ci-token
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import json
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import warnings

HOME_DIR = os.path.expanduser(os.environ.get("GARMIN_AI_HOME", "~/.garmin-ai"))
TOKEN_DIR = os.path.join(HOME_DIR, "tokens")
CI_TOKEN_FILE = "garmin-ci-token.txt"
USER_AGENT = "garmin-ai-sync/1.0"


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str) -> "None":
    print(f"error: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def _import_garmin():
    try:
        from garminconnect import Garmin  # type: ignore
    except ImportError:
        die(
            "the garminconnect library is missing. Install it with:\n"
            "  pip install -r requirements.txt"
        )
    return Garmin


def _private_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    try:
        os.chmod(path, stat.S_IRWXU)  # 0700, owner only
    except OSError:
        pass  # Windows and some network drives do not support this
    return path


def _write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


def _days_back(days: int) -> list[dt.date]:
    today = dt.date.today()
    return [today - dt.timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def _slug(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "activity")).strip("-").lower()
    return (text or "activity")[:60]


def _round(value, digits=1):
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


def _int(value):
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def _dig(payload, *path):
    """Walk nested dicts/lists, returning None instead of raising."""
    node = payload
    for key in path:
        if isinstance(node, list):
            node = node[key] if isinstance(key, int) and len(node) > key else None
        elif isinstance(node, dict):
            node = node.get(key)
        else:
            return None
        if node is None:
            return None
    return node


def _garth(client):
    """The underlying garth session. Named .garth on older garminconnect, .client on 0.3+."""
    session = getattr(client, "garth", None) or getattr(client, "client", None)
    if session is None:
        die("this garminconnect version is not supported. Try: pip install -U garminconnect")
    return session


def _safely(label: str, fn, *args):
    """Garmin's endpoints move around. A missing metric should never abort a run."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - any endpoint failure is non-fatal
        log(f"  (skipped {label}: {type(exc).__name__})")
        return None


# --------------------------------------------------------------------------
# credentials and token storage
# --------------------------------------------------------------------------

def _require_hidden_prompt() -> None:
    """Refuse to ask for a password anywhere it would be echoed to the screen."""
    if not sys.stdin.isatty():
        die(
            "no interactive terminal, so your password cannot be hidden.\n"
            "Run 'python sync_garmin.py --login' directly in Terminal (Mac) or "
            "PowerShell (Windows), not through a pipe, editor or CI job."
        )
    if getpass.getpass is getattr(getpass, "fallback_getpass", None):
        die(
            "this terminal cannot hide typed input, so the password would be "
            "visible on screen. Use a different terminal (Terminal on Mac, "
            "PowerShell or cmd on Windows)."
        )


def _prompt_password(label: str) -> str:
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            secret = getpass.getpass(label)
        except getpass.GetPassWarning:
            die("this terminal would echo your password on screen. Login aborted.")
    if not secret:
        die("empty password. Login aborted.")
    return secret


def _token_bundle() -> dict[str, str]:
    if not os.path.isdir(TOKEN_DIR):
        die("no saved login found. Run: python sync_garmin.py --login")
    bundle = {}
    for name in sorted(os.listdir(TOKEN_DIR)):
        full = os.path.join(TOKEN_DIR, name)
        if os.path.isfile(full):
            with open(full, encoding="utf-8") as fh:
                bundle[name] = fh.read()
    if not bundle:
        die("the saved login is empty. Run: python sync_garmin.py --login")
    return bundle


def _tokens_from_env() -> str | None:
    """CI path: rebuild a private token directory from GARMIN_TOKEN_B64."""
    blob = os.environ.get("GARMIN_TOKEN_B64")
    if not blob:
        return None
    try:
        bundle = json.loads(base64.b64decode(blob.strip()).decode("utf-8"))
    except Exception:
        die("GARMIN_TOKEN_B64 is not a valid token bundle. Re-run --export-ci-token.")
    target = _private_dir(tempfile.mkdtemp(prefix="garmin-tokens-"))
    for name, content in bundle.items():
        _write_private(os.path.join(target, os.path.basename(name)), content)
    return target


def do_login() -> None:
    _require_hidden_prompt()
    Garmin = _import_garmin()

    log("One-time Garmin login. Your password is not stored or printed.")
    email = input("Garmin email: ").strip()
    if not email:
        die("empty email. Login aborted.")
    password = _prompt_password("Garmin password (hidden, nothing will appear): ")

    client = Garmin(email=email, password=password, return_on_mfa=True)
    try:
        result, state = client.login()
    except Exception as exc:  # noqa: BLE001
        die(f"Garmin rejected the login ({type(exc).__name__}). Check your email/password.")
    finally:
        del password  # drop the plaintext as soon as Garmin has seen it

    if result == "needs_mfa":
        code = input("Garmin sent a 2FA code. Enter it here: ").strip()
        if not code:
            die("empty 2FA code. Login aborted.")
        try:
            client.resume_login(state, code)
        except Exception as exc:  # noqa: BLE001
            die(f"that 2FA code was not accepted ({type(exc).__name__}).")

    _private_dir(HOME_DIR)
    _private_dir(TOKEN_DIR)
    _garth(client).dump(TOKEN_DIR)
    for name in os.listdir(TOKEN_DIR):
        try:
            os.chmod(os.path.join(TOKEN_DIR, name), 0o600)
        except OSError:
            pass
    log(f"Logged in. Token saved privately in {TOKEN_DIR} (not printed, lasts about a year).")


def export_ci_token(path: str) -> None:
    bundle = _token_bundle()
    blob = base64.b64encode(json.dumps(bundle).encode("utf-8")).decode("ascii")
    _write_private(path, blob + "\n")
    log(
        f"Wrote {path}. Paste its contents into your GARMIN_TOKEN_B64 GitHub "
        "secret, then delete the file. It is a login credential: never commit "
        "it, never paste it into a chat."
    )


def connect():
    """Return a logged-in, read-only client using the saved token."""
    Garmin = _import_garmin()
    tokendir = _tokens_from_env() or TOKEN_DIR
    if not os.path.isdir(tokendir):
        die("no saved login found. Run: python sync_garmin.py --login")
    client = Garmin()
    try:
        client.login(tokendir)
    except Exception as exc:  # noqa: BLE001
        die(
            f"the saved login no longer works ({type(exc).__name__}). Try "
            "'pip install -U garminconnect' and then re-run --login."
        )
    return client


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

def fetch_wellness(client, day: dt.date) -> dict:
    iso = day.isoformat()
    stats = _safely("daily summary", client.get_user_summary, iso) or {}
    sleep = _safely("sleep", client.get_sleep_data, iso) or {}
    hrv = _safely("HRV", client.get_hrv_data, iso) or {}
    readiness = _safely("training readiness", client.get_training_readiness, iso) or []
    # Garmin returns a single-item list here, but some versions hand back the dict itself.
    readiness_score = _dig(readiness, 0, "score") if isinstance(readiness, list) else _dig(readiness, "score")

    sleep_seconds = _dig(sleep, "dailySleepDTO", "sleepTimeSeconds")
    return {
        "date": iso,
        "resting_hr": _int(stats.get("restingHeartRate")),
        "hrv_overnight_ms": _int(
            _dig(hrv, "hrvSummary", "lastNightAvg")
            or _dig(sleep, "dailySleepDTO", "avgOvernightHrv")
        ),
        "hrv_status": _dig(hrv, "hrvSummary", "status"),
        "sleep_hours": _round(sleep_seconds / 3600.0, 1) if sleep_seconds else None,
        "sleep_score": _int(_dig(sleep, "dailySleepDTO", "sleepScores", "overall", "value")),
        "body_battery_low": _int(stats.get("bodyBatteryLowestValue")),
        "body_battery_high": _int(stats.get("bodyBatteryHighestValue")),
        "stress_avg": _int(stats.get("averageStressLevel")),
        "steps": _int(stats.get("totalSteps")),
        "training_readiness": _int(readiness_score),
    }


def fetch_activities(client, days: int, limit: int) -> list[dict]:
    end = dt.date.today()
    start = end - dt.timedelta(days=max(days - 1, 0))
    raw = _safely(
        "activities", client.get_activities_by_date, start.isoformat(), end.isoformat()
    ) or []
    out = []
    for item in raw[:limit]:
        duration = _dig(item, "duration")
        distance = _dig(item, "distance")
        out.append(
            {
                "id": str(item.get("activityId")),
                "name": item.get("activityName") or "Activity",
                "type": _dig(item, "activityType", "typeKey"),
                "start_local": item.get("startTimeLocal"),
                "date": (item.get("startTimeLocal") or "")[:10],
                "duration_s": _int(duration),
                "distance_km": _round((distance or 0) / 1000.0, 2) if distance else None,
                "avg_hr": _int(item.get("averageHR")),
                "max_hr": _int(item.get("maxHR")),
                "calories": _int(item.get("calories")),
                "elevation_gain_m": _int(item.get("elevationGain")),
                "avg_speed_mps": _round(item.get("averageSpeed"), 3),
                "aerobic_te": _round(item.get("aerobicTrainingEffect"), 1),
                "anaerobic_te": _round(item.get("anaerobicTrainingEffect"), 1),
            }
        )
    return out


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def _hms(seconds) -> str | None:
    if not seconds:
        return None
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m {secs:02d}s"


def _pace(activity: dict) -> str | None:
    speed = activity.get("avg_speed_mps")
    if not speed:
        return None
    per_km = 1000.0 / speed
    return f"{int(per_km // 60)}:{int(per_km % 60):02d} /km"


def wellness_markdown(w: dict) -> str:
    lines = [f"# Garmin wellness {w['date']}"]
    add = lambda text: lines.append(f"- {text}")  # noqa: E731
    if w["resting_hr"]:
        add(f"Resting HR: {w['resting_hr']} bpm")
    if w["hrv_overnight_ms"]:
        status = f" ({w['hrv_status'].lower()})" if w.get("hrv_status") else ""
        add(f"HRV (overnight): {w['hrv_overnight_ms']} ms{status}")
    if w["sleep_hours"]:
        score = f" (score {w['sleep_score']})" if w["sleep_score"] else ""
        add(f"Sleep: {w['sleep_hours']} h{score}")
    if w["body_battery_low"] is not None and w["body_battery_high"] is not None:
        add(f"Body battery: {w['body_battery_low']} -> {w['body_battery_high']}")
    if w["stress_avg"] is not None and w["stress_avg"] >= 0:
        add(f"Stress (avg): {w['stress_avg']}")
    if w["steps"]:
        add(f"Steps: {w['steps']}")
    if w["training_readiness"]:
        add(f"Training readiness: {w['training_readiness']}")
    if len(lines) == 1:
        add("No data recorded (watch probably not worn).")
    return "\n".join(lines) + "\n"


def activity_markdown(a: dict) -> str:
    lines = [f"# {a['name']}"]
    add = lambda text: lines.append(f"- {text}")  # noqa: E731
    if a["start_local"]:
        add(f"Date: {a['start_local'].replace('T', ' ')[:16]}")
    if a["type"]:
        add(f"Type: {a['type'].replace('_', ' ')}")
    if _hms(a["duration_s"]):
        add(f"Duration: {_hms(a['duration_s'])}")
    if a["distance_km"]:
        add(f"Distance: {a['distance_km']} km")
    if a["avg_hr"]:
        add(f"Avg HR: {a['avg_hr']} bpm" + (f" (max {a['max_hr']})" if a["max_hr"] else ""))
    if _pace(a):
        add(f"Avg pace: {_pace(a)}")
    if a["elevation_gain_m"]:
        add(f"Elevation gain: {a['elevation_gain_m']} m")
    if a["calories"]:
        add(f"Calories: {a['calories']}")
    if a["aerobic_te"] or a["anaerobic_te"]:
        add(f"Training effect: aerobic {a['aerobic_te']}, anaerobic {a['anaerobic_te']}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# sinks
# --------------------------------------------------------------------------

def sink_files(out_dir: str, activities: list[dict], wellness: list[dict]) -> None:
    daily_dir = os.path.join(out_dir, "daily")
    act_dir = os.path.join(out_dir, "activities")
    os.makedirs(daily_dir, exist_ok=True)
    os.makedirs(act_dir, exist_ok=True)

    for w in wellness:
        with open(os.path.join(daily_dir, f"{w['date']}.md"), "w", encoding="utf-8") as fh:
            fh.write(wellness_markdown(w))
    for a in activities:
        name = f"{a['date'] or 'undated'}-{_slug(a['name'])}.md"
        with open(os.path.join(act_dir, name), "w", encoding="utf-8") as fh:
            fh.write(activity_markdown(a))

    store_path = os.path.join(out_dir, "data.json")
    store = {"activities": {}, "wellness": {}}
    if os.path.exists(store_path):
        try:
            with open(store_path, encoding="utf-8") as fh:
                store = json.load(fh)
        except (OSError, ValueError):
            pass  # a corrupt store should not stop today's sync
    store.setdefault("activities", {})
    store.setdefault("wellness", {})
    store["activities"].update({a["id"]: a for a in activities})
    store["wellness"].update({w["date"]: w for w in wellness})
    store["updated"] = dt.datetime.now().isoformat(timespec="seconds")
    with open(store_path, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=2, sort_keys=True)

    log(
        f"Wrote {len(wellness)} daily note(s) and {len(activities)} activity note(s) "
        f"to {out_dir}/"
    )


def sink_endpoint(activities: list[dict], wellness: list[dict]) -> None:
    url = os.environ.get("GARMIN_INGEST_URL")
    secret = os.environ.get("GARMIN_INGEST_SECRET") or os.environ.get("SESSION_LOG_SECRET")
    if not url:
        die("set GARMIN_INGEST_URL to use --sink supabase")
    body = json.dumps({"activities": activities, "wellness": wellness}).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            log(f"Posted {len(activities)} activities / {len(wellness)} days -> HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        die(f"ingest endpoint returned HTTP {exc.code}")
    except urllib.error.URLError as exc:
        die(f"could not reach the ingest endpoint: {exc.reason}")


def print_preview(activities: list[dict], wellness: list[dict]) -> None:
    for w in wellness:
        log("")
        log(wellness_markdown(w).rstrip())
    for a in activities:
        log("")
        log(activity_markdown(a).rstrip())
    log("")
    log("(dry run: nothing was written or sent)")


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync your Garmin data (read-only).")
    parser.add_argument("--login", action="store_true", help="one-time login, saves a private token")
    parser.add_argument("--export-ci-token", action="store_true", help="write the token bundle for GitHub Actions")
    parser.add_argument("--days", type=int, default=7, help="how many days back to pull (default 7)")
    parser.add_argument("--limit", type=int, default=50, help="max activities to pull (default 50)")
    parser.add_argument("--sink", choices=["files", "supabase"], default="files")
    parser.add_argument("--out", default="./garmin", help="output folder for --sink files")
    parser.add_argument("--dry-run", action="store_true", help="print what would be saved, save nothing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.login:
        do_login()
        return 0
    if args.export_ci_token:
        export_ci_token(CI_TOKEN_FILE)
        return 0
    if args.days < 1:
        die("--days must be at least 1")

    client = connect()
    log(f"Pulling the last {args.days} day(s) from Garmin (read-only)...")
    activities = fetch_activities(client, args.days, args.limit)
    wellness = [fetch_wellness(client, day) for day in _days_back(args.days)]

    if args.dry_run:
        print_preview(activities, wellness)
    elif args.sink == "files":
        sink_files(args.out, activities, wellness)
    else:
        sink_endpoint(activities, wellness)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\naborted", file=sys.stderr)
        raise SystemExit(130)
