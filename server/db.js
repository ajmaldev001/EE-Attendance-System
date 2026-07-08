const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SUBJECTS = ['Digital Electronics', 'Signals & Systems', 'Microprocessors', 'Communication', 'VLSI Design'];
const MARK_TYPES = ['Internal 1', 'Internal 2', 'Assignment', 'Semester'];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Point it at your Postgres (e.g. Supabase) connection string.');
}

// Managed Postgres (Supabase/Neon/Render) requires SSL; local does not.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString || '');
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Fail fast instead of hanging if the DB is unreachable, so errors surface in logs.
  connectionTimeoutMillis: 10000,
});

/* ---------- query helpers ---------- */
async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ---------- schema ---------- */
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','staff'))
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      reg_no TEXT UNIQUE NOT NULL,
      semester INTEGER NOT NULL DEFAULT 5,
      email TEXT,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      subject TEXT NOT NULL,
      UNIQUE (date, subject)
    );
    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('present','absent','od')),
      PRIMARY KEY (session_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS marks (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      type TEXT NOT NULL,
      obtained REAL NOT NULL,
      max REAL NOT NULL DEFAULT 100,
      UNIQUE (student_id, subject, type)
    );
  `);
}

/* ---------- seed ---------- */
async function seedIfEmpty() {
  const userCount = Number((await one('SELECT COUNT(*)::int AS c FROM users')).c);
  if (userCount === 0) {
    await pool.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)',
      ['Department Admin', 'admin@ece.edu', bcrypt.hashSync('Admin@123', 10), 'admin']);
    await pool.query('INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)',
      ['Staff Member', 'staff@ece.edu', bcrypt.hashSync('Staff@123', 10), 'staff']);
  }

  const studentCount = Number((await one('SELECT COUNT(*)::int AS c FROM students')).c);
  if (studentCount === 0) {
    const names = ['Aarav Sharma', 'Priya Nair', 'Rohan Das', 'Sneha Iyer', 'Karthik Reddy',
      'Ananya Menon', 'Vikram Singh', 'Divya Rao', 'Arjun Pillai', 'Meera Joshi'];
    const studentPw = bcrypt.hashSync('Student@123', 10);
    const ids = [];
    for (let i = 0; i < names.length; i++) {
      const reg = '22ECE' + String(i + 1).padStart(3, '0');
      const email = names[i].split(' ')[0].toLowerCase() + '@ece.edu';
      const row = await one(
        'INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [names[i], reg, 5, email, studentPw]);
      ids.push(row.id);
    }

    // Sample attendance: last 6 days x each subject
    for (let d = 6; d >= 1; d--) {
      const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      for (const sub of SUBJECTS) {
        const ses = await one('INSERT INTO attendance_sessions (date, subject) VALUES ($1,$2) RETURNING id', [date, sub]);
        for (let idx = 0; idx < ids.length; idx++) {
          const r = Math.random();
          const status = idx === 3 && r < 0.5 ? 'absent' : r < 0.08 ? 'absent' : r < 0.14 ? 'od' : 'present';
          await pool.query('INSERT INTO attendance_records (session_id, student_id, status) VALUES ($1,$2,$3)', [ses.id, ids[idx], status]);
        }
      }
    }

    // Sample marks
    for (const sid of ids) {
      for (const sub of SUBJECTS) {
        for (const type of MARK_TYPES) {
          const max = type === 'Semester' ? 100 : type === 'Assignment' ? 20 : 50;
          const obtained = Math.round((0.5 + Math.random() * 0.5) * max);
          await pool.query('INSERT INTO marks (student_id, subject, type, obtained, max) VALUES ($1,$2,$3,$4,$5)', [sid, sub, type, obtained, max]);
        }
      }
    }
    console.log('🌱 Seeded admin, staff, and 10 sample students.');
  }
}

async function init() {
  await createSchema();
  await seedIfEmpty();
}

module.exports = { pool, q, one, tx, init, SUBJECTS, MARK_TYPES };
