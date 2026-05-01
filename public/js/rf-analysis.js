'use strict';
const RF = (() => {

// ── State ──────────────────────────────────────────────────────────────────────
let leafletMap = null;
let heatLayer  = null;
let routeLayer = null;
let stationLayer = null;

let races        = [];
let currentRaceId = null;
let allPositions  = [];   // raw from API [{lat,lon,snr,rssi,rf_source,timestamp}]
let nodeSummary   = [];   // from /nodes endpoint
let summary       = {};   // per-source stats

let activeSources = new Set();  // which rf_source values are checked
let metric = 'density';         // 'density' | 'snr' | 'rssi'
let heatRadius  = 25;
let heatBlur    = 15;
let heatOpacity = 0.70;

// Source metadata: color, display label, frequency string
const SOURCE_META = {
  meshtastic: { color: '#58a6ff', label: 'Meshtastic',  freq: '915 MHz LoRa' },
  aprs:       { color: '#3fb950', label: 'APRS',         freq: '144.390 MHz' },
  lora_aprs:  { color: '#d2a679', label: 'LoRa APRS',    freq: '915 MHz LoRa' },
};
function srcMeta(src) {
  return SOURCE_META[src] || { color: '#8b949e', label: src, freq: '' };
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  const user = await RT.requireLogin('admin');
  if (!user) return;

  RT.applyTheme(localStorage.getItem('rt-theme') || 'dark');
  const themeSel = document.getElementById('theme-sel');
  if (themeSel) themeSel.value = localStorage.getItem('rt-theme') || 'dark';

  initMap();

  const res = await RT.get('/api/races');
  if (!res.ok) { RT.toast('Failed to load races', 'warn'); return; }
  races = res.data;

  const sel = document.getElementById('race-sel');
  sel.innerHTML = races.map(r =>
    `<option value="${r.id}">${r.name} (${r.date})${r.status==='active'?' ★':''}</option>`
  ).join('');

  // Default to active race if one exists
  const active = races.find(r => r.status === 'active');
  if (active) { sel.value = active.id; await selectRace(active.id); }
  else if (races.length) { sel.value = races[0].id; await selectRace(races[0].id); }
}

// ── Map ────────────────────────────────────────────────────────────────────────
function initMap() {
  leafletMap = L.map('map', { zoomControl: true, maxZoom: 18 });
  L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS',
  }).addTo(leafletMap);
  leafletMap.setView([39.5, -98.5], 5);
}

// ── Race selection ─────────────────────────────────────────────────────────────
async function selectRace(raceId) {
  if (!raceId) return;
  currentRaceId = parseInt(raceId);
  showLoading(true);

  // Load positions + nodes in parallel, plus course/stations
  const [rfRes, nodeRes, stnRes, trackRes] = await Promise.all([
    RT.get(`/api/races/${raceId}/rf-analysis`),
    RT.get(`/api/races/${raceId}/rf-analysis/nodes`),
    RT.get(`/api/races/${raceId}/stations`),
    RT.get(`/api/races/${raceId}/tracks/parse`),
  ]);

  showLoading(false);

  if (!rfRes.ok) { RT.toast('Failed to load RF data', 'warn'); return; }

  allPositions = rfRes.data.positions || [];
  summary      = rfRes.data.summary   || {};
  nodeSummary  = nodeRes.ok ? nodeRes.data : [];

  // Build active sources from what's in the data
  const foundSources = new Set(allPositions.map(p => p.rf_source || 'meshtastic'));
  activeSources = new Set(foundSources);

  renderSourceList(foundSources);
  renderStats();
  renderNodeList();
  renderHeatmap();

  // Route overlay
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (trackRes.ok && trackRes.data?.trackPoints?.length) {
    const pts = trackRes.data.trackPoints.map(([lat, lon]) => [lat, lon]);
    routeLayer = L.polyline(pts, { color: '#58a6ff', weight: 2, opacity: 0.5 }).addTo(leafletMap);
  }

  // Station markers
  if (stationLayer) { leafletMap.removeLayer(stationLayer); stationLayer = null; }
  if (stnRes.ok && stnRes.data?.length) {
    stationLayer = L.layerGroup().addTo(leafletMap);
    for (const s of stnRes.data) {
      if (!s.lat || !s.lon) continue;
      const color = s.type === 'start' ? '#3fb950' : s.type === 'finish' ? '#f78166' :
                    s.type === 'start_finish' ? '#a371f7' : s.type === 'turnaround' ? '#58a6ff' : '#d2a679';
      const letter = s.type === 'start' ? 'S' : s.type === 'finish' ? 'F' :
                     s.type === 'start_finish' ? '⇌' : s.type === 'turnaround' ? 'T' : s.name[0]?.toUpperCase() || 'A';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2px solid #fff4;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#000;font-family:'Courier New'">${letter}</div>`,
          className: '', iconAnchor: [11, 11],
        }),
      }).bindTooltip(s.name).addTo(stationLayer);
    }
  }

  // Fit map to data
  const allPts = allPositions.filter(p => p.lat && p.lon);
  if (allPts.length) {
    leafletMap.fitBounds(L.latLngBounds(allPts.map(p => [p.lat, p.lon])).pad(0.1));
  }
}

// ── Source toggle list ─────────────────────────────────────────────────────────
function renderSourceList(foundSources) {
  const el = document.getElementById('src-list');
  if (!foundSources.size) {
    el.innerHTML = '<div class="text-dim" style="font-size:13px">No RF data for this race</div>';
    return;
  }
  el.innerHTML = [...foundSources].map(src => {
    const m = srcMeta(src);
    const s = summary[src] || {};
    return `
      <div class="src-row">
        <input type="checkbox" id="chk-${src}" checked onchange="RF.toggleSource('${src}', this.checked)">
        <span class="src-dot" style="background:${m.color}"></span>
        <label class="src-label" for="chk-${src}">
          <div style="font-size:14px">${m.label}</div>
          <div style="font-size:12px;color:var(--text3)">${m.freq}</div>
        </label>
        <span class="src-count">${(s.count||0).toLocaleString()}</span>
      </div>`;
  }).join('');
}

// ── Summary stats ──────────────────────────────────────────────────────────────
function renderStats() {
  const el = document.getElementById('stats-body');
  if (!Object.keys(summary).length) {
    el.innerHTML = '<span class="text-dim" style="font-size:13px">No data</span>';
    return;
  }
  const total = Object.values(summary).reduce((a, s) => a + s.count, 0);
  const nodes = Object.values(summary).reduce((a, s) => a + s.node_count, 0);

  let html = `
    <div class="stat-row"><span>Total packets</span><span class="stat-val">${total.toLocaleString()}</span></div>
    <div class="stat-row"><span>Unique nodes</span><span class="stat-val">${nodes}</span></div>`;

  for (const [src, s] of Object.entries(summary)) {
    const m = srcMeta(src);
    // Time range
    let timeStr = '';
    if (s.first_ts && s.last_ts) {
      const dur = s.last_ts - s.first_ts;
      const h = Math.floor(dur / 3600), mn = Math.floor((dur % 3600) / 60);
      timeStr = h ? `${h}h ${mn}m` : `${mn}m`;
    }
    html += `
      <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border)">
        <div style="font-size:12px;color:${m.color};letter-spacing:1px;margin-bottom:4px">${m.label.toUpperCase()}</div>
        <div class="stat-row"><span>Packets</span><span class="stat-val">${s.count.toLocaleString()}</span></div>
        <div class="stat-row"><span>Nodes</span><span class="stat-val">${s.node_count}</span></div>
        ${s.avg_snr  != null ? `<div class="stat-row"><span>Avg SNR</span><span class="stat-val">${s.avg_snr} dB</span></div>` : ''}
        ${s.avg_rssi != null ? `<div class="stat-row"><span>Avg RSSI</span><span class="stat-val">${s.avg_rssi} dBm</span></div>` : ''}
        ${timeStr ? `<div class="stat-row"><span>Duration</span><span class="stat-val">${timeStr}</span></div>` : ''}
      </div>`;
  }
  el.innerHTML = html;
}

// ── Node list ──────────────────────────────────────────────────────────────────
function renderNodeList() {
  const el = document.getElementById('node-list');
  if (!nodeSummary.length) {
    el.innerHTML = '<span class="text-dim" style="font-size:13px">No data</span>';
    return;
  }
  el.innerHTML = nodeSummary.map(n => {
    const m = srcMeta(n.rf_source);
    const displayName = n.participant_name
      ? `#${n.bib} ${n.participant_name}`
      : (n.long_name || n.short_name || n.node_id);
    const snrStr  = n.avg_snr  != null ? `${Math.round(n.avg_snr)} dB`  : '';
    const rssiStr = n.avg_rssi != null ? `${Math.round(n.avg_rssi)} dBm` : '';
    const sigStr  = [snrStr, rssiStr].filter(Boolean).join(' / ');
    return `
      <div class="node-row" title="${n.node_id}">
        <span class="src-dot" style="background:${m.color}"></span>
        <span class="node-name">${displayName}</span>
        <span class="node-pkt">${n.packet_count.toLocaleString()}</span>
      </div>
      ${sigStr ? `<div style="font-size:11px;color:var(--text3);padding:0 4px 4px 22px">${sigStr}</div>` : ''}`;
  }).join('');
}

// ── Heatmap rendering ──────────────────────────────────────────────────────────
function buildHeatPoints() {
  const pts = [];
  for (const p of allPositions) {
    if (!activeSources.has(p.rf_source || 'meshtastic')) continue;
    let intensity;
    if (metric === 'snr') {
      if (p.snr == null) continue;
      intensity = Math.max(0, Math.min(1, (p.snr + 20) / 30)); // -20..+10 dB → 0..1
    } else if (metric === 'rssi') {
      if (p.rssi == null) continue;
      intensity = Math.max(0, Math.min(1, (p.rssi + 140) / 80)); // -140..-60 dBm → 0..1
    } else {
      intensity = 1; // density: uniform weight, let kernel do the work
    }
    pts.push([p.lat, p.lon, intensity]);
  }
  return pts;
}

function renderHeatmap() {
  if (heatLayer) { leafletMap.removeLayer(heatLayer); heatLayer = null; }
  const pts = buildHeatPoints();
  if (!pts.length) return;
  heatLayer = L.heatLayer(pts, {
    radius: heatRadius,
    blur:   heatBlur,
    max:    metric === 'density' ? undefined : 1.0,
    minOpacity: 0.05,
    gradient: metric === 'rssi' || metric === 'snr'
      ? { 0.0: '#0d1117', 0.3: '#1464d2', 0.6: '#3fb950', 0.85: '#fafa00', 1.0: '#f85149' }
      : undefined, // use leaflet-heat default for density
  }).addTo(leafletMap);
  heatLayer.setLatLngs(pts); // re-apply opacity via pane
  // Apply opacity via the canvas element
  setTimeout(() => {
    const canvas = document.querySelector('.leaflet-heatmap-layer');
    if (canvas) canvas.style.opacity = heatOpacity;
  }, 50);
}

// ── Controls ───────────────────────────────────────────────────────────────────
function toggleSource(src, checked) {
  if (checked) activeSources.add(src);
  else activeSources.delete(src);
  renderHeatmap();
}

function setMetric(m) {
  metric = m;
  ['density','snr','rssi'].forEach(id => {
    document.getElementById('btn-' + id)?.classList.toggle('active', id === m);
  });
  renderHeatmap();
}

function setOpacity(val) {
  heatOpacity = val / 100;
  document.getElementById('lbl-opacity').textContent = val + '%';
  const canvas = document.querySelector('.leaflet-heatmap-layer');
  if (canvas) canvas.style.opacity = heatOpacity;
}

function setRadius(val) {
  heatRadius = parseInt(val);
  document.getElementById('lbl-radius').textContent = val;
  rebuildHeatLayer();
}

function setBlur(val) {
  heatBlur = parseInt(val);
  document.getElementById('lbl-blur').textContent = val;
  rebuildHeatLayer();
}

function rebuildHeatLayer() {
  if (!allPositions.length) return;
  renderHeatmap();
}

function showLoading(on) {
  document.getElementById('loading-overlay').style.display = on ? 'flex' : 'none';
}

init();

return { selectRace, toggleSource, setMetric, setOpacity, setRadius, setBlur };
})();
