'use strict';
const RF = (() => {

// ── State ──────────────────────────────────────────────────────────────────────
let leafletMap = null;
let heatLayer  = null;
let routeLayer = null;
let stationLayer = null;

let races        = [];
let currentRaceId = null;
let allPositions  = [];   // raw from API [{lat,lon,snr,rssi,rf_source,timestamp,node_id}]
let nodeSummary   = [];   // from /nodes endpoint
let summary       = {};   // per-source stats
let stationData   = [];   // station records for bounds calc
let routePoints   = [];   // [[lat,lon], ...] from track parse

let activeSources = new Set();  // which rf_source values are checked
let metric = 'density';         // 'density' | 'snr' | 'rssi'
let heatRadius  = 20;
let heatBlur    = 12;
let heatOpacity = 0.70;
let rightTab    = 'stats';

// Source metadata: color, display label, frequency string
const SOURCE_META = {
  meshtastic: { color: '#58a6ff', label: 'Meshtastic',  freq: '915 MHz LoRa' },
  aprs:       { color: '#3fb950', label: 'APRS',         freq: '144.390 MHz' },
  lora_aprs:  { color: '#d2a679', label: 'LoRa APRS',    freq: '915 MHz LoRa' },
};
function srcMeta(src) {
  return SOURCE_META[src] || { color: '#8b949e', label: src, freq: '' };
}

// Signal quality gradient (weak → strong): red → yellow → green → blue
const SIGNAL_GRADIENT = { 0.0: '#f85149', 0.35: '#ffa657', 0.55: '#fafa00', 0.75: '#3fb950', 1.0: '#58a6ff' };

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  const user = await RT.requireLogin('admin');
  if (!user) return;

  initMap();

  const res = await RT.get('/api/races');
  if (!res.ok) { RT.toast('Failed to load races', 'warn'); return; }
  races = res.data;

  const sel = document.getElementById('race-sel');
  sel.innerHTML = races.map(r =>
    `<option value="${r.id}">${r.name} (${r.date})${r.status==='active'?' ★':''}</option>`
  ).join('');

  // Honour ?race=ID from admin page, else default to active race
  const params = new URLSearchParams(window.location.search);
  const urlRace = params.get('race') ? parseInt(params.get('race')) : null;
  const active  = races.find(r => r.status === 'active');
  const target  = urlRace
    ? races.find(r => r.id === urlRace)
    : active;

  if (target) {
    sel.value = target.id;
    await selectRace(target.id);
  } else if (races.length) {
    sel.value = races[0].id;
    await selectRace(races[0].id);
  }
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
  stationData  = (stnRes.ok && stnRes.data?.length) ? stnRes.data : [];
  routePoints  = (trackRes.ok && trackRes.data?.trackPoints?.length)
    ? trackRes.data.trackPoints.map(([lat, lon]) => [lat, lon]) : [];

  // Build active sources from what's in the data
  const foundSources = new Set(allPositions.map(p => p.rf_source || 'meshtastic'));
  activeSources = new Set(foundSources);

  renderSourceList(foundSources);
  renderStats();
  renderNodeList();
  renderRawTable();
  renderHeatmap();

  // Route overlay
  if (routeLayer) { leafletMap.removeLayer(routeLayer); routeLayer = null; }
  if (routePoints.length) {
    routeLayer = L.polyline(routePoints, { color: '#58a6ff', weight: 2, opacity: 0.5 }).addTo(leafletMap);
  }

  // Station markers
  if (stationLayer) { leafletMap.removeLayer(stationLayer); stationLayer = null; }
  if (stationData.length) {
    stationLayer = L.layerGroup().addTo(leafletMap);
    for (const s of stationData) {
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

  fitMapToCourse();
}

// Fit map to the best available bounds: route > stations > positions
function fitMapToCourse() {
  const latLngs = [];

  if (routePoints.length) {
    latLngs.push(...routePoints);
  } else {
    // Fall back: stations then positions
    for (const s of stationData) {
      if (s.lat && s.lon) latLngs.push([s.lat, s.lon]);
    }
    for (const p of allPositions) {
      if (p.lat && p.lon) latLngs.push([p.lat, p.lon]);
    }
  }

  if (latLngs.length) {
    leafletMap.fitBounds(L.latLngBounds(latLngs).pad(0.08));
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
    <div class="ctrl-block">
      <div class="ctrl-title">Overall</div>
      <div class="stat-row"><span>Total packets</span><span class="stat-val">${total.toLocaleString()}</span></div>
      <div class="stat-row"><span>Unique nodes</span><span class="stat-val">${nodes}</span></div>
    </div>`;

  for (const [src, s] of Object.entries(summary)) {
    const m = srcMeta(src);
    let timeStr = '';
    if (s.first_ts && s.last_ts) {
      const dur = s.last_ts - s.first_ts;
      const h = Math.floor(dur / 3600), mn = Math.floor((dur % 3600) / 60);
      timeStr = h ? `${h}h ${mn}m` : `${mn}m`;
    }
    // Signal quality badge
    const snrColor  = snrQualityColor(s.avg_snr);
    const rssiColor = rssiQualityColor(s.avg_rssi);
    html += `
      <div class="ctrl-block">
        <div class="ctrl-title" style="color:${m.color}">${m.label}</div>
        <div class="stat-row"><span>Packets</span><span class="stat-val">${s.count.toLocaleString()}</span></div>
        <div class="stat-row"><span>Nodes</span><span class="stat-val">${s.node_count}</span></div>
        ${s.avg_snr  != null ? `<div class="stat-row"><span>Avg SNR</span><span class="stat-val" style="color:${snrColor}">${s.avg_snr} dB</span></div>` : ''}
        ${s.avg_rssi != null ? `<div class="stat-row"><span>Avg RSSI</span><span class="stat-val" style="color:${rssiColor}">${s.avg_rssi} dBm</span></div>` : ''}
        ${timeStr ? `<div class="stat-row"><span>Duration</span><span class="stat-val">${timeStr}</span></div>` : ''}
        ${s.avg_snr != null ? renderSignalBar(s.avg_snr, 'snr') : ''}
      </div>`;
  }
  el.innerHTML = html;
}

// Color coding for signal quality display
function snrQualityColor(snr) {
  if (snr == null) return 'var(--text3)';
  if (snr >= 5)   return '#58a6ff'; // excellent
  if (snr >= 0)   return '#3fb950'; // good
  if (snr >= -10) return '#fafa00'; // fair
  if (snr >= -15) return '#ffa657'; // poor
  return '#f85149';                  // very poor
}
function rssiQualityColor(rssi) {
  if (rssi == null) return 'var(--text3)';
  if (rssi >= -80)  return '#58a6ff'; // excellent
  if (rssi >= -100) return '#3fb950'; // good
  if (rssi >= -115) return '#fafa00'; // fair
  if (rssi >= -125) return '#ffa657'; // poor
  return '#f85149';                    // very poor
}

function renderSignalBar(snr, type) {
  // Normalize to 0..1 for the gradient bar width
  const norm = type === 'snr'
    ? Math.max(0, Math.min(1, (snr + 20) / 30))
    : Math.max(0, Math.min(1, (snr + 140) / 80));
  const pct = Math.round(norm * 100);
  return `
    <div style="margin-top:6px">
      <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:linear-gradient(to right,#f85149,#fafa00,#3fb950,#58a6ff);border-radius:3px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:2px">
        <span>Weak</span><span>Strong</span>
      </div>
    </div>`;
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
    const snrStr  = n.avg_snr  != null ? `SNR ${Math.round(n.avg_snr)} dB`   : '';
    const rssiStr = n.avg_rssi != null ? `RSSI ${Math.round(n.avg_rssi)} dBm` : '';
    const sigStr  = [snrStr, rssiStr].filter(Boolean).join('  ');
    const snrColor = snrQualityColor(n.avg_snr);
    return `
      <div class="node-row" title="${n.node_id}">
        <span class="src-dot" style="background:${m.color}"></span>
        <span class="node-name">${displayName}</span>
        <span class="node-pkt">${n.packet_count.toLocaleString()}</span>
      </div>
      ${sigStr ? `<div style="font-size:11px;color:${snrColor};padding:0 4px 4px 22px">${sigStr}</div>` : ''}`;
  }).join('');
}

// ── Raw data table ─────────────────────────────────────────────────────────────
function renderRawTable() {
  const tbody = document.getElementById('raw-tbody');
  if (!allPositions.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text3);padding:10px;text-align:center">No data</td></tr>';
    return;
  }

  // Show up to 500 most recent, filtered by active sources
  const filtered = [...allPositions]
    .filter(p => activeSources.has(p.rf_source || 'meshtastic'))
    .slice(-500)
    .reverse();

  tbody.innerHTML = filtered.map(p => {
    const src  = p.rf_source || 'meshtastic';
    const m    = srcMeta(src);
    const time = p.timestamp ? new Date(p.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const snrC = p.snr  != null ? `style="color:${snrQualityColor(p.snr)}"` : '';
    const rsiC = p.rssi != null ? `style="color:${rssiQualityColor(p.rssi)}"` : '';
    const node = p.node_id ? p.node_id.slice(-6) : '—';
    return `<tr>
      <td>${time}</td>
      <td><span style="color:${m.color}">${m.label.slice(0,4)}</span></td>
      <td title="${p.node_id||''}">${node}</td>
      <td>${p.lat?.toFixed(5) ?? '—'}</td>
      <td>${p.lon?.toFixed(5) ?? '—'}</td>
      <td ${snrC}>${p.snr  != null ? p.snr  + ' dB'  : '—'}</td>
      <td ${rsiC}>${p.rssi != null ? p.rssi + ' dBm' : '—'}</td>
    </tr>`;
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
      // -20..+10 dB → 0..1  (higher = better signal = more intense)
      intensity = Math.max(0, Math.min(1, (p.snr + 20) / 30));
    } else if (metric === 'rssi') {
      if (p.rssi == null) continue;
      // -140..-60 dBm → 0..1
      intensity = Math.max(0, Math.min(1, (p.rssi + 140) / 80));
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

  // Update signal legend visibility
  const legend = document.getElementById('signal-legend');
  if (metric !== 'density' && pts.length) {
    legend.classList.add('visible');
    const title = document.getElementById('legend-title');
    const minLbl = document.getElementById('legend-min');
    const maxLbl = document.getElementById('legend-max');
    if (metric === 'snr') {
      title.textContent = 'SNR';
      minLbl.textContent = '≤ −20 dB (poor)';
      maxLbl.textContent = '+10 dB (excellent)';
    } else {
      title.textContent = 'RSSI';
      minLbl.textContent = '≤ −140 dBm';
      maxLbl.textContent = '−60 dBm';
    }
  } else {
    legend.classList.remove('visible');
  }

  if (!pts.length) return;

  heatLayer = L.heatLayer(pts, {
    radius:     heatRadius,
    blur:       heatBlur,
    max:        metric === 'density' ? undefined : 1.0,
    minOpacity: 0.04,
    gradient:   metric !== 'density' ? SIGNAL_GRADIENT : undefined,
  }).addTo(leafletMap);

  // Apply opacity via the canvas element
  setTimeout(() => {
    const canvas = document.querySelector('.leaflet-heatmap-layer');
    if (canvas) canvas.style.opacity = heatOpacity;
  }, 50);
}

// ── Right panel tabs ───────────────────────────────────────────────────────────
function switchTab(id) {
  rightTab = id;
  ['stats', 'nodes', 'raw'].forEach(t => {
    document.getElementById(`rp-tab-${t}`)?.classList.toggle('active', t === id);
    document.getElementById(`rp-${t}`)?.style.setProperty('display', t === id ? '' : 'none');
  });
  if (id === 'raw') renderRawTable();
}

// ── Controls ───────────────────────────────────────────────────────────────────
function toggleSource(src, checked) {
  if (checked) activeSources.add(src);
  else activeSources.delete(src);
  renderHeatmap();
  if (rightTab === 'raw') renderRawTable();
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
  renderHeatmap();
}

function setBlur(val) {
  heatBlur = parseInt(val);
  document.getElementById('lbl-blur').textContent = val;
  renderHeatmap();
}

async function clearData() {
  if (!currentRaceId) return;
  const race = races.find(r => r.id === currentRaceId);
  if (!confirm(`Clear ALL RF position data for "${race?.name || currentRaceId}"?\n\nThis permanently deletes all stored tracker packets for this race. Participant results and events are not affected.`)) return;
  const res = await RT.del(`/api/races/${currentRaceId}/rf-analysis`);
  if (!res.ok) { RT.toast('Failed to clear data', 'warn'); return; }
  RT.toast(`Cleared ${res.data?.deleted ?? 0} records`, 'ok');
  // Reload
  await selectRace(currentRaceId);
}

function showLoading(on) {
  document.getElementById('loading-overlay').style.display = on ? 'flex' : 'none';
}

init();

return { selectRace, toggleSource, setMetric, setOpacity, setRadius, setBlur, clearData, switchTab };
})();
