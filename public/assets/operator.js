'use strict';
/* global L, mqtt */

const RT = (() => {

// ── State ─────────────────────────────────────────────────────────────────
const API = '/RaceTracker/api';
let currentRace  = null;   // full race object from server
let participants = [];
let stations     = [];
let heats        = [];
let classes      = [];
let parsedPaths  = [];     // [{name, points:[{lat,lng}]}] from loaded file
let raceStart    = null;   // Date when race activated
let clockTimer   = null;

// Leaflet
let map            = null;
let trackLayer     = null;
let stationLayer   = null;
let markerLayer    = null;
let currentBase    = null;
let addingStation  = false;
let pendingStationLatLng = null;

// MQTT (browser direct, for real-time marker updates)
let mqttClient    = null;

// SSE
let sseSource     = null;

// Position cache: tracker_id -> latest position object
const posCache = new Map();

// Log
const MAX_LOG = 200;
let logTab = 'events';
const eventLog = [];
const alertLog = [];

let selectedFile = null;  // File object for upload
let selectedCsv  = null;

// ── Utility ───────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function fmt(ms, format) {
  if (!ms) return '—';
  const d = new Date(ms);
  if ((format || currentRace?.time_format) === '24') {
    return d.toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  return d.toLocaleTimeString('en-US', { hour12: true, hour:'numeric', minute:'2-digit', second:'2-digit' });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '--:--:--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error); }
  return r.json();
}

function log(msg, type = 'info') {
  const entry = { time: Date.now(), msg, type };
  eventLog.unshift(entry);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  if (logTab === 'events') renderLog();
}

function logAlert(msg) {
  const entry = { time: Date.now(), msg, type: 'alert' };
  alertLog.unshift(entry);
  if (alertLog.length > MAX_LOG) alertLog.pop();
  if (logTab === 'alerts') renderLog();
  updateAlertCount();
}

function renderLog() {
  const body = el('log-body');
  const src  = logTab === 'events' ? eventLog : alertLog;
  body.innerHTML = src.map(e =>
    `<div class="log-entry">
       <span class="log-time">${fmt(e.time)}</span>
       <span class="log-msg log-${e.type}">${e.msg}</span>
     </div>`
  ).join('');
}

function updateAlertCount() {
  const open = alertLog.filter(a => !a.resolved).length;
  el('logtab-alerts').textContent = open > 0 ? `ALERTS (${open})` : 'ALERTS';
}

// ── Race clock ────────────────────────────────────────────────────────────
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (!raceStart) return;
    el('race-clock').textContent = fmtDuration(Date.now() - raceStart);
  }, 1000);
}

// ── Map init ──────────────────────────────────────────────────────────────
const BASE_LAYERS = {
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
               opts:{ subdomains:'abcd', maxZoom:19, attribution:'&copy; CartoDB' } },
  topo:      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
               opts:{ maxZoom:16, attribution:'USGS' } },
  satellite: { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
               opts:{ maxZoom:16, attribution:'USGS' } },
  hybrid:    { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
               opts:{ maxZoom:16, attribution:'USGS' } },
};

function initMap() {
  if (map) return;
  el('no-course').style.display = 'none';
  el('map').style.display = 'block';
  el('map-overlay').style.display = 'block';
  map = L.map('map', { zoomControl: true });
  setBaseLayer('dark');
  trackLayer   = L.layerGroup().addTo(map);
  stationLayer = L.layerGroup().addTo(map);
  markerLayer  = L.layerGroup().addTo(map);

  map.on('click', e => {
    if (addingStation) { pendingStationLatLng = e.latlng; openStationEditModal(null, e.latlng); }
  });
}

function setBaseLayer(key) {
  if (currentBase) map.removeLayer(currentBase);
  const def = BASE_LAYERS[key] || BASE_LAYERS.dark;
  currentBase = L.tileLayer(def.url, def.opts).addTo(map);
}

// ── Route drawing ─────────────────────────────────────────────────────────
async function loadCourseFile(fileId, pathIndex) {
  if (!fileId) return;
  try {
    const resp = await fetch(`${API}/files/${fileId}/content`);
    const text = await resp.text();
    const ext  = text.trim().startsWith('<gpx') || text.includes('<trk') ? 'gpx' : 'kml';
    parsedPaths = ext === 'gpx' ? parseGPX(text) : parseKML(text);
    buildPathSelector(pathIndex || 0);
    drawRoute(pathIndex || 0);
  } catch(e) { log('Failed to load course file: ' + e.message, 'warn'); }
}

function parseKML(txt) {
  const out = [];
  const re  = /<Placemark[\s\S]*?<\/Placemark>/gi;
  let pm;
  while ((pm = re.exec(txt)) !== null) {
    const ls = pm[0].match(/<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!ls) continue;
    const name = (pm[0].match(/<name>(.*?)<\/name>/i) || ['','Unnamed'])[1];
    const pts  = ls[1].trim().split(/\s+/).map(c => {
      const p = c.split(',');
      return p.length >= 2 ? { lat: parseFloat(p[1]), lng: parseFloat(p[0]) } : null;
    }).filter(Boolean);
    if (pts.length >= 2) out.push({ name, points: pts });
  }
  return out;
}

function parseGPX(txt) {
  const pts = [];
  const re  = /<trkpt[^>]+lat="([^"]+)"[^>]+lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(txt)) !== null) pts.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
  return pts.length >= 2 ? [{ name: 'GPX Track', points: pts }] : [];
}

function buildPathSelector(selectedIdx) {
  const grp = el('path-select-group');
  const sel = el('path-select');
  if (parsedPaths.length <= 1) { grp.style.display = 'none'; return; }
  grp.style.display = 'block';
  sel.innerHTML = parsedPaths.map((p, i) =>
    `<option value="${i}" ${i === selectedIdx ? 'selected':''}>${p.name}</option>`
  ).join('');
}

function drawRoute(idx) {
  if (!map || !parsedPaths[idx]) return;
  trackLayer.clearLayers();
  const pts = parsedPaths[idx].points.map(p => [p.lat, p.lng]);
  L.polyline(pts, { color: '#58a6ff', weight: 3, opacity: 0.7 }).addTo(trackLayer);
  map.fitBounds(L.polyline(pts).getBounds(), { padding: [40, 40] });
}

// ── Station markers ───────────────────────────────────────────────────────
const STATION_COLORS = { start:'#3fb950', finish:'#f78166', aid:'#d2a679', custom:'#8b949e' };
const STATION_LABELS = { start:'S', finish:'F', aid:'A', custom:'P' };

function drawStations() {
  if (!map) return;
  stationLayer.clearLayers();
  for (const stn of stations) {
    const col   = STATION_COLORS[stn.type] || '#8b949e';
    const label = STATION_LABELS[stn.type] || '?';
    const icon  = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${col};
             border:2px solid rgba(255,255,255,.5);display:flex;align-items:center;
             justify-content:center;font-size:10px;font-weight:bold;color:#000;
             font-family:'Courier New',monospace">${label}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
    const marker = L.marker([stn.lat, stn.lng], { icon, draggable: true })
      .addTo(stationLayer)
      .bindTooltip(stn.name, { permanent: false, direction: 'top' });

    marker.on('dragend', async e => {
      const ll = e.target.getLatLng();
      await api('PUT', `/races/${currentRace.id}/stations/${stn.id}`, { lat: ll.lat, lng: ll.lng });
      await reloadStations();
    });
    marker.on('click', () => openStationEditModal(stn));
  }
  renderStationPills();
}

function renderStationPills() {
  el('station-pills').innerHTML = stations.map(s =>
    `<span style="font-size:10px;padding:2px 7px;border-radius:3px;cursor:pointer;
      background:rgba(${hexToRgb(STATION_COLORS[s.type]||'#8b949e')},.15);
      color:${STATION_COLORS[s.type]||'#8b949e'}"
      onclick="RT.openStationEditModal_byId(${s.id})">${s.name}</span>`
  ).join('');
}

function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : '128,128,128';
}

// ── Tracker markers ───────────────────────────────────────────────────────
function getHeatStyle(heatId) {
  const h = heats.find(x => x.id === heatId);
  return h ? { color: h.color, shape: h.icon_type } : { color: '#58a6ff', shape: 'circle' };
}

function getParticipantByTracker(trackerId) {
  return participants.find(p => p.tracker_id === trackerId);
}

const markerMap = new Map(); // tracker_id -> L.marker

function updateTrackerMarker(pos) {
  if (!map) return;
  const p = getParticipantByTracker(pos.tracker_id);
  const style = getHeatStyle(p?.heat_id);
  const isAlert   = alertLog.some(a => a.tracker_id === pos.tracker_id && !a.resolved);
  const isMissing = p?.status === 'active' && currentRace &&
                    (Date.now() - pos.rx_time > (currentRace.missing_timer_min || 30) * 60000);
  const label = p?.bib || pos.tracker_id.slice(-4);

  const shapeClass = `heat-${style.shape}`;
  const extraClass = isAlert ? 'alert' : isMissing ? 'missing' : '';
  const html = `<div class="tracker-icon ${shapeClass} ${extraClass}"
    style="background:${style.color};color:#000">${label}</div>`;

  const icon = L.divIcon({ className:'', html, iconSize:[24,24], iconAnchor:[12,12] });

  if (markerMap.has(pos.tracker_id)) {
    const mk = markerMap.get(pos.tracker_id);
    mk.setLatLng([pos.lat, pos.lng]);
    mk.setIcon(icon);
  } else {
    const mk = L.marker([pos.lat, pos.lng], { icon })
      .addTo(markerLayer)
      .bindTooltip(() => {
        const pp = getParticipantByTracker(pos.tracker_id);
        return pp ? `#${pp.bib} — ${pp.name}` : pos.tracker_id;
      });
    mk.on('click', () => {
      const pp = getParticipantByTracker(pos.tracker_id);
      if (pp) openInfoPanel(pp.id);
    });
    markerMap.set(pos.tracker_id, mk);
  }
}

function refreshAllMarkers() {
  for (const [tid, pos] of posCache) updateTrackerMarker(pos);
}

// ── Participant list ──────────────────────────────────────────────────────
function renderParticipantList() {
  const search = (el('p-search')?.value || '').toLowerCase();
  const filter = el('p-filter-status')?.value || '';
  const list   = el('participant-list');
  if (!list) return;

  let rows = participants.filter(p => {
    if (filter && p.status !== filter) return false;
    if (search && !p.name.toLowerCase().includes(search) && !String(p.bib).includes(search)) return false;
    return true;
  });

  const stats = { active:0, finished:0, dnf:0, dns:0 };
  for (const p of participants) if (stats[p.status] !== undefined) stats[p.status]++;
  el('stat-active')?.setAttribute('textContent', stats.active);
  if (el('stat-active'))   el('stat-active').textContent   = stats.active;
  if (el('stat-finished')) el('stat-finished').textContent = stats.finished;
  if (el('stat-dnf'))      el('stat-dnf').textContent      = stats.dnf;

  const cached = pos => posCache.get(p.tracker_id);

  list.innerHTML = rows.map(p => {
    const pos    = p.tracker_id ? posCache.get(p.tracker_id) : null;
    const style  = getHeatStyle(p.heat_id);
    const pct    = pos?.progress_pct != null ? pos.progress_pct.toFixed(1) + '%' : '—';
    const bat    = pos?.battery_pct  != null ? pos.battery_pct + '%'          : '—';
    const hasAlert = alertLog.some(a => a.participant_id === p.id && !a.resolved);
    return `<div class="participant-row ${hasAlert?'alert-row':''}"
               data-id="${p.id}" onclick="RT.openInfoPanel(${p.id})">
      <span class="p-bib">#${p.bib}</span>
      <div class="p-icon heat-${style.shape}" style="background:${style.color}"></div>
      <span class="p-name">${p.name}</span>
      <span class="p-pct">${pct}</span>
      <span class="p-batt" style="${+bat<20?'color:var(--accent3)':''}">${bat}</span>
    </div>`;
  }).join('');

  updateStatOverlay(stats);
}

function updateStatOverlay(stats) {
  if (el('stat-active'))   el('stat-active').textContent   = stats?.active   ?? 0;
  if (el('stat-finished')) el('stat-finished').textContent = stats?.finished ?? 0;
  if (el('stat-dnf'))      el('stat-dnf').textContent      = stats?.dnf      ?? 0;
  if (el('stat-alerts'))   el('stat-alerts').textContent   = alertLog.filter(a=>!a.resolved).length;
}

// ── Info panel ────────────────────────────────────────────────────────────
async function openInfoPanel(participantId) {
  const p = await api('GET', `/races/${currentRace.id}/participants/${participantId}`);
  const pos = p.tracker_id ? posCache.get(p.tracker_id) : null;
  const style = getHeatStyle(p.heat_id);

  el('info-bib').textContent  = `#${p.bib}`;
  el('info-name').textContent = p.name;

  let html = '';

  // Status + progress
  const pct = pos?.progress_pct != null ? pos.progress_pct.toFixed(1) : null;
  html += `<div class="info-field">
    <div class="info-label">STATUS</div>
    <div class="info-value status-${p.status}">${p.status.toUpperCase()}
      ${pct != null ? `<span style="color:var(--text2);font-size:11px"> &mdash; ${pct}% along course</span>` : ''}
    </div>
    ${pct != null ? `<div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
  </div>`;

  // Tracker info
  if (pos) {
    html += `<div class="info-field">
      <div class="info-label">LAST POSITION</div>
      <div class="info-value" style="font-size:11px;color:var(--text2)">
        ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}<br>
        ${fmt(pos.rx_time)} &nbsp;&bull;&nbsp;
        ${pos.battery_pct != null ? `Bat: ${pos.battery_pct}%` : ''}
        ${pos.snr   != null ? ` &bull; SNR: ${pos.snr}dB`  : ''}
        ${pos.rssi  != null ? ` &bull; RSSI: ${pos.rssi}`  : ''}
      </div>
    </div>`;
  }

  // Contact info
  html += `<div class="info-section">PARTICIPANT INFO</div>`;
  const fields = [
    ['TRACKER ID', p.tracker_id], ['AGE', p.age], ['GENDER', p.gender],
    ['PHONE', p.phone], ['EMERGENCY CONTACT', p.emergency_contact],
    ['EMERGENCY PHONE', p.emergency_phone],
    ['HEAT', heats.find(h=>h.id===p.heat_id)?.name],
    ['CLASS', classes.find(c=>c.id===p.class_id)?.name],
    ['NOTES', p.notes],
  ];
  for (const [label, val] of fields) {
    if (!val) continue;
    html += `<div class="info-field">
      <div class="info-label">${label}</div>
      <div class="info-value" style="font-size:12px">${val}</div>
    </div>`;
  }

  // Timing log
  if (p.timing?.length) {
    html += `<div class="info-section">TIMING LOG</div>`;
    html += p.timing.map(t =>
      `<div class="timing-row">
         <span class="timing-time">${fmt(t.event_time)}</span>
         <span class="timing-station">${t.station_name || '—'}</span>
         <span class="timing-type">${t.event_type}</span>
         ${t.auto_detected ? '<span class="timing-auto">auto</span>' : ''}
       </div>`
    ).join('');
  }

  // Edit + status buttons
  html += `<div class="info-section">ACTIONS</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
    <button onclick="RT.openParticipantModal(${p.id})" style="font-size:11px">EDIT</button>
    <button onclick="RT.setParticipantStatus(${p.id},'active')"   style="font-size:11px" class="success">SET ACTIVE</button>
    <button onclick="RT.setParticipantStatus(${p.id},'dns')"      style="font-size:11px">DNS</button>
    <button onclick="RT.setParticipantStatus(${p.id},'dnf')"      style="font-size:11px" class="danger">DNF</button>
    <button onclick="RT.setParticipantStatus(${p.id},'finished')" style="font-size:11px" class="primary">FINISH</button>
  </div>`;

  el('info-panel-body').innerHTML = html;
  el('info-panel').classList.add('open');
}

function closeInfoPanel() { el('info-panel').classList.remove('open'); }

async function setParticipantStatus(id, status) {
  await api('PUT', `/races/${currentRace.id}/participants/${id}`, { status });
  await reloadParticipants();
  openInfoPanel(id);
  log(`Participant #${participants.find(p=>p.id===id)?.bib} → ${status}`, 'timing');
}

// ── Timing tab ────────────────────────────────────────────────────────────
async function reloadTiming() {
  if (!currentRace) return;
  const events = await api('GET', `/races/${currentRace.id}/timing`);
  const list   = el('timing-list');
  if (!list) return;
  if (!events.length) { list.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:8px">No events recorded.</div>'; return; }
  list.innerHTML = `<table>
    <thead><tr><th>TIME</th><th>BIB</th><th>STATION</th><th>TYPE</th><th></th></tr></thead>
    <tbody>${events.slice().reverse().map(e =>
      `<tr>
        <td>${fmt(e.event_time)}</td>
        <td>${e.bib || '—'}</td>
        <td>${e.station_name || '—'}</td>
        <td>${e.event_type}${e.auto_detected?'<span class="badge badge-auto" style="margin-left:4px">auto</span>':''}</td>
        <td class="td-action" onclick="RT.deleteTimingEvent(${e.id})">&#10005;</td>
      </tr>`
    ).join('')}</tbody>
  </table>`;
}

async function deleteTimingEvent(id) {
  if (!confirm('Delete this timing event?')) return;
  await api('DELETE', `/races/${currentRace.id}/timing/${id}`);
  reloadTiming();
}

// ── SSE ───────────────────────────────────────────────────────────────────
function connectSSE(raceId) {
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseSource = new EventSource(`${API}/events/${raceId}`);

  sseSource.onopen = () => {
    el('sse-status-pill').className = 'pill pill-ok';
    el('sse-status-pill').textContent = 'SSE';
  };
  sseSource.onerror = () => {
    el('sse-status-pill').className = 'pill pill-err';
    el('sse-status-pill').textContent = 'SSE ERR';
  };
  sseSource.onmessage = e => {
    try { handleSSE(JSON.parse(e.data)); } catch {}
  };
}

function handleSSE(msg) {
  switch (msg.type) {
    case 'position': {
      posCache.set(msg.tracker_id, msg);
      updateTrackerMarker(msg);
      renderParticipantList();
      break;
    }
    case 'timing': {
      const p = participants.find(x => x.id === msg.participant_id);
      const s = stations.find(x => x.id === msg.station_id);
      log(`#${p?.bib || '?'} ${msg.event} at ${s?.name || '?'}${msg.auto?' [auto]':''}`, 'timing');
      reloadTiming();
      break;
    }
    case 'alert': {
      const p = participants.find(x => x.id === msg.participant_id);
      const entry = { ...msg, participant_id: msg.participant_id, tracker_id: msg.tracker_id, resolved: false };
      alertLog.unshift(entry);
      if (alertLog.length > MAX_LOG) alertLog.pop();
      const name = p ? `#${p.bib} ${p.name}` : msg.tracker_id;
      let detail = '';
      if (msg.alert_type === 'off_course') detail = ` (${msg.dist}m off course)`;
      if (msg.alert_type === 'missing')    detail = ` (no signal)`;
      logAlert(`${name}: ${msg.alert_type}${detail}`);
      if (markerMap.has(msg.tracker_id)) updateTrackerMarker(posCache.get(msg.tracker_id) || { tracker_id: msg.tracker_id });
      break;
    }
    case 'mqtt_status': {
      const pill = el('mqtt-status-pill');
      if (msg.status === 'connected') {
        pill.className = 'pill pill-ok';
        pill.textContent = `MQTT ${msg.host || ''}`;
        log(`MQTT connected to ${msg.host}`, 'ok');
      } else if (msg.status === 'error') {
        pill.className = 'pill pill-err';
        pill.textContent = 'MQTT ERR';
        log('MQTT error: ' + msg.message, 'warn');
      } else {
        pill.className = 'pill pill-idle';
        pill.textContent = 'MQTT';
      }
      break;
    }
  }
}

// ── Browser-side MQTT (direct, for lowest latency markers) ────────────────
function connectBrowserMQTT() {
  if (!currentRace) return;
  if (mqttClient) { try { mqttClient.end(true); } catch {} mqttClient = null; }

  const r      = currentRace;
  const proto  = r.mqtt_tls ? 'wss' : 'ws';
  const url    = `${proto}://${r.mqtt_host}:${r.mqtt_port}`;
  const topic  = `msh/${r.mqtt_region}/2/json/${r.mqtt_channel}/#`;
  const opts   = { reconnectPeriod: 5000 };
  if (r.mqtt_user) { opts.username = r.mqtt_user; opts.password = r.mqtt_pass; }

  try {
    mqttClient = mqtt.connect(url, opts);
    mqttClient.on('connect', () => {
      mqttClient.subscribe(topic);
      el('mqtt-status-pill').className   = 'pill pill-ok';
      el('mqtt-status-pill').textContent = `MQTT ${r.mqtt_host}`;
    });
    mqttClient.on('error', () => {
      el('mqtt-status-pill').className   = 'pill pill-err';
      el('mqtt-status-pill').textContent = 'MQTT ERR';
    });
    mqttClient.on('message', (t, payload) => {
      try {
        const msg = JSON.parse(payload.toString());
        const pos = msg.payload;
        if (!pos || pos.latitude_i == null) return;
        const tid = String(msg.from);
        const lat = pos.latitude_i  / 1e7;
        const lng = pos.longitude_i / 1e7;
        // Merge with cached progress data if available
        const cached = posCache.get(tid) || {};
        const merged = { ...cached, tracker_id: tid, lat, lng,
          battery_pct: msg.payload?.device_metrics?.battery_level ?? cached.battery_pct,
          snr: msg.rx_snr ?? cached.snr, rssi: msg.rx_rssi ?? cached.rssi,
          rx_time: Date.now() };
        posCache.set(tid, merged);
        updateTrackerMarker(merged);
      } catch {}
    });
  } catch (e) { log('Browser MQTT failed: ' + e.message, 'warn'); }
}

// ── Race management ───────────────────────────────────────────────────────
async function loadRace(race) {
  currentRace = race;
  stations    = race.stations  || [];
  heats       = race.heats     || [];
  classes     = race.classes   || [];

  // UI state
  el('race-status-pill').textContent = race.name;
  el('race-status-pill').className   = `pill pill-${race.status}`;
  el('btn-activate').disabled = race.status !== 'pending';
  el('btn-finish').disabled   = race.status !== 'active';

  // Settings fields
  el('setting-geofence').value    = race.geofence_radius_m;
  el('setting-missing').value     = race.missing_timer_min;
  el('setting-timeformat').value  = race.time_format;
  el('setting-offcourse-en').checked = !!race.off_course_alerts;
  el('setting-offcourse-dist').value = race.off_course_distance_m;

  // Course file selector
  await loadFileList();
  if (race.course_file_id) {
    el('course-file-select').value = race.course_file_id;
    initMap();
    await loadCourseFile(race.course_file_id, race.selected_path_index);
  }

  // Participants
  await reloadParticipants();

  // Heats & classes
  renderHeats();
  renderClasses();
  drawStations();

  if (race.status === 'active') {
    raceStart = race.created_at; // approximate; improve with a race_started_at field later
    startClock();
    connectSSE(race.id);
    connectBrowserMQTT();
    // Load existing latest positions
    try {
      const positions = await api('GET', `/races/${race.id}/positions/latest`);
      for (const p of positions) { posCache.set(p.tracker_id, p); updateTrackerMarker(p); }
    } catch {}
  }

  // Existing alerts
  try {
    const alerts = await api('GET', `/races/${race.id}/positions/alerts`);
    for (const a of alerts) {
      if (!a.resolved_at) alertLog.unshift({ ...a, resolved: false });
    }
    updateAlertCount();
  } catch {}

  reloadTiming();
  el('no-course').style.display = 'none';
  initMap();
}

async function reloadParticipants() {
  if (!currentRace) return;
  participants = await api('GET', `/races/${currentRace.id}/participants`);
  // Merge latest positions into posCache
  for (const p of participants) {
    if (p.tracker_id && p.last_lat != null) {
      const existing = posCache.get(p.tracker_id) || {};
      posCache.set(p.tracker_id, { ...existing,
        tracker_id: p.tracker_id, lat: p.last_lat, lng: p.last_lng,
        rx_time: p.last_seen, battery_pct: p.battery_pct,
        participant_id: p.id
      });
    }
  }
  renderParticipantList();
  refreshAllMarkers();
}

async function reloadStations() {
  if (!currentRace) return;
  const race = await api('GET', `/races/${currentRace.id}`);
  stations   = race.stations || [];
  drawStations();
}

async function activateRace() {
  if (!currentRace) return;
  if (!confirm(`Activate "${currentRace.name}"? This will start the MQTT bridge and generate the viewer link.`)) return;
  const r = await api('POST', `/races/${currentRace.id}/activate`);
  log(`Race activated. Viewer hash: ${r.viewer_hash}`, 'ok');
  currentRace = await api('GET', `/races/${currentRace.id}`);
  el('btn-activate').disabled = true;
  el('btn-finish').disabled   = false;
  el('race-status-pill').className   = 'pill pill-active';
  el('race-status-pill').textContent = currentRace.name;
  raceStart = Date.now();
  startClock();
  connectSSE(currentRace.id);
  connectBrowserMQTT();
}

async function finishRace() {
  if (!currentRace) return;
  if (!confirm('Mark race as finished?')) return;
  await api('POST', `/races/${currentRace.id}/finish`);
  currentRace.status = 'finished';
  el('btn-finish').disabled = true;
  el('race-status-pill').className   = 'pill pill-finished';
  el('race-status-pill').textContent = currentRace.name;
  if (mqttClient) { try { mqttClient.end(true); } catch {} mqttClient = null; }
  log('Race finished.', 'ok');
}

// ── MQTT config ───────────────────────────────────────────────────────────
function openMqttModal() {
  if (!currentRace) { alert('Select a race first.'); return; }
  el('mqtt-host').value    = currentRace.mqtt_host    || 'apps.k7swi.org';
  el('mqtt-port').value    = currentRace.mqtt_port    || 9001;
  el('mqtt-user').value    = currentRace.mqtt_user    || '';
  el('mqtt-pass').value    = currentRace.mqtt_pass    || '';
  el('mqtt-region').value  = currentRace.mqtt_region  || 'US';
  el('mqtt-channel').value = currentRace.mqtt_channel || 'RaceTracker';
  el('mqtt-tls').checked   = !!currentRace.mqtt_tls;
  updateMqttTopicPreview();
  el('mqtt-modal').style.display = 'flex';
}

function updateMqttTopicPreview() {
  const region  = el('mqtt-region')?.value  || 'US';
  const channel = el('mqtt-channel')?.value || 'RaceTracker';
  el('mqtt-topic-preview').textContent = `msh/${region}/2/json/${channel}/#`;
}

async function saveMqttConfig() {
  await api('PUT', `/races/${currentRace.id}`, {
    mqtt_host:    el('mqtt-host').value,
    mqtt_port:    +el('mqtt-port').value,
    mqtt_user:    el('mqtt-user').value,
    mqtt_pass:    el('mqtt-pass').value,
    mqtt_region:  el('mqtt-region').value,
    mqtt_channel: el('mqtt-channel').value,
    mqtt_tls:     el('mqtt-tls').checked ? 1 : 0,
  });
  currentRace = await api('GET', `/races/${currentRace.id}`);
  closeModal('mqtt-modal');
  if (currentRace.status === 'active') connectBrowserMQTT();
  log('MQTT config saved.', 'ok');
}

// ── Race modal ────────────────────────────────────────────────────────────
async function openRaceModal() {
  el('race-modal').style.display = 'flex';
  const races = await api('GET', '/races');
  el('race-list').innerHTML = races.length === 0
    ? '<div style="color:var(--text3);font-size:11px;padding:8px">No races yet. Create one above.</div>'
    : races.map(r => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;
                  border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <div style="flex:1">
          <div style="font-weight:bold">${r.name}</div>
          <div style="font-size:10px;color:var(--text3)">${r.date} &bull; <span class="pill pill-${r.status}" style="padding:1px 6px">${r.status}</span>
          ${r.viewer_hash ? `<span style="color:var(--accent4);margin-left:6px">&#128279; viewer active</span>` : ''}
          </div>
        </div>
        <button onclick="RT.selectRace(${r.id})" class="primary" style="font-size:11px">SELECT</button>
        <button onclick="RT.deleteRace(${r.id})" class="danger"  style="font-size:11px">DEL</button>
      </div>`
    ).join('');
  // Pre-fill today's date
  if (!el('new-race-date').value) el('new-race-date').value = new Date().toISOString().slice(0,10);
}

async function createRace() {
  const name = el('new-race-name').value.trim();
  const date = el('new-race-date').value;
  if (!name || !date) { alert('Name and date required.'); return; }
  await api('POST', '/races', { name, date });
  el('new-race-name').value = '';
  openRaceModal();
}

async function selectRace(id) {
  closeModal('race-modal');
  posCache.clear();
  markerLayer?.clearLayers();
  markerMap.clear();
  if (sseSource) { sseSource.close(); sseSource = null; }
  const race = await api('GET', `/races/${id}`);
  initMap();
  loadRace(race);
}

async function deleteRace(id) {
  if (!confirm('Delete this race and all its data?')) return;
  await api('DELETE', `/races/${id}`);
  openRaceModal();
  if (currentRace?.id === id) {
    currentRace = null;
    el('race-status-pill').textContent = 'NO RACE';
    el('race-status-pill').className   = 'pill pill-idle';
  }
}

// ── Course file handling ──────────────────────────────────────────────────
async function loadFileList() {
  const files = await api('GET', '/files');
  const sel   = el('course-file-select');
  sel.innerHTML = '<option value="">— select uploaded file —</option>' +
    files.map(f => `<option value="${f.id}">${f.original_name}</option>`).join('');
  if (currentRace?.course_file_id) sel.value = currentRace.course_file_id;
}

async function onCourseFileChange() {
  const fileId = +el('course-file-select').value;
  if (!fileId || !currentRace) return;
  await api('PUT', `/races/${currentRace.id}`, { course_file_id: fileId, selected_path_index: 0 });
  currentRace.course_file_id = fileId;
  currentRace.selected_path_index = 0;
  initMap();
  await loadCourseFile(fileId, 0);
}

async function onPathChange() {
  const idx = +el('path-select').value;
  if (!currentRace) return;
  await api('PUT', `/races/${currentRace.id}`, { selected_path_index: idx });
  currentRace.selected_path_index = idx;
  drawRoute(idx);
}

function openUploadModal() { el('upload-modal').style.display = 'flex'; }

function onFileSelected(input) {
  selectedFile = input.files[0];
  if (selectedFile) {
    el('upload-zone').classList.add('has-file');
    el('upload-text').textContent = selectedFile.name;
    el('btn-do-upload').disabled  = false;
  }
}

async function doUpload() {
  if (!selectedFile) return;
  const fd = new FormData();
  fd.append('file', selectedFile);
  el('upload-status').textContent = 'Uploading…';
  try {
    const r = await fetch(`${API}/files`, { method:'POST', body: fd });
    const f = await r.json();
    el('upload-status').textContent = `Uploaded: ${f.original_name}`;
    selectedFile = null;
    el('btn-do-upload').disabled = true;
    el('upload-zone').classList.remove('has-file');
    el('upload-text').textContent = '↑ Click to select KML or GPX file';
    await loadFileList();
    closeModal('upload-modal');
  } catch(e) { el('upload-status').textContent = 'Error: ' + e.message; }
}

// ── Station editing ───────────────────────────────────────────────────────
function addStationMode() {
  if (!map) { alert('Load a course file first.'); return; }
  addingStation = true;
  el('add-station-banner').style.display = 'block';
}

function cancelStationMode() {
  addingStation = false;
  el('add-station-banner').style.display = 'none';
  pendingStationLatLng = null;
}

function openStationEditModal(stn, latlng) {
  cancelStationMode();
  el('station-edit-title').textContent = stn ? 'EDIT STATION' : 'ADD STATION';
  el('station-edit-id').value  = stn?.id || '';
  el('station-name').value     = stn?.name || '';
  el('station-type').value     = stn?.type || 'aid';
  el('station-lat').value      = stn?.lat  || latlng?.lat?.toFixed(6) || '';
  el('station-lng').value      = stn?.lng  || latlng?.lng?.toFixed(6) || '';
  el('station-cutoff').value   = stn?.cutoff_time || '';
  el('station-edit-modal').style.display = 'flex';
}

function openStationEditModal_byId(id) {
  openStationEditModal(stations.find(s=>s.id===id));
}

async function saveStation() {
  const id   = el('station-edit-id').value;
  const body = {
    name: el('station-name').value.trim(),
    type: el('station-type').value,
    lat:  +el('station-lat').value,
    lng:  +el('station-lng').value,
    cutoff_time: el('station-cutoff').value || null,
  };
  if (!body.name) { alert('Name required.'); return; }
  if (id) await api('PUT', `/races/${currentRace.id}/stations/${id}`, body);
  else    await api('POST',`/races/${currentRace.id}/stations`, body);
  closeModal('station-edit-modal');
  await reloadStations();
}

async function openStationsTable() {
  if (!currentRace) return;
  await reloadStations();
  el('stations-table-wrap').innerHTML = `
    <table>
      <thead><tr><th>#</th><th>NAME</th><th>TYPE</th><th>CUTOFF</th><th></th></tr></thead>
      <tbody>${stations.map((s,i) =>
        `<tr>
          <td>${i+1}</td>
          <td>${s.name}</td>
          <td>${s.type}</td>
          <td>${s.cutoff_time||'—'}</td>
          <td>
            <span class="td-action" onclick="RT.openStationEditModal_byId(${s.id});RT.closeModal('stations-modal')">edit</span>
            &nbsp;
            <span class="td-action" onclick="RT.deleteStation(${s.id})">del</span>
          </td>
        </tr>`
      ).join('')}</tbody>
    </table>`;
  el('stations-modal').style.display = 'flex';
}

async function deleteStation(id) {
  if (!confirm('Delete this station?')) return;
  await api('DELETE', `/races/${currentRace.id}/stations/${id}`);
  await reloadStations();
  await openStationsTable();
}

// ── Heats ─────────────────────────────────────────────────────────────────
function renderHeats() {
  el('heats-list').innerHTML = heats.map(h =>
    `<div style="display:flex;align-items:center;gap:6px;padding:4px;
                 border:1px solid var(--border);border-radius:4px">
      <div class="heat-${h.icon_type}" style="width:12px;height:12px;background:${h.color};flex-shrink:0"></div>
      <span style="flex:1;font-size:11px">${h.name}</span>
      <span style="font-size:10px;color:var(--text3)">${h.start_time||''}</span>
      <span class="td-action" onclick="RT.openHeatModal(${h.id})" style="font-size:10px">edit</span>
      <span class="td-action" onclick="RT.deleteHeat(${h.id})" style="font-size:10px">del</span>
    </div>`
  ).join('');
}

function openHeatModal(id) {
  const h = id ? heats.find(x=>x.id===id) : null;
  el('heat-modal-title').textContent = h ? 'EDIT HEAT' : 'ADD HEAT';
  el('heat-edit-id').value  = h?.id || '';
  el('heat-name').value     = h?.name || '';
  el('heat-start').value    = h?.start_time || '';
  el('heat-icon').value     = h?.icon_type || 'circle';
  el('heat-color').value    = h?.color || '#58a6ff';
  el('heat-modal').style.display = 'flex';
}

async function saveHeat() {
  const id   = el('heat-edit-id').value;
  const body = { name: el('heat-name').value.trim(), start_time: el('heat-start').value||null,
                 icon_type: el('heat-icon').value, color: el('heat-color').value };
  if (!body.name) { alert('Name required.'); return; }
  if (id) await api('PUT', `/races/${currentRace.id}/heats/${id}`, body);
  else    await api('POST',`/races/${currentRace.id}/heats`, body);
  closeModal('heat-modal');
  const race = await api('GET', `/races/${currentRace.id}`);
  heats = race.heats;
  renderHeats();
  refreshAllMarkers();
}

async function deleteHeat(id) {
  if (!confirm('Delete heat? Participants assigned to it will lose their heat assignment.')) return;
  await api('DELETE', `/races/${currentRace.id}/heats/${id}`);
  const race = await api('GET', `/races/${currentRace.id}`);
  heats = race.heats;
  renderHeats();
}

// ── Classes ───────────────────────────────────────────────────────────────
function renderClasses() {
  el('classes-list').innerHTML = classes.map(c =>
    `<div style="display:flex;align-items:center;gap:6px;padding:4px;
                 border:1px solid var(--border);border-radius:4px">
      <span style="flex:1;font-size:11px">${c.name}</span>
      <span class="td-action" onclick="RT.openClassModal(${c.id})" style="font-size:10px">edit</span>
      <span class="td-action" onclick="RT.deleteClass(${c.id})" style="font-size:10px">del</span>
    </div>`
  ).join('');
}

function openClassModal(id) {
  const c = id ? classes.find(x=>x.id===id) : null;
  el('class-modal-title').textContent = c ? 'EDIT CLASS' : 'ADD CLASS';
  el('class-edit-id').value = c?.id || '';
  el('class-name').value    = c?.name || '';
  el('class-modal').style.display = 'flex';
}

async function saveClass() {
  const id = el('class-edit-id').value;
  const name = el('class-name').value.trim();
  if (!name) { alert('Name required.'); return; }
  if (id) await api('PUT', `/races/${currentRace.id}/classes/${id}`, { name });
  else    await api('POST',`/races/${currentRace.id}/classes`, { name });
  closeModal('class-modal');
  const race = await api('GET', `/races/${currentRace.id}`);
  classes = race.classes;
  renderClasses();
}

async function deleteClass(id) {
  if (!confirm('Delete class?')) return;
  await api('DELETE', `/races/${currentRace.id}/classes/${id}`);
  const race = await api('GET', `/races/${currentRace.id}`);
  classes = race.classes;
  renderClasses();
}

// ── Participant modal ─────────────────────────────────────────────────────
function populateHeatClassSelects() {
  const hOpts = '<option value="">— none —</option>' + heats.map(h=>`<option value="${h.id}">${h.name}</option>`).join('');
  const cOpts = '<option value="">— none —</option>' + classes.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  el('p-heat').innerHTML  = hOpts;
  el('p-class').innerHTML = cOpts;
}

async function openParticipantModal(id) {
  populateHeatClassSelects();
  const p = id ? participants.find(x=>x.id===id) : null;
  el('participant-modal-title').textContent = p ? 'EDIT PARTICIPANT' : 'ADD PARTICIPANT';
  el('p-edit-id').value   = p?.id || '';
  el('p-bib').value       = p?.bib || '';
  el('p-name').value      = p?.name || '';
  el('p-tracker').value   = p?.tracker_id || '';
  el('p-age').value       = p?.age || '';
  el('p-gender').value    = p?.gender || '';
  el('p-phone').value     = p?.phone || '';
  el('p-ec-name').value   = p?.emergency_contact || '';
  el('p-ec-phone').value  = p?.emergency_phone || '';
  el('p-heat').value      = p?.heat_id  || '';
  el('p-class').value     = p?.class_id || '';
  el('p-notes').value     = p?.notes || '';
  el('participant-modal').style.display = 'flex';
}

async function saveParticipant() {
  const id   = el('p-edit-id').value;
  const body = {
    bib: el('p-bib').value.trim(), name: el('p-name').value.trim(),
    tracker_id: el('p-tracker').value.trim() || null,
    age: el('p-age').value || null, gender: el('p-gender').value || null,
    phone: el('p-phone').value || null,
    emergency_contact: el('p-ec-name').value  || null,
    emergency_phone:   el('p-ec-phone').value || null,
    heat_id:  el('p-heat').value  || null,
    class_id: el('p-class').value || null,
    notes:    el('p-notes').value || null,
  };
  if (!body.bib || !body.name) { alert('Bib and name required.'); return; }
  if (id) await api('PUT', `/races/${currentRace.id}/participants/${id}`, body);
  else    await api('POST',`/races/${currentRace.id}/participants`, body);
  closeModal('participant-modal');
  await reloadParticipants();
}

// ── CSV import ────────────────────────────────────────────────────────────
function openImportModal() { el('import-modal').style.display = 'flex'; }

function onCsvSelected(input) {
  selectedCsv = input.files[0];
  if (selectedCsv) {
    el('csv-upload-zone').classList.add('has-file');
    el('csv-upload-text').textContent = selectedCsv.name;
    el('btn-do-import').disabled = false;
  }
}

async function doImport() {
  if (!selectedCsv || !currentRace) return;
  const fd = new FormData();
  fd.append('file', selectedCsv);
  el('import-status').textContent = 'Importing…';
  try {
    const r = await fetch(`${API}/races/${currentRace.id}/participants/import`, { method:'POST', body:fd });
    const d = await r.json();
    el('import-status').textContent = `Done: ${d.imported} imported, ${d.skipped} skipped.`;
    selectedCsv = null;
    el('btn-do-import').disabled = true;
    el('csv-upload-zone').classList.remove('has-file');
    el('csv-upload-text').textContent = '↑ Select CSV file';
    await reloadParticipants();
  } catch(e) { el('import-status').textContent = 'Error: ' + e.message; }
}

// ── Timing entry modal ────────────────────────────────────────────────────
function openTimingEntryModal() {
  if (!currentRace) return;
  // Populate participant select
  filterTimingParticipants();
  // Populate station select
  el('timing-station-select').innerHTML =
    '<option value="">— none —</option>' +
    stations.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  // Default time to now
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  el('timing-time').value = now.toISOString().slice(0,16);
  el('timing-modal').style.display = 'flex';
}

function filterTimingParticipants() {
  const q   = (el('timing-p-search')?.value || '').toLowerCase();
  const sel = el('timing-p-select');
  if (!sel) return;
  sel.innerHTML = participants
    .filter(p => !q || p.name.toLowerCase().includes(q) || String(p.bib).includes(q))
    .map(p=>`<option value="${p.id}">#${p.bib} — ${p.name}</option>`)
    .join('');
}

async function saveTimingEntry() {
  const pid = el('timing-p-select').value;
  const sid = el('timing-station-select').value;
  const typ = el('timing-event-type').value;
  const t   = new Date(el('timing-time').value).getTime();
  if (!typ || !t) { alert('Event type and time required.'); return; }
  await api('POST', `/races/${currentRace.id}/timing`, {
    participant_id: pid || null,
    station_id:     sid || null,
    event_type:     typ,
    event_time:     t,
    entered_by:     'operator',
  });
  closeModal('timing-modal');
  await reloadParticipants();
  await reloadTiming();
  log(`Manual timing: ${typ} @ ${fmt(t)}`, 'timing');
}

// ── Settings save ─────────────────────────────────────────────────────────
async function saveSetting(key, value) {
  if (!currentRace) return;
  await api('PUT', `/races/${currentRace.id}`, { [key]: value });
  currentRace[key] = value;
}

// ── Tab switching ─────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    const tabs = ['race','participants','timing'];
    b.classList.toggle('active', tabs[i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el('tab-' + name)?.classList.add('active');
  if (name === 'timing') reloadTiming();
}

function switchLogTab(name) {
  logTab = name;
  el('logtab-events').classList.toggle('active', name === 'events');
  el('logtab-alerts').classList.toggle('active', name === 'alerts');
  renderLog();
}

function filterParticipants() { renderParticipantList(); }

function clearLog() {
  if (logTab === 'events') eventLog.length = 0;
  else alertLog.length = 0;
  renderLog();
}

// ── Modal helpers ─────────────────────────────────────────────────────────
function closeModal(id) { el(id).style.display = 'none'; }

function openModal(id) { el(id).style.display = 'flex'; }

// Close modals on backdrop click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-bg')) e.target.style.display = 'none';
});

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  updateMqttTopicPreview();
  log('RaceTracker ready. Open RACES to begin.', 'info');
}

document.addEventListener('DOMContentLoaded', init);

// Public API
return {
  // Race
  openRaceModal, createRace, selectRace, deleteRace,
  activateRace, finishRace,
  // MQTT
  openMqttModal, saveMqttConfig, updateMqttTopicPreview,
  // Course
  openUploadModal, onFileSelected, doUpload, onCourseFileChange, onPathChange,
  // Stations
  addStationMode, cancelStationMode, openStationEditModal, openStationEditModal_byId,
  openStationsTable, saveStation, deleteStation,
  // Heats / Classes
  openHeatModal, saveHeat, deleteHeat,
  openClassModal, saveClass, deleteClass,
  // Participants
  openParticipantModal, saveParticipant, filterParticipants,
  openImportModal, onCsvSelected, doImport,
  setParticipantStatus,
  // Timing
  openTimingEntryModal, filterTimingParticipants, saveTimingEntry, deleteTimingEvent,
  // Info panel
  openInfoPanel, closeInfoPanel,
  // Map
  setBaseLayer,
  // Settings
  saveSetting,
  // UI
  switchTab, switchLogTab, clearLog, closeModal,
};

})();
