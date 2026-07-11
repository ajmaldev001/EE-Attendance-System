const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { pool, q, one, tx, init, COLLEGE, SUBJECTS, SUBJECT_NAMES, FACULTY, PERIODS, MARK_TYPES, facultyEmail } = require('./db');
const { signToken, authenticate, requireRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Raise the limit so student photos (small base64 data URLs) fit comfortably.
app.use(express.json({ limit: '5mb' }));

/* small async wrapper so thrown errors return JSON 500 instead of crashing */
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

/* ---------- Query helpers ---------- */
async function attendanceStats(studentId) {
  const rows = await q('SELECT status, COUNT(*)::int AS c FROM attendance_records WHERE student_id = $1 GROUP BY status', [studentId]);
  let present = 0, absent = 0, late = 0, od = 0;
  rows.forEach(r => {
    if (r.status === 'present') present = r.c;
    else if (r.status === 'late') late = r.c;
    else if (r.status === 'od') od = r.c;
    else absent = r.c;
  });
  const total = present + absent + late + od;
  // Late arrivals and on-duty (OD) both count as having attended the period.
  const pct = total ? Math.round(((present + late + od) / total) * 100) : 0;
  return { total, present, absent, late, od, pct };
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
  return { id: s.id, name: s.name, roll: s.roll_no || null, reg: s.reg_no, sem: s.semester, email: s.email, photo: s.photo || null, lateral: !!s.lateral_entry };
}

function publicFaculty(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, department: u.department || null };
}

// Subjects a given user may take attendance for. Admin/HOD/class advisor see
// all; faculty see the subjects whose allocation names them.
function subjectsForUser(user) {
  if (!user || user.role === 'admin' || user.role === 'hod' || user.role === 'advisor') return SUBJECTS;
  const needle = (user.name || '').toLowerCase();
  return SUBJECTS.filter(s => s.faculty.toLowerCase().includes(needle));
}

// College identity with the class advisor resolved from whoever holds the role.
async function collegeInfo() {
  const adv = await one("SELECT name FROM users WHERE role = 'advisor' ORDER BY id LIMIT 1");
  return { ...COLLEGE, classAdvisor: adv ? adv.name : COLLEGE.classAdvisor };
}

/* ================= AUTH ================= */
app.get('/api/meta', wrap(async (req, res) => res.json({ college: await collegeInfo(), subjects: SUBJECTS, periods: PERIODS, markTypes: MARK_TYPES })));

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
  const user = { id: u.id, role: u.role, name: u.name, email: u.email, department: u.department || null };
  return res.json({ token: signToken(user), user });
}));

app.get('/api/me', authenticate, (req, res) => res.json({ user: req.user }));

/* ================= ROLE GROUPS ================= */
// admin      → full control (manage students, faculty, subjects)
// adminHod   → admin + HOD oversight (unlock attendance, view everything)
// staff      → anyone who works with class data: admin, HOD, faculty
const admin = [authenticate, requireRole('admin')];
const adminHod = [authenticate, requireRole('admin', 'hod')];
const staff = [authenticate, requireRole('admin', 'staff', 'hod', 'faculty', 'advisor')];

async function studentWithStats(s) {
  return { ...publicStudent(s), stats: await attendanceStats(s.id), avgMark: await studentAvgMark(s.id) };
}

// Dashboard stats
app.get('/api/dashboard', staff, wrap(async (req, res) => {
  const { date } = req.query;
  const students = await q('SELECT * FROM students ORDER BY reg_no');
  const sessions = Number((await one('SELECT COUNT(*)::int AS c FROM attendance_sessions')).c);
  const totalFaculty = Number((await one("SELECT COUNT(*)::int AS c FROM users WHERE role IN ('hod','faculty','advisor')")).c);
  const withStats = await Promise.all(students.map(async s => ({ ...publicStudent(s), stats: await attendanceStats(s.id) })));
  const pcts = withStats.map(s => s.stats.pct);
  const avgAtt = withStats.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / withStats.length) : 0;
  const low = withStats.filter(s => s.stats.total && s.stats.pct < 75);
  let present = 0, absent = 0, late = 0, od = 0;
  const totals = await q('SELECT status, COUNT(*)::int AS c FROM attendance_records GROUP BY status');
  totals.forEach(r => { if (r.status === 'present') present = r.c; else if (r.status === 'late') late = r.c; else if (r.status === 'od') od = r.c; else absent = r.c; });

  // Today's activity: how many of the 9 periods have been taken, and today's attendance %.
  const day = date || null;
  let periodsToday = 0, todayPct = null;
  if (day) {
    periodsToday = Number((await one('SELECT COUNT(*)::int AS c FROM attendance_sessions WHERE date = $1', [day])).c);
    const t = await one(`
      SELECT COUNT(*) FILTER (WHERE r.status IN ('present','late','od'))::int AS attended, COUNT(r.*)::int AS total
      FROM attendance_records r JOIN attendance_sessions s ON s.id = r.session_id WHERE s.date = $1`, [day]);
    if (t && t.total) todayPct = Math.round((t.attended / t.total) * 100);
  }

  res.json({
    college: await collegeInfo(),
    totalStudents: students.length, totalFaculty, sessions, avgAtt, low, students: withStats,
    statusTotals: { present, absent, late, od },
    today: { periods: periodsToday, totalPeriods: PERIODS.length, pct: todayPct },
  });
}));

// Students CRUD
app.get('/api/students', staff, wrap(async (req, res) => {
  const rows = await q('SELECT * FROM students ORDER BY reg_no');
  res.json(await Promise.all(rows.map(studentWithStats)));
}));

app.post('/api/students', admin, wrap(async (req, res) => {
  const { name, roll, reg, sem, email, password, photo } = req.body || {};
  if (!name || !reg) return res.status(400).json({ error: 'Name and Register No are required' });
  const exists = await one('SELECT id FROM students WHERE reg_no = $1', [reg.trim()]);
  if (exists) return res.status(409).json({ error: 'Register No already exists' });
  const pw = bcrypt.hashSync(password && password.length ? password : 'Student@123', 10);
  const row = await one('INSERT INTO students (name, roll_no, reg_no, semester, email, password_hash, photo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [name.trim(), (roll || '').trim() || null, reg.trim(), Number(sem) || 5, (email || '').trim(), pw, photo || null]);
  res.status(201).json({ id: row.id });
}));

app.put('/api/students/:id', admin, wrap(async (req, res) => {
  const { name, roll, reg, sem, email, password, photo } = req.body || {};
  const s = await one('SELECT * FROM students WHERE id = $1', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  if (reg) {
    const dup = await one('SELECT id FROM students WHERE reg_no = $1 AND id != $2', [reg.trim(), s.id]);
    if (dup) return res.status(409).json({ error: 'Register No already exists' });
  }
  const pw = password && password.length ? bcrypt.hashSync(password, 10) : s.password_hash;
  // photo omitted → keep current; null → clear; string → replace.
  const newPhoto = photo === undefined ? s.photo : photo;
  const newRoll = roll === undefined ? s.roll_no : ((roll || '').trim() || null);
  await pool.query('UPDATE students SET name=$1, roll_no=$2, reg_no=$3, semester=$4, email=$5, password_hash=$6, photo=$7 WHERE id=$8',
    [name ?? s.name, newRoll, (reg ?? s.reg_no).trim(), Number(sem) || s.semester, email ?? s.email, pw, newPhoto, s.id]);
  res.json({ ok: true });
}));

app.delete('/api/students/:id', admin, wrap(async (req, res) => {
  await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ================= FACULTY ================= */
app.get('/api/faculty', staff, wrap(async (req, res) => {
  const rows = await q("SELECT * FROM users WHERE role IN ('hod','faculty','advisor') ORDER BY role DESC, name");
  // Attach the subjects each faculty is allocated.
  const list = rows.map(u => ({
    ...publicFaculty(u),
    subjects: SUBJECTS.filter(s => s.faculty.toLowerCase().includes((u.name || '').toLowerCase())).map(s => ({ code: s.code, name: s.name })),
  }));
  res.json(list);
}));

app.post('/api/faculty', admin, wrap(async (req, res) => {
  const { name, email, department, role, password } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const mail = (email && email.trim()) ? email.trim().toLowerCase() : facultyEmail(name);
  const dup = await one('SELECT id FROM users WHERE email = $1', [mail]);
  if (dup) return res.status(409).json({ error: 'Email already exists' });
  const r = ['hod', 'advisor'].includes(role) ? role : 'faculty';
  const pw = bcrypt.hashSync(password && password.length ? password : (r === 'hod' ? 'Hod@123' : 'Faculty@123'), 10);
  const row = await one('INSERT INTO users (name, email, password_hash, role, department) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [name.trim(), mail, pw, r, (department || '').trim() || null]);
  res.status(201).json({ id: row.id, email: mail });
}));

app.put('/api/faculty/:id', admin, wrap(async (req, res) => {
  const { name, email, department, role, password } = req.body || {};
  const u = await one("SELECT * FROM users WHERE id = $1 AND role IN ('hod','faculty','advisor')", [req.params.id]);
  if (!u) return res.status(404).json({ error: 'Faculty not found' });
  if (email) {
    const dup = await one('SELECT id FROM users WHERE email = $1 AND id != $2', [email.trim().toLowerCase(), u.id]);
    if (dup) return res.status(409).json({ error: 'Email already exists' });
  }
  const pw = password && password.length ? bcrypt.hashSync(password, 10) : u.password_hash;
  const r = role ? (['hod', 'advisor'].includes(role) ? role : 'faculty') : u.role;
  await pool.query('UPDATE users SET name=$1, email=$2, department=$3, role=$4, password_hash=$5 WHERE id=$6',
    [name ?? u.name, (email ?? u.email).trim().toLowerCase(), department ?? u.department, r, pw, u.id]);
  res.json({ ok: true });
}));

app.delete('/api/faculty/:id', admin, wrap(async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1 AND role IN ('hod','faculty','advisor')", [req.params.id]);
  res.json({ ok: true });
}));

// Subjects the logged-in user may take attendance for.
app.get('/api/my/subjects', staff, wrap(async (req, res) => {
  res.json(subjectsForUser(req.user));
}));

// Attendance — one session per (date, period), 9 periods a day.
const ATT_STATUSES = ['present', 'absent', 'late', 'od'];

// Overview of a day: which of the 9 periods have been taken.
app.get('/api/attendance/day', staff, wrap(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const rows = await q(`
    SELECT s.period, s.subject, s.locked, u.name AS faculty,
           COUNT(r.*) FILTER (WHERE r.status = 'present')::int AS present,
           COUNT(r.*) FILTER (WHERE r.status = 'absent')::int  AS absent,
           COUNT(r.*) FILTER (WHERE r.status = 'late')::int    AS late,
           COUNT(r.*) FILTER (WHERE r.status = 'od')::int      AS od
    FROM attendance_sessions s
    LEFT JOIN users u ON u.id = s.faculty_id
    LEFT JOIN attendance_records r ON r.session_id = s.id
    WHERE s.date = $1
    GROUP BY s.period, s.subject, s.locked, u.name
    ORDER BY s.period`, [date]);
  const byPeriod = {};
  rows.forEach(r => { byPeriod[r.period] = r; });
  res.json({ periods: PERIODS, byPeriod });
}));

// Load a single period's attendance sheet.
app.get('/api/attendance', staff, wrap(async (req, res) => {
  const { date, period } = req.query;
  if (!date || !period) return res.status(400).json({ error: 'date and period required' });
  const session = await one('SELECT * FROM attendance_sessions WHERE date = $1 AND period = $2', [date, Number(period)]);
  const marks = {};
  let meta = null;
  if (session) {
    (await q('SELECT student_id, status FROM attendance_records WHERE session_id = $1', [session.id]))
      .forEach(r => { marks[r.student_id] = r.status; });
    const fac = session.faculty_id ? await one('SELECT name FROM users WHERE id = $1', [session.faculty_id]) : null;
    meta = { subject: session.subject, faculty: fac ? fac.name : null, facultyId: session.faculty_id, locked: session.locked };
  }
  res.json({ exists: !!session, meta, marks });
}));

app.post('/api/attendance', staff, wrap(async (req, res) => {
  const { date, period, subject, marks, lock } = req.body || {};
  if (!date || !period || !subject || typeof marks !== 'object') {
    return res.status(400).json({ error: 'date, period, subject, marks required' });
  }
  const isOverseer = req.user.role === 'admin' || req.user.role === 'hod';
  // Faculty may only record attendance for a subject allocated to them.
  if (!isOverseer && !subjectsForUser(req.user).some(s => s.name === subject)) {
    return res.status(403).json({ error: 'You are not allocated to this subject.' });
  }
  const existing = await one('SELECT * FROM attendance_sessions WHERE date = $1 AND period = $2', [date, Number(period)]);
  if (existing) {
    if (existing.locked && !isOverseer) return res.status(403).json({ error: 'This period is locked. Ask Admin or HOD to unlock it.' });
    if (existing.faculty_id && existing.faculty_id !== req.user.id && !isOverseer) {
      return res.status(403).json({ error: 'This period was taken by another faculty; you cannot edit it.' });
    }
  }
  await tx(async (client) => {
    let session = existing;
    if (!session) {
      session = (await client.query(
        'INSERT INTO attendance_sessions (date, period, subject, faculty_id, locked) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [date, Number(period), subject, req.user.id, !!lock])).rows[0];
    } else {
      session = (await client.query(
        'UPDATE attendance_sessions SET subject=$1, faculty_id=$2, locked=$3 WHERE id=$4 RETURNING *',
        [subject, isOverseer ? session.faculty_id || req.user.id : req.user.id, !!lock || session.locked, session.id])).rows[0];
    }
    for (const [sid, status] of Object.entries(marks)) {
      if (ATT_STATUSES.includes(status)) {
        await client.query(
          `INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,$3)
           ON CONFLICT (session_id, student_id) DO UPDATE SET status = EXCLUDED.status`,
          [session.id, Number(sid), status]);
      }
    }
  });
  res.json({ ok: true, locked: !!lock });
}));

// Admin/HOD can unlock a locked period so it can be corrected.
app.post('/api/attendance/unlock', adminHod, wrap(async (req, res) => {
  const { date, period } = req.body || {};
  if (!date || !period) return res.status(400).json({ error: 'date and period required' });
  await pool.query('UPDATE attendance_sessions SET locked = false WHERE date = $1 AND period = $2', [date, Number(period)]);
  res.json({ ok: true });
}));

// Marks
app.get('/api/marks', staff, wrap(async (req, res) => {
  const { subject, type } = req.query;
  if (!subject || !type) return res.status(400).json({ error: 'subject and type required' });
  const rows = await q('SELECT student_id, obtained, max, submission_date FROM marks WHERE subject = $1 AND type = $2', [subject, type]);
  const map = {};
  let submissionDate = null;
  rows.forEach(r => {
    map[r.student_id] = { obtained: r.obtained, max: r.max };
    if (r.submission_date) submissionDate = r.submission_date;
  });
  res.json({ marks: map, submissionDate });
}));

app.post('/api/marks', staff, wrap(async (req, res) => {
  const { subject, type, entries, submissionDate } = req.body || {};
  if (!subject || !type || !Array.isArray(entries)) return res.status(400).json({ error: 'subject, type, entries required' });
  const subDate = submissionDate || null;
  await tx(async (client) => {
    for (const e of entries) {
      await client.query('DELETE FROM marks WHERE student_id = $1 AND subject = $2 AND type = $3', [e.studentId, subject, type]);
      if (e.obtained !== null && e.obtained !== '' && !isNaN(e.obtained)) {
        await client.query('INSERT INTO marks (student_id, subject, type, obtained, max, submission_date) VALUES ($1,$2,$3,$4,$5,$6)',
          [e.studentId, subject, type, Number(e.obtained), Number(e.max) || 100, subDate]);
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
  for (const sub of SUBJECT_NAMES) {
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
  const rows = [['Roll No', 'Name', 'Reg No', 'Semester', 'Attendance %', 'Present', 'Absent', 'Late', 'OD', 'Avg Marks %']];
  for (const s of students) {
    const st = await attendanceStats(s.id), avg = await studentAvgMark(s.id);
    rows.push([s.roll_no || '', s.name, s.reg_no, s.semester, st.pct, st.present, st.absent, st.late, st.od, avg ?? '']);
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
  const bySubject = SUBJECT_NAMES.map(sub => {
    const recs = history.filter(h => h.subject === sub);
    let present = 0, absent = 0, late = 0, od = 0;
    recs.forEach(h => { if (h.status === 'present') present++; else if (h.status === 'late') late++; else if (h.status === 'od') od++; else absent++; });
    const total = recs.length, pct = total ? Math.round(((present + late + od) / total) * 100) : 0;
    return { sub, total, present, absent, late, od, pct };
  });
  res.json({ stats: await attendanceStats(req.user.id), history, bySubject });
}));

app.get('/api/me/marks', studentOnly, wrap(async (req, res) => {
  const rows = await q('SELECT subject, type, obtained, max, submission_date FROM marks WHERE student_id = $1', [req.user.id]);
  const bySubject = SUBJECT_NAMES.map(sub => {
    const ms = rows.filter(r => r.subject === sub);
    const byType = {};
    ms.forEach(m => { byType[m.type] = { obtained: m.obtained, max: m.max, submissionDate: m.submission_date }; });
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
