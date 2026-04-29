'use strict';
const VW = (() => {
let race = null, participants = {}, stations = [], heats = {}, trackPoints = null;
let leafletMap, markerLayer, routeLayer, stationMarkers = {};
let sortBy = 'position', clockInterval;
let fmt24 = false;
let mapMode = true; // vs leaderboard on mobile
let viewerLayersControl = null, viewerBaseTiles = null, currentViewerBaseLayer = null;
let viewerLegendControl = null, activeViewerOverlays = new Set();

const LAYER_LEGENDS = {
'Precipitation': { label:'PRECIP (mm/h)',    grad:'#c8e6fa,#64b4fa,#1464d2,#00be00,#fafa00,#fa8c32,#fa3232', ticks:['0.1','1','5','25','100','140'] },
  'Clouds':        { label:'CLOUD COVER',      grad:'rgba(255,255,255,0.15),#888888',                   ticks:['0%','50%','100%'] },
  'Wind Speed':    { label:'WIND (m/s)',        grad:'#ffffff,#64c8fa,#1464d2,#00be00,#fafa00,#fa6400,#fa0000', ticks:['0','5','15','25','50','200'] },
  'Temperature':   { label:'TEMPERATURE (°F)', grad:'#820eb4,#1464d2,#20e8e8,#28b428,#f0f032,#fa8c32,#fa3232', ticks:['-4','32','59','86','104'] },
};

const BASE_LAYERS = {
  'Topo':      { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  'Satellite': { url:'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts:{ maxZoom:16, maxNativeZoom:16, attribution:'USGS' } },
  'Street':    { url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ maxZoom:19, attribution:'© OSM' } },
  'Dark':      { url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts:{ subdomains:'abcd', maxZoom:19, attribution:'© CartoDB' } },
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
  leafletMap = L.map('viewer-map', { zoomControl: true, maxZoom: 16 });
  markerLayer = L.layerGroup().addTo(leafletMap);
  viewerBaseTiles = {};
  for (const [name, cfg] of Object.entries(BASE_LAYERS)) {
    viewerBaseTiles[name] = L.tileLayer(cfg.url, cfg.opts);
  }
  setViewerBaseLayer('Topo');
  leafletMap.setView([39.5, -98.5], 5);
  leafletMap.on('overlayadd',    e => { activeViewerOverlays.add(e.name);    updateViewerLegend(); });
  leafletMap.on('overlayremove', e => { activeViewerOverlays.delete(e.name); updateViewerLegend(); });
}

function setViewerBaseLayer(name) {
  if (currentViewerBaseLayer) leafletMap.removeLayer(currentViewerBaseLayer);
  currentViewerBaseLayer = viewerBaseTiles[name] || viewerBaseTiles['Topo'];
  currentViewerBaseLayer.addTo(leafletMap);
  const sel = document.getElementById('vw-base-layer-sel');
  if (sel) sel.value = name;
}

async function setupWeatherLayers(owmKey) {
  if (viewerLayersControl) { leafletMap.removeControl(viewerLayersControl); viewerLayersControl = null; }
  if (viewerLegendControl) { leafletMap.removeControl(viewerLegendControl); viewerLegendControl = null; }
  activeViewerOverlays.clear();

  const overlays = {};
  if (owmKey) {
    const owm = (layer, opacity) => L.tileLayer(
      `https://tile.openweathermap.org/map/${layer}/{z}/{x}/{y}.png?appid=${owmKey}`,
      { opacity: opacity || 0.55, attribution: '© OpenWeatherMap', maxZoom: 16, zIndex: 200 }
    );
    overlays['&#127783; Precipitation'] = owm('precipitation_new');
    overlays['&#9729; Clouds']          = owm('clouds_new', 0.45);
    overlays['&#127790; Wind Speed']    = owm('wind_new');
    overlays['&#127777; Temperature']   = owm('temp_new', 0.5);
  }
  if (Object.keys(overlays).length)
    viewerLayersControl = L.control.layers({}, overlays, { collapsed: true, position: 'topright' }).addTo(leafletMap);
  if (Object.keys(overlays).length) {
    viewerLegendControl = L.control({ position: 'bottomright' });
    viewerLegendControl.onAdd = () => {
      const div = L.DomUtil.create('div', '');
      div.id = 'vw-wx-legend';
      div.style.cssText = 'display:none;background:var(--surface,#161b22);border:1px solid var(--border,#30363d);border-radius:6px;padding:8px 10px;font-family:monospace;min-width:170px;pointer-events:none';
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    viewerLegendControl.addTo(leafletMap);
  }
}

function updateViewerLegend() {
  const div = document.getElementById('vw-wx-legend');
  if (!div) return;
  if (activeViewerOverlays.size === 0) { div.style.display = 'none'; return; }
  const name = [...activeViewerOverlays].at(-1);
  const key = Object.keys(LAYER_LEGENDS).find(k => name.includes(k));
  if (!key) { div.style.display = 'none'; return; }
  const spec = LAYER_LEGENDS[key];
  div.style.display = '';
  div.innerHTML = `
    <div style="font-size:10px;letter-spacing:1px;color:var(--text3,#7d8590);margin-bottom:4px">${spec.label}</div>
    <div style="height:8px;width:150px;border-radius:3px;background:linear-gradient(to right,${spec.grad});margin-bottom:3px"></div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2,#8b949e)">${spec.ticks.map(t=>`<span>${t}</span>`).join('')}</div>`;
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
  if (race.weather_enabled) setupWeatherLayers(data.weatherKey);
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
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:#000">${letter}</div>`,
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
  if (data.action === 'clear') { participants = {}; renderLeaderboard(); return; }
  if (!data.participant) return;
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
    return `<div class="v-lb-row v-lb-cols ${finished ? 'text-ok' : ''}">
      <span style="color:var(--text3)">${i+1}</span>
      <span style="color:${sc};font-weight:bold">${p.bib}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${dot} ${p.name}</span>
      <span style="color:var(--accent)">${pct}</span>
      <span style="color:var(--text2);font-size:11px">${p._pct && p.start_time ? fmtPace(p) : '--'}</span>
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
return { setSort, toggleView, setViewerBaseLayer };
})();
