const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SUBJECTS = ['Digital Electronics', 'Signals & Systems', 'Microprocessors', 'Communication', 'VLSI Design'];
const MARK_TYPES = ['Internal 1', 'Internal 2', 'Assignment', 'Semester'];

// Official class roster: [reg_no, name]
const STUDENTS = [
  ['714024169001', 'Abirami'],
  ['714024169002', 'AJAIKUMAR G'],
  ['714024169003', 'ANAND K'],
  ['714024169004', 'ASHWIN S'],
  ['714024169005', 'DARSHAN R A'],
  ['714024169006', 'DHARANEESH A M'],
  ['714024169007', 'DHIVYA G B'],
  ['714024169008', 'GOKUL P'],
  ['714024169009', 'HARINI D'],
  ['714024169010', 'HARINI K S'],
  ['714024169011', 'JAI ADITYA T'],
  ['714024169012', 'JAIABINAV T'],
  ['714024169013', 'JITHIN RIO R'],
  ['714024169014', 'KAMALESH V K'],
  ['714024169015', 'KAVIESHWARA M'],
  ['714024169016', 'KAVYA M'],
  ['714024169017', 'KIRUTHIKA S'],
  ['714024169018', 'MANOVA M'],
  ['714024169019', 'MIRUTHULA S'],
  ['714024169020', 'MOHAMED JAIM M'],
  ['714024169021', 'MOHAMMED AYMAN M'],
  ['714024169022', 'MONIKA M'],
  ['714024169023', 'MUKILAN R'],
  ['714024169024', 'NITHIKKANNAN JS'],
  ['714024169025', 'NITIN K R'],
  ['714024169026', 'PRATHEEP D'],
  ['714024169027', 'PRITHIKA P'],
  ['714024169028', 'PUGAAZHENDHI S'],
  ['714024169029', 'RAGHUL VASUN V T'],
  ['714024169030', 'RAHUL PRASATH S'],
  ['714024169031', 'RETHIKA S'],
  ['714024169032', 'ROOBASHRI S'],
  ['714024169033', 'SAKTHISHREE D'],
  ['714024169034', 'SANJEEV G H'],
  ['714024169035', 'SANJEYKRISHNA V'],
  ['714024169036', 'SANKAMES V S'],
  ['714024169037', 'SANTHOSH KUMAR S'],
  ['714024169038', 'SASMITHA S P'],
  ['714024169039', 'SHANMATHI S'],
  ['714024169040', 'SOORYA VELAA P'],
  ['714024169041', 'SRI VATSAN P'],
  ['714024169042', 'SRIRAM M R'],
  ['714024169043', 'SUBHASHINI N'],
  ['714024169044', 'SUBIKSHA L'],
  ['714024169045', 'SUMAN S'],
  ['714024169046', 'SWETHA R'],
  ['714024169047', 'THARUN M'],
  ['714024169048', 'THARUN R'],
  ['714024169049', 'THARUN R M'],
  ['714024169050', 'THIRUMURUGAN S'],
  ['714024169051', 'UDHAYA R'],
  ['714024169052', 'VARSHA V R'],
  ['714024169053', 'WINSTON CHURCHIL'],
  ['714024169054', 'YOGESH S'],
  ['714024169301', 'ABHISHEK P'],
  ['714024169302', 'KAUSHIK R'],
];

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
      password_hash TEXT NOT NULL,
      photo TEXT
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
      submission_date TEXT,
      UNIQUE (student_id, subject, type)
    );
  `);
  // Idempotent migrations for databases created before these columns existed.
  await pool.query('ALTER TABLE marks ADD COLUMN IF NOT EXISTS submission_date TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT');
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
    const studentPw = bcrypt.hashSync('Student@123', 10);
    for (const [reg, name] of STUDENTS) {
      const email = name.split(' ')[0].toLowerCase() + '@eevlsi.edu';
      await pool.query(
        'INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES ($1,$2,$3,$4,$5)',
        [name, reg, 5, email, studentPw]);
    }
    console.log(`🌱 Seeded admin, staff, and ${STUDENTS.length} students.`);
  }
}

async function init() {
  await createSchema();
  await seedIfEmpty();
}

module.exports = { pool, q, one, tx, init, SUBJECTS, MARK_TYPES, STUDENTS };
