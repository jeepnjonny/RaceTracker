'use strict';
let currentUser = null;
let races = [], activeRaceId = null;
let editingRaceId = null, editingUserId = null, editingHeatId = null;
let selectedRaceId = null; // race being configured in sub-tabs

const TABS = [
  { id: 'races',     label: 'RACES' },
  { id: 'heats',     label: 'HEATS/CLASSES' },
  { id: 'course',    label: 'COURSE' },
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
    case 'course':    el.innerHTML = renderCourseTab(); bindCourseTab(); break;
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
  window.open(url, '_blank');
  navigator.clipboard.writeText(url).then(() => RT.toast('Viewer URL opened and copied to clipboard', 'ok'));
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
async function openRaceModal(id) {
  editingRaceId = id || null;
  const race = id ? races.find(r => r.id === id) : null;
  document.getElementById('race-modal-title').textContent = id ? 'EDIT RACE' : 'NEW RACE';
  document.getElementById('rm-name').value           = race?.name || '';
  document.getElementById('rm-date').value           = race?.date || new Date().toISOString().split('T')[0];
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
  // Populate course dropdown
  const cr = await RT.get('/api/courses');
  const cSel = document.getElementById('rm-course-id');
  cSel.innerHTML = '<option value="">— None —</option>' +
    (cr.ok ? cr.data : []).map(c => `<option value="${c.id}"${race?.course_id===c.id?' selected':''}>${c.name} (${c.file_type.toUpperCase()})</option>`).join('');
  document.getElementById('race-modal').classList.remove('hidden');
}

async function saveRace() {
  const courseVal = document.getElementById('rm-course-id').value;
  const body = {
    name:                document.getElementById('rm-name').value.trim(),
    date:                document.getElementById('rm-date').value,
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
    course_id:           courseVal ? parseInt(courseVal) : null,
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
      showTab('course');
      RT.toast('Race created — assign a course and seed aid stations below', 'ok');
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

// ── Course File Library ───────────────────────────────────────────────────────
let courseFiles = [], selectedCourseId = null;
let csvFilesList = [], selectedCsvId = null;
let courseParseData = null; // { paths, points, trackPoints, totalDistance, pathIndex }

function renderCourseTab() {
  const raceOpts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name} (${r.date})</option>`).join('');
  return `
  <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start">
    <!-- Left: course file list -->
    <div>
      <div class="card" style="margin-bottom:0">
        <h3>KML / GPX LIBRARY</h3>
        <div style="margin-bottom:8px">
          <div class="upload-zone" onclick="document.getElementById('course-upload-input').click()" style="padding:8px;cursor:pointer">
            <span style="font-size:11px">&#8593; Upload KML or GPX</span>
            <input type="file" id="course-upload-input" accept=".kml,.gpx" style="display:none" onchange="uploadCourseFile(this)">
          </div>
        </div>
        <div id="course-file-list"><div class="text-dim" style="font-size:12px;padding:6px">Loading...</div></div>
      </div>
    </div>
    <!-- Right: course detail panel -->
    <div id="course-detail-panel">
      <div class="card" style="margin-bottom:0">
        <div id="course-detail-inner" style="color:var(--text3);font-size:12px;padding:20px;text-align:center">
          Select a course file to preview
        </div>
      </div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:300px 1fr;gap:12px;align-items:start;margin-top:12px">
    <!-- Left: CSV file list -->
    <div>
      <div class="card" style="margin-bottom:0">
        <h3>STATION CSV LIBRARY</h3>
        <div style="margin-bottom:8px">
          <div class="upload-zone" onclick="document.getElementById('csv-lib-input').click()" style="padding:8px;cursor:pointer">
            <span style="font-size:11px">&#8593; Upload CSV</span>
            <input type="file" id="csv-lib-input" accept=".csv" style="display:none" onchange="uploadCsvFile(this)">
          </div>
        </div>
        <div id="csv-lib-list"><div class="text-dim" style="font-size:12px;padding:6px">Loading...</div></div>
      </div>
    </div>
    <!-- Right: CSV detail -->
    <div id="csv-detail-panel">
      <div class="card" style="margin-bottom:0">
        <div id="csv-detail-inner" style="color:var(--text3);font-size:12px;padding:20px;text-align:center">
          Select a CSV file to preview
        </div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:12px">
    <h3>RACE STATIONS
      <select id="st-race-sel" onchange="selectedRaceId=parseInt(this.value);loadStations()" style="margin-left:12px;font-size:11px;padding:3px 6px">${raceOpts}</select>
    </h3>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="primary" onclick="openStationModal()">+ ADD</button>
      <button onclick="showInlineCsvImport()">CSV IMPORT</button>
    </div>
    <div id="inline-csv-panel" class="hidden" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px">
      <div class="text-dim" style="font-size:11px;margin-bottom:6px">Columns: name, lat, lon, type (start/finish/aid/checkpoint), cutoff_time</div>
      <div class="upload-zone" onclick="document.getElementById('inline-csv-input').click()" style="padding:8px">
        <div id="inline-csv-label">&#8593; Select CSV file</div>
        <input type="file" id="inline-csv-input" accept=".csv" style="display:none" onchange="inlineCsvSelected(this)">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="primary" id="inline-csv-btn" disabled onclick="importStationsCsv()">IMPORT</button>
        <button onclick="document.getElementById('inline-csv-panel').classList.add('hidden')">CANCEL</button>
      </div>
    </div>
    <div id="stations-list"></div>
  </div>`;
}

async function bindCourseTab() {
  await Promise.all([loadCourseFiles(), loadCsvLibFiles(), loadStations()]);
}

// ── KML/GPX course library ────────────────────────────────────────────────────
async function loadCourseFiles() {
  const res = await RT.get('/api/courses');
  courseFiles = res.ok ? res.data : [];
  renderCourseFileList();
}

function renderCourseFileList() {
  const el = document.getElementById('course-file-list');
  if (!el) return;
  if (!courseFiles.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No course files uploaded yet.</div>'; return; }
  el.innerHTML = courseFiles.map(c => `
    <div class="infra-row" style="cursor:pointer;border-radius:4px;${c.id===selectedCourseId?'background:var(--surface3,#161b22);':''}" onclick="selectCourse(${c.id})">
      <span class="infra-node" style="min-width:unset;flex:1;font-size:12px">${c.name}</span>
      <span class="badge" style="color:${c.file_type==='kml'?'var(--accent4)':'var(--accent)'};">${c.file_type.toUpperCase()}</span>
      <button style="font-size:10px;padding:2px 6px" onclick="event.stopPropagation();renameCourse(${c.id})">REN</button>
      <button class="danger" style="font-size:10px;padding:2px 6px" onclick="event.stopPropagation();deleteCourse(${c.id})">DEL</button>
    </div>`).join('');
}

async function selectCourse(id) {
  selectedCourseId = id;
  renderCourseFileList();
  const el = document.getElementById('course-detail-inner');
  el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Loading...</div>';
  const res = await RT.get(`/api/courses/${id}/parse`);
  if (!res.ok) { el.innerHTML = `<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Error: ${res.error}</div>`; return; }
  courseParseData = res.data;
  renderCourseDetail(el, courseFiles.find(c => c.id === id));
}

function buildCourseSVG(points, w, h) {
  if (!points || points.length < 2) return `<svg width="${w}" height="${h}"><text x="${w/2}" y="${h/2}" text-anchor="middle" fill="#888" font-size="12">No track data</text></svg>`;
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 16;
  const rangeX = maxLon - minLon || 0.0001, rangeY = maxLat - minLat || 0.0001;
  const scale = Math.min((w - pad*2) / rangeX, (h - pad*2) / rangeY);
  const drawnW = rangeX * scale, drawnH = rangeY * scale;
  const offX = pad + (w - pad*2 - drawnW) / 2;
  const offY = pad + (h - pad*2 - drawnH) / 2;
  const toX = lon => offX + (lon - minLon) * scale;
  const toY = lat => h - offY - (lat - minLat) * scale;
  const d = points.map((p, i) => `${i===0?'M':'L'}${toX(p[1]).toFixed(1)},${toY(p[0]).toFixed(1)}`).join(' ');
  const sx = toX(points[0][1]).toFixed(1), sy = toY(points[0][0]).toFixed(1);
  const ex = toX(points[points.length-1][1]).toFixed(1), ey = toY(points[points.length-1][0]).toFixed(1);
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${h}px;display:block;background:var(--surface2);border-radius:6px">
    <path d="${d}" fill="none" stroke="#f5a623" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx}" cy="${sy}" r="5" fill="#3fb950" stroke="#0d1117" stroke-width="1.5"/>
    <circle cx="${ex}" cy="${ey}" r="5" fill="#f85149" stroke="#0d1117" stroke-width="1.5"/>
  </svg>`;
}

function renderCourseDetail(el, course) {
  const d = courseParseData;
  const hasPaths = d.paths?.length > 1;
  const dist = d.totalDistance ? RT.fmtDist(d.totalDistance) : '—';
  const svg = buildCourseSVG(d.trackPoints, 520, 200);
  const raceOpts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name}</option>`).join('');
  const wpts = d.points || [];

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-size:13px;font-weight:bold;color:var(--text)">${course.name}</div>
      <div class="text-dim" style="font-size:11px">${dist}${d.trackPoints?` · ${d.trackPoints.length} pts`:''}</div>
    </div>
    ${svg}
    ${hasPaths ? `
    <div style="margin-top:10px">
      <label style="font-size:10px;letter-spacing:1px;color:var(--text3)">SELECT PATH</label>
      <select onchange="setCoursePathIndex(${course.id}, this.value)" style="margin-top:4px">
        ${d.paths.map(p => `<option value="${p.index}"${p.index===d.pathIndex?' selected':''}>${p.name} (${p.pointCount} pts)</option>`).join('')}
      </select>
    </div>` : ''}
    ${wpts.length ? `
    <div style="margin-top:12px">
      <div style="font-size:10px;letter-spacing:1px;color:var(--text3);margin-bottom:6px">WAYPOINTS / POINTS OF INTEREST (${wpts.length})</div>
      <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:4px">
        ${wpts.map((w, i) => `
        <div class="infra-row" style="gap:6px">
          <input type="checkbox" id="wpt-${i}" checked style="flex-shrink:0">
          <label for="wpt-${i}" style="flex:1;font-size:12px;cursor:pointer">${w.name}</label>
          <span class="text-dim" style="font-size:10px">${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}</span>
          <select id="wpt-type-${i}" style="font-size:10px;padding:1px 4px">
            <option value="aid">AID</option><option value="start">START</option>
            <option value="finish">FINISH</option><option value="checkpoint">CHECK</option>
          </select>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
        <label style="font-size:11px;color:var(--text3)">SEED TO RACE:</label>
        <select id="seed-race-sel" style="flex:1">${raceOpts}</select>
        <button class="primary" onclick="seedWaypointsToRace()" style="font-size:10px;padding:4px 10px">SEED STATIONS</button>
      </div>
    </div>` : `<div class="text-dim" style="font-size:11px;margin-top:10px">No waypoints/POIs in this file. Use the CSV library to import station coordinates.</div>`}`;
}

async function setCoursePathIndex(courseId, idx) {
  await RT.put(`/api/courses/${courseId}`, { path_index: parseInt(idx) });
  await selectCourse(courseId);
  RT.toast('Course path updated', 'ok');
}

async function uploadCourseFile(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('course', file);
  const res = await fetch(RT.BASE + 'api/courses/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json.ok) {
    RT.toast(`Uploaded: ${file.name}`, 'ok');
    await loadCourseFiles();
    selectCourse(json.data.id);
  } else RT.toast(json.error || 'Upload failed', 'warn');
  input.value = '';
}

async function renameCourse(id) {
  const c = courseFiles.find(x => x.id === id);
  const name = prompt('Rename course:', c?.name || '');
  if (!name || name === c?.name) return;
  await RT.put(`/api/courses/${id}`, { name });
  await loadCourseFiles();
  if (selectedCourseId === id) await selectCourse(id);
}

async function deleteCourse(id) {
  if (!confirm('Delete this course file? Any races using it will lose their course assignment.')) return;
  await RT.del(`/api/courses/${id}`);
  if (selectedCourseId === id) {
    selectedCourseId = null;
    courseParseData = null;
    const el = document.getElementById('course-detail-inner');
    if (el) el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Select a course file to preview</div>';
  }
  await loadCourseFiles();
  RT.toast('Course deleted', 'ok');
}

async function seedWaypointsToRace() {
  const raceId = parseInt(document.getElementById('seed-race-sel').value);
  const wpts = courseParseData?.points || [];
  const waypoints = wpts
    .map((w, i) => ({ ...w, type: document.getElementById(`wpt-type-${i}`)?.value || 'aid', checked: document.getElementById(`wpt-${i}`)?.checked }))
    .filter(w => w.checked);
  if (!waypoints.length) { RT.toast('No waypoints selected', 'warn'); return; }
  if (!confirm(`Seed ${waypoints.length} station(s) to ${races.find(r=>r.id===raceId)?.name}? Existing stations are kept.`)) return;
  const res = await RT.post(`/api/races/${raceId}/stations/seed`, { waypoints });
  if (res.ok) {
    RT.toast(`Seeded ${res.data.length} stations`, 'ok');
    selectedRaceId = raceId;
    await loadStations();
  } else RT.toast(res.error, 'warn');
}

// ── CSV file library ──────────────────────────────────────────────────────────
async function loadCsvLibFiles() {
  const res = await RT.get('/api/csv-files');
  csvFilesList = res.ok ? res.data : [];
  renderCsvLibList();
}

function renderCsvLibList() {
  const el = document.getElementById('csv-lib-list');
  if (!el) return;
  if (!csvFilesList.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No CSV files uploaded yet.</div>'; return; }
  el.innerHTML = csvFilesList.map(f => `
    <div class="infra-row" style="cursor:pointer;border-radius:4px;${f.id===selectedCsvId?'background:var(--surface3,#161b22);':''}" onclick="selectCsvFile(${f.id})">
      <span style="flex:1;font-size:12px;color:var(--text)">${f.name}</span>
      <button style="font-size:10px;padding:2px 6px" onclick="event.stopPropagation();renameCsvFile(${f.id})">REN</button>
      <button class="danger" style="font-size:10px;padding:2px 6px" onclick="event.stopPropagation();deleteCsvFile(${f.id})">DEL</button>
    </div>`).join('');
}

async function selectCsvFile(id) {
  selectedCsvId = id;
  renderCsvLibList();
  const el = document.getElementById('csv-detail-inner');
  el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Loading...</div>';
  const res = await RT.get(`/api/csv-files/${id}/preview`);
  if (!res.ok) { el.innerHTML = `<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Error: ${res.error}</div>`; return; }
  const { lines, total } = res.data;
  const raceOpts = races.map(r => `<option value="${r.id}"${r.id===selectedRaceId?' selected':''}>${r.name}</option>`).join('');
  el.innerHTML = `
    <div style="font-size:13px;font-weight:bold;color:var(--text);margin-bottom:8px">${csvFilesList.find(f=>f.id===id)?.name} <span class="text-dim" style="font-size:11px">(${total} rows)</span></div>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:4px">
      <table class="data-table" style="margin:0">
        <tbody>${lines.map((l, i) => `<tr style="${i===0?'background:var(--surface2)':''}"><td style="font-size:11px;white-space:nowrap">${l.split(',').join('</td><td style="font-size:11px;white-space:nowrap">')}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <label style="font-size:11px;color:var(--text3)">IMPORT TO RACE:</label>
      <select id="csv-import-race-sel" style="flex:1">${raceOpts}</select>
      <button class="primary" onclick="importCsvFromLibrary(${id})" style="font-size:10px;padding:4px 10px">IMPORT STATIONS</button>
    </div>`;
}

async function uploadCsvFile(input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('csv', file);
  const res = await fetch(RT.BASE + 'api/csv-files/upload', { method: 'POST', body: form });
  const json = await res.json();
  if (json.ok) {
    RT.toast(`Uploaded: ${file.name}`, 'ok');
    await loadCsvLibFiles();
    selectCsvFile(json.data.id);
  } else RT.toast(json.error || 'Upload failed', 'warn');
  input.value = '';
}

async function renameCsvFile(id) {
  const f = csvFilesList.find(x => x.id === id);
  const name = prompt('Rename CSV file:', f?.name || '');
  if (!name || name === f?.name) return;
  await RT.put(`/api/csv-files/${id}`, { name });
  await loadCsvLibFiles();
  if (selectedCsvId === id) await selectCsvFile(id);
}

async function deleteCsvFile(id) {
  if (!confirm('Delete this CSV file?')) return;
  await RT.del(`/api/csv-files/${id}`);
  if (selectedCsvId === id) {
    selectedCsvId = null;
    const el = document.getElementById('csv-detail-inner');
    if (el) el.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center;font-size:12px">Select a CSV file to preview</div>';
  }
  await loadCsvLibFiles();
  RT.toast('CSV file deleted', 'ok');
}

async function importCsvFromLibrary(fileId) {
  const raceId = parseInt(document.getElementById('csv-import-race-sel').value);
  const race = races.find(r => r.id === raceId);
  if (!confirm(`Import stations from CSV into "${race?.name}"? Existing stations are kept.`)) return;
  const prevRes = await RT.get(`/api/csv-files/${fileId}/preview`);
  // We need the full file — read it from the server via the import endpoint
  // The import endpoint accepts { csv: content } but we stored the file server-side
  // Use a multipart workaround: fetch the file content via the server
  const res = await RT.post(`/api/races/${raceId}/stations/import-from-lib`, { csv_file_id: fileId });
  if (res.ok) {
    RT.toast(`Imported ${res.data.length} stations`, 'ok');
    selectedRaceId = raceId;
    await loadStations();
  } else RT.toast(res.error, 'warn');
}

// ── Race stations (inline management) ────────────────────────────────────────
let stations = [], csvInlineContent = '';

async function loadStations() {
  if (!selectedRaceId) return;
  const res = await RT.get(`/api/races/${selectedRaceId}/stations`);
  stations = res.ok ? res.data : [];
  renderStationsList();
}

function renderStationsList() {
  const el = document.getElementById('stations-list');
  if (!el) return;
  if (!stations.length) { el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:6px">No stations yet. Seed from a course file above, import a CSV, or add manually.</div>'; return; }
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

function showInlineCsvImport() {
  csvInlineContent = '';
  document.getElementById('inline-csv-label').textContent = '↑ Select CSV file';
  document.getElementById('inline-csv-btn').disabled = true;
  document.getElementById('inline-csv-panel').classList.remove('hidden');
}

function inlineCsvSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    csvInlineContent = e.target.result;
    document.getElementById('inline-csv-label').textContent = `✓ ${file.name}`;
    document.getElementById('inline-csv-btn').disabled = false;
  };
  reader.readAsText(file);
}

async function importStationsCsv() {
  if (!csvInlineContent) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/stations/import`, { csv: csvInlineContent });
  if (res.ok) {
    RT.toast('Stations imported', 'ok');
    document.getElementById('inline-csv-panel').classList.add('hidden');
    await loadStations();
  } else RT.toast(res.error, 'warn');
}

let editingStationId = null;

function openStationModal(id) {
  editingStationId = id || null;
  const s = id ? stations.find(x => x.id === id) : null;
  document.getElementById('station-modal-title').textContent = id ? 'EDIT STATION' : 'NEW STATION';
  document.getElementById('sm-name').value   = s?.name || '';
  document.getElementById('sm-type').value   = s?.type || 'aid';
  document.getElementById('sm-lat').value    = s?.lat ?? '';
  document.getElementById('sm-lon').value    = s?.lon ?? '';
  document.getElementById('sm-cutoff').value = s?.cutoff_time || '';
  document.getElementById('station-modal').classList.remove('hidden');
  document.getElementById('sm-name').focus();
}

async function saveStation() {
  const name   = document.getElementById('sm-name').value.trim();
  const type   = document.getElementById('sm-type').value;
  const lat    = parseFloat(document.getElementById('sm-lat').value);
  const lon    = parseFloat(document.getElementById('sm-lon').value);
  const cutoff = document.getElementById('sm-cutoff').value.trim() || null;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  if (isNaN(lat) || isNaN(lon)) { RT.toast('Valid lat/lon required', 'warn'); return; }
  const body = { name, type, lat, lon, cutoff_time: cutoff };
  const res = editingStationId
    ? await RT.put(`/api/races/${selectedRaceId}/stations/${editingStationId}`, body)
    : await RT.post(`/api/races/${selectedRaceId}/stations`, body);
  if (res.ok) {
    closeModal('station-modal');
    await loadStations();
    RT.toast(editingStationId ? 'Station updated' : 'Station added', 'ok');
  } else RT.toast(res.error, 'warn');
}

async function deleteStation(id) {
  if (!confirm('Delete this station?')) return;
  await RT.del(`/api/races/${selectedRaceId}/stations/${id}`);
  await loadStations();
}

// ── Personnel ─────────────────────────────────────────────────────────────────
let personnel = [], personnelCsvContent = '';
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
      <button class="primary" onclick="openPersonnelModal()">+ ADD PERSON</button>
      <button onclick="showPersonnelCsvPanel()">CSV IMPORT</button>
    </div>
    <div id="pers-csv-panel" class="hidden" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:10px">
      <div class="text-dim" style="font-size:11px;margin-bottom:6px">Columns: name, station_name, tracker_id, phone</div>
      <div class="upload-zone" onclick="document.getElementById('pers-csv-input').click()" style="padding:8px">
        <div id="pers-csv-label">&#8593; Select CSV file</div>
        <input type="file" id="pers-csv-input" accept=".csv" style="display:none" onchange="personnelCsvSelected(this)">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="primary" id="pers-csv-btn" disabled onclick="importPersonnelCsv()">IMPORT</button>
        <button onclick="document.getElementById('pers-csv-panel').classList.add('hidden')">CANCEL</button>
      </div>
    </div>
    <div id="personnel-list"></div>
  </div>`;
}

function showPersonnelCsvPanel() {
  personnelCsvContent = '';
  document.getElementById('pers-csv-label').textContent = '↑ Select CSV file';
  document.getElementById('pers-csv-btn').disabled = true;
  document.getElementById('pers-csv-panel').classList.remove('hidden');
}

function personnelCsvSelected(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    personnelCsvContent = e.target.result;
    document.getElementById('pers-csv-label').textContent = `✓ ${file.name}`;
    document.getElementById('pers-csv-btn').disabled = false;
  };
  reader.readAsText(file);
}

async function importPersonnelCsv() {
  if (!personnelCsvContent) return;
  const res = await RT.post(`/api/races/${selectedRaceId}/personnel/import`, { csv: personnelCsvContent });
  if (res.ok) {
    RT.toast('Personnel imported', 'ok');
    document.getElementById('pers-csv-panel').classList.add('hidden');
    await loadPersonnel();
  } else RT.toast(res.error, 'warn');
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
        <button style="font-size:10px;padding:2px 8px" onclick="openPersonnelModal(${p.id})">EDIT</button>
        <button class="danger" style="font-size:10px;padding:2px 8px" onclick="deletePersonnel(${p.id})">DEL</button>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

let editingPersonnelId = null;

function openPersonnelModal(id) {
  editingPersonnelId = id || null;
  const p = id ? personnel.find(x => x.id === id) : null;
  document.getElementById('personnel-modal-title').textContent = id ? 'EDIT PERSONNEL' : 'NEW PERSONNEL';
  document.getElementById('pm-name').value       = p?.name || '';
  document.getElementById('pm-tracker-id').value = p?.tracker_id || '';
  document.getElementById('pm-phone').value      = p?.phone || '';
  const sel = document.getElementById('pm-station-id');
  sel.innerHTML = '<option value="">— Unassigned —</option>' +
    stations.map(s => `<option value="${s.id}"${s.id === p?.station_id ? ' selected' : ''}>${s.name}</option>`).join('');
  document.getElementById('personnel-modal').classList.remove('hidden');
  document.getElementById('pm-name').focus();
}

async function savePersonnel() {
  const name       = document.getElementById('pm-name').value.trim();
  const station_id = document.getElementById('pm-station-id').value || null;
  const tracker_id = document.getElementById('pm-tracker-id').value.trim() || null;
  const phone      = document.getElementById('pm-phone').value.trim() || null;
  if (!name) { RT.toast('Name required', 'warn'); return; }
  const body = { name, station_id: station_id ? parseInt(station_id) : null, tracker_id, phone };
  const res = editingPersonnelId
    ? await RT.put(`/api/races/${selectedRaceId}/personnel/${editingPersonnelId}`, body)
    : await RT.post(`/api/races/${selectedRaceId}/personnel`, body);
  if (res.ok) {
    closeModal('personnel-modal');
    await loadPersonnel();
    RT.toast(editingPersonnelId ? 'Personnel updated' : 'Personnel added', 'ok');
  } else RT.toast(res.error, 'warn');
}

async function deletePersonnel(id) {
  if (!confirm('Delete this person?')) return;
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
    <h3>MQTT / DATA SOURCE</h3>
    <div class="form-row">
      <div class="form-group"><label>BROKER HOST</label><input id="s-mqtt-host" placeholder="apps.k7swi.org"></div>
      <div class="form-group"><label>PORT</label><input id="s-mqtt-port-ws" type="number" value="9001"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>USERNAME</label><input id="s-mqtt-user" placeholder="racetracker"></div>
      <div class="form-group"><label>PASSWORD</label><input id="s-mqtt-pass" type="password"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>REGION</label><input id="s-mqtt-region" placeholder="US"></div>
      <div class="form-group"><label>CHANNEL</label><input id="s-mqtt-channel" placeholder="LongFast"></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>FORMAT</label>
        <select id="s-mqtt-format">
          <option value="json">JSON (unencrypted)</option>
          <option value="proto">Encrypted Protobuf</option>
        </select>
      </div>
      <div class="form-group"><label>PSK (base64)</label><input id="s-mqtt-psk" placeholder="AQ=="></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="primary" onclick="saveSettings()">SAVE</button>
      <button onclick="testMqtt()" id="s-mqtt-test-btn">TEST CONNECTION</button>
      <span id="s-mqtt-status" style="font-size:11px;align-self:center;color:var(--text3)"></span>
    </div>
  </div>
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
  if (!res.ok) return;
  const s = res.data;
  document.getElementById('s-mqtt-host').value       = s.mqtt_host || '';
  document.getElementById('s-mqtt-port-ws').value    = s.mqtt_port_ws || '9001';
  document.getElementById('s-mqtt-user').value       = s.mqtt_user || '';
  document.getElementById('s-mqtt-pass').value       = s.mqtt_pass || '';
  document.getElementById('s-mqtt-region').value     = s.mqtt_region || '';
  document.getElementById('s-mqtt-channel').value    = s.mqtt_channel || '';
  document.getElementById('s-mqtt-format').value     = s.mqtt_format || 'json';
  document.getElementById('s-mqtt-psk').value        = s.mqtt_psk || '';
  document.getElementById('settings-weather-key').value = s.weather_api_key || '';
}

async function saveSettings() {
  const res = await RT.put('/api/settings', {
    mqtt_host:      document.getElementById('s-mqtt-host').value.trim() || null,
    mqtt_port_ws:   document.getElementById('s-mqtt-port-ws').value || '9001',
    mqtt_user:      document.getElementById('s-mqtt-user').value.trim() || null,
    mqtt_pass:      document.getElementById('s-mqtt-pass').value || null,
    mqtt_region:    document.getElementById('s-mqtt-region').value.trim() || null,
    mqtt_channel:   document.getElementById('s-mqtt-channel').value.trim() || null,
    mqtt_format:    document.getElementById('s-mqtt-format').value,
    mqtt_psk:       document.getElementById('s-mqtt-psk').value.trim() || null,
    weather_api_key: document.getElementById('settings-weather-key').value.trim() || null,
  });
  if (res.ok) RT.toast('Settings saved', 'ok');
  else RT.toast(res.error, 'warn');
}

async function testMqtt() {
  const btn = document.getElementById('s-mqtt-test-btn');
  const status = document.getElementById('s-mqtt-status');
  btn.disabled = true;
  status.textContent = 'Testing...';
  status.style.color = 'var(--text3)';
  await saveSettings();
  const res = await RT.post('/api/settings/mqtt-test', {});
  btn.disabled = false;
  if (res.ok && res.data?.connected) {
    status.textContent = '✓ Connected';
    status.style.color = 'var(--accent2)';
  } else {
    status.textContent = '✗ Failed';
    status.style.color = 'var(--accent3)';
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-bg:not(.hidden)').forEach(m => m.classList.add('hidden'));
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    const modal = e.target.closest('.modal-bg');
    if (!modal) return;
    if (modal.id === 'personnel-modal') savePersonnel();
    if (modal.id === 'station-modal')   saveStation();
    if (modal.id === 'user-modal')      saveUser();
  }
});

// Bind heat preview updates
document.addEventListener('change', e => {
  if (e.target.id === 'hm-color' || e.target.id === 'hm-shape') updateHeatPreview();
});

init();
