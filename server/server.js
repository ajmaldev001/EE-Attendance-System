const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, q, one, tx, init, SUBJECTS, MARK_TYPES } = require('./db');
const { signToken, authenticate, requireRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* small async wrapper so thrown errors return JSON 500 instead of crashing */
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

/* ---------- Query helpers ---------- */
async function attendanceStats(studentId) {
  const rows = await q('SELECT status, COUNT(*)::int AS c FROM attendance_records WHERE student_id = $1 GROUP BY status', [studentId]);
  let present = 0, absent = 0, od = 0;
  rows.forEach(r => { if (r.status === 'present') present = r.c; else if (r.status === 'od') od = r.c; else absent = r.c; });
  const total = present + absent + od;
  const pct = total ? Math.round(((present + od) / total) * 100) : 0;
  return { total, present, absent, od, pct };
}

async function studentAvgMark(studentId) {
  const rows = await q('SELECT obtained, max FROM marks WHERE student_id = $1', [studentId]);
  if (!rows.length) return null;
  const avg = rows.reduce((a, m) => a + (m.obtained / m.max) * 100, 0) / rows.length;
  return Math.round(avg);
}

function gradeFor(pct) {
  if (pct >= 90) return 'O'; if (pct >= 80) return 'A+'; if (pct >= 70) return 'A';
  if (pct >= 60) return 'B+'; if (pct >= 50) return 'B'; if (pct >= 40) return 'C'; return 'F';
}

function publicStudent(s) {
  return { id: s.id, name: s.name, reg: s.reg_no, sem: s.semester, email: s.email };
}

/* ================= AUTH ================= */
app.get('/api/meta', (req, res) => res.json({ subjects: SUBJECTS, markTypes: MARK_TYPES }));

app.post('/api/login', wrap(async (req, res) => {
  const { role, identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Missing credentials' });

  if (role === 'student') {
    const s = await one('SELECT * FROM students WHERE reg_no = $1', [identifier.trim()]);
    if (!s || !bcrypt.compareSync(password, s.password_hash)) return res.status(401).json({ error: 'Invalid register number or password' });
    const user = { id: s.id, role: 'student', name: s.name, reg: s.reg_no };
    return res.json({ token: signToken(user), user });
  }
  const u = await one('SELECT * FROM users WHERE email = $1', [identifier.trim().toLowerCase()]);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  const user = { id: u.id, role: u.role, name: u.name, email: u.email };
  return res.json({ token: signToken(user), user });
}));

app.get('/api/me', authenticate, (req, res) => res.json({ user: req.user }));

/* ================= STAFF / ADMIN ================= */
const staff = [authenticate, requireRole('admin', 'staff')];

async function studentWithStats(s) {
  return { ...publicStudent(s), stats: await attendanceStats(s.id), avgMark: await studentAvgMark(s.id) };
}

// Dashboard stats
app.get('/api/dashboard', staff, wrap(async (req, res) => {
  const students = await q('SELECT * FROM students ORDER BY reg_no');
  const sessions = Number((await one('SELECT COUNT(*)::int AS c FROM attendance_sessions')).c);
  const withStats = await Promise.all(students.map(async s => ({ ...publicStudent(s), stats: await attendanceStats(s.id) })));
  const pcts = withStats.map(s => s.stats.pct);
  const avgAtt = withStats.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / withStats.length) : 0;
  const low = withStats.filter(s => s.stats.total && s.stats.pct < 75);
  let present = 0, absent = 0, od = 0;
  const totals = await q('SELECT status, COUNT(*)::int AS c FROM attendance_records GROUP BY status');
  totals.forEach(r => { if (r.status === 'present') present = r.c; else if (r.status === 'od') od = r.c; else absent = r.c; });
  res.json({ totalStudents: students.length, sessions, avgAtt, low, students: withStats, statusTotals: { present, absent, od } });
}));

// Students CRUD
app.get('/api/students', staff, wrap(async (req, res) => {
  const rows = await q('SELECT * FROM students ORDER BY reg_no');
  res.json(await Promise.all(rows.map(studentWithStats)));
}));

app.post('/api/students', staff, wrap(async (req, res) => {
  const { name, reg, sem, email, password } = req.body || {};
  if (!name || !reg) return res.status(400).json({ error: 'Name and Register No are required' });
  const exists = await one('SELECT id FROM students WHERE reg_no = $1', [reg.trim()]);
  if (exists) return res.status(409).json({ error: 'Register No already exists' });
  const pw = bcrypt.hashSync(password && password.length ? password : 'Student@123', 10);
  const row = await one('INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [name.trim(), reg.trim(), Number(sem) || 5, (email || '').trim(), pw]);
  res.status(201).json({ id: row.id });
}));

app.put('/api/students/:id', staff, wrap(async (req, res) => {
  const { name, reg, sem, email, password } = req.body || {};
  const s = await one('SELECT * FROM students WHERE id = $1', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  if (reg) {
    const dup = await one('SELECT id FROM students WHERE reg_no = $1 AND id != $2', [reg.trim(), s.id]);
    if (dup) return res.status(409).json({ error: 'Register No already exists' });
  }
  const pw = password && password.length ? bcrypt.hashSync(password, 10) : s.password_hash;
  await pool.query('UPDATE students SET name=$1, reg_no=$2, semester=$3, email=$4, password_hash=$5 WHERE id=$6',
    [name ?? s.name, (reg ?? s.reg_no).trim(), Number(sem) || s.semester, email ?? s.email, pw, s.id]);
  res.json({ ok: true });
}));

app.delete('/api/students/:id', staff, wrap(async (req, res) => {
  await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// Attendance
app.get('/api/attendance', staff, wrap(async (req, res) => {
  const { date, subject } = req.query;
  if (!date || !subject) return res.status(400).json({ error: 'date and subject required' });
  const session = await one('SELECT id FROM attendance_sessions WHERE date = $1 AND subject = $2', [date, subject]);
  const marks = {};
  if (session) {
    (await q('SELECT student_id, status FROM attendance_records WHERE session_id = $1', [session.id]))
      .forEach(r => { marks[r.student_id] = r.status; });
  }
  res.json({ exists: !!session, marks });
}));

app.post('/api/attendance', staff, wrap(async (req, res) => {
  const { date, subject, marks } = req.body || {};
  if (!date || !subject || typeof marks !== 'object') return res.status(400).json({ error: 'date, subject, marks required' });
  await tx(async (client) => {
    let session = (await client.query('SELECT id FROM attendance_sessions WHERE date = $1 AND subject = $2', [date, subject])).rows[0];
    if (!session) {
      session = (await client.query('INSERT INTO attendance_sessions (date, subject) VALUES ($1,$2) RETURNING id', [date, subject])).rows[0];
    }
    for (const [sid, status] of Object.entries(marks)) {
      if (['present', 'absent', 'od'].includes(status)) {
        await client.query(
          `INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,$3)
           ON CONFLICT (session_id, student_id) DO UPDATE SET status = EXCLUDED.status`,
          [session.id, Number(sid), status]);
      }
    }
  });
  res.json({ ok: true });
}));

// Marks
app.get('/api/marks', staff, wrap(async (req, res) => {
  const { subject, type } = req.query;
  if (!subject || !type) return res.status(400).json({ error: 'subject and type required' });
  const rows = await q('SELECT student_id, obtained, max FROM marks WHERE subject = $1 AND type = $2', [subject, type]);
  const map = {};
  rows.forEach(r => { map[r.student_id] = { obtained: r.obtained, max: r.max }; });
  res.json(map);
}));

app.post('/api/marks', staff, wrap(async (req, res) => {
  const { subject, type, entries } = req.body || {};
  if (!subject || !type || !Array.isArray(entries)) return res.status(400).json({ error: 'subject, type, entries required' });
  await tx(async (client) => {
    for (const e of entries) {
      await client.query('DELETE FROM marks WHERE student_id = $1 AND subject = $2 AND type = $3', [e.studentId, subject, type]);
      if (e.obtained !== null && e.obtained !== '' && !isNaN(e.obtained)) {
        await client.query('INSERT INTO marks (student_id, subject, type, obtained, max) VALUES ($1,$2,$3,$4,$5)',
          [e.studentId, subject, type, Number(e.obtained), Number(e.max) || 100]);
      }
    }
  });
  res.json({ ok: true });
}));

// Reports
async function buildStudentReport(id) {
  const s = await one('SELECT * FROM students WHERE id = $1', [id]);
  if (!s) return null;
  const stats = await attendanceStats(id);
  const subjMarks = [];
  for (const sub of SUBJECTS) {
    const ms = await q('SELECT obtained, max FROM marks WHERE student_id = $1 AND subject = $2', [id, sub]);
    if (!ms.length) { subjMarks.push({ sub, pct: null, grade: null }); continue; }
    const pct = Math.round(ms.reduce((a, m) => a + (m.obtained / m.max) * 100, 0) / ms.length);
    subjMarks.push({ sub, pct, grade: gradeFor(pct) });
  }
  const history = await q(`
    SELECT ses.date, ses.subject, r.status
    FROM attendance_records r JOIN attendance_sessions ses ON ses.id = r.session_id
    WHERE r.student_id = $1 ORDER BY ses.date DESC, ses.subject`, [id]);
  return { student: publicStudent(s), stats, subjMarks, history };
}

app.get('/api/reports/student/:id', staff, wrap(async (req, res) => {
  const report = await buildStudentReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Student not found' });
  res.json(report);
}));

app.get('/api/export/csv', staff, wrap(async (req, res) => {
  const students = await q('SELECT * FROM students ORDER BY reg_no');
  const rows = [['Name', 'Reg No', 'Semester', 'Attendance %', 'Present', 'Absent', 'OD', 'Avg Marks %']];
  for (const s of students) {
    const st = await attendanceStats(s.id), avg = await studentAvgMark(s.id);
    rows.push([s.name, s.reg_no, s.semester, st.pct, st.present, st.absent, st.od, avg ?? '']);
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
  res.send(csv);
}));

/* ================= STUDENT (own data only) ================= */
const studentOnly = [authenticate, requireRole('student')];

app.get('/api/me/summary', studentOnly, wrap(async (req, res) => {
  const report = await buildStudentReport(req.user.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
}));

app.get('/api/me/attendance', studentOnly, wrap(async (req, res) => {
  const history = await q(`
    SELECT ses.date, ses.subject, r.status
    FROM attendance_records r JOIN attendance_sessions ses ON ses.id = r.session_id
    WHERE r.student_id = $1 ORDER BY ses.date DESC, ses.subject`, [req.user.id]);
  const bySubject = SUBJECTS.map(sub => {
    const recs = history.filter(h => h.subject === sub);
    let present = 0, absent = 0, od = 0;
    recs.forEach(h => { if (h.status === 'present') present++; else if (h.status === 'od') od++; else absent++; });
    const total = recs.length, pct = total ? Math.round(((present + od) / total) * 100) : 0;
    return { sub, total, present, absent, od, pct };
  });
  res.json({ stats: await attendanceStats(req.user.id), history, bySubject });
}));

app.get('/api/me/marks', studentOnly, wrap(async (req, res) => {
  const rows = await q('SELECT subject, type, obtained, max FROM marks WHERE student_id = $1', [req.user.id]);
  const bySubject = SUBJECTS.map(sub => {
    const ms = rows.filter(r => r.subject === sub);
    const byType = {};
    ms.forEach(m => { byType[m.type] = { obtained: m.obtained, max: m.max }; });
    const pct = ms.length ? Math.round(ms.reduce((a, m) => a + (m.obtained / m.max) * 100, 0) / ms.length) : null;
    return { sub, byType, pct, grade: pct === null ? null : gradeFor(pct) };
  });
  res.json({ markTypes: MARK_TYPES, bySubject });
}));

/* ================= STATIC FRONTEND ================= */
app.use(express.static(path.join(__dirname, '..')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

/* ================= STARTUP ================= */
// Bind the port FIRST so the host (Render) detects an open port immediately,
// then initialize the database. If init were awaited before listen, a slow or
// hanging DB connection would prevent the port from ever opening.
app.listen(PORT, () => {
  console.log(`✅ Attendance server listening on port ${PORT}`);
  init()
    .then(() => console.log('✅ Database initialized'))
    .catch(err => console.error('❌ Database init failed:', err.message));
});
