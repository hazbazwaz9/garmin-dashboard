/* ---------------------------------------------------------------
   Garmin recovery dashboard.

   Reads the data.json written by sync_garmin.py (see
   guides/connect-garmin-to-ai/). Three sources, tried in order:
     1. ?src=<url> in the address bar, or a URL you saved here before
     2. garmin/data.json sitting next to this page
     3. a data.json you open from your own computer (nothing is
        uploaded - the file is read in the browser and stays there)
   If none of those produce data, the page falls back to clearly
   labelled sample numbers so the layout is never empty.
   --------------------------------------------------------------- */

(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var STORE_KEY = 'garmin-dash-src';
  var DEFAULT_PATH = 'garmin/data.json';

  var state = { days: [], activities: [], updated: null, range: 30, sample: false, source: '' };

  // ---------- tiny helpers ----------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG, tag);
    for (var key in attrs) {
      if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  function num(value) {
    var parsed = typeof value === 'string' ? parseFloat(value) : value;
    return typeof parsed === 'number' && isFinite(parsed) ? parsed : null;
  }

  function fmtDate(iso, long) {
    var parts = String(iso).split('-');
    var date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    return date.toLocaleDateString(undefined, long
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric' });
  }

  function fmtDuration(seconds) {
    if (!seconds) return '';
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.round((seconds % 3600) / 60);
    return hours ? hours + 'h ' + String(minutes).padStart(2, '0') + 'm' : minutes + 'm';
  }

  function titleCase(text) {
    if (!text) return '';
    return String(text).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  // ---------- data ----------

  function normalise(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    var wellness = raw.wellness || raw.daily || {};
    var activities = raw.activities || [];
    var days = (Array.isArray(wellness) ? wellness : Object.keys(wellness).map(function (k) {
      var row = wellness[k] || {};
      if (!row.date) row = Object.assign({ date: k }, row);
      return row;
    })).filter(function (row) { return row && /^\d{4}-\d{2}-\d{2}$/.test(row.date); });

    days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    var acts = (Array.isArray(activities) ? activities : Object.keys(activities).map(function (k) {
      return activities[k];
    })).filter(Boolean);
    acts.sort(function (a, b) {
      return String(b.start_local || b.date || '') < String(a.start_local || a.date || '') ? -1 : 1;
    });

    if (!days.length && !acts.length) throw new Error('no rows');
    return { days: days, activities: acts, updated: raw.updated || null };
  }

  /* A deterministic stand-in so the page reads correctly before any real
     data exists. Always announced in the banner - never passed off as real. */
  function sampleData() {
    var seed = 20260628;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
    var days = [];
    var activities = [];
    var today = new Date();
    for (var back = 89; back >= 0; back--) {
      var when = new Date(today.getTime() - back * 86400000);
      var iso = when.toISOString().slice(0, 10);
      var wave = Math.sin(back / 9) * 4;
      var worn = rnd() > 0.06;
      var sleep = worn ? Math.round((7 + Math.sin(back / 5) * 0.8 + rnd() * 0.7) * 10) / 10 : null;
      var low = Math.round(14 + rnd() * 22);
      days.push({
        date: iso,
        resting_hr: worn ? Math.round(49 - wave / 3 + rnd() * 3) : null,
        hrv_overnight_ms: worn ? Math.round(68 + wave + rnd() * 8) : null,
        hrv_status: 'BALANCED',
        sleep_hours: sleep,
        sleep_score: sleep ? Math.round(60 + sleep * 4 + rnd() * 6) : null,
        body_battery_low: worn ? low : null,
        body_battery_high: worn ? Math.round(low + 48 + rnd() * 22) : null,
        stress_avg: worn ? Math.round(26 + rnd() * 14) : null,
        steps: Math.round(7000 + rnd() * 8000),
        training_readiness: worn ? Math.round(62 + wave * 2 + rnd() * 14) : null
      });
      if (back % 7 === 1 || back % 7 === 3 || back % 7 === 5) {
        var isLong = back % 7 === 5;
        var km = isLong ? 16 + rnd() * 6 : 8 + rnd() * 5;
        activities.push({
          id: 'sample-' + back,
          name: isLong ? 'Long run' : (back % 7 === 1 ? 'Threshold intervals' : 'Easy run'),
          type: 'running',
          start_local: iso + ' 06:' + String(10 + Math.round(rnd() * 40)).padStart(2, '0') + ':00',
          date: iso,
          duration_s: Math.round(km * (isLong ? 320 : 280)),
          distance_km: Math.round(km * 10) / 10,
          avg_hr: Math.round((isLong ? 143 : 152) + rnd() * 6),
          max_hr: Math.round(168 + rnd() * 12),
          calories: Math.round(km * 68),
          elevation_gain_m: Math.round(40 + rnd() * 180),
          avg_speed_mps: Math.round((isLong ? 3.1 : 3.5) * 1000) / 1000,
          aerobic_te: Math.round((2.6 + rnd() * 1.6) * 10) / 10,
          anaerobic_te: Math.round(rnd() * 15) / 10
        });
      }
    }
    activities.reverse();
    return { days: days, activities: activities, updated: null };
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function loadData() {
    var params = new URLSearchParams(location.search);
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (err) { saved = null; }
    var url = params.get('src') || saved || DEFAULT_PATH;

    return fetchJson(url).then(function (raw) {
      var data = normalise(raw);
      data.source = url;
      return data;
    }).catch(function () {
      var fallback = sampleData();
      fallback.sample = true;
      return fallback;
    });
  }

  function applyData(data) {
    state.days = data.days;
    state.activities = data.activities;
    state.updated = data.updated;
    state.sample = !!data.sample;
    state.source = data.source || '';
    render();
  }

  // ---------- windowing ----------

  function windowDays() {
    var days = state.days.slice(-state.range);
    if (!days.length) return [];
    // Fill missing calendar days so gaps in the trend read as gaps, not as continuity.
    var byDate = {};
    days.forEach(function (row) { byDate[row.date] = row; });
    var first = new Date(days[0].date + 'T00:00:00Z');
    var last = new Date(days[days.length - 1].date + 'T00:00:00Z');
    var filled = [];
    for (var t = first.getTime(); t <= last.getTime(); t += 86400000) {
      var iso = new Date(t).toISOString().slice(0, 10);
      filled.push(byDate[iso] || { date: iso });
    }
    return filled;
  }

  function series(days, key) {
    return days.map(function (row) { return { date: row.date, v: num(row[key]) }; });
  }

  function latest(rows) {
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i].v !== null) return rows[i];
    return null;
  }

  function mean(rows, skipLast) {
    var values = rows.filter(function (r) { return r.v !== null; }).map(function (r) { return r.v; });
    if (skipLast) values = values.slice(0, -1);
    if (!values.length) return null;
    return values.reduce(function (a, b) { return a + b; }, 0) / values.length;
  }

  // ---------- chart engine ----------

  var PAD = { top: 14, right: 58, bottom: 26, left: 40 };
  var PLOT_H = 172;

  /* Round tick steps - 1, 2, 2.5, 5 or 10 times a power of ten - so the
     axis reads 40 / 45 / 50 rather than 43.65 / 47.55 / 51.45. */
  function niceStep(span, count) {
    var raw = Math.max(span, 1e-6) / Math.max(count, 1);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 2.5 ? 2.5 : (norm <= 5 ? 5 : 10)));
    return step * mag;
  }

  function niceDomain(values, opts) {
    opts = opts || {};
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.15;
    var lo = opts.zero ? 0 : min - pad;
    var hi = max + pad;
    if (opts.max !== undefined) hi = Math.min(hi, Math.max(max, opts.max));
    var step = niceStep(hi - lo, opts.ticks || 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (opts.max !== undefined) hi = Math.min(hi, Math.max(max, opts.max));
    return { min: lo, max: hi, step: step };
  }

  function ticksFor(domain) {
    var out = [];
    for (var v = domain.min; v <= domain.max + domain.step * 1e-6; v += domain.step) out.push(v);
    return out;
  }

  /* One renderer for all three forms. `rows` carry {date, v} or {date, lo, hi}. */
  function drawChart(host, cfg) {
    host.innerHTML = '';
    var rows = cfg.rows;
    var hasData = rows.some(function (r) {
      return cfg.type === 'range' ? (r.lo !== null && r.hi !== null) : r.v !== null;
    });
    if (!hasData) {
      var empty = document.createElement('p');
      empty.className = 'c-empty';
      empty.textContent = cfg.emptyText || 'No readings in this range. This metric only records on nights you wear the watch.';
      host.appendChild(empty);
      return;
    }

    var width = Math.max(host.clientWidth || 520, 280);
    var height = PLOT_H + PAD.top + PAD.bottom;
    var innerW = width - PAD.left - PAD.right;
    var band = innerW / Math.max(rows.length, 1);

    var values = [];
    rows.forEach(function (r) {
      if (cfg.type === 'range') { if (r.lo !== null) values.push(r.lo); if (r.hi !== null) values.push(r.hi); }
      else if (r.v !== null) values.push(r.v);
    });
    var domain = niceDomain(values, { zero: cfg.zero, max: cfg.max, ticks: cfg.ticks });

    var svg = svgEl('svg', {
      'class': 'chart',
      viewBox: '0 0 ' + width + ' ' + height,
      role: 'img',
      tabindex: '0',
      'aria-label': cfg.ariaLabel
    });

    function x(i) { return PAD.left + band * (i + 0.5); }
    function y(v) { return PAD.top + PLOT_H - ((v - domain.min) / (domain.max - domain.min)) * PLOT_H; }

    // gridlines + y ticks (solid hairlines, recessive)
    ticksFor(domain).forEach(function (value) {
      var yy = Math.round(y(value)) + 0.5;
      svg.appendChild(svgEl('line', { 'class': 'gridline', x1: PAD.left, x2: width - PAD.right, y1: yy, y2: yy }));
      var label = svgEl('text', { 'class': 'tick', x: PAD.left - 8, y: yy + 4, 'text-anchor': 'end' });
      label.textContent = cfg.tick ? cfg.tick(value) : (value % 1 ? value.toFixed(1) : String(value));
      svg.appendChild(label);
    });
    svg.appendChild(svgEl('line', {
      'class': 'axisline',
      x1: PAD.left, x2: width - PAD.right,
      y1: PAD.top + PLOT_H + 0.5, y2: PAD.top + PLOT_H + 0.5
    }));

    // x ticks: first, middle, last only - dates never collide
    [0, Math.floor(rows.length / 2), rows.length - 1].forEach(function (index, slot) {
      if (index < 0 || index >= rows.length) return;
      if (slot === 1 && rows.length < 6) return;
      var label = svgEl('text', {
        'class': 'tick',
        x: x(index),
        y: PAD.top + PLOT_H + 18,
        'text-anchor': slot === 0 ? 'start' : (slot === 2 ? 'end' : 'middle')
      });
      label.textContent = fmtDate(rows[index].date);
      svg.appendChild(label);
    });

    var marks = svgEl('g', {});
    svg.appendChild(marks);

    if (cfg.type === 'line') {
      var segments = [];
      var current = [];
      rows.forEach(function (row, i) {
        if (row.v === null) { if (current.length) segments.push(current); current = []; return; }
        current.push({ x: x(i), y: y(row.v) });
      });
      if (current.length) segments.push(current);

      segments.forEach(function (points) {
        if (points.length > 1) {
          var area = 'M' + points[0].x + ',' + (PAD.top + PLOT_H) +
            points.map(function (p) { return 'L' + p.x + ',' + p.y; }).join('') +
            'L' + points[points.length - 1].x + ',' + (PAD.top + PLOT_H) + 'Z';
          marks.appendChild(svgEl('path', { 'class': 'mark-area', d: area }));
        }
        var line = points.map(function (p, i) { return (i ? 'L' : 'M') + p.x + ',' + p.y; }).join('');
        marks.appendChild(svgEl('path', { 'class': 'mark-line', d: line }));
        if (points.length === 1) {
          marks.appendChild(svgEl('circle', { 'class': 'mark-dot', cx: points[0].x, cy: points[0].y, r: 4 }));
        }
      });
    } else if (cfg.type === 'column') {
      var colW = Math.min(24, Math.max(band - 2, 3));   // 2px surface gap between neighbours
      rows.forEach(function (row, i) {
        if (row.v === null) return;
        var top = y(row.v);
        var base = PAD.top + PLOT_H;
        var left = x(i) - colW / 2;
        var radius = Math.min(4, colW / 2, Math.max(base - top, 0));
        // 4px rounded cap, square at the baseline
        var d = 'M' + left + ',' + base + 'V' + (top + radius) +
          'a' + radius + ',' + radius + ' 0 0 1 ' + radius + ',' + -radius +
          'h' + (colW - radius * 2) +
          'a' + radius + ',' + radius + ' 0 0 1 ' + radius + ',' + radius +
          'V' + base + 'Z';
        marks.appendChild(svgEl('path', { 'class': 'mark-col', d: d, 'data-i': i }));
      });
    } else if (cfg.type === 'range') {
      rows.forEach(function (row, i) {
        if (row.lo === null || row.hi === null) return;
        marks.appendChild(svgEl('line', {
          'class': 'mark-range', 'data-i': i,
          x1: x(i), x2: x(i), y1: y(row.lo), y2: y(row.hi)
        }));
        marks.appendChild(svgEl('circle', { 'class': 'mark-dot-soft', cx: x(i), cy: y(row.lo), r: 3.5 }));
        marks.appendChild(svgEl('circle', { 'class': 'mark-dot', cx: x(i), cy: y(row.hi), r: 3.5 }));
      });
    }

    // one selective direct label: the most recent reading
    var lastIndex = -1;
    for (var i = rows.length - 1; i >= 0; i--) {
      var row = rows[i];
      if (cfg.type === 'range' ? row.hi !== null : row.v !== null) { lastIndex = i; break; }
    }
    if (lastIndex >= 0) {
      var lastRow = rows[lastIndex];
      var lastValue = cfg.type === 'range' ? lastRow.hi : lastRow.v;
      if (cfg.type !== 'range') {
        marks.appendChild(svgEl('circle', { 'class': 'mark-dot', cx: x(lastIndex), cy: y(lastValue), r: 4.5 }));
      }
      // Measure before placing: a label that would run off the right edge
      // flips to the left of its dot rather than being clipped by the viewBox.
      var text = cfg.label(lastRow);
      var estimated = text.length * 7.4 + 6;
      var labelX = x(lastIndex) + 10;
      var anchor = 'start';
      if (labelX + estimated > width - 2) { labelX = x(lastIndex) - 10; anchor = 'end'; }
      var label = svgEl('text', {
        'class': 'end-label',
        x: labelX,
        y: Math.max(y(lastValue) + 4, PAD.top + 10),
        'text-anchor': anchor
      });
      label.textContent = text;
      marks.appendChild(label);
    }

    // ---- hover / focus layer ----
    var crosshair = null;
    if (cfg.type === 'line') {
      crosshair = svgEl('line', {
        'class': 'crosshair', y1: PAD.top, y2: PAD.top + PLOT_H, x1: 0, x2: 0, opacity: 0
      });
      svg.appendChild(crosshair);
    }
    var hit = svgEl('rect', {
      'class': 'hit', x: PAD.left, y: PAD.top, width: Math.max(innerW, 1), height: PLOT_H
    });
    svg.appendChild(hit);

    var tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'status');
    host.appendChild(tip);
    host.appendChild(svg);

    var cursor = -1;

    function valueAt(index) {
      var row = rows[index];
      if (!row) return null;
      if (cfg.type === 'range') return (row.lo !== null && row.hi !== null) ? row : null;
      return row.v !== null ? row : null;
    }

    function nearest(index, direction) {
      for (var step = 0; step < rows.length; step++) {
        var probe = index + step * (direction || 1);
        if (probe < 0 || probe >= rows.length) break;
        if (valueAt(probe)) return probe;
      }
      for (var back = 0; back < rows.length; back++) {
        var alt = index - back * (direction || 1);
        if (alt < 0 || alt >= rows.length) break;
        if (valueAt(alt)) return alt;
      }
      return -1;
    }

    function hide() {
      cursor = -1;
      tip.removeAttribute('data-show');
      if (crosshair) crosshair.setAttribute('opacity', 0);
      $$('.on', svg).forEach(function (node) { node.classList.remove('on'); });
    }

    function show(index) {
      var row = valueAt(index);
      if (!row) return;
      cursor = index;

      tip.textContent = '';
      var when = document.createElement('div');
      when.className = 't-date';
      when.textContent = fmtDate(row.date, true);
      tip.appendChild(when);

      cfg.tipRows(row).forEach(function (entry) {
        var line = document.createElement('div');
        line.className = 't-row';
        var key = document.createElement('span');
        key.className = 't-key';
        var value = document.createElement('span');
        value.className = 't-val';
        value.textContent = entry.value;              // untrusted-safe: textContent only
        var name = document.createElement('span');
        name.className = 't-name';
        name.textContent = entry.name;
        line.appendChild(key);
        line.appendChild(value);
        line.appendChild(name);
        tip.appendChild(line);
      });

      var px = x(index) / width * host.clientWidth;
      var top = cfg.type === 'range' ? y(row.hi) : y(row.v);
      tip.setAttribute('data-show', '1');
      tip.style.left = Math.max(4, Math.min(px - tip.offsetWidth / 2, host.clientWidth - tip.offsetWidth - 4)) + 'px';
      tip.style.top = Math.max(0, (top / height) * host.clientHeight - tip.offsetHeight - 12) + 'px';

      if (crosshair) {
        crosshair.setAttribute('x1', x(index));
        crosshair.setAttribute('x2', x(index));
        crosshair.setAttribute('opacity', 1);
      }
      $$('.on', svg).forEach(function (node) { node.classList.remove('on'); });
      $$('[data-i="' + index + '"]', svg).forEach(function (node) { node.classList.add('on'); });
    }

    function indexFromEvent(event) {
      var box = svg.getBoundingClientRect();
      var localX = (event.clientX - box.left) / box.width * width;
      return Math.max(0, Math.min(rows.length - 1, Math.floor((localX - PAD.left) / band)));
    }

    svg.addEventListener('pointermove', function (event) {
      var index = nearest(indexFromEvent(event));
      if (index >= 0) show(index); else hide();
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        var direction = event.key === 'ArrowRight' ? 1 : -1;
        var start = cursor < 0 ? (direction > 0 ? 0 : rows.length - 1) : cursor + direction;
        var index = nearest(Math.max(0, Math.min(rows.length - 1, start)), direction);
        if (index >= 0) { show(index); event.preventDefault(); }
      } else if (event.key === 'Escape') {
        hide();
      }
    });
  }

  function sparkline(host, rows, goodUp) {
    host.innerHTML = '';
    var points = rows.filter(function (r) { return r.v !== null; }).slice(-12);
    if (points.length < 2) return;
    var width = 100, height = 34;
    var values = points.map(function (p) { return p.v; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    var path = points.map(function (p, i) {
      var px = (i / (points.length - 1)) * (width - 6) + 3;
      var py = height - 5 - ((p.v - min) / (max - min)) * (height - 12);
      return (i ? 'L' : 'M') + px.toFixed(1) + ',' + py.toFixed(1);
    }).join('');
    svg.appendChild(svgEl('path', {
      d: path, fill: 'none', stroke: 'var(--spark)', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke'
    }));
    var lastY = height - 5 - ((points[points.length - 1].v - min) / (max - min)) * (height - 12);
    svg.appendChild(svgEl('circle', {
      cx: width - 3, cy: lastY.toFixed(1), r: 3,
      fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2,
      'vector-effect': 'non-scaling-stroke'
    }));
    host.appendChild(svg);
    void goodUp;
  }

  // ---------- rendering ----------

  function renderBanner() {
    var banner = $('#dash-banner');
    if (state.sample) {
      banner.className = 'dash-banner';
      banner.hidden = false;
      banner.innerHTML = '';
      var icon = svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' });
      icon.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
      icon.appendChild(svgEl('path', { d: 'M12 8h.01M11 12h1v4h1' , 'stroke-linecap': 'round'}));
      banner.appendChild(icon);
      var text = document.createElement('div');
      text.innerHTML = '<strong>Sample numbers.</strong> No Garmin data has been loaded yet, so this is made-up data ' +
        'showing what the dashboard looks like once it is connected. ';
      var link = document.createElement('button');
      link.type = 'button';
      link.textContent = 'Load your data.json';
      link.addEventListener('click', openDialog);
      text.appendChild(link);
      banner.appendChild(text);
    } else {
      banner.hidden = true;
    }
  }

  function renderMeta() {
    var meta = $('#dash-meta');
    meta.textContent = '';
    var days = windowDays();
    var bits = [];
    if (state.updated) {
      bits.push(['Last sync', new Date(state.updated).toLocaleString(undefined,
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
    }
    if (days.length) bits.push(['Showing', fmtDate(days[0].date) + ' to ' + fmtDate(days[days.length - 1].date)]);
    bits.push(['Days on file', String(state.days.length)]);
    bits.push(['Workouts', String(state.activities.length)]);
    bits.forEach(function (pair) {
      var span = document.createElement('span');
      span.textContent = pair[0] + ': ';
      var strong = document.createElement('strong');
      strong.textContent = pair[1];
      span.appendChild(strong);
      meta.appendChild(span);
    });
  }

  var STATUS = {
    good: { label: 'Ready to train', color: 'var(--good)' },
    warning: { label: 'Train easy', color: 'var(--warning)' },
    serious: { label: 'Take it easy', color: 'var(--serious)' },
    critical: { label: 'Rest day', color: 'var(--critical)' }
  };

  function readinessStatus(score) {
    if (score >= 75) return 'good';
    if (score >= 50) return 'warning';
    if (score >= 25) return 'serious';
    return 'critical';
  }

  function renderHero() {
    var days = windowDays();
    var rows = series(days, 'training_readiness');
    var last = latest(rows);
    var host = $('#hero-card');
    host.innerHTML = '';

    var label = document.createElement('div');
    label.className = 'hero-label';
    label.textContent = 'Training readiness';
    host.appendChild(label);

    var figure = document.createElement('div');
    figure.className = 'hero-figure';
    if (last) {
      figure.appendChild(document.createTextNode(String(Math.round(last.v))));
      var unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = ' / 100';
      figure.appendChild(unit);
    } else {
      figure.textContent = '--';
    }
    host.appendChild(figure);

    var sub = document.createElement('div');
    sub.className = 'hero-sub';
    sub.textContent = last ? fmtDate(last.date, true) : 'No reading yet';
    host.appendChild(sub);

    if (last) {
      var key = readinessStatus(last.v);
      var badge = document.createElement('span');
      badge.className = 'status';
      var icon = svgEl('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: STATUS[key].color,
        'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      });
      icon.appendChild(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
      icon.appendChild(svgEl('path', {
        d: key === 'good' ? 'M8 12.5l2.5 2.5L16 9' : (key === 'critical' ? 'M15 9l-6 6M9 9l6 6' : 'M12 7.5v6M12 16.5v.01')
      }));
      badge.appendChild(icon);
      badge.appendChild(document.createTextNode(STATUS[key].label));
      host.appendChild(badge);
    }
  }

  var KPIS = [
    { key: 'resting_hr', label: 'Resting HR', unit: 'bpm', goodUp: false, digits: 0 },
    { key: 'hrv_overnight_ms', label: 'Overnight HRV', unit: 'ms', goodUp: true, digits: 0 },
    { key: 'sleep_hours', label: 'Sleep', unit: 'h', goodUp: true, digits: 1 },
    { key: 'body_battery_high', label: 'Body battery peak', unit: '', goodUp: true, digits: 0 }
  ];

  function renderKpis() {
    var days = windowDays();
    var host = $('#kpi-row');
    host.innerHTML = '';

    KPIS.forEach(function (spec) {
      var rows = series(days, spec.key);
      var last = latest(rows);
      var average = mean(rows, true);

      var card = document.createElement('div');
      card.className = 'panel kpi';

      var label = document.createElement('div');
      label.className = 'k-label';
      label.textContent = spec.label;
      card.appendChild(label);

      var value = document.createElement('div');
      value.className = 'k-value';
      if (last) {
        value.appendChild(document.createTextNode(last.v.toFixed(spec.digits)));
        if (spec.unit) {
          var unit = document.createElement('span');
          unit.className = 'unit';
          unit.textContent = ' ' + spec.unit;
          value.appendChild(unit);
        }
      } else {
        value.textContent = '--';
      }
      card.appendChild(value);

      var delta = document.createElement('div');
      delta.className = 'k-delta';
      if (last && average !== null) {
        var diff = last.v - average;
        var better = spec.goodUp ? diff > 0 : diff < 0;
        if (Math.abs(diff) >= (spec.digits ? 0.05 : 0.5)) {
          delta.classList.add(better ? 'up' : 'down');
          delta.textContent = (diff > 0 ? '+' : '-') + Math.abs(diff).toFixed(spec.digits) +
            (spec.unit ? ' ' + spec.unit : '') + ' vs ' + state.range + '-day avg';
        } else {
          delta.textContent = 'Level with the ' + state.range + '-day avg';
        }
      } else {
        delta.textContent = 'No reading in this range';
      }
      card.appendChild(delta);

      var spark = document.createElement('div');
      spark.className = 'k-spark';
      card.appendChild(spark);
      host.appendChild(card);
      sparkline(spark, rows, spec.goodUp);
    });
  }

  function chartConfigs(days) {
    return [
      {
        host: '#c-sleep',
        type: 'column',
        zero: true,
        ticks: 3,
        rows: series(days, 'sleep_hours'),
        ariaLabel: 'Column chart of hours slept per night.',
        tick: function (v) { return (v % 1 ? v.toFixed(1) : v.toFixed(0)) + 'h'; },
        label: function (r) { return r.v.toFixed(1) + 'h'; },
        tipRows: function (r) {
          var day = state.days.filter(function (d) { return d.date === r.date; })[0] || {};
          var out = [{ value: r.v.toFixed(1) + ' h', name: 'asleep' }];
          if (num(day.sleep_score) !== null) out.push({ value: String(day.sleep_score), name: 'sleep score' });
          return out;
        }
      },
      {
        host: '#c-hrv',
        type: 'line',
        rows: series(days, 'hrv_overnight_ms'),
        ariaLabel: 'Line chart of overnight heart rate variability in milliseconds.',
        tick: function (v) { return Math.round(v); },
        label: function (r) { return Math.round(r.v) + ' ms'; },
        tipRows: function (r) { return [{ value: Math.round(r.v) + ' ms', name: 'overnight HRV' }]; }
      },
      {
        host: '#c-rhr',
        type: 'line',
        rows: series(days, 'resting_hr'),
        ariaLabel: 'Line chart of resting heart rate in beats per minute.',
        tick: function (v) { return Math.round(v); },
        label: function (r) { return Math.round(r.v) + ' bpm'; },
        tipRows: function (r) { return [{ value: Math.round(r.v) + ' bpm', name: 'resting HR' }]; }
      },
      {
        host: '#c-bb',
        type: 'range',
        zero: true,
        ticks: 2,
        max: 100,
        rows: days.map(function (row) {
          return { date: row.date, lo: num(row.body_battery_low), hi: num(row.body_battery_high) };
        }),
        ariaLabel: 'Range chart of daily body battery, from the day’s low to its high.',
        tick: function (v) { return Math.round(v); },
        label: function (r) { return Math.round(r.hi) + ''; },
        tipRows: function (r) {
          return [
            { value: Math.round(r.hi) + '', name: 'peak' },
            { value: Math.round(r.lo) + '', name: 'low' }
          ];
        }
      }
    ];
  }

  function renderCharts() {
    var days = windowDays();
    chartConfigs(days).forEach(function (cfg) {
      var card = $(cfg.host);
      if (!card) return;
      drawChart($('.plot', card), cfg);
    });
  }

  var DAILY_COLUMNS = [
    ['Date', function (row) { return fmtDate(row.date, true); }, false],
    ['Sleep (h)', function (row) { return num(row.sleep_hours) === null ? '--' : num(row.sleep_hours).toFixed(1); }, true],
    ['Sleep score', function (row) { return num(row.sleep_score) === null ? '--' : row.sleep_score; }, true],
    ['HRV (ms)', function (row) { return num(row.hrv_overnight_ms) === null ? '--' : row.hrv_overnight_ms; }, true],
    ['Resting HR', function (row) { return num(row.resting_hr) === null ? '--' : row.resting_hr; }, true],
    ['Body battery', function (row) {
      return num(row.body_battery_low) === null ? '--' : row.body_battery_low + '–' + row.body_battery_high;
    }, true],
    ['Stress', function (row) { return num(row.stress_avg) === null ? '--' : row.stress_avg; }, true],
    ['Steps', function (row) { return num(row.steps) === null ? '--' : Number(row.steps).toLocaleString(); }, true],
    ['Readiness', function (row) { return num(row.training_readiness) === null ? '--' : row.training_readiness; }, true]
  ];

  function buildTable(columns, rows, caption) {
    var table = document.createElement('table');
    table.className = 'data';
    if (caption) {
      var cap = document.createElement('caption');
      cap.textContent = caption;
      table.appendChild(cap);
    }
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    columns.forEach(function (col) {
      var th = document.createElement('th');
      th.scope = 'col';
      if (col[2]) th.className = 'num';
      th.textContent = col[0];
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (col, index) {
        var cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        if (col[2]) cell.className = 'num';
        if (col[3]) cell.className = col[3];
        cell.textContent = col[1](row);           // untrusted-safe: textContent only
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderDailyTable() {
    var host = $('#daily-table-wrap');
    host.innerHTML = '';
    var days = windowDays().slice().reverse();
    host.appendChild(buildTable(DAILY_COLUMNS, days, 'Every reading in the selected range'));
  }

  function renderActivities() {
    var host = $('#activity-wrap');
    host.innerHTML = '';
    var days = windowDays();
    var from = days.length ? days[0].date : '0000-00-00';
    var rows = state.activities.filter(function (act) {
      return String(act.date || act.start_local || '').slice(0, 10) >= from;
    });

    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'c-empty';
      empty.textContent = 'No workouts recorded in this range.';
      host.appendChild(empty);
      return;
    }

    var columns = [
      ['Date', function (a) { return fmtDate(String(a.date || a.start_local).slice(0, 10), true); }, false],
      ['Workout', function (a) { return a.name || 'Activity'; }, false, 'name'],
      ['Type', function (a) { return titleCase(a.type); }, false],
      ['Duration', function (a) { return fmtDuration(num(a.duration_s)) || '--'; }, true],
      ['Distance', function (a) { return num(a.distance_km) === null ? '--' : num(a.distance_km).toFixed(2) + ' km'; }, true],
      ['Avg HR', function (a) { return num(a.avg_hr) === null ? '--' : a.avg_hr + ' bpm'; }, true],
      ['Calories', function (a) { return num(a.calories) === null ? '--' : Number(a.calories).toLocaleString(); }, true]
    ];
    host.appendChild(buildTable(columns, rows, rows.length + ' workout' + (rows.length === 1 ? '' : 's') + ' in this range'));
  }

  function render() {
    renderBanner();
    renderMeta();
    renderHero();
    renderKpis();
    renderCharts();
    renderDailyTable();
    renderActivities();
  }

  // ---------- data source dialog ----------

  function openDialog() {
    var dialog = $('#src-dialog');
    var input = $('#src-url');
    try { input.value = localStorage.getItem(STORE_KEY) || ''; } catch (err) { input.value = ''; }
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  function closeDialog() {
    var dialog = $('#src-dialog');
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }

  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = normalise(JSON.parse(String(reader.result)));
        data.source = file.name;
        applyData(data);
        closeDialog();
      } catch (err) {
        showError('That file is not a Garmin data.json the dashboard can read.');
      }
    };
    reader.readAsText(file);
  }

  function showError(message) {
    var banner = $('#dash-banner');
    banner.className = 'dash-banner error';
    banner.hidden = false;
    banner.textContent = message;
  }

  function wireDialog() {
    var dialog = $('#src-dialog');
    var drop = $('#src-drop');
    var picker = $('#src-file');

    $('#btn-source').addEventListener('click', openDialog);
    $('#src-cancel').addEventListener('click', closeDialog);
    drop.addEventListener('click', function () { picker.click(); });
    drop.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); picker.click(); }
    });
    picker.addEventListener('change', function () {
      if (picker.files && picker.files[0]) readFile(picker.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (name) {
      drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) readFile(file);
    });

    $('#src-save').addEventListener('click', function () {
      var url = $('#src-url').value.trim();
      try {
        if (url) localStorage.setItem(STORE_KEY, url); else localStorage.removeItem(STORE_KEY);
      } catch (err) { /* private browsing: the URL just is not remembered */ }
      if (!url) { closeDialog(); return; }
      fetchJson(url).then(function (raw) {
        var data = normalise(raw);
        data.source = url;
        applyData(data);
        closeDialog();
      }).catch(function () {
        showError('Could not read Garmin data from that URL. Check the address and that it allows this page to read it.');
        closeDialog();
      });
    });

    $('#src-sample').addEventListener('click', function () {
      var data = sampleData();
      data.sample = true;
      applyData(data);
      closeDialog();
    });

    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
  }

  function wireFilters() {
    $$('#range-filter button').forEach(function (button) {
      button.addEventListener('click', function () {
        state.range = parseInt(button.getAttribute('data-range'), 10);
        $$('#range-filter button').forEach(function (other) {
          other.setAttribute('aria-checked', String(other === button));
        });
        render();
      });
    });

    var toggle = $('#btn-table');
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-pressed') === 'true';
      toggle.setAttribute('aria-pressed', String(!open));
      toggle.textContent = open ? 'Show data table' : 'Hide data table';
      $('#daily-table').hidden = open;
    });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 150);
  });

  document.addEventListener('DOMContentLoaded', function () {
    wireFilters();
    wireDialog();
    loadData().then(applyData);
  });
})();
