const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { db, SUBJECTS, MARK_TYPES } = require('./db');
const { signToken, authenticate, requireRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* ---------- Query helpers ---------- */
function attendanceStats(studentId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM attendance_records WHERE student_id = ? GROUP BY status
  `).all(studentId);
  let present = 0, absent = 0, od = 0;
  rows.forEach(r => { if (r.status === 'present') present = r.c; else if (r.status === 'od') od = r.c; else absent = r.c; });
  const total = present + absent + od;
  const pct = total ? Math.round(((present + od) / total) * 100) : 0;
  return { total, present, absent, od, pct };
}

function studentAvgMark(studentId) {
  const rows = db.prepare('SELECT obtained, max FROM marks WHERE student_id = ?').all(studentId);
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

app.post('/api/login', (req, res) => {
  const { role, identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Missing credentials' });

  if (role === 'student') {
    const s = db.prepare('SELECT * FROM students WHERE reg_no = ?').get(identifier.trim());
    if (!s || !bcrypt.compareSync(password, s.password_hash)) return res.status(401).json({ error: 'Invalid register number or password' });
    const user = { id: s.id, role: 'student', name: s.name, reg: s.reg_no };
    return res.json({ token: signToken(user), user });
  }
  // staff/admin
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(identifier.trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
  const user = { id: u.id, role: u.role, name: u.name, email: u.email };
  return res.json({ token: signToken(user), user });
});

app.get('/api/me', authenticate, (req, res) => res.json({ user: req.user }));

/* ================= STAFF / ADMIN ================= */
const staff = [authenticate, requireRole('admin', 'staff')];

// Dashboard stats
app.get('/api/dashboard', staff, (req, res) => {
  const students = db.prepare('SELECT * FROM students ORDER BY reg_no').all();
  const sessions = db.prepare('SELECT COUNT(*) AS c FROM attendance_sessions').get().c;
  const withStats = students.map(s => ({ ...publicStudent(s), stats: attendanceStats(s.id) }));
  const pcts = withStats.map(s => s.stats.pct);
  const avgAtt = withStats.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / withStats.length) : 0;
  const low = withStats.filter(s => s.stats.total && s.stats.pct < 75);
  let present = 0, absent = 0, od = 0;
  const totals = db.prepare('SELECT status, COUNT(*) AS c FROM attendance_records GROUP BY status').all();
  totals.forEach(r => { if (r.status === 'present') present = r.c; else if (r.status === 'od') od = r.c; else absent = r.c; });
  res.json({
    totalStudents: students.length, sessions, avgAtt, low,
    students: withStats, statusTotals: { present, absent, od }
  });
});

// Students CRUD
app.get('/api/students', staff, (req, res) => {
  const rows = db.prepare('SELECT * FROM students ORDER BY reg_no').all();
  res.json(rows.map(s => ({ ...publicStudent(s), stats: attendanceStats(s.id), avgMark: studentAvgMark(s.id) })));
});

app.post('/api/students', staff, (req, res) => {
  const { name, reg, sem, email, password } = req.body || {};
  if (!name || !reg) return res.status(400).json({ error: 'Name and Register No are required' });
  const exists = db.prepare('SELECT id FROM students WHERE reg_no = ?').get(reg.trim());
  if (exists) return res.status(409).json({ error: 'Register No already exists' });
  const pw = bcrypt.hashSync(password && password.length ? password : 'Student@123', 10);
  const info = db.prepare('INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), reg.trim(), Number(sem) || 5, (email || '').trim(), pw);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/students/:id', staff, (req, res) => {
  const { name, reg, sem, email, password } = req.body || {};
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  if (reg) {
    const dup = db.prepare('SELECT id FROM students WHERE reg_no = ? AND id != ?').get(reg.trim(), s.id);
    if (dup) return res.status(409).json({ error: 'Register No already exists' });
  }
  const pw = password && password.length ? bcrypt.hashSync(password, 10) : s.password_hash;
  db.prepare('UPDATE students SET name=?, reg_no=?, semester=?, email=?, password_hash=? WHERE id=?')
    .run(name ?? s.name, (reg ?? s.reg_no).trim(), Number(sem) || s.semester, email ?? s.email, pw, s.id);
  res.json({ ok: true });
});

app.delete('/api/students/:id', staff, (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Attendance
app.get('/api/attendance', staff, (req, res) => {
  const { date, subject } = req.query;
  if (!date || !subject) return res.status(400).json({ error: 'date and subject required' });
  const session = db.prepare('SELECT id FROM attendance_sessions WHERE date = ? AND subject = ?').get(date, subject);
  const marks = {};
  if (session) {
    db.prepare('SELECT student_id, status FROM attendance_records WHERE session_id = ?').all(session.id)
      .forEach(r => { marks[r.student_id] = r.status; });
  }
  res.json({ exists: !!session, marks });
});

app.post('/api/attendance', staff, (req, res) => {
  const { date, subject, marks } = req.body || {};
  if (!date || !subject || typeof marks !== 'object') return res.status(400).json({ error: 'date, subject, marks required' });
  const tx = db.transaction(() => {
    let session = db.prepare('SELECT id FROM attendance_sessions WHERE date = ? AND subject = ?').get(date, subject);
    if (!session) {
      const info = db.prepare('INSERT INTO attendance_sessions (date, subject) VALUES (?, ?)').run(date, subject);
      session = { id: info.lastInsertRowid };
    }
    const up = db.prepare(`INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, ?)
      ON CONFLICT(session_id, student_id) DO UPDATE SET status = excluded.status`);
    Object.entries(marks).forEach(([sid, status]) => {
      if (['present', 'absent', 'od'].includes(status)) up.run(session.id, Number(sid), status);
    });
  });
  tx();
  res.json({ ok: true });
});

// Marks
app.get('/api/marks', staff, (req, res) => {
  const { subject, type } = req.query;
  if (!subject || !type) return res.status(400).json({ error: 'subject and type required' });
  const rows = db.prepare('SELECT student_id, obtained, max FROM marks WHERE subject = ? AND type = ?').all(subject, type);
  const map = {};
  rows.forEach(r => { map[r.student_id] = { obtained: r.obtained, max: r.max }; });
  res.json(map);
});

app.post('/api/marks', staff, (req, res) => {
  const { subject, type, entries } = req.body || {};
  if (!subject || !type || !Array.isArray(entries)) return res.status(400).json({ error: 'subject, type, entries required' });
  const tx = db.transaction(() => {
    const del = db.prepare('DELETE FROM marks WHERE student_id = ? AND subject = ? AND type = ?');
    const ins = db.prepare('INSERT INTO marks (student_id, subject, type, obtained, max) VALUES (?, ?, ?, ?, ?)');
    entries.forEach(e => {
      del.run(e.studentId, subject, type);
      if (e.obtained !== null && e.obtained !== '' && !isNaN(e.obtained)) {
        ins.run(e.studentId, subject, type, Number(e.obtained), Number(e.max) || 100);
      }
    });
  });
  tx();
  res.json({ ok: true });
});

// Reports
function buildStudentReport(id) {
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!s) return null;
  const stats = attendanceStats(id);
  const subjMarks = SUBJECTS.map(sub => {
    const ms = db.prepare('SELECT obtained, max FROM marks WHERE student_id = ? AND subject = ?').all(id, sub);
    if (!ms.length) return { sub, pct: null, grade: null };
    const pct = Math.round(ms.reduce((a, m) => a + (m.obtained / m.max) * 100, 0) / ms.length);
    return { sub, pct, grade: gradeFor(pct) };
  });
  const history = db.prepare(`
    SELECT ses.date, ses.subject, r.status
    FROM attendance_records r JOIN attendance_sessions ses ON ses.id = r.session_id
    WHERE r.student_id = ? ORDER BY ses.date DESC, ses.subject
  `).all(id);
  return { student: publicStudent(s), stats, subjMarks, history };
}

app.get('/api/reports/student/:id', staff, (req, res) => {
  const report = buildStudentReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Student not found' });
  res.json(report);
});

app.get('/api/export/csv', staff, (req, res) => {
  const students = db.prepare('SELECT * FROM students ORDER BY reg_no').all();
  const rows = [['Name', 'Reg No', 'Semester', 'Attendance %', 'Present', 'Absent', 'OD', 'Avg Marks %']];
  students.forEach(s => {
    const st = attendanceStats(s.id), avg = studentAvgMark(s.id);
    rows.push([s.name, s.reg_no, s.semester, st.pct, st.present, st.absent, st.od, avg ?? '']);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
  res.send(csv);
});

/* ================= STUDENT (own data only) ================= */
const studentOnly = [authenticate, requireRole('student')];

app.get('/api/me/summary', studentOnly, (req, res) => {
  const report = buildStudentReport(req.user.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
});

app.get('/api/me/attendance', studentOnly, (req, res) => {
  const history = db.prepare(`
    SELECT ses.date, ses.subject, r.status
    FROM attendance_records r JOIN attendance_sessions ses ON ses.id = r.session_id
    WHERE r.student_id = ? ORDER BY ses.date DESC, ses.subject
  `).all(req.user.id);
  const bySubject = SUBJECTS.map(sub => {
    const recs = history.filter(h => h.subject === sub);
    let present = 0, absent = 0, od = 0;
    recs.forEach(h => { if (h.status === 'present') present++; else if (h.status === 'od') od++; else absent++; });
    const total = recs.length, pct = total ? Math.round(((present + od) / total) * 100) : 0;
    return { sub, total, present, absent, od, pct };
  });
  res.json({ stats: attendanceStats(req.user.id), history, bySubject });
});

app.get('/api/me/marks', studentOnly, (req, res) => {
  const rows = db.prepare('SELECT subject, type, obtained, max FROM marks WHERE student_id = ?').all(req.user.id);
  const bySubject = SUBJECTS.map(sub => {
    const ms = rows.filter(r => r.subject === sub);
    const byType = {};
    ms.forEach(m => { byType[m.type] = { obtained: m.obtained, max: m.max }; });
    const pct = ms.length ? Math.round(ms.reduce((a, m) => a + (m.obtained / m.max) * 100, 0) / ms.length) : null;
    return { sub, byType, pct, grade: pct === null ? null : gradeFor(pct) };
  });
  res.json({ markTypes: MARK_TYPES, bySubject });
});

/* ================= STATIC FRONTEND ================= */
app.use(express.static(path.join(__dirname, '..')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

app.listen(PORT, () => console.log(`✅ Attendance server running at http://localhost:${PORT}`));
