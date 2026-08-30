(() => {
  const q = (id) => document.getElementById(id);

  const CONFIG_KEY = 'speedtest1000_config';
  const STORE_KEY = 'speedtest1000_state';

  const defaults = {
    total: 1000,
    intervalMin: 10,
    downsBytes: 20 * 1024 * 1024,
    upsBytes: 5 * 1024 * 1024,
  };

  let config = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (saved && typeof saved === 'object') config = { ...defaults, ...saved };
  } catch (e) {}

  const DOWNS_URL = () => 'https://speed.cloudflare.com/__down?bytes=' + config.downsBytes;
  const UPS_URL = 'https://speed.cloudflare.com/__up';
  const PING_URL = 'https://speed.cloudflare.com/__down?bytes=1024';

  function blankState() {
    return {
      started: false,
      paused: true,
      running: false,
      results: [],
      startAt: null,
      nextRunAt: null,
      phase: 'Ожидание',
      lastFastSample: null,
    };
  }

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return s && Array.isArray(s.results) ? s : null;
    } catch (e) {
      return null;
    }
  }

  let state = loadState() || blankState();
  state.running = false;

  function save() {
    const s = { ...state, running: false };
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  async function timedGet(url) {
    try {
      const start = performance.now();
      const r = await fetch(url, { cache: 'no-store' });
      await r.arrayBuffer();
      return performance.now() - start;
    } catch (e) {
      return null;
    }
  }

  async function measurePing() {
    let total = 0;
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const t = await timedGet(PING_URL);
      if (t != null) {
        total += t;
        n++;
      }
    }
    return n ? Math.round(total / n) : null;
  }

  async function measureDownload() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);
      const resp = await fetch(DOWNS_URL(), { cache: 'no-store', signal: controller.signal });
      if (!resp.ok || !resp.body) throw new Error('bad response');
      const reader = resp.body.getReader();
      let bytes = 0;
      const start = performance.now();
      for (;;) {
        const step = await reader.read();
        if (step.value) bytes += step.value.length;
        if (step.done) break;
      }
      clearTimeout(timer);
      const secs = (performance.now() - start) / 1000;
      return secs > 0 ? (bytes * 8) / secs / 1e6 : null;
    } catch (e) {
      return null;
    }
  }

  async function measureUpload() {
    try {
      const payload = new Uint8Array(config.upsBytes);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);
      const start = performance.now();
      const resp = await fetch(UPS_URL, {
        method: 'POST',
        body: payload.buffer,
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const secs = (performance.now() - start) / 1000;
      if (resp.status === 413 || (resp.status >= 400 && resp.status < 500)) return null;
      return secs > 0 ? (config.upsBytes * 8) / secs / 1e6 : null;
    } catch (e) {
      return null;
    }
  }

  async function runTest() {
    state.running = true;
    state.paused = false;
    render();

    state.phase = 'Пинг…';
    render();
    const ping = await measurePing();

    state.phase = 'Скачивание…';
    render();
    const down = await measureDownload();

    state.phase = 'Загрузка…';
    render();
    const up = await measureUpload();

    state.results.push({ t: Date.now(), ping, down, up });
    state.nextRunAt = Date.now() + config.intervalMin * 60000;
    state.running = false;
    state.phase = state.results.length >= config.total ? 'Завершено' : 'Ожидание';
    save();
    render();

    if (state.results.length >= config.total) {
      state.paused = true;
      save();
      render();
    }
  }

  function tick() {
    if (
      state.started &&
      !state.paused &&
      !state.running &&
      state.results.length < config.total &&
      Date.now() >= (state.nextRunAt || 0)
    ) {
      runTest();
    }
    render();
  }

  function toggleStart() {
    if (state.running || state.results.length >= config.total) return;
    if (!state.started || state.paused) {
      state.started = true;
      state.paused = false;
      if (!state.startAt) state.startAt = Date.now();
      if (state.nextRunAt == null || state.nextRunAt <= Date.now()) state.nextRunAt = Date.now();
      save();
    } else {
      state.paused = true;
      state.phase = 'Пауза';
      save();
    }
    render();
  }

  function runNow() {
    if (state.running || state.paused || !state.started) return;
    if (state.results.length >= config.total) return;
    state.nextRunAt = Date.now() - 1;
    save();
    render();
  }

  function resetAll() {
    if (!confirm('Сбросить все результаты и начать заново?')) return;
    localStorage.removeItem(STORE_KEY);
    state = blankState();
    render();
  }

  function fmt(v, unit, digits) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(digits == null ? 1 : digits) + ' ' + unit;
  }

  function countdownText() {
    if (state.results.length >= config.total) return 'Завершено';
    if (state.paused) return 'На паузе';
    const ms = (state.nextRunAt || 0) - Date.now();
    if (ms <= 0) return 'Запуск…';
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function stats() {
    const vals = state.results.map((r) => r.down).filter((v) => v != null && v > 0);
    const last = state.results[state.results.length - 1] || null;
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return {
      last,
      avg,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      count: vals.length,
    };
  }

  function etaText() {
    if (state.results.length >= config.total) return 'Завершено';
    const remain = Math.max(0, config.total - state.results.length);
    const ms = remain * config.intervalMin * 60000;
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    let out = 'Тестов осталось: ' + remain + '.';
    if (days > 0) out += ' ~' + days + ' дн';
    if (hours > 0 || days > 0) out += ' ' + hours + ' ч';
    if (days <= 0 && hours <= 0) out += ' ~' + Math.floor(ms / 60000) + ' мин';
    return out;
  }

  function drawChart() {
    const canvas = q('chart');
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, wrap.clientWidth);
    const h = 240;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const padL = 50, padR = 14, padT = 18, padB = 26;
    const iw = w - padL - padR;
    const ih = h - padT - padB;

    const vals = state.results.map((r) => r.down).filter((v) => v != null && v > 0);

    ctx.font = '11px monospace';
    const niceMax = vals.length ? Math.max(...vals) * 1.1 : 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + ih * (1 - i / 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(230,235,247,0.55)';
      ctx.fillText((niceMax * i / 4).toFixed(0), 4, y + 4);
    }

    if (vals.length < 2) {
      ctx.fillStyle = 'rgba(230,235,247,0.4)';
      ctx.fillText('Запустите тесты, чтобы увидеть график', padL, h / 2);
      return;
    }

    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const x = padL + (i / (vals.length - 1)) * iw;
      const y = padT + ih * (1 - vals[i] / niceMax);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const lastX = padL + iw;
    const lastY = padT + ih * (1 - vals[vals.length - 1] / niceMax);
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(230,235,247,0.55)';
    ctx.font = '11px system-ui';
    ctx.fillText(
      'мин ' + Math.min(...vals).toFixed(1) + ' · макс ' + Math.max(...vals).toFixed(1),
      padL + 6,
      h - 4
    );
  }

  function renderTable() {
    const tbody = q('historyBody');
    const rows = state.results.slice(-20).reverse();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Пока пусто</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((r, i) => {
        const idx = state.results.length - i;
        return (
          '<tr>' +
          '<td>#' + idx + '</td>' +
          '<td>' + new Date(r.t).toLocaleString('ru-RU') + '</td>' +
          '<td>' + fmt(r.ping, 'мс', 0) + '</td>' +
          '<td>' + fmt(r.down, '', 1) + '</td>' +
          '<td>' + fmt(r.up, '', 1) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function render() {
    const done = state.results.length;
    const total = config.total;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;

    q('progressFill').style.width = pct.toFixed(2) + '%';
    q('progressLabel').textContent = pct.toFixed(1) + '%';
    q('statDone').textContent = done + ' / ' + total;
    q('countdown').textContent = countdownText();
    q('phase').textContent = state.phase;
    q('eta').textContent = etaText();

    const s = stats();
    q('lastSpeed').textContent = fmt(s.last ? s.last.down : null, '');
    q('avgSpeed').textContent = fmt(s.avg, '');
    q('minSpeed').textContent = fmt(s.min, '');
    q('maxSpeed').textContent = fmt(s.max, '');
    q('lastPing').textContent = fmt(s.last ? s.last.ping : null, 'мс', 0);
    q('lastUp').textContent = fmt(s.last ? s.last.up : null, '');

    const btn = q('btnMain');
    btn.disabled = state.running || done >= total;
    if (!state.started) btn.textContent = 'Старт';
    else if (state.running) btn.textContent = 'Тест идёт…';
    else if (state.paused) {
      btn.textContent = done >= total ? 'Завершено' : 'Продолжить';
      btn.disabled = done >= total;
    } else btn.textContent = 'Пауза';

    q('btnNow').disabled = state.running || state.paused || !state.started || done >= total;

    drawChart();
    renderTable();
  }

  q('btnMain').addEventListener('click', toggleStart);
  q('btnNow').addEventListener('click', runNow);
  q('btnReset').addEventListener('click', resetAll);

  q('cfgTotal').value = config.total;
  q('cfgInterval').value = config.intervalMin;

  q('cfgTotal').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    config.total = v > 0 ? v : defaults.total;
    e.target.value = config.total;
    saveConfig();
    render();
  });

  q('cfgInterval').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    config.intervalMin = v > 0 ? v : defaults.intervalMin;
    e.target.value = config.intervalMin;
    saveConfig();
    render();
  });

  window.addEventListener('resize', render);

  render();
  setInterval(tick, 1000);
})();