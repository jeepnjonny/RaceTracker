'use strict';
const VW = (() => {
let race = null, participants = {}, stations = [], heats = {}, trackPoints = null;
let leafletMap, markerLayer, routeLayer, currentBaseLayer, stationMarkers = {};
let sortBy = 'position', clockInterval;
let fmt24 = false;
let mapMode = true; // vs leaderboard on mobile

const BASE_LAYERS = {
  topo:      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  satellite: { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  osm:       { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ maxZoom:19, attribution:'© OSM' } },
};

// Extract viewer token from URL: /view/:token
const token = location.pathname.split('/view/')[1]?.split('/')[0];

async function init() {
  if (!token) { document.body.innerHTML = '<div style="padding:40px;color:#f78166;font-family:monospace">Invalid viewer link.</div>'; return; }
  initMap();
  RT.connectWS(handleWS, token);
  startClock();
}

function initMap() {
  leafletMap = L.map('viewer-map', { zoomControl: true, maxZoom: 18 });
  markerLayer = L.layerGroup().addTo(leafletMap);
  currentBaseLayer = L.tileLayer(BASE_LAYERS.topo.url, BASE_LAYERS.topo.opts).addTo(leafletMap);
  leafletMap.setView([39.5, -98.5], 5);
}

function handleWS(msg) {
  const { type, data } = msg;
  if (type === 'init') handleInit(data);
  else if (type === 'position') handlePosition(data);
  else if (type === 'event') handleEvent(data);
  else if (type === 'participant_update') handleParticipantUpdate(data);
}

function handleInit(data) {
  if (!data.race) {
    document.getElementById('vw-race-pill').textContent = 'NO ACTIVE RACE';
    return;
  }
  race = data.race;
  fmt24 = race.time_format === '24h';
  document.getElementById('vw-race-pill').className = 'pill pill-ok';
  document.getElementById('vw-race-pill').textContent = race.name.toUpperCase();

  heats = {}; (data.heats || []).forEach(h => heats[h.id] = h);
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
}

function enrichParticipant(p, registry) {
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const reg = registry ? registry.find(r => r.node_id === p.tracker_id || r.long_name === p.tracker_id) : null;
  return { ...p, heat, registry: reg };
}

function renderRoute() {
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (!trackPoints || trackPoints.length < 2) return;
  routeLayer = L.polyline(trackPoints, { color: '#f5a623', weight: 5, opacity: 0.85 }).addTo(leafletMap);
  leafletMap.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
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
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;color:#000">${letter}</div>`,
      className: '', iconAnchor: [10, 10],
    });
    const m = L.marker([s.lat, s.lon], { icon }).bindTooltip(s.name).addTo(leafletMap);
    stationMarkers[s.id] = m;
  }
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  for (const p of Object.values(participants)) {
    if (p.last_lat && p.last_lon) createMarker(p);
  }
  // Auto-fit map to markers
  const pts = Object.values(participants).filter(p => p.last_lat);
  if (pts.length >= 2) {
    const bounds = L.latLngBounds(pts.map(p => [p.last_lat, p.last_lon]));
    leafletMap.fitBounds(bounds, { padding: [30, 30] });
  } else if (pts.length === 1) {
    leafletMap.setView([pts[0].last_lat, pts[0].last_lon], 14);
  }
}

function createMarker(p) {
  const heat = p.heat_id ? heats[p.heat_id] : null;
  const { svg } = RT.trackerIcon(heat, false, false);
  const icon = L.divIcon({ html: `<div title="#${p.bib} ${p.name}">${svg}</div>`, className: 'leaflet-div-icon', iconAnchor: [10, 10] });
  const m = L.marker([p.last_lat, p.last_lon], { icon });
  m._pid = p.id;
  m.bindTooltip(`#${p.bib} ${p.name}`, { permanent: false });
  m.addTo(markerLayer);
}

function handlePosition(data) {
  const { nodeId, lat, lon, timestamp } = data;
  const p = Object.values(participants).find(x => x.tracker_id === nodeId ||
    (x.registry && (x.registry.long_name === nodeId || x.registry.short_name === nodeId)));
  if (!p) return;
  p.last_lat = lat; p.last_lon = lon;
  if (!p.registry) p.registry = {};
  p.registry.last_seen = timestamp;
  // Update marker
  const existing = markerLayer.getLayers().find(m => m._pid === p.id);
  if (existing) existing.setLatLng([lat, lon]);
  else createMarker(p);
  renderLeaderboard();
}

function handleEvent(data) {
  const p = participants[data.participantId];
  if (!p) return;
  if (data.event_type === 'start')  p.status = 'active';
  if (data.event_type === 'finish') p.status = 'finished';
  if (data.event_type === 'dnf')    p.status = 'dnf';
  renderLeaderboard();
}

function handleParticipantUpdate(data) {
  if (data.action === 'delete') { delete participants[data.id]; renderLeaderboard(); return; }
  participants[data.participant.id] = enrichParticipant(data.participant, []);
  renderLeaderboard();
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderLeaderboard() {
  const el = document.getElementById('viewer-lb-body');
  if (!el) return;
  const list = Object.values(participants).filter(p => race?.leaderboard_enabled !== 0);
  list.forEach(p => { p._pct = computePct(p); });

  list.sort((a, b) => {
    if (sortBy === 'position') return (b._pct || 0) - (a._pct || 0);
    if (sortBy === 'bib') return String(a.bib).localeCompare(String(b.bib), undefined, { numeric: true });
    if (sortBy === 'pace') return (a._pace || Infinity) - (b._pace || Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'heat') return (a.heat?.name || '').localeCompare(b.heat?.name || '');
    return 0;
  });

  const STATUS_COLORS = { dns:'#484f58', active:'#58a6ff', dnf:'#f78166', finished:'#3fb950' };

  el.innerHTML = list.map((p, i) => {
    const sc = STATUS_COLORS[p.status] || '#484f58';
    const heat = p.heat_id ? heats[p.heat_id] : null;
    const dot = heat ? `<span class="dot" style="background:${heat.color}"></span>` : '';
    const pct = p._pct != null ? `${p._pct.toFixed(0)}%` : '--';
    const finished = p.status === 'finished';
    return `<div class="v-lb-row ${finished ? 'text-ok' : ''}">
      <span style="color:var(--text3)">${i+1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${dot} ${p.name}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text2);font-size:10px">${p._pct && p.start_time ? fmtPace(p) : '--'}</span>
    </div>`;
  }).join('');
}

function computePct(p) {
  // Without server-side calculation, derive from last_lat if trackPoints available
  if (!p.last_lat || !trackPoints || !trackPoints.length) return null;
  let minD = Infinity, best = 0, total = 0;
  const dists = [0];
  for (let i = 1; i < trackPoints.length; i++) {
    const d = haversine(trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]);
    total += d; dists.push(total);
  }
  for (let i = 0; i < trackPoints.length - 1; i++) {
    const [lat1,lon1] = trackPoints[i], [lat2,lon2] = trackPoints[i+1];
    const segLen = dists[i+1] - dists[i];
    const ax = p.last_lat - lat1, ay = p.last_lon - lon1, bx = lat2-lat1, by = lon2-lon1;
    const t = Math.max(0, Math.min(1, (ax*bx+ay*by)/Math.max(1e-10, bx*bx+by*by)));
    const d = haversine(p.last_lat, p.last_lon, lat1+t*bx, lon1+t*by);
    if (d < minD) { minD = d; best = (dists[i] + t*segLen) / total * 100; }
  }
  return Math.min(100, best);
}

function fmtPace(p) {
  if (!p.start_time || !p._pct) return '--';
  const elapsed = Math.floor(Date.now()/1000) - p.start_time;
  const total = computeTotal();
  if (!total || elapsed <= 0) return '--';
  const ms = (p._pct/100*total) / elapsed;
  return RT.fmtPace(ms);
}

let _total = null;
function computeTotal() {
  if (_total) return _total;
  if (!trackPoints || trackPoints.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < trackPoints.length; i++)
    d += haversine(trackPoints[i-1][0], trackPoints[i-1][1], trackPoints[i][0], trackPoints[i][1]);
  _total = d; return d;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function setSort(key) {
  sortBy = key;
  document.querySelectorAll('.v-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderLeaderboard();
}

function toggleView() {
  mapMode = !mapMode;
  document.body.classList.toggle('lb-mode', !mapMode);
  document.getElementById('vw-toggle-btn').textContent = mapMode ? 'LEADERBOARD' : 'MAP';
}

function startClock() {
  clockInterval = setInterval(() => {
    if (!race) return;
    const active = Object.values(participants).find(p => p.status === 'active' && p.start_time);
    if (!active) return;
    const elapsed = Math.floor(Date.now()/1000) - active.start_time;
    document.getElementById('vw-clock').textContent = RT.fmtElapsed(elapsed > 0 ? elapsed : 0);
  }, 1000);
}

init();
return { setSort, toggleView };
})();
