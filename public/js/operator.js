'use strict';
const OP = (() => {
// ── State ─────────────────────────────────────────────────────────────────────
let race = null, participants = {}, stations = [], heats = {}, classes = {};
let personnel = [], messages = [];
let markerLayer = null, routeLayer = null, stationMarkers = {}, trackPoints = null;
let leafletMap = null, currentBaseLayer = null, weatherLayersControl = null;
let sortBy = 'position', selectedPId = null, selectedStationId = null;
let alerts = [], rightTab = 'info';
let clockInterval = null, missingCheckInterval = null, stoppedCheckInterval = null;
let fmt24 = false;
let editingPId = null;

const BASE_LAYERS = {
  topo:      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  satellite: { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  osm:       { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ maxZoom:19, attribution:'© OSM' } },
  dark:      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts:{ subdomains:'abcd', maxZoom:19, attribution:'© CartoDB' } },
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const user = await RT.requireLogin('operator');
  if (!user) return;
  if (user.role === 'admin') {
    document.getElementById('admin-btn').classList.remove('hidden');
    document.getElementById('no-race-admin-btn').classList.remove('hidden');
  }
  fmt24 = false;

  initMap();
  RT.connectWS(handleWS);
  await loadInitialData();
  startClock();
  missingCheckInterval = setInterval(checkMissing, 30000);
  stoppedCheckInterval = setInterval(checkStopped, 60000);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function handleWS(msg) {
  const { type, data } = msg;
  if (type === 'init') handleInit(data);
  else if (type === 'position') handlePosition(data);
  else if (type === 'event') handleEvent(data);
  else if (type === 'alert') handleAlert(data);
  else if (type === 'message') handleMessage(data);
  else if (type === 'participant_update') handleParticipantUpdate(data);
  else if (type === 'station_update') handleStationUpdate(data);
  else if (type === 'mqtt_status') updateMqttPill(data);
  else if (type === 'aprs_status') updateAprsPill(data);
  else if (type === 'tracker_info') handleTrackerInfo(data);
}

function applyMessagingFlag() {
  const btn = document.querySelector('#right-panel .tab-btn[onclick*="\'msg\'"]');
  if (!btn) return;
  const enabled = race?.messaging_enabled;
  btn.style.display = enabled ? '' : 'none';
  if (!enabled && rightTab === 'msg') switchRightTab('info');
}

function handleInit(data) {
  if (!data.race) { updateRacePill(null); return; }
  race = data.race;
  fmt24 = race.time_format === '24h';
  updateRacePill(race);
  updateMqttPill(data.mqtt);
  if (data.aprs) updateAprsPill(data.aprs);
  applyMessagingFlag();

  heats = {}; (data.heats || []).forEach(h => heats[h.id] = h);
  classes = {}; (data.classes || []).forEach(c => classes[c.id] = c);
  stations = data.stations || [];

  participants = {};
  (data.participants || []).forEach(p => {
    participants[p.id] = enrichParticipant(p, data.registry || []);
  });

  if (data.trackPoints?.length) trackPoints = data.trackPoints;
  renderRoute();
  renderStationMarkers();
  renderAllMarkers();
  renderLeaderboard();
  renderPersonnelRecipients();
  updateStats();
  checkStationWarnings();
  if (!trackPoints) loadTrackData(); // fallback API fetch if WS didn't include track
  setupWeatherLayers(data.weatherKey);
}

async function loadInitialData() {
  const res = await RT.get('/api/races/active');
  if (!res.ok || !res.data) { updateRacePill(null); return; }
  race = res.data;
  fmt24 = race.time_format === '24h';
  updateRacePill(race);
  applyMessagingFlag();

  const [pr, sr, hr, cr, personnelR, msgR] = await Promise.all([
    RT.get(`/api/races/${race.id}/participants`),
    RT.get(`/api/races/${race.id}/stations`),
    RT.get(`/api/races/${race.id}/heats`),
    RT.get(`/api/races/${race.id}/classes`),
    RT.get(`/api/races/${race.id}/personnel`),
    RT.get(`/api/races/${race.id}/messages?limit=100`),
  ]);

  heats = {}; (hr.data || []).forEach(h => heats[h.id] = h);
  classes = {}; (cr.data || []).forEach(c => classes[c.id] = c);
  stations = sr.data || [];
  personnel = personnelR.data || [];
  messages = msgR.data || [];

  participants = {};
  (pr.data || []).forEach(p => { participants[p.id] = p; });

  renderRoute();
  renderStationMarkers();
  renderAllMarkers();
  renderLeaderboard();
  renderPersonnelRecipients();
  updateStats();
  checkStationWarnings();
  loadTrackData();
}

async function loadTrackData() {
  if (!race) return;
  const res = await RT.get(`/api/races/${race.id}/tracks/parse`);
  if (res.ok && res.data?.trackPoints) {
    trackPoints = res.data.trackPoints;
    document.getElementById('stat-dist').textContent = RT.fmtDist(res.data.totalDistance);
    renderRoute();
  }
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  leafletMap = L.map('map', { zoomControl: true, maxZoom: 18 });
  markerLayer = L.layerGroup().addTo(leafletMap);
  setBaseLayer('topo');
  leafletMap.setView([39.5, -98.5], 5);
  leafletMap.on('click', onMapClick);
}

function setBaseLayer(name) {
  if (currentBaseLayer) leafletMap.removeLayer(currentBaseLayer);
  const cfg = BASE_LAYERS[name] || BASE_LAYERS.topo;
  currentBaseLayer = L.tileLayer(cfg.url, cfg.opts).addTo(leafletMap);
  document.getElementById('base-layer-sel').value = name;
}

async function setupWeatherLayers(owmKey) {
  if (weatherLayersControl) { leafletMap.removeControl(weatherLayersControl); weatherLayersControl = null; }
  const overlays = {};
  try {
    const r = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const d = await r.json();
    const frame = d.radar?.past?.slice(-1)[0];
    if (frame) overlays['&#127783; Radar'] = L.tileLayer(
      `${d.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
      { opacity: 0.65, attribution: '<a href="https://rainviewer.com">RainViewer</a>', zIndex: 200, maxNativeZoom: 12 }
    );
  } catch {}
  if (owmKey) {
    const owm = (layer, opacity) => L.tileLayer(
      `https://tile.openweathermap.org/map/${layer}/{z}/{x}/{y}.png?appid=${owmKey}`,
      { opacity: opacity || 0.55, attribution: '© OpenWeatherMap', maxZoom: 19, zIndex: 200 }
    );
    overlays['&#127783; Precipitation'] = owm('precipitation_new');
    overlays['&#9729; Clouds']          = owm('clouds_new', 0.45);
    overlays['&#127790; Wind Speed']    = owm('wind_new');
    overlays['&#127777; Temperature']   = owm('temp_new', 0.5);
  }
  if (Object.keys(overlays).length) {
    weatherLayersControl = L.control.layers({}, overlays, { collapsed: true, position: 'bottomleft' }).addTo(leafletMap);
  }
}

function onMapClick(e) {
  // Allow admin to add stations by clicking the map (if shift-held)
  selectedPId = null;
  selectedStationId = null;
  renderLeaderboard();
}

function renderRoute() {
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (!trackPoints || trackPoints.length < 2) return;
  routeLayer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(leafletMap);
  if (!selectedPId) leafletMap.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

function renderStationMarkers() {
  Object.values(stationMarkers).forEach(m => leafletMap.removeLayer(m));
  stationMarkers = {};
  for (const s of stations) {
    const color = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                  s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' :
                  s.type === 'netcontrol' ? '#d2993a' : s.type === 'repeater' ? '#6e7681' : '#d2a679';
    const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                   s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' :
                   s.type === 'netcontrol' ? 'N' : s.type === 'repeater' ? 'R' : s.name[0]?.toUpperCase() || 'A';
    const icon = L.divIcon({
      html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:#000;font-family:'Courier New'">${letter}</div>`,
      className: '', iconAnchor: [11, 11],
    });
    const marker = L.marker([s.lat, s.lon], { icon })
      .addTo(leafletMap)
      .bindTooltip(s.name, { permanent: false, direction: 'top' });
    marker.on('click', () => showStationInfo(s.id));
    stationMarkers[s.id] = marker;
  }
}

// ── Participants / Markers ────────────────────────────────────────────────────
function enrichParticipant(p, registry) {
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const cls  = p.class_id ? classes[p.class_id] : null;
  const reg  = registry ? registry.find(r => r.node_id === p.tracker_id || r.long_name === p.tracker_id || r.short_name === p.tracker_id) : null;
  return { ...p, heat, class: cls, registry: reg };
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  for (const p of Object.values(participants)) {
    if (p.last_lat && p.last_lon) updateOrCreateMarker(p);
  }
}

function updateOrCreateMarker(p) {
  if (!p.last_lat || !p.last_lon) return;
  const now = Math.floor(Date.now() / 1000);
  const missingTimer = race?.missing_timer || 3600;
  const lastSeen = p.registry?.last_seen || p.last_seen || 0;
  const missing = lastSeen && (now - lastSeen) > missingTimer;
  const alerting = alerts.some(a => a.participantId === p.id);
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const { svg, cls } = RT.trackerIcon(heat, alerting, missing);

  const icon = L.divIcon({
    html: `<div class="${cls}" title="Bib ${p.bib}: ${p.name}">${svg}</div>`,
    className: 'leaflet-div-icon', iconAnchor: [10, 10],
  });

  const existing = markerLayer.getLayers().find(m => m._pid === p.id);
  if (existing) {
    existing.setLatLng([p.last_lat, p.last_lon]);
    existing.setIcon(icon);
  } else {
    const m = L.marker([p.last_lat, p.last_lon], { icon });
    m._pid = p.id;
    m.bindTooltip(`#${p.bib} ${p.name}`, { permanent: false });
    m.on('click', () => showParticipantInfo(p.id));
    m.addTo(markerLayer);
  }
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderLeaderboard() {
  const el = document.getElementById('leaderboard-body');
  if (!el) return;
  const list = Object.values(participants);
  list.forEach(p => {
    p._pct = computePercent(p);
    p._pace = computePace(p);
  });

  list.sort((a, b) => {
    if (sortBy === 'position') return (b._pct || 0) - (a._pct || 0);
    if (sortBy === 'bib') return String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true });
    if (sortBy === 'pace') return (a._pace || Infinity) - (b._pace || Infinity);
    if (sortBy === 'eta') return (a._eta || Infinity) - (b._eta || Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'heat') return (a.heat?.name || '').localeCompare(b.heat?.name || '');
    return 0;
  });

  el.innerHTML = list.map((p, i) => {
    const now = Math.floor(Date.now() / 1000);
    const missingTimer = race?.missing_timer || 3600;
    const lastSeen = p.registry?.last_seen || p.last_seen || 0;
    const missing = lastSeen && (now - lastSeen) > missingTimer;
    const alerting = alerts.some(a => a.participantId === p.id);
    const heat = p.heat_id ? heats[p.heat_id] : null;
    const dot = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '<span class="dot" style="background:var(--text3)"></span>';
    const sc = STATUS_COLORS[p.status] || 'var(--text3)';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const pace = p._pace ? RT.fmtSpeed(p._pace, race?.speed_units || 'min_mile') : '--';
    const bat = p.registry?.battery_level != null ? `${p.registry.battery_level}%` : '--';
    const rowCls = (alerting ? 'alert-row' : '') + (missing ? ' missing-row' : '') + (p.id === selectedPId ? ' selected' : '');
    return `<div class="lb-row ${rowCls}" onclick="OP.selectParticipant(${p.id})">
      <span style="color:var(--text3)">${i + 1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${dot} ${p.name}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text2)">${pace}</span>
      <span style="color:var(--text3);font-size:10px">${bat}</span>
    </div>`;
  }).join('');

  updateStats(list);
}

const STATUS_COLORS = { dns: '#484f58', active: '#58a6ff', dnf: '#f78166', finished: '#3fb950' };

function computePercent(p) {
  if (!p.last_lat || !p.last_lon || !trackPoints || !trackPoints.length) return null;
  let minD = Infinity, bestAlong = 0, totalDist = 0;
  const dists = [0];
  for (let i = 1; i < trackPoints.length; i++) {
    const d = haversine(trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]);
    totalDist += d; dists.push(totalDist);
  }
  if (totalDist === 0) return 0;
  for (let i = 0; i < trackPoints.length - 1; i++) {
    const [lat1, lon1] = trackPoints[i], [lat2, lon2] = trackPoints[i + 1];
    const segLen = dists[i + 1] - dists[i];
    const t = clamp01(dot2(p.last_lat - lat1, p.last_lon - lon1, lat2 - lat1, lon2 - lon1) /
      Math.max(1e-10, (lat2-lat1)**2 + (lon2-lon1)**2));
    const closeLat = lat1 + t*(lat2-lat1), closeLon = lon1 + t*(lon2-lon1);
    const d = haversine(p.last_lat, p.last_lon, closeLat, closeLon);
    if (d < minD) { minD = d; bestAlong = dists[i] + t * segLen; }
  }
  // For out-and-back: full race = 2x one-way track.
  // Outbound: 0–50%. Return leg (after turnaround): 50–100%.
  if (race?.race_format === 'out_and_back') {
    if (p.has_turnaround) return Math.min(100, (2 * totalDist - bestAlong) / (2 * totalDist) * 100);
    return Math.min(50, bestAlong / (2 * totalDist) * 100);
  }
  return Math.min(100, bestAlong / totalDist * 100);
}

function computePace(p) {
  if (!p.start_time || !p.last_lat) return null;
  const pct = p._pct;
  if (pct == null || !trackPoints) return null;
  const elapsed = Math.floor(Date.now() / 1000) - p.start_time;
  if (elapsed <= 0) return null;
  let totalDist = computeTotalDist();
  if (!totalDist) return null;
  if (race?.race_format === 'out_and_back') totalDist *= 2;
  return (pct / 100 * totalDist) / elapsed; // m/s
}

let _cachedTotalDist = null;
function computeTotalDist() {
  if (_cachedTotalDist) return _cachedTotalDist;
  if (!trackPoints || trackPoints.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < trackPoints.length; i++)
    d += haversine(trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]);
  _cachedTotalDist = d;
  return d;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function dot2(ax, ay, bx, by) { return ax*bx + ay*by; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function updateStats(list) {
  const ps = list || Object.values(participants);
  document.getElementById('stat-active').textContent   = ps.filter(p=>p.status==='active').length;
  document.getElementById('stat-finished').textContent = ps.filter(p=>p.status==='finished').length;
  document.getElementById('stat-dnf').textContent      = ps.filter(p=>p.status==='dnf').length;
  document.getElementById('stat-dns').textContent      = ps.filter(p=>p.status==='dns').length;
}

function setSort(key) {
  sortBy = key;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderLeaderboard();
}

// ── Participant selection / info ──────────────────────────────────────────────
function selectParticipant(id) {
  selectedPId = id;
  selectedStationId = null;
  renderLeaderboard();
  showParticipantInfo(id);
  switchRightTab('info');
  // Pan map to marker
  const p = participants[id];
  if (p?.last_lat && p?.last_lon) leafletMap.panTo([p.last_lat, p.last_lon]);
}

async function showParticipantInfo(id) {
  selectedPId = id;
  const res = await RT.get(`/api/races/${race.id}/participants/${id}`);
  if (!res.ok) return;
  const p = res.data;
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const cls  = p.class_id ? classes[p.class_id] : null;
  const reg  = p.tracker ? p.tracker : null;
  const sc = STATUS_COLORS[p.status] || 'var(--text3)';
  const pct = participants[id]?._pct;

  const el = document.getElementById('info-panel');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      ${heat ? RT.SHAPES[heat.shape]?.(heat.color, 20) || '' : ''}
      <span style="font-size:15px;font-weight:bold">#${p.bib} ${p.name}</span>
      <span class="badge" style="background:${sc}22;color:${sc}">${p.status?.toUpperCase()}</span>
      <button style="margin-left:auto;font-size:10px;padding:2px 8px" onclick="OP.openEditModal(${id})">EDIT</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div class="info-field"><span class="lbl">HEAT</span><span class="val">${heat?.name||'—'}</span></div>
      <div class="info-field"><span class="lbl">CLASS</span><span class="val">${cls?.name||'—'}</span></div>
      <div class="info-field"><span class="lbl">START</span><span class="val">${RT.fmtTime(p.start_time, fmt24)}</span></div>
      <div class="info-field"><span class="lbl">FINISH</span><span class="val">${RT.fmtTime(p.finish_time, fmt24)}</span></div>
      <div class="info-field"><span class="lbl">PROGRESS</span><span class="val text-accent">${pct != null ? pct.toFixed(1)+'%' : '—'}</span></div>
      <div class="info-field"><span class="lbl">BATTERY</span><span class="val">${reg?.battery_level != null ? reg.battery_level+'%' : '—'}</span></div>
      <div class="info-field"><span class="lbl">LAST SEEN</span><span class="val">${RT.timeAgo(reg?.last_seen)}</span></div>
      <div class="info-field"><span class="lbl">TRACKER</span><span class="val text-dim" style="font-size:10px">${p.tracker_id||'—'}</span></div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:8px;margin-bottom:8px">
      <div class="info-field"><span class="lbl">PHONE</span><span class="val">${p.phone||'—'}</span></div>
      <div class="info-field"><span class="lbl">EMERGENCY</span><span class="val">${p.emergency_contact||'—'}</span></div>
      ${p.age ? `<div class="info-field"><span class="lbl">AGE</span><span class="val">${p.age}</span></div>` : ''}
    </div>
    <div style="border-top:1px solid var(--border);padding-top:8px">
      <div style="font-size:10px;letter-spacing:2px;color:var(--text3);margin-bottom:6px">EVENT LOG</div>
      ${(p.events||[]).length === 0 ? '<div class="text-dim" style="font-size:11px">No events yet.</div>' :
        p.events.map(e => `
          <div class="log-entry">
            <span class="log-time">${RT.fmtTime(e.timestamp, fmt24)}</span>
            <span class="log-msg ${e.event_type==='finish'?'log-ok':e.event_type==='dnf'||e.event_type==='off_course'?'log-warn':''}">
              ${formatEventType(e.event_type)}${e.station_name ? ' @ ' + e.station_name : ''}
              ${e.notes ? ' — ' + e.notes : ''}
              ${e.manual ? ' <span class="text-dim">(manual)</span>' : ''}
            </span>
          </div>`).join('')}
    </div>`;
}

function formatEventType(t) {
  return { start:'START', aid_arrive:'ARRIVE', aid_depart:'DEPART', finish:'FINISH',
           dnf:'DNF', dns:'DNS', off_course:'OFF COURSE', stopped:'STOPPED', manual:'NOTE' }[t] || t;
}

function showStationInfo(id) {
  selectedStationId = id;
  selectedPId = null;
  const s = stations.find(x => x.id === id);
  if (!s) return;
  switchRightTab('info');

  RT.get(`/api/races/${race.id}/events?station_id=${id}&limit=50`).then(res => {
    const events = res.ok ? res.data : [];
    const stPersonnel = personnel.filter(p => p.station_id === id);
    const el = document.getElementById('info-panel');
    el.innerHTML = `
      <div style="margin-bottom:10px">
        <span style="font-size:14px;font-weight:bold;color:var(--accent4)">${s.name}</span>
        <span class="badge" style="color:var(--accent4);margin-left:6px">${s.type.toUpperCase()}</span>
        ${s.cutoff_time ? `<span class="text-dim" style="font-size:11px;margin-left:6px">Cutoff: ${s.cutoff_time}</span>` : ''}
      </div>
      <div style="font-size:10px;letter-spacing:2px;color:var(--text3);margin-bottom:6px">PERSONNEL (${stPersonnel.length})</div>
      ${stPersonnel.length ? stPersonnel.map(p =>
        `<div class="list-row" style="cursor:default">
          <span>${p.name}</span>
          ${p.tracker_id ? `<span class="text-dim" style="font-size:10px">${p.tracker_id}</span>` : ''}
          ${p.phone ? `<span class="text-dim" style="font-size:10px">${p.phone}</span>` : ''}
        </div>`).join('') : '<div class="text-dim" style="font-size:11px;margin-bottom:8px">None assigned.</div>'}
      <div style="font-size:10px;letter-spacing:2px;color:var(--text3);margin:8px 0 6px">ARRIVALS / DEPARTURES</div>
      ${events.length === 0 ? '<div class="text-dim" style="font-size:11px">No events yet.</div>' :
        events.map(e => `<div class="log-entry">
          <span class="log-time">${RT.fmtTime(e.timestamp, fmt24)}</span>
          <span class="log-msg ${e.event_type==='aid_arrive'||e.event_type==='start'?'log-info':''}">
            ${e.participant_name ? `#${e.bib} ${e.participant_name}` : '?'} — ${formatEventType(e.event_type)}
          </span>
        </div>`).join('')}`;
  });
}

// ── Edit Participant Modal ────────────────────────────────────────────────────
async function openEditModal(id) {
  editingPId = id;
  const p = participants[id];
  if (!p) return;

  // Populate heats dropdown
  const heatSel = document.getElementById('em-heat');
  heatSel.innerHTML = '<option value="">— none —</option>' +
    Object.values(heats).map(h => `<option value="${h.id}"${h.id===p.heat_id?' selected':''}>${h.name}</option>`).join('');
  const classSel = document.getElementById('em-class');
  classSel.innerHTML = '<option value="">— none —</option>' +
    Object.values(classes).map(c => `<option value="${c.id}"${c.id===p.class_id?' selected':''}>${c.name}</option>`).join('');
  const stationSel = document.getElementById('em-event-station');
  stationSel.innerHTML = '<option value="">— none —</option>' +
    stations.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  document.getElementById('em-bib').value       = p.bib;
  document.getElementById('em-name').value      = p.name;
  document.getElementById('em-status').value    = p.status || 'dns';
  document.getElementById('em-tracker').value   = p.tracker_id || '';
  document.getElementById('em-phone').value     = p.phone || '';
  document.getElementById('em-emergency').value = p.emergency_contact || '';
  document.getElementById('em-start').value     = p.start_time ? new Date(p.start_time * 1000).toTimeString().slice(0,8) : '';
  document.getElementById('em-finish').value    = p.finish_time ? new Date(p.finish_time * 1000).toTimeString().slice(0,8) : '';
  document.getElementById('em-event-type').value = '';
  document.getElementById('em-event-time').value = '';
  document.getElementById('em-notes').value      = '';
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function saveParticipant() {
  const id = editingPId;
  const body = {
    name:              document.getElementById('em-name').value.trim(),
    status:            document.getElementById('em-status').value,
    tracker_id:        document.getElementById('em-tracker').value.trim() || null,
    heat_id:           document.getElementById('em-heat').value || null,
    class_id:          document.getElementById('em-class').value || null,
    phone:             document.getElementById('em-phone').value.trim() || null,
    emergency_contact: document.getElementById('em-emergency').value.trim() || null,
  };

  // Parse optional time fields
  const startStr = document.getElementById('em-start').value.trim();
  const finishStr = document.getElementById('em-finish').value.trim();
  if (startStr) body.start_time = parseTimeToUnix(startStr);
  if (finishStr) body.finish_time = parseTimeToUnix(finishStr);

  const res = await RT.put(`/api/races/${race.id}/participants/${id}`, body);
  if (!res.ok) { RT.toast(res.error, 'warn'); return; }

  // Log manual event if selected
  const eventType = document.getElementById('em-event-type').value;
  if (eventType) {
    const stationId = document.getElementById('em-event-station').value || null;
    const notes = document.getElementById('em-notes').value.trim() || null;
    const evTimeStr = document.getElementById('em-event-time').value.trim();
    const ts = evTimeStr ? parseTimeToUnix(evTimeStr) : Math.floor(Date.now() / 1000);
    await RT.post(`/api/races/${race.id}/events`, { participant_id: id, event_type: eventType, station_id: stationId, timestamp: ts, notes });
  }

  document.getElementById('edit-modal').classList.add('hidden');
  participants[id] = { ...participants[id], ...res.data };
  updateOrCreateMarker(participants[id]);
  renderLeaderboard();
  showParticipantInfo(id);
  RT.toast('Saved', 'ok');
}

function parseTimeToUnix(str) {
  // Parse HH:MM:SS or HH:MM relative to today
  const today = new Date();
  const parts = str.split(':').map(Number);
  today.setHours(parts[0] || 0, parts[1] || 0, parts[2] || 0, 0);
  return Math.floor(today.getTime() / 1000);
}

// ── WS event handlers ─────────────────────────────────────────────────────────
function handlePosition(data) {
  const { nodeId, lat, lon, altitude, speed, battery, timestamp } = data;
  // Find participant
  const p = findParticipantByNode(nodeId);
  if (p) {
    p.last_lat = lat; p.last_lon = lon;
    if (!p.registry) p.registry = {};
    p.registry.last_seen = timestamp;
    if (battery != null) p.registry.battery_level = battery;
    p._pct = computePercent(p);
    p._pace = computePace(p);
    updateOrCreateMarker(p);
    if (p.id === selectedPId) showParticipantInfo(p.id);
  }
  renderLeaderboard();
}

function handleEvent(data) {
  appendEventLog(data);
  if (data.participantId && participants[data.participantId]) {
    const p = participants[data.participantId];
    if (data.event_type === 'start')  { p.status = 'active';   p.start_time  = data.timestamp; }
    if (data.event_type === 'finish') { p.status = 'finished'; p.finish_time = data.timestamp; }
    if (data.event_type === 'dnf')      p.status = 'dnf';
    if (data.has_turnaround)            p.has_turnaround = true;
    if (data.participantId === selectedPId) showParticipantInfo(data.participantId);
    renderLeaderboard();
  }
}

function handleAlert(data) {
  alerts.push({ ...data, id: Date.now() });
  renderLeaderboard();
  renderAlertsList();
  updateAlertCount();
  RT.toast(`ALERT: ${data.type.replace('_',' ')} — Bib ${data.bib} ${data.name}`, 'alert', 8000);
  // Update marker
  const p = participants[data.participantId];
  if (p) updateOrCreateMarker(p);
}

function handleMessage(data) {
  messages.unshift(data);
  renderMessages();
  if (data.direction === 'in') {
    const count = document.getElementById('msg-tab-count');
    const unread = messages.filter(m => m.direction === 'in' && !m.read).length;
    count.textContent = unread ? `(${unread})` : '';
    RT.toast(`MSG from ${data.from_name || data.from_node_id}: ${data.text}`, 'info', 6000);
  }
}

function handleParticipantUpdate(data) {
  if (data.action === 'add' || data.action === 'update') {
    participants[data.participant.id] = data.participant;
    updateOrCreateMarker(data.participant);
    renderLeaderboard();
  } else if (data.action === 'delete') {
    delete participants[data.id];
    renderLeaderboard();
  }
}

function handleStationUpdate(data) {
  if (data.action === 'add' || data.action === 'update') {
    const idx = stations.findIndex(s => s.id === data.station.id);
    if (idx >= 0) stations[idx] = data.station; else stations.push(data.station);
  } else if (data.action === 'delete') {
    stations = stations.filter(s => s.id !== data.id);
  }
  renderStationMarkers();
  checkStationWarnings();
}

function handleTrackerInfo(data) {
  const p = findParticipantByNode(data.nodeId);
  if (p) {
    if (!p.registry) p.registry = {};
    if (data.battery != null) p.registry.battery_level = data.battery;
    if (data.longName) p.registry.long_name = data.longName;
    p.registry.last_seen = data.timestamp;
    updateOrCreateMarker(p);
    renderLeaderboard();
  }
}

function updateMqttPill(status) {
  const pill = document.getElementById('mqtt-pill');
  if (!pill) return;
  pill.textContent = 'MQTT';
  if (status?.connected) pill.className = 'pill pill-ok pill-pulse';
  else if (status?.enabled) pill.className = 'pill pill-error';
  else pill.className = 'pill pill-idle';
}

function updateAprsPill(status) {
  const pill = document.getElementById('aprs-pill');
  if (!pill) return;
  pill.textContent = 'APRS';
  if (status?.connected) pill.className = 'pill pill-ok pill-pulse';
  else if (status?.enabled) pill.className = 'pill pill-error';
  else pill.className = 'pill pill-idle';
}

function updateRacePill(r) {
  const pill = document.getElementById('race-pill');
  const overlay = document.getElementById('no-race-overlay');
  if (!r) {
    pill.className = 'pill pill-idle';
    pill.textContent = 'NO RACE';
    if (overlay) overlay.style.display = 'flex';
    return;
  }
  pill.className = 'pill pill-ok';
  pill.textContent = r.name.toUpperCase();
  if (overlay) overlay.style.display = 'none';
}

function checkStationWarnings() {
  const bar = document.getElementById('setup-warning');
  const txt = document.getElementById('setup-warning-text');
  if (!bar || !txt || !race) { if (bar) bar.style.display = 'none'; return; }
  const isOutBack = race.race_format === 'out_and_back';
  const missing = [];
  if (isOutBack) {
    if (!stations.some(s => s.type === 'start_finish')) missing.push('START/FINISH');
    if (!stations.some(s => s.type === 'turnaround'))   missing.push('TURNAROUND');
  } else {
    if (!stations.some(s => s.type === 'start'))  missing.push('START');
    if (!stations.some(s => s.type === 'finish')) missing.push('FINISH');
  }
  if (missing.length) {
    txt.textContent = `No ${missing.join(' or ')} station defined — participants will not auto-transition status via geofence.`;
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function findParticipantByNode(nodeId) {
  return Object.values(participants).find(p =>
    p.tracker_id === nodeId ||
    (p.registry && (p.registry.long_name === nodeId || p.registry.short_name === nodeId))
  );
}

// ── Alerts panel ──────────────────────────────────────────────────────────────
function renderAlertsList() {
  const el = document.getElementById('alerts-list');
  if (!el) return;
  if (!alerts.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No active alerts.</div>'; return; }
  el.innerHTML = alerts.slice().reverse().map(a =>
    `<div class="alert-badge">
      <span style="font-size:18px">⚠</span>
      <div>
        <div style="font-weight:bold">${a.type?.replace('_',' ').toUpperCase()}</div>
        <div class="text-dim" style="font-size:10px">#${a.bib} ${a.name} · ${RT.fmtTime(a.timestamp, fmt24)}</div>
        ${a.distanceFromRoute ? `<div style="font-size:10px">${a.distanceFromRoute}m off course</div>` : ''}
      </div>
      <button style="margin-left:auto;font-size:10px;padding:2px 6px" onclick="OP.dismissAlert(${a.id})">✕</button>
    </div>`
  ).join('');
}

function dismissAlert(id) {
  alerts = alerts.filter(a => a.id !== id);
  renderAlertsList();
  updateAlertCount();
  renderLeaderboard();
  renderAllMarkers();
}

function updateAlertCount() {
  const cnt = document.getElementById('alert-count');
  const tabCnt = document.getElementById('alert-tab-count');
  if (alerts.length) {
    cnt.classList.remove('hidden');
    cnt.textContent = `${alerts.length} ALERT${alerts.length>1?'S':''}`;
    tabCnt.textContent = `(${alerts.length})`;
  } else {
    cnt.classList.add('hidden');
    tabCnt.textContent = '';
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────────
function renderPersonnelRecipients() {
  const sel = document.getElementById('msg-recipient');
  if (!sel) return;
  const msgPersonnel = personnel.filter(p => p.tracker_id);
  sel.innerHTML = '<option value="">Select recipient...</option>' +
    msgPersonnel.map(p =>
      `<option value="${p.tracker_id}" data-name="${p.name}">${p.name}${p.station_name?' @ '+p.station_name:''}</option>`
    ).join('');
  sel.addEventListener('change', () => renderMessages());
}

function renderMessages() {
  const sel = document.getElementById('msg-recipient');
  const nodeId = sel?.value;
  const el = document.getElementById('msg-thread');
  if (!el) return;
  const thread = nodeId
    ? messages.filter(m => m.from_node_id === nodeId || m.to_node_id === nodeId)
    : messages.slice(0, 30);
  el.innerHTML = thread.map(m => {
    const cls = m.direction === 'out' ? 'msg-bubble-out' : 'msg-bubble-in';
    const from = m.direction === 'in' ? (m.from_name || m.from_node_id) : 'You';
    return `<div class="${cls}" style="max-width:90%;font-size:11px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${from} · ${RT.fmtTime(m.timestamp, fmt24)}</div>
      <div>${m.text}</div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendMessage() {
  const sel = document.getElementById('msg-recipient');
  const to_node_id = sel?.value;
  const to_name = sel?.options[sel.selectedIndex]?.dataset.name;
  const text = document.getElementById('msg-text').value.trim();
  if (!to_node_id || !text) { RT.toast('Select a recipient and enter a message', 'warn'); return; }
  const res = await RT.post(`/api/races/${race.id}/messages`, { to_node_id, to_name, text });
  if (res.ok) {
    document.getElementById('msg-text').value = '';
    messages.unshift(res.data);
    renderMessages();
    if (!res.data.sent) RT.toast('Message saved but MQTT offline — not delivered', 'warn');
  } else RT.toast(res.error, 'warn');
}

// ── Event log ─────────────────────────────────────────────────────────────────
function appendEventLog(event) {
  const el = document.getElementById('event-log');
  if (!el) return;
  const type = event.event_type || '';
  const cls = type === 'finish' ? 'log-ok' : type === 'dnf' || type === 'off_course' ? 'log-warn' : type === 'start' ? 'log-info' : '';
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="log-time">${RT.fmtTime(event.timestamp, fmt24)}</span>
    <span class="log-msg ${cls}">
      ${event.participant_name ? `#${event.bib} ${event.participant_name}` : ''}
      — ${formatEventType(type)}
      ${event.station_name ? ' @ ' + event.station_name : ''}
      ${event.notes ? ' · ' + event.notes : ''}
    </span>`;
  el.insertBefore(div, el.firstChild);
}

// ── Missing / Stopped checks ──────────────────────────────────────────────────
function checkMissing() {
  if (!race || !race.feat_missing) return;
  const now = Math.floor(Date.now() / 1000);
  const missingTimer = race.missing_timer || 3600;
  for (const p of Object.values(participants)) {
    if (p.status !== 'active') continue;
    const lastSeen = p.registry?.last_seen || 0;
    if (lastSeen && (now - lastSeen) > missingTimer) {
      const key = `missing_${p.id}`;
      if (!alerts.find(a => a.key === key)) {
        alerts.push({ key, type: 'missing', participantId: p.id, bib: p.bib, name: p.name, timestamp: now, id: Date.now() });
        renderAlertsList();
        updateAlertCount();
        RT.toast(`MISSING: Bib ${p.bib} ${p.name} — no signal for ${Math.floor((now-lastSeen)/60)} min`, 'alert', 8000);
      }
    }
  }
  renderLeaderboard();
  renderAllMarkers();
}

function checkStopped() {
  if (!race || !race.feat_stopped) return;
  const now = Math.floor(Date.now() / 1000);
  const stoppedTime = race.stopped_time || 600;
  for (const p of Object.values(participants)) {
    if (p.status !== 'active') continue;
    const lastSeen = p.registry?.last_seen || 0;
    const lastSpeed = p.registry?.last_speed ?? null;
    // Only alert if we have recent signal but speed is 0 (or near 0) for stopped_time
    if (!lastSeen || (now - lastSeen) > stoppedTime * 3) continue; // signal too old — missing alert handles it
    if (lastSpeed !== null && lastSpeed < 0.5 && (now - lastSeen) > stoppedTime) {
      const key = `stopped_${p.id}`;
      if (!alerts.find(a => a.key === key)) {
        alerts.push({ key, type: 'stopped', participantId: p.id, bib: p.bib, name: p.name, timestamp: now, id: Date.now() });
        renderAlertsList();
        updateAlertCount();
        RT.toast(`STOPPED: Bib ${p.bib} ${p.name} — stationary for ${Math.floor((now-lastSeen)/60)} min`, 'alert', 8000);
      }
    } else {
      alerts = alerts.filter(a => a.key !== `stopped_${p.id}`);
    }
  }
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
  clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    if (!race) return;
    const now = Math.floor(Date.now() / 1000);
    const active = Object.values(participants).find(p => p.status === 'active' && p.start_time);
    const elapsed = active ? now - active.start_time : 0;
    document.getElementById('race-clock').textContent = RT.fmtElapsed(elapsed > 0 ? elapsed : 0);
  }, 1000);
}

// ── Right panel tabs ──────────────────────────────────────────────────────────
function switchRightTab(id) {
  rightTab = id;
  document.querySelectorAll('#right-panel .tab-btn').forEach((b, i) => {
    const ids = ['info','alerts','msg','log'];
    b.classList.toggle('active', ids[i] === id);
  });
  document.querySelectorAll('#right-panel .tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`right-tab-${id}`)?.classList.add('active');
  if (id === 'msg') renderMessages();
  if (id === 'alerts') renderAlertsList();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('edit-modal')?.classList.add('hidden');
});

init();

return { setBaseLayer, setSort, selectParticipant, switchRightTab, saveParticipant,
         openEditModal, sendMessage, dismissAlert };
})();
