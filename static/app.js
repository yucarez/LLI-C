/*
 * EFS-3 console — frontend renderer only.
 *
 * This file contains NO fire-growth model, NO state machine, and NO
 * decisions about phases, alarms, or timing. Every one of those numbers
 * comes from the Flask backend (see app.py). This script's only jobs are:
 *   1. Poll /api/state on an interval and update the DOM.
 *   2. Draw the heatmap / radar / HRR chart from the arrays it receives.
 *   3. Forward button clicks to /api/scenario/<rate> and /api/reset.
 */

(function () {
  var statusPill = document.getElementById('statusPill');
  var clockEl = document.getElementById('clock');
  var gaugeValue = document.getElementById('gaugeValue');
  var phaseLabel = document.getElementById('phaseLabel');
  var rTemp = document.getElementById('rTemp');
  var rSmoke = document.getElementById('rSmoke');
  var rCO = document.getElementById('rCO');
  var rFlicker = document.getElementById('rFlicker');
  var rRange = document.getElementById('rRange');
  var logEl = document.getElementById('log');

  var heatCanvas = document.getElementById('heatmap');
  var heatCtx = heatCanvas.getContext('2d');
  var radarCanvas = document.getElementById('radar');
  var radarCtx = radarCanvas.getContext('2d');
  var hrrCanvas = document.getElementById('hrrchart');
  var hrrCtx = hrrCanvas.getContext('2d');
  var hrrScroll = document.getElementById('hrrScroll');

  var buttons = document.querySelectorAll('.scenario-btn');
  var resetBtn = document.getElementById('resetBtn');
  var runBtn = document.getElementById('runBtn');
  var pauseBtn = document.getElementById('pauseBtn');

  var lastLogSignature = '';
  var lastPhase = null;
  var PX_PER_SECOND = 16; // chart grows horizontally at this rate; never autoscrolls

  // ---- thermal color lookup (rendering only — same palette as backend intends) ----
  var stops = [
    [0.00, [5, 7, 10]],
    [0.16, [30, 32, 90]],
    [0.36, [110, 40, 130]],
    [0.55, [195, 55, 55]],
    [0.74, [255, 122, 41]],
    [0.90, [255, 196, 74]],
    [1.00, [255, 246, 216]]
  ];
  function thermalColor(v) {
    v = Math.max(0, Math.min(1, v));
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (v >= a[0] && v <= b[0]) {
        var f = (v - a[0]) / (b[0] - a[0]);
        var c0 = a[1], c1 = b[1];
        var r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
        var g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
        var bl = Math.round(c0[2] + (c1[2] - c0[2]) * f);
        return 'rgb(' + r + ',' + g + ',' + bl + ')';
      }
    }
    return 'rgb(255,246,216)';
  }

  // ---- drawing ----
  function drawHeatmap(grid) {
    var w = heatCanvas.clientWidth || heatCanvas.width;
    var h = heatCanvas.clientHeight || heatCanvas.height;
    if (heatCanvas.width !== w) heatCanvas.width = w;
    if (heatCanvas.height !== h) heatCanvas.height = h;

    var cols = grid.cols, rows = grid.rows, values = grid.values;
    var cw = w / cols, ch = h / rows;

    for (var y = 0; y < rows; y++) {
      var row = values[y];
      for (var x = 0; x < cols; x++) {
        heatCtx.fillStyle = thermalColor(row[x]);
        heatCtx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
      }
    }
  }

  function drawRadar(radar, phase) {
    var w = radarCanvas.width, h = radarCanvas.height;
    var cx = w / 2, cy = h / 2, R = w / 2 - 6;

    radarCtx.clearRect(0, 0, w, h);
    radarCtx.fillStyle = '#05070A';
    radarCtx.fillRect(0, 0, w, h);

    radarCtx.strokeStyle = 'rgba(124,140,150,0.28)';
    radarCtx.lineWidth = 1;
    for (var ring = 1; ring <= 3; ring++) {
      radarCtx.beginPath();
      radarCtx.arc(cx, cy, R * ring / 3, 0, Math.PI * 2);
      radarCtx.stroke();
    }
    radarCtx.beginPath();
    radarCtx.moveTo(cx - R, cy); radarCtx.lineTo(cx + R, cy);
    radarCtx.moveTo(cx, cy - R); radarCtx.lineTo(cx, cy + R);
    radarCtx.stroke();

    var sweepRad = radar.sweep_angle;
    radarCtx.save();
    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.arc(cx, cy, R, sweepRad - 0.55, sweepRad, false);
    radarCtx.closePath();
    radarCtx.fillStyle = 'rgba(63,224,197,0.16)';
    radarCtx.fill();
    radarCtx.restore();

    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.lineTo(cx + Math.cos(sweepRad) * R, cy + Math.sin(sweepRad) * R);
    radarCtx.strokeStyle = '#3FE0C5';
    radarCtx.lineWidth = 1.4;
    radarCtx.stroke();

    if (radar.blip) {
      var b = radar.blip;
      var bx = cx + Math.cos(b.angle) * R * b.dist;
      var by = cy + Math.sin(b.angle) * R * b.dist;
      var pulse = b.pulse;

      var grd = radarCtx.createRadialGradient(bx, by, 0, bx, by, pulse * 2.6);
      var blipColor = b.alarm ? '229,72,77' : '255,122,41';
      grd.addColorStop(0, 'rgba(' + blipColor + ',0.9)');
      grd.addColorStop(1, 'rgba(' + blipColor + ',0)');
      radarCtx.fillStyle = grd;
      radarCtx.beginPath();
      radarCtx.arc(bx, by, pulse * 2.6, 0, Math.PI * 2);
      radarCtx.fill();

      radarCtx.fillStyle = 'rgba(' + blipColor + ',1)';
      radarCtx.beginPath();
      radarCtx.arc(bx, by, 2.6, 0, Math.PI * 2);
      radarCtx.fill();
    }

    radarCtx.fillStyle = 'rgba(124,140,150,0.5)';
    [[0.3, 1.1], [0.6, 2.3], [0.85, 3.4]].forEach(function (p, i) {
      var a = p[0] * Math.PI * 2 + radar.sweep_angle * 0.02;
      var r = R * (0.3 + i * 0.2);
      radarCtx.beginPath();
      radarCtx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.4, 0, Math.PI * 2);
      radarCtx.fill();
    });
  }

  function drawChart(chart, hrr, alarmThreshold, maxMw) {
    // The chart shows the ENTIRE trace, not a trailing window. It grows
    // horizontally as the simulation clock advances, sitting inside a
    // dedicated overflow-x:auto strip (#hrrScroll). We size the canvas to
    // fit the whole trace and deliberately never touch hrrScroll.scrollLeft
    // here — the person's own scroll position is left alone so the chart
    // does not autoscroll out from under them.
    var visibleW = hrrScroll.clientWidth || 700;
    var h = hrrScroll.clientHeight || hrrCanvas.height;

    var totalSeconds = chart.elapsed || 0;
    var points = chart.points || [];
    if (points.length) {
      totalSeconds = Math.max(totalSeconds, points[points.length - 1].t);
    }

    var padL = 40, padR = 16, padT = 10, padB = 18;
    var plotW = Math.max(visibleW - padL - padR, totalSeconds * PX_PER_SECOND);
    var w = Math.max(visibleW, plotW + padL + padR);
    var plotH = h - padT - padB;

    if (hrrCanvas.width !== w) hrrCanvas.width = w;
    if (hrrCanvas.height !== h) hrrCanvas.height = h;
    hrrCanvas.style.width = w + 'px';

    hrrCtx.clearRect(0, 0, w, h);

    function yFor(v) { return padT + plotH - (v / maxMw) * plotH; }
    function xFor(t) { return padL + t * PX_PER_SECOND; }

    // horizontal MW reference lines
    var refs = [2, 6, 12, alarmThreshold, 20];
    hrrCtx.strokeStyle = 'rgba(124,140,150,0.22)';
    hrrCtx.fillStyle = 'rgba(124,140,150,0.65)';
    hrrCtx.font = '9.5px IBM Plex Mono, monospace';
    refs.forEach(function (v) {
      var y = yFor(v);
      hrrCtx.beginPath();
      hrrCtx.moveTo(padL, y); hrrCtx.lineTo(w - padR, y);
      hrrCtx.stroke();
      hrrCtx.fillText(v.toFixed(0), 4, y + 3);
    });

    // vertical time ticks, every 10s across the full trace
    var tickEvery = 10;
    hrrCtx.strokeStyle = 'rgba(124,140,150,0.14)';
    for (var t = 0; t <= totalSeconds + tickEvery; t += tickEvery) {
      var x = xFor(t);
      hrrCtx.beginPath();
      hrrCtx.moveTo(x, padT); hrrCtx.lineTo(x, h - padB);
      hrrCtx.stroke();
      hrrCtx.fillText(t.toFixed(0) + 's', x + 3, h - 5);
    }

    hrrCtx.strokeStyle = 'rgba(124,140,150,0.3)';
    hrrCtx.beginPath();
    hrrCtx.moveTo(padL, padT); hrrCtx.lineTo(padL, h - padB);
    hrrCtx.stroke();

    if (points.length < 2) return;

    hrrCtx.beginPath();
    points.forEach(function (p, i) {
      var x = xFor(p.t);
      var y = yFor(p.hrr);
      if (i === 0) hrrCtx.moveTo(x, y);
      else hrrCtx.lineTo(x, y);
    });
    hrrCtx.strokeStyle = hrr >= alarmThreshold ? '#E5484D' : '#FF7A29';
    hrrCtx.lineWidth = 1.8;
    hrrCtx.stroke();

    hrrCtx.lineTo(xFor(points[points.length - 1].t), h - padB);
    hrrCtx.lineTo(xFor(points[0].t), h - padB);
    hrrCtx.closePath();
    hrrCtx.fillStyle = hrr >= alarmThreshold ? 'rgba(229,72,77,0.10)' : 'rgba(255,122,41,0.10)';
    hrrCtx.fill();
  }

  function renderLog(entries) {
    var signature = entries.length + ':' + (entries[0] ? entries[0].t + entries[0].msg : '');
    if (signature === lastLogSignature) return;
    lastLogSignature = signature;

    logEl.innerHTML = '';
    entries.forEach(function (e) {
      var entry = document.createElement('div');
      entry.className = 'entry ' + (e.cls || '');
      var time = document.createElement('span');
      time.className = 't';
      time.textContent = e.t;
      var text = document.createElement('span');
      text.textContent = e.msg;
      entry.appendChild(time);
      entry.appendChild(text);
      logEl.appendChild(entry);
    });
  }

  // ---- apply one /api/state payload to the whole UI ----
  function applyState(s) {
    statusPill.className = 'status-pill ' + s.status_cls;
    statusPill.textContent = s.status_text;
    clockEl.textContent = s.clock;
    gaugeValue.innerHTML = s.hrr.toFixed(1) + '<span>MW</span>';
    phaseLabel.textContent = s.phase_label;

    var ro = s.readouts;
    rTemp.innerHTML = ro.temp.toFixed(1) + '<small> &deg;C</small>';
    rSmoke.innerHTML = ro.smoke.toFixed(0) + '<small> %</small>';
    rCO.innerHTML = ro.co.toFixed(0) + '<small> ppm</small>';
    rFlicker.innerHTML = (ro.flicker === null ? '&mdash;' : ro.flicker.toFixed(1)) + '<small> Hz</small>';
    rRange.innerHTML = (ro.range === null ? '&mdash;' : ro.range.toFixed(1)) + '<small> m</small>';

    buttons.forEach(function (b) { b.disabled = s.buttons_disabled; });
    runBtn.disabled = s.run_disabled;
    pauseBtn.disabled = s.pause_disabled;
    runBtn.textContent = (s.paused ? '\u25B6 Resume' : '\u25B6 Run');

    // Reset the chart's own scroll position only when a scenario is newly
    // armed or cleared back to standby — never on a routine poll, so the
    // person's manual scroll position is otherwise left untouched.
    if (s.phase !== lastPhase && (s.phase === 'armed' || s.phase === 'standby')) {
      hrrScroll.scrollLeft = 0;
    }
    lastPhase = s.phase;

    drawHeatmap(s.grid);
    drawRadar(s.radar, s.phase);
    drawChart(s.chart, s.hrr, s.alarm_threshold, s.max_mw);
    renderLog(s.log);
  }

  function poll() {
    fetch('/api/state')
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function (err) { console.error('state poll failed', err); });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      fetch('/api/scenario/' + btn.getAttribute('data-rate'), { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(applyState)
        .catch(function (err) { console.error('start scenario failed', err); });
    });
  });

  resetBtn.addEventListener('click', function () {
    fetch('/api/reset', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function (err) { console.error('reset failed', err); });
  });

  runBtn.addEventListener('click', function () {
    fetch('/api/run', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function (err) { console.error('run failed', err); });
  });

  pauseBtn.addEventListener('click', function () {
    fetch('/api/pause', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function (err) { console.error('pause failed', err); });
  });

  poll();
  setInterval(poll, 130);
})();
