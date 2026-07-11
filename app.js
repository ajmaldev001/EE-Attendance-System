/* ===== ECE Attendance & Performance Tracker — client (server-backed) ===== */

/* ---------- tiny utils ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
function gradeFor(pct) {
  if (pct >= 90) return 'O'; if (pct >= 80) return 'A+'; if (pct >= 70) return 'A';
  if (pct >= 60) return 'B+'; if (pct >= 50) return 'B'; if (pct >= 40) return 'C'; return 'F';
}

/* ---------- avatar / photo helpers ---------- */
const initials = (name) => String(name || 'U').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'U';
// Render a student avatar: photo if present, otherwise initials on a colored disc.
function avatarHTML(photo, name, cls = '') {
  return photo
    ? `<span class="avatar ${cls}" style="background-image:url('${photo}')"></span>`
    : `<span class="avatar ${cls} initials">${esc(initials(name))}</span>`;
}
// Read an image file and downscale it to a small square-ish JPEG data URL so it
// stays a few KB in the database and API payloads.
function readImageAsDataURL(file, maxDim = 256, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('Please choose an image file'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- auth / API ---------- */
let auth = { token: localStorage.getItem('token') || null, user: null };
try { auth.user = JSON.parse(localStorage.getItem('user') || 'null'); } catch { auth.user = null; }
let META = { subjects: [], markTypes: [] };

// API base URL — empty for local (same origin), set to Fly.io URL in config.js for Vercel
const API_BASE = ((typeof window !== 'undefined' && window.API_BASE) || '').replace(/\/$/, '');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const res = await fetch(API_BASE + '/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!res.ok) {
    let msg = 'Request failed';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* ---------- modal ---------- */
const overlay = $('#modalOverlay');
function openModal(title, bodyHTML) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  overlay.classList.add('open');
}
function closeModal() { overlay.classList.remove('open'); }
$('#modalClose').onclick = closeModal;
overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- charts ---------- */
let charts = [];
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }
function themeColors() {
  const dark = document.body.dataset.theme === 'dark';
  return { grid: dark ? '#2a3150' : '#e3e7f0', text: dark ? '#9aa3bd' : '#6b7488' };
}

/* ---------- shared bits ---------- */
const content = $('#content');
function statCard(icon, glyph, value, label) {
  return `<div class="stat-card"><div class="stat-icon ${icon}">${glyph}</div>
    <div class="stat-info"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div></div>`;
}
function progressBar(pct, color) {
  return `<div style="display:flex;align-items:center;gap:8px"><div class="progress"><span style="width:${pct}%;background:${color}"></span></div> ${pct}%</div>`;
}
function loadingHTML() { return `<div class="panel"><div class="empty">Loading…</div></div>`; }

/* ================= NAV / ROLE ================= */
const N_DASH = { view: 'dashboard', glyph: '▚', label: 'Dashboard' };
const N_STU = { view: 'students', glyph: '☰', label: 'Students' };
const N_FAC = { view: 'faculty', glyph: '♟', label: 'Faculty' };
const N_ATT = { view: 'attendance', glyph: '✓', label: 'Attendance' };
const N_MARKS = { view: 'marks', glyph: '✎', label: 'Marks' };
const N_REP = { view: 'reports', glyph: '▤', label: 'Reports' };
const NAVS = {
  admin:   [N_DASH, N_STU, N_FAC, N_ATT, N_MARKS, N_REP],
  staff:   [N_DASH, N_STU, N_FAC, N_ATT, N_MARKS, N_REP],
  hod:     [N_DASH, N_STU, N_FAC, N_ATT, N_REP],
  faculty: [N_DASH, N_ATT, N_MARKS, N_REP],
  student: [
    { view: 'mydash', glyph: '▚', label: 'Dashboard' },
    { view: 'myattendance', glyph: '✓', label: 'My Attendance' },
    { view: 'mymarks', glyph: '✎', label: 'My Marks' },
  ],
};
function navKey() {
  const r = auth.user.role;
  if (r === 'student') return 'student';
  return NAVS[r] ? r : 'admin';
}

/* role capability helpers */
const roleIs = (...rs) => rs.includes(auth.user.role);
const isAdmin = () => roleIs('admin', 'staff');
const isOverseer = () => roleIs('admin', 'staff', 'hod'); // can view everything / unlock

/* subject helpers (META.subjects are { code, name, faculty } objects) */
const subjectNames = () => META.subjects.map(s => s.name);
const subjectByName = (name) => META.subjects.find(s => s.name === name) || null;

/* traffic-light colour for an attendance %: 🟢 ≥75, 🟡 60–74, 🔴 <60 */
function attColor(pct) { return pct >= 75 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)'; }

let currentView = null;
function buildSidebar() {
  const items = NAVS[navKey()];
  $('#sidebar .nav').innerHTML = items.map((it, i) =>
    `<button class="nav-item ${i === 0 ? 'active' : ''}" data-view="${it.view}"><span class="ico">${it.glyph}</span> ${it.label}</button>`
  ).join('');
  $$('.nav-item').forEach(b => b.onclick = () => { render(b.dataset.view); $('#sidebar').classList.remove('open'); });

  const u = auth.user;
  const ROLE_LABEL = { admin: 'Administrator', staff: 'Administrator', hod: 'Head of Department', faculty: 'Faculty', student: 'Student' };
  $('#userName').textContent = u.name;
  $('#userRole').textContent = ROLE_LABEL[u.role] || u.role;
  $('#userAvatar').textContent = (u.name || 'U').trim().charAt(0).toUpperCase();
}

const VIEW_FN = {
  dashboard: viewDashboard, students: viewStudents, faculty: viewFaculty, attendance: viewAttendance, marks: viewMarks, reports: viewReports,
  mydash: viewMyDashboard, myattendance: viewMyAttendance, mymarks: viewMyMarks,
};
const VIEW_TITLE = {
  dashboard: 'Dashboard', students: 'Students', faculty: 'Faculty', attendance: 'Attendance', marks: 'Marks', reports: 'Reports',
  mydash: 'My Dashboard', myattendance: 'My Attendance', mymarks: 'My Marks',
};

async function render(view) {
  currentView = view;
  destroyCharts();
  $('#pageTitle').textContent = VIEW_TITLE[view];
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  content.innerHTML = loadingHTML();
  try { await VIEW_FN[view](); }
  catch (e) { content.innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; }
}

/* ================= STAFF: DASHBOARD ================= */
async function viewDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const d = await api('/dashboard?date=' + today);
  const c = d.college || META.college || {};
  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todayPct = d.today && d.today.pct !== null && d.today.pct !== undefined ? d.today.pct + '%' : '—';
  content.innerHTML = `
    <div class="college-banner">
      <div class="cb-main">
        <h2>${esc(c.name || '')}</h2>
        <p>${esc(c.department || '')}</p>
        <div class="cb-tags">
          <span>${esc(c.className || '')}</span>
          <span>Semester ${esc(c.semester || '')}</span>
          <span>${esc(c.academicYear || '')}</span>
          <span>HOD: ${esc(c.hod || '')}</span>
        </div>
      </div>
      <div class="cb-date"><span>${esc(dateStr)}</span><b id="cbClock">${esc(now.toLocaleTimeString())}</b></div>
    </div>
    <div class="stat-grid">
      ${statCard('i-primary', '☰', d.totalStudents, 'Total Students')}
      ${statCard('i-blue', '♟', d.totalFaculty, 'Total Faculty')}
      ${statCard('i-green', '✓', todayPct, `Attendance Today (${d.today ? d.today.periods : 0}/${d.today ? d.today.totalPeriods : 9} periods)`)}
      ${statCard('i-amber', '%', d.avgAtt + '%', 'Overall Attendance')}
    </div>
    <div class="panel-grid">
      <div class="panel"><div class="panel-head"><h3>Attendance by Student</h3></div><div class="chart-box"><canvas id="attBar"></canvas></div></div>
      <div class="panel"><div class="panel-head"><h3>Overall Status</h3></div><div class="chart-box"><canvas id="statusDoughnut"></canvas></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Low Attendance Alerts (&lt; 75%)</h3></div>
      ${d.low.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Roll</th><th>Name</th><th>Reg No</th><th>Attendance</th><th>Status</th></tr></thead>
        <tbody>${d.low.map(s => `<tr><td>${esc(s.roll || '—')}</td><td>${esc(s.name)}</td><td>${esc(s.reg)}</td>
          <td>${progressBar(s.stats.pct, attColor(s.stats.pct))}</td>
          <td><span class="badge ${s.stats.pct < 60 ? 'low' : 'warn'}">${s.stats.pct < 60 ? 'Critical' : 'Low'}</span></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">No students below 75%. 🎉</div>`}
    </div>`;

  // Live clock in the banner.
  clearInterval(window._cbTimer);
  window._cbTimer = setInterval(() => { const el = $('#cbClock'); if (el) el.textContent = new Date().toLocaleTimeString(); else clearInterval(window._cbTimer); }, 1000);

  if (d.students.length) {
    const tc = themeColors();
    charts.push(new Chart($('#attBar'), {
      type: 'bar',
      data: { labels: d.students.map(s => s.roll || s.reg), datasets: [{ label: 'Attendance %', data: d.students.map(s => s.stats.pct),
        backgroundColor: d.students.map(s => s.stats.pct < 60 ? '#dc2626' : s.stats.pct < 75 ? '#f59e0b' : '#4f46e5'), borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }, x: { grid: { display: false }, ticks: { color: tc.text } } } }
    }));
    const t = d.statusTotals;
    charts.push(new Chart($('#statusDoughnut'), {
      type: 'doughnut',
      data: { labels: ['Present', 'Absent', 'Late', 'OD'], datasets: [{ data: [t.present, t.absent, t.late, t.od], backgroundColor: ['#16a34a', '#dc2626', '#f59e0b', '#2563eb'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: tc.text } } } }
    }));
  }
}

/* ================= STAFF: STUDENTS ================= */
let studentSearch = '';
let studentsCache = [];
async function viewStudents() {
  studentsCache = await api('/students');
  content.innerHTML = `
    <div class="controls">
      <input class="search" id="stuSearch" placeholder="Search roll, name or reg no…" value="${esc(studentSearch)}" />
      ${isAdmin() ? `<button class="btn" id="addStu">+ Add Student</button>` : ''}
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Roll</th><th>Name</th><th>Reg No</th><th>Semester</th><th>Attendance</th><th>Avg Marks</th>${isAdmin() ? '<th></th>' : ''}</tr></thead>
      <tbody id="stuBody"></tbody></table></div></div>`;
  if (isAdmin()) $('#addStu').onclick = () => studentForm();
  $('#stuSearch').oninput = e => { studentSearch = e.target.value; drawStudents(); };
  drawStudents();
}
function drawStudents() {
  const q = studentSearch.trim().toLowerCase();
  const rows = studentsCache.filter(s => !q || s.name.toLowerCase().includes(q) || s.reg.toLowerCase().includes(q) || (s.roll || '').toLowerCase().includes(q));
  const body = $('#stuBody');
  const cols = isAdmin() ? 7 : 6;
  if (!rows.length) { body.innerHTML = `<tr><td colspan="${cols}"><div class="empty">No students found.</div></td></tr>`; return; }
  body.innerHTML = rows.map(s => {
    return `<tr>
      <td>${esc(s.roll || '—')}</td>
      <td><span class="name-cell">${avatarHTML(s.photo, s.name)}${esc(s.name)}</span></td><td>${esc(s.reg)}</td><td>Sem ${esc(s.sem)}</td>
      <td>${progressBar(s.stats.pct, attColor(s.stats.pct))}</td>
      <td>${s.avgMark === null ? '—' : s.avgMark + '%'}</td>
      ${isAdmin() ? `<td><div class="btn-row">
        <button class="btn sm outline" data-edit="${s.id}">Edit</button>
        <button class="btn sm outline" data-del="${s.id}">Delete</button>
      </div></td>` : ''}</tr>`;
  }).join('');
  if (isAdmin()) {
    $$('[data-edit]', body).forEach(b => b.onclick = () => studentForm(b.dataset.edit));
    $$('[data-del]', body).forEach(b => b.onclick = () => delStudent(b.dataset.del));
  }
}
function studentForm(id) {
  const s = studentsCache.find(x => String(x.id) === String(id)) || { name: '', reg: '', sem: 5, email: '', photo: null };
  // undefined = unchanged, null = removed, string = new data URL
  let photoState;
  openModal(id ? 'Edit Student' : 'Add Student', `
    <div class="photo-uploader">
      <span id="f_photoPreview">${avatarHTML(s.photo, s.name, 'avatar-lg')}</span>
      <div class="photo-actions">
        <label class="btn sm outline">Upload Photo<input id="f_photo" type="file" accept="image/*" hidden /></label>
        <button type="button" class="btn sm ghost-danger" id="f_photoRemove" ${s.photo ? '' : 'style="display:none"'}>Remove</button>
      </div>
    </div>
    <div class="field"><label>Full Name</label><input id="f_name" value="${esc(s.name)}" placeholder="e.g. Priya Kumar" /></div>
    <div class="field-row">
      <div class="field"><label>Roll No</label><input id="f_roll" value="${esc(s.roll||'')}" placeholder="01" /></div>
      <div class="field"><label>Register No</label><input id="f_reg" value="${esc(s.reg)}" placeholder="714024169001" /></div>
      <div class="field"><label>Semester</label><select id="f_sem">${[1,2,3,4,5,6,7,8].map(n => `<option ${n==s.sem?'selected':''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Email</label><input id="f_email" value="${esc(s.email||'')}" placeholder="student@ece.edu" /></div>
    <div class="field"><label>Password ${id ? '<span style="font-weight:400">(leave blank to keep current)</span>' : ''}</label><input id="f_pw" type="text" placeholder="${id ? 'unchanged' : 'Student@123'}" /></div>
    <button class="btn" id="f_save" style="width:100%">${id ? 'Save Changes' : 'Add Student'}</button>`);

  const renderPreview = (photo, name) => { $('#f_photoPreview').innerHTML = avatarHTML(photo, name, 'avatar-lg'); };
  $('#f_photo').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try { photoState = await readImageAsDataURL(file); renderPreview(photoState, $('#f_name').value); $('#f_photoRemove').style.display = ''; }
    catch (err) { toast(err.message); }
  };
  $('#f_photoRemove').onclick = () => { photoState = null; renderPreview(null, $('#f_name').value); $('#f_photoRemove').style.display = 'none'; $('#f_photo').value = ''; };

  $('#f_save').onclick = async () => {
    const name = $('#f_name').value.trim(), reg = $('#f_reg').value.trim();
    if (!name || !reg) return toast('Name and Register No are required');
    const payload = { name, roll: $('#f_roll').value.trim(), reg, sem: +$('#f_sem').value, email: $('#f_email').value.trim(), password: $('#f_pw').value };
    if (photoState !== undefined) payload.photo = photoState; // only send when it changed
    try {
      if (id) await api('/students/' + id, { method: 'PUT', body: payload });
      else await api('/students', { method: 'POST', body: payload });
      closeModal(); toast(id ? 'Student updated' : 'Student added');
      studentsCache = await api('/students'); drawStudents();
    } catch (e) { toast(e.message); }
  };
}
function delStudent(id) {
  const s = studentsCache.find(x => String(x.id) === String(id));
  openModal('Delete Student', `<p style="margin-bottom:18px">Delete <b>${esc(s.name)}</b> and all their attendance & marks?</p>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn outline" id="d_no">Cancel</button>
      <button class="btn" id="d_yes" style="background:var(--red)">Delete</button></div>`);
  $('#d_no').onclick = closeModal;
  $('#d_yes').onclick = async () => {
    try { await api('/students/' + id, { method: 'DELETE' }); closeModal(); toast('Student deleted');
      studentsCache = await api('/students'); drawStudents(); } catch (e) { toast(e.message); }
  };
}

/* ================= FACULTY ================= */
let facultyCache = [];
async function viewFaculty() {
  facultyCache = await api('/faculty');
  content.innerHTML = `
    <div class="controls">
      <h3 style="margin-right:auto">Teaching Staff</h3>
      ${isAdmin() ? `<button class="btn" id="addFac">+ Add Faculty</button>` : ''}
    </div>
    <div class="faculty-grid" id="facGrid"></div>`;
  if (isAdmin()) $('#addFac').onclick = () => facultyForm();
  drawFaculty();
}
function drawFaculty() {
  const grid = $('#facGrid');
  grid.innerHTML = facultyCache.map(f => `
    <div class="panel faculty-card">
      <div class="fc-top">
        <span class="avatar initials">${esc(initials(f.name))}</span>
        <div class="fc-id">
          <h4>${esc(f.name)}</h4>
          <span class="badge ${f.role === 'hod' ? 'good' : 'info'}">${f.role === 'hod' ? 'HOD' : 'Faculty'}</span>
        </div>
      </div>
      <div class="fc-meta">
        <div><span>Department</span><b>${esc(f.department || '—')}</b></div>
        <div><span>Email</span><b>${esc(f.email)}</b></div>
        <div><span>Subjects</span><b>${f.subjects.length ? f.subjects.map(s => esc(s.code)).join(', ') : '—'}</b></div>
      </div>
      ${isAdmin() ? `<div class="btn-row" style="margin-top:14px">
        <button class="btn sm outline" data-edit="${f.id}">Edit</button>
        <button class="btn sm ghost-danger" data-del="${f.id}">Delete</button>
      </div>` : ''}
    </div>`).join('');
  if (isAdmin()) {
    $$('[data-edit]', grid).forEach(b => b.onclick = () => facultyForm(b.dataset.edit));
    $$('[data-del]', grid).forEach(b => b.onclick = () => delFaculty(b.dataset.del));
  }
}
function facultyForm(id) {
  const f = facultyCache.find(x => String(x.id) === String(id)) || { name: '', email: '', department: 'EE-VDT', role: 'faculty' };
  openModal(id ? 'Edit Faculty' : 'Add Faculty', `
    <div class="field"><label>Full Name</label><input id="ff_name" value="${esc(f.name)}" placeholder="e.g. Dr. A. Kumar" /></div>
    <div class="field-row">
      <div class="field"><label>Role</label><select id="ff_role">
        <option value="faculty" ${f.role!=='hod'?'selected':''}>Faculty</option>
        <option value="hod" ${f.role==='hod'?'selected':''}>HOD</option></select></div>
      <div class="field"><label>Department</label><input id="ff_dept" value="${esc(f.department||'')}" placeholder="EE-VDT" /></div>
    </div>
    <div class="field"><label>Email ${id ? '' : '<span style="font-weight:400">(auto-generated if blank)</span>'}</label><input id="ff_email" value="${esc(f.email||'')}" placeholder="name@siet.edu" /></div>
    <div class="field"><label>Password ${id ? '<span style="font-weight:400">(leave blank to keep current)</span>' : '<span style="font-weight:400">(default Faculty@123)</span>'}</label><input id="ff_pw" type="text" placeholder="${id ? 'unchanged' : 'Faculty@123'}" /></div>
    <button class="btn" id="ff_save" style="width:100%">${id ? 'Save Changes' : 'Add Faculty'}</button>`);
  $('#ff_save').onclick = async () => {
    const name = $('#ff_name').value.trim();
    if (!name) return toast('Name is required');
    const payload = { name, email: $('#ff_email').value.trim(), department: $('#ff_dept').value.trim(), role: $('#ff_role').value, password: $('#ff_pw').value };
    try {
      if (id) await api('/faculty/' + id, { method: 'PUT', body: payload });
      else await api('/faculty', { method: 'POST', body: payload });
      closeModal(); toast(id ? 'Faculty updated' : 'Faculty added');
      facultyCache = await api('/faculty'); drawFaculty();
    } catch (e) { toast(e.message); }
  };
}
function delFaculty(id) {
  const f = facultyCache.find(x => String(x.id) === String(id));
  openModal('Delete Faculty', `<p style="margin-bottom:18px">Delete <b>${esc(f.name)}</b>'s account?</p>
    <div class="btn-row" style="justify-content:flex-end">
      <button class="btn outline" id="fd_no">Cancel</button>
      <button class="btn" id="fd_yes" style="background:var(--red)">Delete</button></div>`);
  $('#fd_no').onclick = closeModal;
  $('#fd_yes').onclick = async () => {
    try { await api('/faculty/' + id, { method: 'DELETE' }); closeModal(); toast('Faculty deleted');
      facultyCache = await api('/faculty'); drawFaculty(); } catch (e) { toast(e.message); }
  };
}

/* ================= STAFF: ATTENDANCE (9 periods / day) ================= */
let attState = { date: new Date().toISOString().slice(0, 10), period: 1, subject: null, marks: {}, meta: null, readOnly: false };
async function viewAttendance() {
  const [students, mySubjects] = await Promise.all([api('/students'), api('/my/subjects')]);
  if (!students.length) { content.innerHTML = `<div class="panel"><div class="empty">Add students first before marking attendance.</div></div>`; return; }
  if (!mySubjects.length) { content.innerHTML = `<div class="panel"><div class="empty">No subjects are allocated to you.</div></div>`; return; }
  attState.subject = attState.subject && mySubjects.some(s => s.name === attState.subject) ? attState.subject : mySubjects[0].name;

  const periods = META.periods || [1,2,3,4,5,6,7,8,9];
  content.innerHTML = `
    <div class="controls">
      <label class="ctl-field"><span>Date</span><input type="date" id="a_date" value="${attState.date}" /></label>
      <label class="ctl-field"><span>Subject</span>
        <select id="a_subject">${mySubjects.map(s => `<option value="${esc(s.name)}" ${s.name===attState.subject?'selected':''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('')}</select>
      </label>
    </div>
    <div class="period-strip" id="periodStrip">
      ${periods.map(p => `<button class="period-btn ${p===attState.period?'active':''}" data-period="${p}">P${p}</button>`).join('')}
    </div>
    <div id="attSheet"></div>`;

  let attReq = 0;
  async function load() {
    const my = ++attReq;
    $('#attSheet').innerHTML = loadingHTML();
    const { exists, meta, marks } = await api(`/attendance?date=${attState.date}&period=${attState.period}`);
    if (my !== attReq) return; // superseded
    // If a session already exists for this period, its subject wins (dropdown follows it
    // when it's one this user can pick). For an empty period, use the current dropdown value.
    if (exists && meta) {
      attState.subject = meta.subject;
      const opt = $$('#a_subject option').find(o => o.value === meta.subject);
      if (opt) $('#a_subject').value = meta.subject;
    } else {
      attState.subject = $('#a_subject').value;
    }
    attState.meta = meta;
    attState.marks = {};
    students.forEach(s => attState.marks[s.id] = exists ? (marks[s.id] || 'absent') : 'present');
    // Read-only if locked, or the period was taken by a different faculty (unless I oversee).
    const takenByOther = exists && meta && meta.facultyId && meta.facultyId !== auth.user.id;
    attState.readOnly = !isOverseer() && !!(exists && meta && (meta.locked || takenByOther));
    drawSheet(exists);
  }

  function drawSheet(exists) {
    const subj = subjectByName(attState.subject) || { code: '', name: attState.subject, faculty: '' };
    const m = attState.meta;
    const locked = m && m.locked;
    const facultyLine = m && m.faculty ? `Taken by ${esc(m.faculty)}` : `Allocated: ${esc(subj.faculty)}`;
    $('#attSheet').innerHTML = `
      <div class="att-header panel">
        <div><h3>${esc(subj.name)}</h3><span class="att-sub">${esc(subj.code)} · ${facultyLine}</span></div>
        <div class="att-meta">
          <span class="badge info">${esc(attState.date)}</span>
          <span class="badge info">Period ${attState.period}</span>
          ${locked ? `<span class="badge low">🔒 Locked</span>` : (exists ? `<span class="badge good">Saved</span>` : `<span class="badge warn">Not taken</span>`)}
        </div>
      </div>
      ${attState.readOnly ? `<div class="panel notice">${locked ? 'This period is locked.' : 'This period was taken by another faculty.'} ${isOverseer() ? '' : 'Only Admin or HOD can change it.'}</div>` : ''}
      <div class="panel">
        ${attState.readOnly ? '' : `<div class="controls" style="margin-bottom:12px">
          <button class="btn outline sm" id="allPresent">All Present</button>
          <button class="btn outline sm" id="allAbsent">All Absent</button>
        </div>`}
        <div class="mark-list" id="markList"></div>
        <div class="btn-row" style="margin-top:18px">
          ${attState.readOnly ? '' : `<button class="btn" id="saveAtt">Save Attendance</button>
            <button class="btn outline" id="saveLock">Save &amp; End Period 🔒</button>`}
          ${(locked && isOverseer()) ? `<button class="btn ghost-danger" id="unlockAtt">Unlock Period</button>` : ''}
        </div>
      </div>`;

    $('#markList').innerHTML = students.map(s => `
      <div class="mark-row">
        <span class="m-roll">${esc(s.roll || '—')}</span>
        <span class="m-name">${esc(s.name)}</span><span class="m-reg">${esc(s.reg)}</span>
        <div class="seg ${attState.readOnly ? 'disabled' : ''}" data-stu="${s.id}">
          <button data-v="present">Present</button><button data-v="absent">Absent</button><button data-v="late">Late</button><button data-v="od">OD</button>
        </div></div>`).join('');
    $$('.seg').forEach(seg => {
      const id = seg.dataset.stu;
      const paint = () => $$('button', seg).forEach(b => b.className = attState.marks[id] === b.dataset.v ? 'on-' + b.dataset.v : '');
      paint();
      if (!attState.readOnly) $$('button', seg).forEach(b => b.onclick = () => { attState.marks[id] = b.dataset.v; paint(); });
    });

    if (!attState.readOnly) {
      $('#allPresent').onclick = () => { students.forEach(s => attState.marks[s.id] = 'present'); drawSheet(exists); };
      $('#allAbsent').onclick = () => { students.forEach(s => attState.marks[s.id] = 'absent'); drawSheet(exists); };
      $('#saveAtt').onclick = () => save(false);
      $('#saveLock').onclick = () => save(true);
    }
    const unlockBtn = $('#unlockAtt');
    if (unlockBtn) unlockBtn.onclick = async () => {
      try { await api('/attendance/unlock', { method: 'POST', body: { date: attState.date, period: attState.period } });
        toast('Period unlocked'); await load(); } catch (e) { toast(e.message); }
    };
  }

  async function save(lock) {
    try {
      await api('/attendance', { method: 'POST', body: { date: attState.date, period: attState.period, subject: attState.subject, marks: attState.marks, lock } });
      toast(lock ? 'Attendance saved & period ended' : 'Attendance saved');
      await load();
    } catch (e) { toast(e.message); }
  }

  $('#a_date').onchange = e => { attState.date = e.target.value; load(); };
  $('#a_subject').onchange = e => { attState.subject = e.target.value; if (attState.meta) attState.meta.subject = e.target.value; drawSheet(!!attState.meta); };
  $$('#periodStrip .period-btn').forEach(b => b.onclick = () => {
    attState.period = Number(b.dataset.period);
    $$('#periodStrip .period-btn').forEach(x => x.classList.toggle('active', x === b));
    load();
  });

  await load();
}

/* ================= STAFF: MARKS ================= */
let marksSubject = null, marksType = null;
async function viewMarks() {
  const students = await api('/students');
  if (!students.length) { content.innerHTML = `<div class="panel"><div class="empty">Add students first.</div></div>`; return; }
  marksSubject = marksSubject || subjectNames()[0];
  marksType = marksType || META.markTypes[0];
  // Default maximum score per assessment type: assignments are graded out of 10.
  const defaultMaxFor = t => t === 'Assignment' ? 10 : 100;
  content.innerHTML = `
    <div class="controls">
      <select id="m_subject">${META.subjects.map(s => `<option value="${esc(s.name)}" ${s.name===marksSubject?'selected':''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('')}</select>
      <select id="m_type">${META.markTypes.map(t => `<option ${t===marksType?'selected':''}>${esc(t)}</option>`).join('')}</select>
      <label id="m_subdateWrap" class="ctl-field" style="display:none">
        <span>Submission date</span>
        <input type="date" id="m_subdate" />
      </label>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Reg No</th><th>Marks Obtained</th><th>Max</th><th>Grade</th></tr></thead>
      <tbody id="marksBody"></tbody></table></div>
      <button class="btn" id="saveMarks" style="margin-top:16px">Save Marks</button></div>`;

  function syncTypeUI() {
    // The submission date only applies to assignments.
    $('#m_subdateWrap').style.display = marksType === 'Assignment' ? '' : 'none';
  }

  // Guards against out-of-order responses when subject/type change quickly.
  let marksReq = 0;
  async function drawMarks() {
    syncTypeUI();
    const my = ++marksReq;
    const resp = await api(`/marks?subject=${encodeURIComponent(marksSubject)}&type=${encodeURIComponent(marksType)}`);
    if (my !== marksReq) return; // a newer request superseded this one
    // Tolerate both the new { marks, submissionDate } shape and a legacy bare map.
    const map = resp && resp.marks ? resp.marks : (resp || {});
    const submissionDate = resp ? resp.submissionDate : null;
    if ($('#m_subdate')) $('#m_subdate').value = submissionDate || '';
    const defMax = defaultMaxFor(marksType);
    const inputCss = 'padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)';
    $('#marksBody').innerHTML = students.map(s => {
      const m = map[s.id];
      const obt = m ? m.obtained : '', max = m ? m.max : defMax;
      const g = m ? gradeFor((m.obtained / m.max) * 100) : '—';
      return `<tr data-stu="${s.id}">
        <td>${esc(s.name)}</td><td>${esc(s.reg)}</td>
        <td><input type="number" class="mk-obt" value="${obt}" min="0" style="width:90px;${inputCss}" /></td>
        <td><input type="number" class="mk-max" value="${max}" min="1" style="width:80px;${inputCss}" /></td>
        <td class="mk-grade"><span class="badge ${g==='F'?'low':'good'}">${g}</span></td></tr>`;
    }).join('');
  }
  $('#m_subject').onchange = e => { marksSubject = e.target.value; drawMarks(); };
  $('#m_type').onchange = e => { marksType = e.target.value; drawMarks(); };
  $('#saveMarks').onclick = async () => {
    const defMax = defaultMaxFor(marksType);
    const entries = $$('#marksBody tr').map(tr => ({
      studentId: Number(tr.dataset.stu),
      obtained: $('.mk-obt', tr).value,
      max: $('.mk-max', tr).value || defMax,
    }));
    const submissionDate = marksType === 'Assignment' ? ($('#m_subdate')?.value || null) : null;
    try { await api('/marks', { method: 'POST', body: { subject: marksSubject, type: marksType, entries, submissionDate } });
      toast('Marks saved'); drawMarks(); } catch (e) { toast(e.message); }
  };
  drawMarks();
}

/* ================= STAFF: REPORTS ================= */
async function viewReports() {
  const students = await api('/students');
  if (!students.length) { content.innerHTML = `<div class="panel"><div class="empty">No data to report yet.</div></div>`; return; }
  content.innerHTML = `
    <div class="controls">
      <select id="r_student"><option value="">— Select a student —</option>
        ${students.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.reg)})</option>`).join('')}</select>
      <button class="btn outline" id="exportCsv">Export CSV</button>
    </div>
    <div id="reportArea"><div class="panel"><div class="empty">Select a student to view their report card.</div></div></div>`;
  $('#r_student').onchange = e => e.target.value ? drawStaffReport(e.target.value) : ($('#reportArea').innerHTML = `<div class="panel"><div class="empty">Select a student.</div></div>`);
  $('#exportCsv').onclick = downloadCsv;
}
async function drawStaffReport(id) {
  const area = $('#reportArea');
  area.innerHTML = loadingHTML();
  const r = await api('/reports/student/' + id);
  renderReportCard(area, r, 'perfChartStaff');
}
async function downloadCsv() {
  const res = await fetch(API_BASE + '/api/export/csv', { headers: { Authorization: 'Bearer ' + auth.token } });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'attendance_report.csv'; a.click();
  toast('CSV exported');
}

/* shared report-card renderer (staff report + student dashboard) */
function renderReportCard(area, r, canvasId) {
  const st = r.stats;
  const withMarks = r.subjMarks.filter(x => x.pct !== null);
  const stu = r.student || {};
  area.innerHTML = `
    <div class="panel student-header">
      ${avatarHTML(stu.photo, stu.name, 'avatar-lg')}
      <div class="student-header-meta">
        <h3>${esc(stu.name || '')}</h3>
        <span>${stu.roll ? `Roll ${esc(stu.roll)} · ` : ''}${esc(stu.reg || '')}${stu.sem ? ` · Sem ${esc(stu.sem)}` : ''}</span>
      </div>
    </div>
    <div class="stat-grid">
      ${statCard('i-green', '✓', st.pct + '%', 'Attendance')}
      ${statCard('i-primary', '☰', st.present, 'Present')}
      ${statCard('i-red', '✕', st.absent, 'Absent')}
      ${statCard('i-amber', '⏱', st.late, 'Late')}
      ${statCard('i-blue', '◆', st.od, 'OD')}
    </div>
    ${st.pct < 75 && st.total ? `<div class="panel" style="border-color:var(--red)"><span class="badge low">⚠ Attendance below 75% — shortage warning</span></div>` : ''}
    <div class="panel-grid">
      <div class="panel"><div class="panel-head"><h3>Subject Performance</h3></div>
        ${withMarks.length ? `<div class="chart-box"><canvas id="${canvasId}"></canvas></div>` : `<div class="empty">No marks recorded.</div>`}</div>
      <div class="panel"><div class="panel-head"><h3>Report Card</h3></div>
        <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Score</th><th>Grade</th></tr></thead>
        <tbody>${r.subjMarks.map(x => `<tr><td>${esc(x.sub)}</td><td>${x.pct === null ? '—' : x.pct + '%'}</td>
          <td>${x.pct === null ? '—' : `<span class="badge ${x.grade==='F'?'low':'good'}">${x.grade}</span>`}</td></tr>`).join('')}</tbody></table></div></div>
    </div>`;
  if (withMarks.length) {
    const tc = themeColors();
    charts.push(new Chart($('#' + canvasId), {
      type: 'bar',
      data: { labels: withMarks.map(x => x.sub.split(' ')[0]), datasets: [{ label: 'Score %', data: withMarks.map(x => x.pct), backgroundColor: '#4f46e5', borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }, x: { grid: { display: false }, ticks: { color: tc.text } } } }
    }));
  }
}

/* ================= STUDENT VIEWS ================= */
async function viewMyDashboard() {
  const r = await api('/me/summary');
  content.innerHTML = `<div id="reportArea"></div>`;
  renderReportCard($('#reportArea'), r, 'perfChartMe');
}

async function viewMyAttendance() {
  const d = await api('/me/attendance');
  content.innerHTML = `
    <div class="stat-grid">
      ${statCard('i-green', '✓', d.stats.pct + '%', 'Overall Attendance')}
      ${statCard('i-primary', '☰', d.stats.present, 'Present')}
      ${statCard('i-red', '✕', d.stats.absent, 'Absent')}
      ${statCard('i-amber', '⏱', d.stats.late, 'Late')}
      ${statCard('i-blue', '◆', d.stats.od, 'OD')}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>By Subject</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Present</th><th>Absent</th><th>Late</th><th>OD</th><th>%</th></tr></thead>
      <tbody>${d.bySubject.filter(s => s.total).map(s => `<tr><td>${esc(s.sub)}</td><td>${s.present}</td><td>${s.absent}</td><td>${s.late}</td><td>${s.od}</td>
        <td>${progressBar(s.pct, attColor(s.pct))}</td></tr>`).join('') || `<tr><td colspan="6"><div class="empty">No attendance recorded yet.</div></td></tr>`}</tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>History</h3></div>
      ${d.history.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Subject</th><th>Status</th></tr></thead>
        <tbody>${d.history.map(h => `<tr><td>${esc(h.date)}</td><td>${esc(h.subject)}</td>
          <td><span class="badge ${h.status}">${h.status.toUpperCase()}</span></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">No attendance records yet.</div>`}
    </div>`;
}

async function viewMyMarks() {
  const d = await api('/me/marks');
  const withMarks = d.bySubject.filter(s => s.pct !== null);
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h3>Performance</h3></div>
      ${withMarks.length ? `<div class="chart-box"><canvas id="myMarksChart"></canvas></div>` : `<div class="empty">No marks recorded yet.</div>`}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Marks by Subject</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Subject</th>${d.markTypes.map(t => `<th>${esc(t)}</th>`).join('')}<th>Overall</th><th>Grade</th></tr></thead>
        <tbody>${d.bySubject.map(s => `<tr><td>${esc(s.sub)}</td>
          ${d.markTypes.map(t => { const m = s.byType[t]; return `<td>${m ? `${m.obtained}/${m.max}${m.submissionDate ? `<br><span class="muted" style="font-size:11px">${esc(m.submissionDate)}</span>` : ''}` : '—'}</td>`; }).join('')}
          <td>${s.pct === null ? '—' : s.pct + '%'}</td>
          <td>${s.grade ? `<span class="badge ${s.grade==='F'?'low':'good'}">${s.grade}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  if (withMarks.length) {
    const tc = themeColors();
    charts.push(new Chart($('#myMarksChart'), {
      type: 'bar',
      data: { labels: withMarks.map(s => s.sub.split(' ')[0]), datasets: [{ label: 'Score %', data: withMarks.map(s => s.pct), backgroundColor: '#4f46e5', borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }, x: { grid: { display: false }, ticks: { color: tc.text } } } }
    }));
  }
}

/* ================= THEME ================= */
function applyTheme(t) {
  document.body.dataset.theme = t;
  $('#themeToggle').textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('ece_theme', t);
}
$('#themeToggle').onclick = () => { applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'); if (currentView) render(currentView); };
applyTheme(localStorage.getItem('ece_theme') || 'light');

/* ================= LOGIN / SESSION ================= */
const loginScreen = $('#loginScreen');
const appEl = $('#app');
let loginRole = 'staff';

const HINTS = {
  staff: 'Admin: <b>admin@ece.edu / Admin@123</b><br>HOD: <b>dhilip.kumar@siet.edu / Hod@123</b><br>Faculty: <b>boopathy@siet.edu / Faculty@123</b>',
  student: 'Register No: <b>714024169001</b> … <b>714024169054</b><br>Password: <b>Student@123</b>',
};
function setLoginRole(role) {
  loginRole = role;
  $$('.role-btn').forEach(b => b.classList.toggle('active', b.dataset.role === role));
  $('#idLabel').textContent = role === 'student' ? 'Register Number' : 'Email';
  $('#loginId').placeholder = role === 'student' ? '714024169001' : 'name@siet.edu';
  $('#loginHint').innerHTML = HINTS[role];
}
$$('.role-btn').forEach(b => b.onclick = () => setLoginRole(b.dataset.role));

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  const identifier = $('#loginId').value.trim();
  const password = $('#loginPw').value;
  if (!identifier || !password) { $('#loginError').textContent = 'Enter your credentials'; return; }
  try {
    const { token, user } = await api('/login', { method: 'POST', body: { role: loginRole, identifier, password } });
    auth = { token, user };
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    await enterApp();
  } catch (err) { $('#loginError').textContent = err.message; }
};

function logout() {
  auth = { token: null, user: null };
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  appEl.style.display = 'none';
  loginScreen.style.display = 'grid';
  $('#loginPw').value = '';
}
$('#logoutBtn').onclick = logout;
$('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');

async function enterApp() {
  META = await api('/meta');
  loginScreen.style.display = 'none';
  appEl.style.display = 'flex';
  buildSidebar();
  render(NAVS[navKey()][0].view);
}

/* ---------- boot ---------- */
setLoginRole('staff');
(async function boot() {
  if (auth.token && auth.user) {
    try { await api('/me'); await enterApp(); return; }
    catch { logout(); }
  }
  loginScreen.style.display = 'grid';
})();
