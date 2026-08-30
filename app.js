(() => {
  const q = (id) => document.getElementById(id);

  const CONFIG_KEY = 'speedtest1000_config';
  const STORE_KEY = 'speedtest1000_state';

  const defaults = {
    total: 1000,
    durationMin: 10,
    chunkBytes: 100 * 1024 * 1024,
    upBytes: 10 * 1024 * 1024,
  };

  let config = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (saved && typeof saved === 'object') config = { ...defaults, ...saved };
  } catch (e) {}

  const PING_URL = 'https://speed.cloudflare.com/__down?bytes=1024';
  const UPS_URL = 'https://speed.cloudflare.com/__up';
  const DOWNS_URL = () => 'https://speed.cloudflare.com/__down?bytes=' + config.chunkBytes;

  function blankState() {
    return {
      paused: false,
      pausedAt: null,
      tests: [],
      current: null,
    };
  }

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s === 'object' && Array.isArray(s.tests)) return s;
      return null;
    } catch (e) {
      return null;
    }
  }

  let state = loadState() || blankState();
  if (!Array.isArray(state.tests)) state.tests = [];
  if (state.current && typeof state.current.bytes !== 'number') state.current = null;

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  let currentAbort = null;
  let pumping = false;

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

  async function measureUpload() {
    try {
      const payload = new Uint8Array(config.upBytes);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
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
      return secs > 0 ? (config.upBytes * 8) / secs / 1e6 : null;
    } catch (e) {
      return null;
    }
  }

  function streamOnce() {
    const controller = new AbortController();
    currentAbort = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    return fetch(DOWNS_URL(), { cache: 'no-store', signal: controller.signal })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) return 0;
        const reader = resp.body.getReader();
        let bytes = 0;
        for (;;) {
          const s = await reader.read();
          if (s.value) bytes += s.value.length;
          if (s.done) break;
        }
        return bytes;
      })
      .catch(() => 0)
      .finally(() => {
        clearTimeout(timer);
        if (currentAbort === controller) currentAbort = null;
      });
  }

  async function downloadLoop() {
    const cur = state.current;
    const durMs = config.durationMin * 60000;
    while (!state.paused && Date.now() < cur.startedAt + durMs) {
      const got = await streamOnce();
      if (got > 0) cur.bytes += got;
      save();
      if (got <= 0 && !state.paused) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (!state.paused && state.tests.length < config.total) {
        if (!state.current) {
          state.current = { startedAt: Date.now(), bytes: 0, ping: null, up: null };
        }
        if (state.current.ping == null) state.current.ping = await measurePing();
        if (state.current.up == null) state.current.up = await measureUpload();
        await downloadLoop();
        if (state.paused) break;
        if (Date.now() >= state.current.startedAt + config.durationMin * 60000) {
          finalize();
        } else {
          break;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function finalize() {
    const cur = state.current;
    const seconds = (Date.now() - cur.startedAt) / 1000;
    const down = seconds > 0 ? (cur.bytes * 8) / seconds / 1e6 : null;
    state.tests.push({
      t: Date.now(),
      ping: cur.ping,
      up: cur.up,
      down,
      bytes: cur.bytes,
      seconds,
    });
    state.current = null;
    if (state.tests.length >= config.total) state.paused = true;
    save();
  }

  function setPaused(p) {
    if (p && !state.paused) {
      state.paused = true;
      state.pausedAt = Date.now();
      if (currentAbort) currentAbort.abort();
      save();
    } else if (!p && state.paused) {
      if (state.current) state.current.startedAt += Date.now() - (state.pausedAt || Date.now());
      state.paused = false;
      state.pausedAt = null;
      save();
      pump();
    }
    render();
  }

  function resetAll() {
    if (!confirm('Сбросить все результаты и начать заново?')) return;
    localStorage.removeItem(STORE_KEY);
    state = blankState();
    render();
    pump();
  }

  function fmt(v, unit, digits) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(digits == null ? 1 : digits) + ' ' + unit;
  }

  function mmss(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function liveMbps() {
    if (!state.current) return null;
    const secs = (Date.now() - state.current.startedAt) / 1000;
    return secs > 0 ? (state.current.bytes * 8) / secs / 1e6 : null;
  }

  function etaText() {
    if (state.tests.length >= config.total) return 'Завершено';
    const remain = Math.max(0, config.total - state.tests.length);
    const ms = remain * config.durationMin * 60000;
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

    const vals = state.tests.map((t) => t.down).filter((v) => v != null && v > 0);

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
    const rows = state.tests.slice(-20).reverse();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted)">Пока пусто</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((t, i) => {
        const idx = state.tests.length - i;
        return (
          '<tr>' +
          '<td>#' + idx + '</td>' +
          '<td>' + new Date(t.t).toLocaleString('ru-RU') + '</td>' +
          '<td>' + fmt(t.ping, 'мс', 0) + '</td>' +
          '<td>' + fmt(t.down, '', 1) + '</td>' +
          '<td>' + fmt(t.up, '', 1) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function render() {
    const done = state.tests.length;
    const total = config.total;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;

    if (state.paused && done >= total) {
      q('phase').textContent = 'Завершено';
    } else if (state.paused) {
      q('phase').textContent = 'Пауза';
    } else {
      q('phase').textContent = state.current ? 'Измерение скорости…' : 'Подготовка…';
    }
    q('curTest').textContent = state.current ? '#' + (done + 1) + ' из ' + total : (done >= total ? '—' : '#' + (done + 1) + ' из ' + total);
    q('liveSpeed').textContent = fmt(liveMbps(), '');
    q('curBytes').textContent = state.current ? fmt((state.current.bytes / 1048576), 'МБ', 0) : '—';

    const durMs = config.durationMin * 60000;
    if (state.current) {
      const elapsed = Date.now() - state.current.startedAt;
      const curPct = Math.min(100, (elapsed / durMs) * 100);
      q('curProgressFill').style.width = curPct.toFixed(2) + '%';
      q('curTime').textContent = mmss(elapsed) + ' / ' + mmss(durMs);
    } else if (state.paused && done < total) {
      q('curProgressFill').style.width = '0%';
      q('curTime').textContent = 'На паузе';
    } else {
      q('curProgressFill').style.width = '100%';
      q('curTime').textContent = 'Готово';
    }

    q('progressFill').style.width = pct.toFixed(2) + '%';
    q('progressLabel').textContent = pct.toFixed(1) + '%';
    q('statDone').textContent = done + ' / ' + total;
    q('eta').textContent = etaText();

    const vals = state.tests.map((t) => t.down).filter((v) => v != null && v > 0);
    const last = state.tests[state.tests.length - 1] || null;
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

    q('lastSpeed').textContent = fmt(last ? last.down : null, '');
    q('avgSpeed').textContent = fmt(avg, '');
    q('minSpeed').textContent = fmt(vals.length ? Math.min(...vals) : null, '');
    q('maxSpeed').textContent = fmt(vals.length ? Math.max(...vals) : null, '');
    q('lastPing').textContent = fmt(last ? last.ping : null, 'мс', 0);
    q('lastUp').textContent = fmt(last ? last.up : null, '');

    const btn = q('btnMain');
    if (done >= total) {
      btn.textContent = 'Завершено';
      btn.disabled = true;
    } else {
      btn.textContent = state.paused ? 'Продолжить' : 'Пауза';
      btn.disabled = false;
    }

    drawChart();
    renderTable();
  }

  q('btnMain').addEventListener('click', () => setPaused(!state.paused));
  q('btnReset').addEventListener('click', resetAll);

  q('cfgTotal').value = config.total;
  q('cfgDuration').value = config.durationMin;

  q('cfgTotal').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    config.total = v > 0 ? v : defaults.total;
    e.target.value = config.total;
    saveConfig();
    if (state.tests.length >= config.total && !state.paused) {
      finalize();
    }
    render();
  });

  q('cfgDuration').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    config.durationMin = v > 0 ? v : defaults.durationMin;
    e.target.value = config.durationMin;
    saveConfig();
    render();
  });

  window.addEventListener('resize', render);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.paused && state.tests.length < config.total) pump();
  });

  render();
  setInterval(() => {
    if (!state.paused && state.tests.length < config.total && !pumping) pump();
    render();
  }, 500);
})();