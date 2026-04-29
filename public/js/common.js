'use strict';
// Shared utilities for all dashboard pages

const RT = (() => {
  // Detect sub-path prefix (e.g. /RaceTracker/ when proxied via nginx)
  const BASE = (() => {
    const seg = location.pathname.split('/')[1];
    return seg && !seg.includes('.') ? '/' + seg + '/' : '/';
  })();

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function getMe() {
    const res = await fetch(BASE + 'api/auth/me');
    if (!res.ok) return null;
    const j = await res.json();
    return j.ok ? j.data : null;
  }

  async function logout() {
    await fetch(BASE + 'api/auth/logout', { method: 'POST' });
    window.location.href = BASE;
  }

  async function requireLogin(requiredRole) {
    const user = await getMe();
    if (!user) { window.location.href = BASE; return null; }
    if (requiredRole && user.role !== requiredRole && !(requiredRole === 'operator' && user.role === 'admin')) {
      window.location.href = BASE;
      return null;
    }
    return user;
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  async function api(method, url, body, methodOverride) {
    const opts = { method, headers: {} };
    if (methodOverride) opts.headers['X-HTTP-Method-Override'] = methodOverride;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + url.replace(/^\//, ''), opts);
    return res.json();
  }

  const get  = url        => api('GET',  url);
  const post = (url, b)   => api('POST', url, b);
  const put  = (url, b)   => api('PUT',  url, b);
  const del  = url        => api('POST', url, undefined, 'DELETE');

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connectWS(onMessage, tokenParam) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = tokenParam ? `?token=${tokenParam}` : '';
    const url = `${proto}://${location.host}${BASE}ws${qs}`;
    let ws, reconnectTimer;

    function connect() {
      ws = new WebSocket(url);
      ws.onopen  = () => { console.log('[ws] connected'); clearTimeout(reconnectTimer); };
      ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { reconnectTimer = setTimeout(connect, 2000 + Math.random() * 4000); };
      ws.onerror = () => ws.close();
    }
    connect();
    return { send: d => ws?.readyState === 1 && ws.send(JSON.stringify(d)) };
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  function fmtTime(unixSec, fmt24) {
    if (!unixSec) return '--';
    const d = new Date(unixSec * 1000);
    if (fmt24) return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function fmtElapsed(seconds) {
    if (seconds == null || isNaN(seconds)) return '--';
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function fmtDist(meters) {
    if (meters == null) return '--';
    return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
  }

  function fmtSpeed(mPerSec, units) {
    if (!mPerSec || mPerSec <= 0) return '--';
    switch (units) {
      case 'kmh': return `${(mPerSec * 3.6).toFixed(1)} km/h`;
      case 'mph': return `${(mPerSec * 2.23694).toFixed(1)} mph`;
      case 'min_km': {
        const mpk = 1000 / mPerSec / 60;
        const m = Math.floor(mpk), s = Math.round((mpk - m) * 60);
        return `${m}:${String(s).padStart(2,'0')}/km`;
      }
      default: { // min_mile
        const mpm = 26.8224 / mPerSec;
        const m = Math.floor(mpm), s = Math.round((mpm - m) * 60);
        return `${m}:${String(s).padStart(2,'0')}/mi`;
      }
    }
  }

  function fmtPace(mPerSec) { return fmtSpeed(mPerSec, 'min_mile'); }

  function fmtBattery(pct) {
    if (pct == null) return '--';
    const color = pct > 50 ? '#3fb950' : pct > 20 ? '#d2a679' : '#f78166';
    return `<span style="color:${color}">${pct}%</span>`;
  }

  function timeAgo(unixSec) {
    if (!unixSec) return '--';
    const diff = Math.floor(Date.now() / 1000) - unixSec;
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    return `${Math.floor(diff/3600)}h ago`;
  }

  // ── SVG tracker icon shapes ───────────────────────────────────────────────
  const SHAPES = {
    circle:   (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    triangle: (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18,18 2,18" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    square:   (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    diamond:  (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18,10 10,18 2,10" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
    star:     (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,1 12.9,7.6 20,8.2 14.7,13 16.2,20 10,16.3 3.8,20 5.3,13 0,8.2 7.1,7.6" fill="${c}" stroke="#fff" stroke-width="1"/></svg>`,
    pentagon: (c, sz=20) => `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><polygon points="10,2 18.1,7.9 14.9,17.6 5.1,17.6 1.9,7.9" fill="${c}" stroke="#fff" stroke-width="1.5"/></svg>`,
  };

  function trackerIcon(heat, alerting, missing) {
    const color = missing ? '#484f58' : (heat?.color || '#58a6ff');
    const shape = heat?.shape || 'circle';
    const svg = (SHAPES[shape] || SHAPES.circle)(color);
    const cls = alerting ? 'tracker-icon-alert' : '';
    return { svg, cls };
  }

  // ── Status helpers ────────────────────────────────────────────────────────
  const STATUS_COLORS = { dns:'#484f58', active:'#58a6ff', dnf:'#f78166', finished:'#3fb950' };

  function statusBadge(status) {
    const c = STATUS_COLORS[status] || '#484f58';
    return `<span class="badge" style="background:${c}22;color:${c}">${(status||'--').toUpperCase()}</span>`;
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  const THEMES = [
    { id: 'a', label: 'Dark' },
    { id: 'b', label: 'High-Vis Dark' },
    { id: 'c', label: 'High-Vis Day' },
    { id: 'd', label: 'Amber' },
  ];

  function applyTheme(id) {
    if (id && id !== 'a') document.documentElement.setAttribute('data-theme', id);
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('rt-theme', id || 'a');
  }

  // Apply immediately to avoid flash
  applyTheme(localStorage.getItem('rt-theme') || 'a');

  function injectThemeSelector() {
    const right = document.getElementById('topbar-right');
    if (!right) return;
    const saved = localStorage.getItem('rt-theme') || 'a';
    const sel = document.createElement('select');
    sel.title = 'Display theme';
    sel.style.cssText = 'font-size:11px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:4px;font-family:var(--font);cursor:pointer';
    sel.innerHTML = THEMES.map(t => `<option value="${t.id}"${t.id === saved ? ' selected' : ''}>${t.label}</option>`).join('');
    sel.onchange = () => applyTheme(sel.value);
    right.prepend(sel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectThemeSelector);
  else injectThemeSelector();

  // ── Toast notifications ───────────────────────────────────────────────────
  let toastContainer;
  function toast(msg, type = 'info', duration = 4000) {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:6px;';
      document.body.appendChild(toastContainer);
    }
    const colors = { info: 'var(--accent)', ok: 'var(--accent2)', warn: 'var(--accent3)', alert: 'var(--accent3)' };
    const el = document.createElement('div');
    el.style.cssText = `background:var(--surface);border:1px solid ${colors[type]||colors.info};color:${colors[type]||colors.info};padding:8px 14px;border-radius:6px;font-family:var(--font);font-size:13px;max-width:320px;box-shadow:0 4px 12px rgba(0,0,0,.4);`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  return { BASE, getMe, logout, requireLogin, api, get, post, put, del, connectWS,
           fmtTime, fmtElapsed, fmtDist, fmtPace, fmtSpeed, fmtBattery, timeAgo,
           trackerIcon, SHAPES, statusBadge, toast, STATUS_COLORS, applyTheme, THEMES };
})();
