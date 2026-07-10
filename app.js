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
const NAVS = {
  staff: [
    { view: 'dashboard', glyph: '▚', label: 'Dashboard' },
    { view: 'students', glyph: '☰', label: 'Students' },
    { view: 'attendance', glyph: '✓', label: 'Attendance' },
    { view: 'marks', glyph: '✎', label: 'Marks' },
    { view: 'reports', glyph: '▤', label: 'Reports' },
  ],
  student: [
    { view: 'mydash', glyph: '▚', label: 'Dashboard' },
    { view: 'myattendance', glyph: '✓', label: 'My Attendance' },
    { view: 'mymarks', glyph: '✎', label: 'My Marks' },
  ],
};
function navKey() { return auth.user.role === 'student' ? 'student' : 'staff'; }

let currentView = null;
function buildSidebar() {
  const items = NAVS[navKey()];
  $('#sidebar .nav').innerHTML = items.map((it, i) =>
    `<button class="nav-item ${i === 0 ? 'active' : ''}" data-view="${it.view}"><span class="ico">${it.glyph}</span> ${it.label}</button>`
  ).join('');
  $$('.nav-item').forEach(b => b.onclick = () => { render(b.dataset.view); $('#sidebar').classList.remove('open'); });

  const u = auth.user;
  $('#userName').textContent = u.name;
  $('#userRole').textContent = u.role;
  $('#userAvatar').textContent = (u.name || 'U').trim().charAt(0).toUpperCase();
}

const VIEW_FN = {
  dashboard: viewDashboard, students: viewStudents, attendance: viewAttendance, marks: viewMarks, reports: viewReports,
  mydash: viewMyDashboard, myattendance: viewMyAttendance, mymarks: viewMyMarks,
};
const VIEW_TITLE = {
  dashboard: 'Dashboard', students: 'Students', attendance: 'Attendance', marks: 'Marks', reports: 'Reports',
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
  const d = await api('/dashboard');
  content.innerHTML = `
    <div class="stat-grid">
      ${statCard('i-primary', '☰', d.totalStudents, 'Total Students')}
      ${statCard('i-green', '✓', d.avgAtt + '%', 'Avg Attendance')}
      ${statCard('i-blue', '▤', d.sessions, 'Sessions Logged')}
      ${statCard('i-red', '!', d.low.length, 'Below 75%')}
    </div>
    <div class="panel-grid">
      <div class="panel"><div class="panel-head"><h3>Attendance by Student</h3></div><div class="chart-box"><canvas id="attBar"></canvas></div></div>
      <div class="panel"><div class="panel-head"><h3>Overall Status</h3></div><div class="chart-box"><canvas id="statusDoughnut"></canvas></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Low Attendance Alerts (&lt; 75%)</h3></div>
      ${d.low.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Reg No</th><th>Attendance</th><th>Status</th></tr></thead>
        <tbody>${d.low.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.reg)}</td>
          <td>${progressBar(s.stats.pct, 'var(--red)')}</td><td><span class="badge low">Low</span></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">No students below 75%. 🎉</div>`}
    </div>`;

  if (d.students.length) {
    const tc = themeColors();
    charts.push(new Chart($('#attBar'), {
      type: 'bar',
      data: { labels: d.students.map(s => s.reg), datasets: [{ label: 'Attendance %', data: d.students.map(s => s.stats.pct),
        backgroundColor: d.students.map(s => s.stats.pct < 75 ? '#dc2626' : '#4f46e5'), borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }, x: { grid: { display: false }, ticks: { color: tc.text } } } }
    }));
    const t = d.statusTotals;
    charts.push(new Chart($('#statusDoughnut'), {
      type: 'doughnut',
      data: { labels: ['Present', 'Absent', 'OD'], datasets: [{ data: [t.present, t.absent, t.od], backgroundColor: ['#16a34a', '#dc2626', '#2563eb'], borderWidth: 0 }] },
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
      <input class="search" id="stuSearch" placeholder="Search name or reg no…" value="${esc(studentSearch)}" />
      <button class="btn" id="addStu">+ Add Student</button>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Reg No</th><th>Semester</th><th>Attendance</th><th>Avg Marks</th><th></th></tr></thead>
      <tbody id="stuBody"></tbody></table></div></div>`;
  $('#addStu').onclick = () => studentForm();
  $('#stuSearch').oninput = e => { studentSearch = e.target.value; drawStudents(); };
  drawStudents();
}
function drawStudents() {
  const q = studentSearch.trim().toLowerCase();
  const rows = studentsCache.filter(s => !q || s.name.toLowerCase().includes(q) || s.reg.toLowerCase().includes(q));
  const body = $('#stuBody');
  if (!rows.length) { body.innerHTML = `<tr><td colspan="6"><div class="empty">No students found.</div></td></tr>`; return; }
  body.innerHTML = rows.map(s => {
    const col = s.stats.pct < 75 ? 'var(--red)' : 'var(--green)';
    return `<tr>
      <td><span class="name-cell">${avatarHTML(s.photo, s.name)}${esc(s.name)}</span></td><td>${esc(s.reg)}</td><td>Sem ${esc(s.sem)}</td>
      <td>${progressBar(s.stats.pct, col)}</td>
      <td>${s.avgMark === null ? '—' : s.avgMark + '%'}</td>
      <td><div class="btn-row">
        <button class="btn sm outline" data-edit="${s.id}">Edit</button>
        <button class="btn sm outline" data-del="${s.id}">Delete</button>
      </div></td></tr>`;
  }).join('');
  $$('[data-edit]', body).forEach(b => b.onclick = () => studentForm(b.dataset.edit));
  $$('[data-del]', body).forEach(b => b.onclick = () => delStudent(b.dataset.del));
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
    const payload = { name, reg, sem: +$('#f_sem').value, email: $('#f_email').value.trim(), password: $('#f_pw').value };
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

/* ================= STAFF: ATTENDANCE ================= */
let attState = { date: new Date().toISOString().slice(0, 10), subject: null, marks: {} };
async function viewAttendance() {
  const students = await api('/students');
  if (!students.length) { content.innerHTML = `<div class="panel"><div class="empty">Add students first before marking attendance.</div></div>`; return; }
  attState.subject = attState.subject || META.subjects[0];
  content.innerHTML = `
    <div class="controls">
      <input type="date" id="a_date" value="${attState.date}" />
      <select id="a_subject">${META.subjects.map(s => `<option ${s===attState.subject?'selected':''}>${esc(s)}</option>`).join('')}</select>
      <button class="btn outline" id="allPresent">All Present</button>
      <button class="btn outline" id="allAbsent">All Absent</button>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Mark Attendance</h3><span id="existingTag"></span></div>
      <div class="mark-list" id="markList"></div>
      <button class="btn" id="saveAtt" style="margin-top:18px;width:100%">Save Attendance</button>
    </div>`;

  // Guards against out-of-order responses when date/subject change quickly.
  let attReq = 0;
  async function syncFromExisting() {
    const my = ++attReq;
    const { exists, marks } = await api(`/attendance?date=${attState.date}&subject=${encodeURIComponent(attState.subject)}`);
    if (my !== attReq) return false; // superseded by a newer request
    attState.marks = {};
    students.forEach(s => attState.marks[s.id] = exists ? (marks[s.id] || 'absent') : 'present');
    $('#existingTag').innerHTML = exists ? `<span class="badge info">Editing saved record</span>` : '';
    return true;
  }
  function drawMarks() {
    $('#markList').innerHTML = students.map(s => `
      <div class="mark-row">
        <span class="m-name">${esc(s.name)}</span><span class="m-reg">${esc(s.reg)}</span>
        <div class="seg" data-stu="${s.id}">
          <button data-v="present">Present</button><button data-v="absent">Absent</button><button data-v="od">OD</button>
        </div></div>`).join('');
    $$('.seg').forEach(seg => {
      const id = seg.dataset.stu;
      const paint = () => $$('button', seg).forEach(b => b.className = attState.marks[id] === b.dataset.v ? 'on-' + b.dataset.v : '');
      paint();
      $$('button', seg).forEach(b => b.onclick = () => { attState.marks[id] = b.dataset.v; paint(); });
    });
  }
  await syncFromExisting(); drawMarks();

  $('#a_date').onchange = async e => { attState.date = e.target.value; if (await syncFromExisting()) drawMarks(); };
  $('#a_subject').onchange = async e => { attState.subject = e.target.value; if (await syncFromExisting()) drawMarks(); };
  $('#allPresent').onclick = () => { students.forEach(s => attState.marks[s.id] = 'present'); drawMarks(); };
  $('#allAbsent').onclick = () => { students.forEach(s => attState.marks[s.id] = 'absent'); drawMarks(); };
  $('#saveAtt').onclick = async () => {
    try { await api('/attendance', { method: 'POST', body: { date: attState.date, subject: attState.subject, marks: attState.marks } });
      toast('Attendance saved'); await syncFromExisting(); } catch (e) { toast(e.message); }
  };
}

/* ================= STAFF: MARKS ================= */
let marksSubject = null, marksType = null;
async function viewMarks() {
  const students = await api('/students');
  if (!students.length) { content.innerHTML = `<div class="panel"><div class="empty">Add students first.</div></div>`; return; }
  marksSubject = marksSubject || META.subjects[0];
  marksType = marksType || META.markTypes[0];
  // Default maximum score per assessment type: assignments are graded out of 10.
  const defaultMaxFor = t => t === 'Assignment' ? 10 : 100;
  content.innerHTML = `
    <div class="controls">
      <select id="m_subject">${META.subjects.map(s => `<option ${s===marksSubject?'selected':''}>${esc(s)}</option>`).join('')}</select>
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
        <span>${esc(stu.reg || '')}${stu.sem ? ` · Sem ${esc(stu.sem)}` : ''}</span>
      </div>
    </div>
    <div class="stat-grid">
      ${statCard('i-green', '✓', st.pct + '%', 'Attendance')}
      ${statCard('i-primary', '☰', st.present, 'Present Days')}
      ${statCard('i-red', '✕', st.absent, 'Absent Days')}
      ${statCard('i-blue', '◆', st.od, 'OD Days')}
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
      ${statCard('i-blue', '◆', d.stats.od, 'OD')}
    </div>
    <div class="panel">
      <div class="panel-head"><h3>By Subject</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Present</th><th>Absent</th><th>OD</th><th>%</th></tr></thead>
      <tbody>${d.bySubject.map(s => `<tr><td>${esc(s.sub)}</td><td>${s.present}</td><td>${s.absent}</td><td>${s.od}</td>
        <td>${progressBar(s.pct, s.pct < 75 ? 'var(--red)' : 'var(--green)')}</td></tr>`).join('')}</tbody></table></div>
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
  staff: 'Demo — Admin: <b>admin@ece.edu / Admin@123</b><br>Staff: <b>staff@ece.edu / Staff@123</b>',
  student: 'Register No: <b>714024169001</b> … <b>714024169054</b><br>Password: <b>Student@123</b>',
};
function setLoginRole(role) {
  loginRole = role;
  $$('.role-btn').forEach(b => b.classList.toggle('active', b.dataset.role === role));
  $('#idLabel').textContent = role === 'student' ? 'Register Number' : 'Email';
  $('#loginId').placeholder = role === 'student' ? '714024169001' : 'admin@ece.edu';
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
