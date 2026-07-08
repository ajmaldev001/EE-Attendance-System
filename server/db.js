const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SUBJECTS = ['Digital Electronics', 'Signals & Systems', 'Microprocessors', 'Communication', 'VLSI Design'];
const MARK_TYPES = ['Internal 1', 'Internal 2', 'Assignment', 'Semester'];

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','staff'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    reg_no TEXT UNIQUE NOT NULL,
    semester INTEGER NOT NULL DEFAULT 5,
    email TEXT,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    subject TEXT NOT NULL,
    UNIQUE (date, subject)
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    session_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('present','absent','od')),
    PRIMARY KEY (session_id, student_id),
    FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    obtained REAL NOT NULL,
    max REAL NOT NULL DEFAULT 100,
    UNIQUE (student_id, subject, type),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  );
`);

function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('Department Admin', 'admin@ece.edu', bcrypt.hashSync('Admin@123', 10), 'admin');
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run('Staff Member', 'staff@ece.edu', bcrypt.hashSync('Staff@123', 10), 'staff');
  }

  const studentCount = db.prepare('SELECT COUNT(*) AS c FROM students').get().c;
  if (studentCount === 0) {
    const names = ['Aarav Sharma', 'Priya Nair', 'Rohan Das', 'Sneha Iyer', 'Karthik Reddy',
      'Ananya Menon', 'Vikram Singh', 'Divya Rao', 'Arjun Pillai', 'Meera Joshi'];
    const insStu = db.prepare('INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES (?, ?, ?, ?, ?)');
    const studentPw = bcrypt.hashSync('Student@123', 10);
    const ids = [];
    const insertAll = db.transaction(() => {
      names.forEach((name, i) => {
        const reg = '22ECE' + String(i + 1).padStart(3, '0');
        const email = name.split(' ')[0].toLowerCase() + '@ece.edu';
        const info = insStu.run(name, reg, 5, email, studentPw);
        ids.push(info.lastInsertRowid);
      });
    });
    insertAll();

    // Sample attendance: last 6 days x each subject
    const insSession = db.prepare('INSERT INTO attendance_sessions (date, subject) VALUES (?, ?)');
    const insRec = db.prepare('INSERT INTO attendance_records (session_id, student_id, status) VALUES (?, ?, ?)');
    const seedAtt = db.transaction(() => {
      for (let d = 6; d >= 1; d--) {
        const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        SUBJECTS.forEach(sub => {
          const sInfo = insSession.run(date, sub);
          ids.forEach((sid, idx) => {
            const r = Math.random();
            const status = idx === 3 && r < 0.5 ? 'absent' : r < 0.08 ? 'absent' : r < 0.14 ? 'od' : 'present';
            insRec.run(sInfo.lastInsertRowid, sid, status);
          });
        });
      }
    });
    seedAtt();

    // Sample marks
    const insMark = db.prepare('INSERT INTO marks (student_id, subject, type, obtained, max) VALUES (?, ?, ?, ?, ?)');
    const seedMarks = db.transaction(() => {
      ids.forEach(sid => SUBJECTS.forEach(sub => MARK_TYPES.forEach(type => {
        const max = type === 'Semester' ? 100 : type === 'Assignment' ? 20 : 50;
        const obtained = Math.round((0.5 + Math.random() * 0.5) * max);
        insMark.run(sid, sub, type, obtained, max);
      })));
    });
    seedMarks();
  }
}

seedIfEmpty();

module.exports = { db, SUBJECTS, MARK_TYPES };
