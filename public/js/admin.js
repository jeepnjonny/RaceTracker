'use strict';
let currentUser = null;
let races = [], activeRaceId = null;
let editingRaceId = null, editingUserId = null, editingHeatId = null;
let selectedRaceId = null; // race being configured in sub-tabs

const TABS = [
  { id: 'races',     label: 'RACES' },
  { id: 'heats',     label: 'HEATS/CLASSES' },
  { id: 'stations',  label: 'STATIONS' },
  { id: 'personnel', label: 'PERSONNEL' },
  { id: 'infra',     label: 'INFRASTRUCTURE' },
  { id: 'users',     label: 'USERS' },
  { id: 'settings',  label: 'SETTINGS' },
];
let currentTab = 'races';

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  currentUser = await RT.requireLogin('admin');
  if (!currentUser) return;

  buildTabs();
  RT.connectWS(handleWS);
  await loadRaces();
  showTab('races');
}

function buildTabs() {
  const wrap = document.getElementById('admin-tabs');
  wrap.innerHTML = TABS.map(t =>
    `<button class="admin-tab${t.id===currentTab?' active':''}" onclick="showTab('${t.id}')">${t.label}</button>`
  ).join('');
}

function showTab(id) {
  currentTab = id;
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.textContent === TABS.find(t=>t.id===id)?.label));
  renderTab();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function handleWS(msg) {
  if (msg.type === 'mqtt_status') updateMqttPill(msg.data);
  if (msg.type === 'tracker_info') refreshInfra();
  if (msg.type === 'init') {
    if (msg.data.mqtt) updateMqttPill(msg.data.mqtt);
  }
}

function updateMqttPill(status) {
  const pill = document.getElementById('mqtt-pill');
  if (status.connected) {
    pill.className = 'pill pill-ok pill-pulse';
    pill.textContent = 'MQTT LIVE';
  } else {
    pill.className = 'pill pill-error';
    pill.textContent = 'MQTT OFFLINE';
  }
}

// ── Races ─────────────────────────────────────────────────────────────────────
async function loadRaces() {
  const res = await RT.get('/api/races');
  if (!res.ok) return;
  races = res.data;
  const active = races.find(r => r.status === 'active');
  activeRaceId = active?.id || null;
  if (!selectedRaceId && races.length) selectedRaceId = races[0].id;
  document.getElementById('active-race-pill').textContent = active ? active.name.toUpperCase() : 'NO ACTIVE RACE';
  document.getElementById('active-race-pill').className = active ? 'pill pill-ok' : 'pill pill-idle';
}

function renderTab() {
  const el = document.getElementById('admin-content');
  switch (currentTab) {
    case 'races':     el.innerHTML = renderRacesTab(); bindRacesTab(); break;
    case 'heats':     el.innerHTML = renderHeatsTab(); bindHeatsTab(); break;
    case 'stations':  el.innerHTML = renderStationsTab(); bindStationsTab(); break;
    case 'personnel': el.innerHTML = renderPersonnelTab(); bindPersonnelTab(); break;
    case 'infra':     el.innerHTML = renderInfraTab(); refreshInfra(); break;
    case 'users':     el.innerHTML = renderUsersTab(); loadUsers(); break;
    case 'settings':  el.innerHTML = renderSettingsTab(); bindSettingsTab(); break;
  }
}

function renderRacesTab() {
  return `
  <div class="card">
    <h3>RACE MANAGEMENT</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openRaceModal()">+ NEW RACE</button>
    </div>
    <div id="race-list"></div>
  </div>`;
}

function bindRacesTab() {
  renderRaceList();
}

function renderRaceList() {
  const el = document.getElementById('race-list');
  if (!el) return;
  if (!races.length) { el.innerHTML = '<div class="text-dim" style="padding:12px;font-size:12px">No races yet.</div>'; return; }
  el.innerHTML = races.map(r => `
    <div class="race-card ${r.status==='active'?'active-race':''}" onclick="selectRace(${r.id})">
      <div style="flex:1">
        <div style="font-weight:bold;color:${r.status==='active'?'var(--accent2)':'var(--text)'}">${r.name}</div>
        <div class="text-dim" style="font-size:10px">${r.date} · ${r.participant_count||0} participants</div>
      </div>
      <span class="badge" style="background:${r.status==='active'?'#3fb95022':r.status==='past'?'#48505822':'#58a6ff22'};color:${r.status==='active'?'var(--accent2)':r.status==='past'?'var(--text3)':'var(--accent)'}">${r.status.toUpperCase()}</span>
      <div style="display:flex;gap:4px">
        ${r.status!=='active'?`<button onclick="event.stopPropagation();activateRace(${r.id})" class="success" style="font-size:10px;padding:3px 8px">ACTIVATE</button>`:''}
        ${r.status==='active'?`<button onclick="event.stopPropagation();deactivateRace(${r.id})" class="danger" style="font-size:10px;padding:3px 8px">DEACTIVATE</button>`:''}
        <button onclick="event.stopPropagation();openRaceModal(${r.id})" style="font-size:10px;padding:3px 8px">EDIT</button>
        <button onclick="event.stopPropagation();cloneRace(${r.id})" style="font-size:10px;padding:3px 8px">CLONE</button>
        ${r.viewer_token?`<button onclick="event.stopPropagation();copyViewerLink('${r.viewer_token}')" style="font-size:10px;padding:3px 8px;color:var(--accent4)">VIEWER LINK</button>
         <button onclick="event.stopPropagation();revokeViewerToken(${r.id})" class="danger" style="font-size:10px;padding:3px 8px">REVOKE</button>`
         :`<button onclick="event.stopPropagation();genViewerToken(${r.id})" style="font-size:10px;padding:3px 8px">GEN VIEWER</button>`}
        ${r.status!=='active'?`<button onclick="event.stopPropagation();deleteRace(${r.id})" class="danger" style="font-size:10px;padding:3px 8px">DEL</button>`:''}
      </div>
    </div>
  `).join('');
}

function selectRace(id) {
  selectedRaceId = id;
  renderTab();
}

async function activateRace(id) {
  if (!confirm('Activate this race? The current active race (if any) will be set to past.')) return;
  const res = await RT.post(`/api/races/${id}/activate`);
  if (res.ok) { RT.toast('Race activated', 'ok'); await loadRaces(); renderTab(); }
  else RT.toast(res.error, 'warn');
}

async function deactivateRace(id) {
  if (!confirm('Deactivate this race?')) return;
  const res = await RT.post(`/api/races/${id}/deactivate`);
  if (res.ok) { RT.toast('Race deactivated', 'ok'); await loadRaces(); renderTab(); }
}

async function deleteRace(id) {
  if (!confirm('Delete this race and all its data? This cannot be undone.')) return;
  const res = await RT.del(`/api/races/${id}`);
  if (res.ok) { RT.toast('Race deleted', 'ok'); await loadRaces(); renderTab(); }
  else RT.toast(res.error, 'warn');
}

async function genViewerToken(id) {
  const res = await RT.post(`/api/races/${id}/viewer-token`);
  if (res.ok) {
    await loadRaces(); renderTab();
    copyViewerLink(res.data.token);
  }
}

function copyViewerLink(token) {
  const url = `${location.origin}${RT.BASE}view/${token}`;
  navigator.clipboard.writeText(url).then(() => RT.toast('Viewer URL copied to clipboard', 'ok'));
}

async function revokeViewerToken(id) {
  if (!confirm('Revoke viewer link? Existing users will lose access.')) return;
  await RT.del(`/api/races/${id}/viewer-token`);
  await loadRaces(); renderTab();
}

async function cloneRace(id) {
  const src = races.find(r => r.id === id);
  const name = prompt(`Clone "${src.name}" — enter new race name:`, src.name + ' (Copy)');
  if (!name) return;
  const date = prompt('New race date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
  if (!date) return;
  const res = await RT.post(`/api/races/${id}/clone`, { name, date });
  if (res.ok) { RT.toast('Race cloned', 'ok'); await loadRaces(); renderTab(); }
  else RT.toast(res.error, 'warn');
}

// ── Race Modal ────────────────────────────────────────────────────────────────
function openRaceModal(id) {
  editingRaceId = id || null;
  const race = id ? races.find(r => r.id === id) : null;
  document.getElementById('race-modal-title').textContent = id ? 'EDIT RACE' : 'NEW RACE';
  document.getElementById('rm-name').value           = race?.name || '';
  document.getElementById('rm-date').value           = race?.date || new Date().toISOString().split('T')[0];
  document.getElementById('rm-mqtt-host').value      = race?.mqtt_host || 'apps.k7swi.org';
  document.getElementById('rm-mqtt-port-ws').value   = race?.mqtt_port_ws || 9001;
  document.getElementById('rm-mqtt-user').value      = race?.mqtt_user || 'racetracker';
  document.getElementById('rm-mqtt-pass').value      = race?.mqtt_pass || 'racetracker';
  document.getElementById('rm-mqtt-region').value    = race?.mqtt_region || 'US';
  document.getElementById('rm-mqtt-channel').value   = race?.mqtt_channel || 'RaceTracker';
  document.getElementById('rm-mqtt-format').value    = race?.mqtt_format || 'json';
  document.getElementById('rm-mqtt-psk').value       = race?.mqtt_psk || 'AQ==';
  document.getElementById('rm-time-format').value    = race?.time_format || '24h';
  document.getElementById('rm-missing-timer').value  = Math.round((race?.missing_timer || 3600) / 60);
  document.getElementById('rm-geofence').value       = race?.geofence_radius || 15;
  document.getElementById('rm-off-course').value     = race?.off_course_distance || 100;
  document.getElementById('rm-stopped').value        = Math.round((race?.stopped_time || 600) / 60);
  document.getElementById('rm-alerts').checked       = !!(race?.alerts_enabled ?? 1);
  document.getElementById('rm-messaging').checked    = !!(race?.messaging_enabled);
  document.getElementById('rm-viewer-map').checked   = !!(race?.viewer_map_enabled ?? 1);
  document.getElementById('rm-leaderboard').checked  = !!(race?.leaderboard_enabled ?? 1);
  document.getElementById('rm-weather').checked      = !!(race?.weather_enabled);
  document.getElementById('race-modal').classList.remove('hidden');
}

async function saveRace() {
  const body = {
    name:                document.getElementById('rm-name').value.trim(),
    date:                document.getElementById('rm-date').value,
    mqtt_host:           document.getElementById('rm-mqtt-host').value.trim(),
    mqtt_port_ws:        parseInt(document.getElementById('rm-mqtt-port-ws').value),
    mqtt_user:           document.getElementById('rm-mqtt-user').value.trim(),
    mqtt_pass:           document.getElementById('rm-mqtt-pass').value,
    mqtt_region:         document.getElementById('rm-mqtt-region').value.trim(),
    mqtt_channel:        document.getElementById('rm-mqtt-channel').value.trim(),
    mqtt_format:         document.getElementById('rm-mqtt-format').value,
    mqtt_psk:            document.getElementById('rm-mqtt-psk').value.trim(),
    time_format:         document.getElementById('rm-time-format').value,
    missing_timer:       parseInt(document.getElementById('rm-missing-timer').value) * 60,
    geofence_radius:     parseInt(document.getElementById('rm-geofence').value),
    off_course_distance: parseInt(document.getElementById('rm-off-course').value),
    stopped_time:        parseInt(document.getElementById('rm-stopped').value) * 60,
    alerts_enabled:      document.getElementById('rm-alerts').checked ? 1 : 0,
    messaging_enabled:   document.getElementById('rm-messaging').checked ? 1 : 0,
    viewer_map_enabled:  document.getElementById('rm-viewer-map').checked ? 1 : 0,
    leaderboard_enabled: document.getElementById('rm-leaderboard').checked ? 1 : 0,
    weather_enabled:     document.getElementById('rm-weather').checked ? 1 : 0,
  };
  if (!body.name || !body.date) { RT.toast('Name and date required', 'warn'); return; }
  const res = editingRaceId
    ? await RT.put(`/api/races/${editingRaceId}`, body)
    : await RT.post('/api/races', body);
  if (res.ok) {
    closeModal('race-modal');
    if (!editingRaceId && res.data?.id) {
      selectedRaceId = res.data.id;
      await loadRaces();
      showTab('stations');
      RT.toast('Race created — set up track and aid stations below', 'ok');
    } else {
      RT.toast('Race updated', 'ok');
      await loadRaces(); renderTab();
    }
  } else RT.toast(res.error, 'warn');
}

// ── Heats / Classes ───────────────────────────────────────────────────────────
let heats = [], classes = [];

function renderHeatsTab() {
  const opts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name} (${r.date})</option>`).join('');
  return `
  <div class="card">
    <h3>SELECT RACE</h3>
    <select id="hc-race-sel" onchange="selectedRaceId=parseInt(this.value);loadHeatsClasses()">${opts}</select>
  </div>
  <div class="card">
    <h3>HEATS <span class="text-dim">(groups with icon/color)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="openHeatModal()">+ ADD HEAT</button>
    </div>
    <div id="heats-list"></div>
  </div>
  <div class="card">
    <h3>CLASSES <span class="text-dim">(e.g. age groups, gender)</span></h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input id="new-class-name" placeholder="Class name (e.g. M30-39)" style="width:200px">
      <button class="primary" onclick="addClass()">+ ADD</button>
    </div>
    <div id="classes-list"></div>
  </div>`;
}

async function bindHeatsTab() { await loadHeatsClasses(); }

async function loadHeatsClasses() {
  if (!selectedRaceId) return;
  const [hr, cr] = await Promise.all([
    RT.get(`/api/races/${selectedRaceId}/heats`),
    RT.get(`/api/races/${selectedRaceId}/classes`),
  ]);
  heats = hr.ok ? hr.data : [];
  classes = cr.ok ? cr.data : [];
  renderHeatsList();
  renderClassesList();
}

function renderHeatsList() {
  const el = document.getElementById('heats-list');
  if (!el) return;
  if (!heats.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No heats defined.</div>'; return; }
  el.innerHTML = `<table class="data-table"><thead><tr><th>NAME</th><th>COLOR</th><th>SHAPE</th><th>ICON</th><th></th></tr></thead><tbody>
    ${heats.map(h => `<tr>
      <td>${h.name}</td>
      <td><span style="color:${h.color}">${h.color}</span></td>
      <td>${h.shape}</td>
      <td>${RT.SHAPES[h.shape]?.(h.color, 18) || ''}</td>
      <td style="text-align:right">
        <button style="font-size:10px;padding:2px 8px" onclick="openHeatModal(${h.id})">EDIT</button>
        <button class="danger" style="font-size:10px;padding:2px 8px" onclick="deleteHeat(${h.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

function renderClassesList() {
  const el = document.getElementById('classes-list');
  if (!el) return;
  if (!classes.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No classes defined.</div>'; return; }
  el.innerHTML = `<table class="data-table"><thead><tr><th>NAME</th><th></th></tr></thead><tbody>
    ${classes.map(c => `<tr><td>${c.name}</td><td style="text-align:right">
      <button class="danger" style="font-size:10px;padding:2px 8px" onclick="deleteClass(${c.id})">DEL</button>
    </td></tr>`).join('')}
  </tbody></table>`;
}

function openHeatModal(id) {
  editingHeatId = id || null;
  const heat = id ? heats.find(h => h.id === id) : null;
  document.getElementById('heat-modal-title').textContent = id ? 'EDIT HEAT' : 'NEW HEAT';
  document.getElementById('hm-name').value   = heat?.name || '';
  document.getElementById('hm-color').value  = heat?.color || '#58a6ff';
  document.getElementById('hm-shape').value  = heat?.shape || 'circle';
  updateHeatPreview();
  document.getElementById('heat-modal').classList.remove('hidden');
}

function updateHeatPreview() {
  const color = document.getElementById('hm-color').value;
  const shape = document.getElementById('hm-shape').value;
  const el = document.getElementById('hm-preview');
  if (el) el.innerHTML = (RT.SHAPES[shape]?.(color, 24) || '') + `<span style="color:${color};font-size:12px">${shape}</span>`;
}

async function saveHeat() {
  const name = document.getElementById('hm-name').value.trim();
  const color = document.getElementById('hm-color').value;
  const shape = document.getElementById('hm-shape').value;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  const res = editingHeatId
    ? await RT.put(`/api/races/${selectedRaceId}/heats/${editingHeatId}`, { name, color, shape })
    : await RT.post(`/api/races/${selectedRaceId}/heats`, { name, color, shape });
  if (res.ok) { closeModal('heat-modal'); await loadHeatsClasses(); RT.toast('Heat saved', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function deleteHeat(id) {
  if (!confirm('Delete this heat?')) return;
  await RT.del(`/api/races/${selectedRaceId}/heats/${id}`);
  await loadHeatsClasses();
}

async function addClass() {
  const name = document.getElementById('new-class-name').value.trim();
  if (!name) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/classes`, { name });
  if (res.ok) { document.getElementById('new-class-name').value = ''; await loadHeatsClasses(); }
}

async function deleteClass(id) {
  if (!confirm('Delete this class?')) return;
  await RT.del(`/api/races/${selectedRaceId}/classes/${id}`);
  await loadHeatsClasses();
}

// ── Stations ──────────────────────────────────────────────────────────────────
function renderStationsTab() {
  const opts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name} (${r.date})</option>`).join('');
  return `
  <div class="card">
    <h3>SELECT RACE</h3>
    <select id="st-race-sel" onchange="selectedRaceId=parseInt(this.value);loadStations()">${opts}</select>
  </div>
  <div class="card">
    <h3>TRACK FILE</h3>
    <div class="upload-zone" onclick="document.getElementById('track-file-input').click()">
      <div id="track-file-label">&#8593; Upload KML or GPX file</div>
      <input type="file" id="track-file-input" accept=".kml,.gpx" style="display:none" onchange="uploadTrack(this)">
    </div>
    <div id="path-selector" class="hidden" style="margin-top:10px"></div>
  </div>
  <div class="card">
    <h3>AID STATIONS / POINTS</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="primary" onclick="openStationModal()">+ ADD STATION</button>
      <button onclick="showCsvImport('stations')">CSV IMPORT</button>
    </div>
    <div id="stations-list"></div>
  </div>
  <div id="csv-import-panel" class="hidden card">
    <h3 id="csv-import-title">CSV IMPORT</h3>
    <div class="text-dim" id="csv-import-hint" style="font-size:11px;margin-bottom:8px"></div>
    <div class="upload-zone" onclick="document.getElementById('csv-file-input').click()" id="csv-drop-zone">
      <div id="csv-file-label">&#8593; Click to select CSV file</div>
      <input type="file" id="csv-file-input" accept=".csv" style="display:none" onchange="csvFileSelected(this)">
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="primary" onclick="importCsv()" id="csv-import-btn" disabled>IMPORT</button>
      <button onclick="document.getElementById('csv-import-panel').classList.add('hidden')">CANCEL</button>
    </div>
  </div>`;
}

let csvImportTarget = '', csvFileContent = '';
const CSV_HINTS = {
  stations:     'Columns: name, lat, lon, type (start/finish/aid/checkpoint), cutoff_time',
  participants: 'Columns: bib, name, tracker_id, heat, class, age, phone, emergency_contact',
  personnel:    'Columns: name, station_name, tracker_id, phone',
};

function showCsvImport(target) {
  csvImportTarget = target;
  csvFileContent = '';
  document.getElementById('csv-file-label').textContent = '↑ Click to select CSV file';
  document.getElementById('csv-import-btn').disabled = true;
  document.getElementById('csv-import-title').textContent = 'CSV IMPORT — ' + target.toUpperCase();
  document.getElementById('csv-import-hint').textContent = CSV_HINTS[target] || '';
  document.getElementById('csv-import-panel').classList.remove('hidden');
}

function csvFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    csvFileContent = e.target.result;
    document.getElementById('csv-file-label').textContent = `✓ ${file.name}`;
    document.getElementById('csv-import-btn').disabled = false;
  };
  reader.readAsText(file);
}

async function importCsv() {
  if (!csvFileContent) return;
  const url = csvImportTarget === 'stations'
    ? `/api/races/${selectedRaceId}/stations/import`
    : csvImportTarget === 'personnel'
    ? `/api/races/${selectedRaceId}/personnel/import`
    : `/api/races/${selectedRaceId}/participants/import`;
  const res = await RT.post(url, { csv: csvFileContent });
  if (res.ok) {
    RT.toast('Imported successfully', 'ok');
    document.getElementById('csv-import-panel').classList.add('hidden');
    if (csvImportTarget === 'stations') loadStations();
    else if (csvImportTarget === 'personnel') loadPersonnel();
  } else RT.toast(res.error, 'warn');
}

async function bindStationsTab() { await loadStations(); checkTrackFile(); }

async function checkTrackFile() {
  if (!selectedRaceId) return;
  const res = await RT.get(`/api/races/${selectedRaceId}/tracks/parse`);
  if (res.ok && res.data) {
    document.getElementById('track-file-label').textContent = `✓ Track loaded — ${RT.fmtDist(res.data.totalDistance)} · ${res.data.paths?.length || 1} path(s)`;
    document.getElementById('track-file-label').style.color = 'var(--accent2)';
    if (res.data.paths?.length > 1) showPathSelector(res.data.paths, res.data.pathIndex);
  }
}

function showPathSelector(paths, selectedIdx) {
  const el = document.getElementById('path-selector');
  el.classList.remove('hidden');
  el.innerHTML = `<label>SELECT PATH TO USE AS COURSE</label>
    <select onchange="setPathIndex(this.value)">
      ${paths.map((p, i) => `<option value="${i}"${i===selectedIdx?' selected':''}>${p.name} (${p.pointCount} pts)</option>`).join('')}
    </select>`;
}

async function setPathIndex(idx) {
  await RT.put(`/api/races/${selectedRaceId}/tracks/path-index`, { index: parseInt(idx) });
  RT.toast('Course path updated', 'ok');
}

async function uploadTrack(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('track', file);
  const res = await fetch(RT.BASE + `api/races/${selectedRaceId}/tracks/upload`, { method: 'POST', body: form });
  const json = await res.json();
  if (json.ok) {
    RT.toast(`Track uploaded: ${json.data.file}`, 'ok');
    document.getElementById('track-file-label').textContent = `✓ ${json.data.file}`;
    if (json.data.paths.length > 1) showPathSelector(json.data.paths, 0);
  } else RT.toast(json.error, 'warn');
}

let stations = [];
async function loadStations() {
  if (!selectedRaceId) return;
  const res = await RT.get(`/api/races/${selectedRaceId}/stations`);
  stations = res.ok ? res.data : [];
  const el = document.getElementById('stations-list');
  if (!el) return;
  if (!stations.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No stations yet.</div>'; return; }
  el.innerHTML = `<table class="data-table"><thead><tr><th>#</th><th>NAME</th><th>TYPE</th><th>LAT</th><th>LON</th><th>CUTOFF</th><th></th></tr></thead><tbody>
    ${stations.map((s, i) => `<tr>
      <td class="text-dim">${i + 1}</td>
      <td>${s.name}</td>
      <td><span class="badge" style="color:var(--accent4)">${s.type.toUpperCase()}</span></td>
      <td class="text-dim">${s.lat.toFixed(5)}</td>
      <td class="text-dim">${s.lon.toFixed(5)}</td>
      <td>${s.cutoff_time || '--'}</td>
      <td style="text-align:right">
        <button style="font-size:10px;padding:2px 8px" onclick="openStationModal(${s.id})">EDIT</button>
        <button class="danger" style="font-size:10px;padding:2px 8px" onclick="deleteStation(${s.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

let editingStationId = null;
function openStationModal(id) {
  editingStationId = id || null;
  const s = id ? stations.find(x => x.id === id) : null;
  const name = prompt('Station name:', s?.name || '');
  if (!name) return;
  const lat = parseFloat(prompt('Latitude:', s?.lat || ''));
  const lon = parseFloat(prompt('Longitude:', s?.lon || ''));
  if (isNaN(lat) || isNaN(lon)) { RT.toast('Invalid coordinates', 'warn'); return; }
  const type = prompt('Type (start/finish/aid/checkpoint):', s?.type || 'aid');
  const cutoff = prompt('Cutoff time HH:MM (leave blank for none):', s?.cutoff_time || '') || null;
  id ? updateStation(id, { name, lat, lon, type, cutoff_time: cutoff })
     : createStation({ name, lat, lon, type, cutoff_time: cutoff });
}

async function createStation(body) {
  const res = await RT.post(`/api/races/${selectedRaceId}/stations`, body);
  if (res.ok) { await loadStations(); RT.toast('Station added', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function updateStation(id, body) {
  const res = await RT.put(`/api/races/${selectedRaceId}/stations/${id}`, body);
  if (res.ok) { await loadStations(); RT.toast('Station updated', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function deleteStation(id) {
  if (!confirm('Delete this station?')) return;
  await RT.del(`/api/races/${selectedRaceId}/stations/${id}`);
  await loadStations();
}

// ── Personnel ─────────────────────────────────────────────────────────────────
let personnel = [];
function renderPersonnelTab() {
  const opts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name}</option>`).join('');
  return `
  <div class="card">
    <h3>SELECT RACE</h3>
    <select id="pers-race-sel" onchange="selectedRaceId=parseInt(this.value);loadPersonnel()">${opts}</select>
  </div>
  <div class="card">
    <h3>AID STATION PERSONNEL</h3>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="primary" onclick="addPersonnel()">+ ADD PERSON</button>
      <button onclick="showCsvImport('personnel')">CSV IMPORT</button>
    </div>
    <div id="personnel-list"></div>
  </div>
  <div id="csv-import-panel" class="hidden card">
    <h3 id="csv-import-title">CSV IMPORT</h3>
    <div class="text-dim" id="csv-import-hint" style="font-size:11px;margin-bottom:8px"></div>
    <div class="upload-zone" onclick="document.getElementById('csv-file-input').click()">
      <div id="csv-file-label">&#8593; Click to select CSV file</div>
      <input type="file" id="csv-file-input" accept=".csv" style="display:none" onchange="csvFileSelected(this)">
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="primary" onclick="importCsv()" id="csv-import-btn" disabled>IMPORT</button>
      <button onclick="document.getElementById('csv-import-panel').classList.add('hidden')">CANCEL</button>
    </div>
  </div>`;
}

async function bindPersonnelTab() { await loadPersonnel(); }

async function loadPersonnel() {
  if (!selectedRaceId) return;
  const [pr, sr] = await Promise.all([
    RT.get(`/api/races/${selectedRaceId}/personnel`),
    RT.get(`/api/races/${selectedRaceId}/stations`),
  ]);
  personnel = pr.ok ? pr.data : [];
  stations = sr.ok ? sr.data : [];
  const el = document.getElementById('personnel-list');
  if (!el) return;
  if (!personnel.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No personnel yet.</div>'; return; }
  el.innerHTML = `<table class="data-table"><thead><tr><th>NAME</th><th>STATION</th><th>TRACKER ID</th><th>PHONE</th><th></th></tr></thead><tbody>
    ${personnel.map(p => `<tr>
      <td>${p.name}</td>
      <td>${p.station_name || '<span class="text-dim">—</span>'}</td>
      <td>${p.tracker_id || '<span class="text-dim">—</span>'}</td>
      <td>${p.phone || '<span class="text-dim">—</span>'}</td>
      <td style="text-align:right">
        <button style="font-size:10px;padding:2px 8px" onclick="editPersonnel(${p.id})">EDIT</button>
        <button class="danger" style="font-size:10px;padding:2px 8px" onclick="deletePersonnel(${p.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

async function addPersonnel() {
  const name = prompt('Name:'); if (!name) return;
  const stationName = prompt(`Station (${stations.map(s=>s.name).join(', ')}) or blank:`);
  const station = stations.find(s => s.name.toLowerCase() === stationName?.toLowerCase());
  const tracker_id = prompt('Tracker ID (node ID, longname, or shortname — leave blank if none):') || null;
  const phone = prompt('Phone (optional):') || null;
  const res = await RT.post(`/api/races/${selectedRaceId}/personnel`, { name, station_id: station?.id || null, tracker_id, phone });
  if (res.ok) { await loadPersonnel(); RT.toast('Added', 'ok'); }
}

async function editPersonnel(id) {
  const p = personnel.find(x => x.id === id);
  const name = prompt('Name:', p.name); if (!name) return;
  const stationName = prompt(`Station:`, p.station_name || '');
  const station = stations.find(s => s.name.toLowerCase() === stationName?.toLowerCase());
  const tracker_id = prompt('Tracker ID:', p.tracker_id || '') || null;
  const phone = prompt('Phone:', p.phone || '') || null;
  await RT.put(`/api/races/${selectedRaceId}/personnel/${id}`, { name, station_id: station?.id || null, tracker_id, phone });
  await loadPersonnel();
}

async function deletePersonnel(id) {
  if (!confirm('Delete?')) return;
  await RT.del(`/api/races/${selectedRaceId}/personnel/${id}`);
  await loadPersonnel();
}


// ── Infrastructure ────────────────────────────────────────────────────────────
function renderInfraTab() {
  return `
  <div class="card">
    <h3>TRACKER REGISTRY <span class="text-dim">(all nodes seen via MQTT)</span></h3>
    <div id="infra-list"><div class="text-dim" style="font-size:12px;padding:6px">Loading...</div></div>
  </div>`;
}

async function refreshInfra() {
  const res = await RT.get('/api/trackers');
  const el = document.getElementById('infra-list');
  if (!el || !res.ok) return;
  const trackers = res.data;
  if (!trackers.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No trackers seen yet.</div>'; return; }
  const now = Math.floor(Date.now() / 1000);
  const missingTimer = (races.find(r=>r.id===activeRaceId))?.missing_timer || 3600;
  el.innerHTML = `<table class="data-table"><thead><tr><th>NODE ID</th><th>LONG NAME</th><th>SHORT</th><th>BATTERY</th><th>LAST SEEN</th><th>POSITION</th></tr></thead><tbody>
    ${trackers.map(t => {
      const missing = t.last_seen && (now - t.last_seen) > missingTimer;
      const age = RT.timeAgo(t.last_seen);
      return `<tr style="${missing?'opacity:0.45':''}">
        <td class="text-accent">${t.node_id}</td>
        <td>${t.long_name||'—'}</td>
        <td>${t.short_name||'—'}</td>
        <td>${t.battery_level!=null?RT.fmtBattery(t.battery_level):'—'}</td>
        <td class="${missing?'text-warn':''}">${age}</td>
        <td class="text-dim">${t.last_lat?`${t.last_lat.toFixed(4)}, ${t.last_lon.toFixed(4)}`:'—'}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

// ── Users ─────────────────────────────────────────────────────────────────────
let users = [];
function renderUsersTab() {
  return `
  <div class="card">
    <h3>USER MANAGEMENT</h3>
    <button class="primary" onclick="openUserModal()" style="margin-bottom:10px">+ NEW USER</button>
    <div id="users-list"></div>
  </div>`;
}

async function loadUsers() {
  const res = await RT.get('/api/users');
  users = res.ok ? res.data : [];
  const el = document.getElementById('users-list');
  if (!el) return;
  el.innerHTML = `<table class="data-table"><thead><tr><th>USERNAME</th><th>ROLE</th><th>CREATED</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr>
      <td>${u.username}${u.id===currentUser.id?' <span class="text-dim">(you)</span>':''}</td>
      <td><span class="badge" style="color:${u.role==='admin'?'var(--accent3)':'var(--accent)'}">${u.role.toUpperCase()}</span></td>
      <td class="text-dim">${new Date(u.created_at*1000).toLocaleDateString()}</td>
      <td style="text-align:right">
        <button style="font-size:10px;padding:2px 8px" onclick="openUserModal(${u.id})">EDIT</button>
        ${u.id!==currentUser.id?`<button class="danger" style="font-size:10px;padding:2px 8px" onclick="deleteUser(${u.id})">DEL</button>`:''}
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

function openUserModal(id) {
  editingUserId = id || null;
  const user = id ? users.find(u => u.id === id) : null;
  document.getElementById('user-modal-title').textContent = id ? 'EDIT USER' : 'NEW USER';
  document.getElementById('um-username').value = user?.username || '';
  document.getElementById('um-password').value = '';
  document.getElementById('um-role').value = user?.role || 'operator';
  document.getElementById('user-modal').classList.remove('hidden');
}

async function saveUser() {
  const username = document.getElementById('um-username').value.trim();
  const password = document.getElementById('um-password').value;
  const role = document.getElementById('um-role').value;
  if (!username) { RT.toast('Username required', 'warn'); return; }
  if (!editingUserId && !password) { RT.toast('Password required for new user', 'warn'); return; }
  const body = { username, role };
  if (password) body.password = password;
  const res = editingUserId
    ? await RT.put(`/api/users/${editingUserId}`, body)
    : await RT.post('/api/users', body);
  if (res.ok) { closeModal('user-modal'); await loadUsers(); RT.toast('User saved', 'ok'); }
  else RT.toast(res.error, 'warn');
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  await RT.del(`/api/users/${id}`);
  await loadUsers();
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettingsTab() {
  return `
  <div class="card">
    <h3>OPENWEATHER</h3>
    <div class="form-group" style="max-width:400px">
      <label>API KEY</label>
      <input id="settings-weather-key" placeholder="Paste OpenWeather API key here">
    </div>
    <button class="primary" onclick="saveSettings()" style="margin-top:6px">SAVE</button>
  </div>`;
}

async function bindSettingsTab() {
  const res = await RT.get('/api/settings');
  if (res.ok) document.getElementById('settings-weather-key').value = res.data.weather_api_key || '';
}

async function saveSettings() {
  const res = await RT.put('/api/settings', {
    weather_api_key: document.getElementById('settings-weather-key').value.trim() || null,
  });
  if (res.ok) RT.toast('Settings saved', 'ok');
  else RT.toast(res.error, 'warn');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-bg:not(.hidden)').forEach(m => m.classList.add('hidden'));
});

// Bind heat preview updates
document.addEventListener('change', e => {
  if (e.target.id === 'hm-color' || e.target.id === 'hm-shape') updateHeatPreview();
});

init();
