const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// College / department identity (III B.E. EE-VDT, Semester V, 2026–2027).
const COLLEGE = {
  name: 'Sri Shakthi Institute of Engineering and Technology',
  department: 'B.E. Electronics Engineering – VLSI Design and Technology (EE-VDT)',
  programme: 'B.E. EE-VDT',
  className: 'III B.E. EE-VDT',
  academicYear: '2026–2027',
  semester: 'V',
  hod: 'Dr. P. Dhilip Kumar',
  classAdvisor: 'Mr. S. Boopathy', // update here if the class advisor is someone else
};

// Subject allocation: { code, name, faculty (display string) }.
const SUBJECTS = [
  { code: '21MA501',     name: 'Graph Theory',                                faculty: 'Dr. Beryl Ben' },
  { code: '21EC501',     name: 'Environmental Science and Engineering (EVS)', faculty: 'Mrs. R. Vasanthi' },
  { code: '21VL501',     name: 'Scripting Languages for FPGA (SL)',           faculty: 'Dr. P. Dhilip Kumar' },
  { code: '21PEC05',     name: 'Synthesis and STA (Professional Elective 2)', faculty: 'Mrs. C. Prema' },
  { code: '21EC521',     name: 'Digital Signal Processing (DSP)',             faculty: 'Mrs. S. Vimelatha' },
  { code: '21VL522',     name: 'Embedded System Design (ESD)',                faculty: 'Mr. S. Boopathy' },
  { code: '21EC521 LAB', name: 'Digital Signal Processing Laboratory',        faculty: 'Mrs. P. Eswari' },
  { code: '21VL512',     name: 'Embedded System Design Laboratory',           faculty: 'Mr. S. Boopathy' },
  { code: '21VL512 LAB', name: 'Scripting Languages Laboratory',              faculty: 'Dr. P. Dhilip Kumar' },
  { code: '21VL511',     name: 'Engineering Exploration V',                   faculty: 'Mr. S. Boopathy' },
  { code: '21DNS501',    name: 'Career Enhancement Program (CEP III)',        faculty: 'Verbal – Ms. Padmini, Quants – Mr. Manoj Kumar' },
];

// Teaching staff. Dr. P. Dhilip Kumar is the HOD (and also teaches); the rest are faculty.
const FACULTY = [
  { name: 'Dr. Beryl Ben',       department: 'Mathematics', role: 'faculty' },
  { name: 'Mrs. R. Vasanthi',    department: 'EE-VDT',      role: 'faculty' },
  { name: 'Dr. P. Dhilip Kumar', department: 'EE-VDT',      role: 'hod' },
  { name: 'Mrs. C. Prema',       department: 'EE-VDT',      role: 'faculty' },
  { name: 'Mrs. S. Vimelatha',   department: 'EE-VDT',      role: 'faculty' },
  { name: 'Mr. S. Boopathy',     department: 'EE-VDT',      role: 'faculty' },
  { name: 'Mrs. P. Eswari',      department: 'EE-VDT',      role: 'faculty' },
  { name: 'Ms. Padmini',         department: 'English',     role: 'faculty' },
  { name: 'Mr. Manoj Kumar',     department: 'Aptitude',    role: 'faculty' },
];

// Each teaching day has 9 fixed periods (no weekly timetable).
const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const MARK_TYPES = ['Internal 1', 'Internal 2', 'Assignment', 'Semester'];

// Build a login email from a faculty display name, e.g. "Dr. P. Dhilip Kumar" -> "dhilip.kumar@siet.edu".
function facultyEmail(name) {
  const slug = name
    .replace(/^(Dr|Mr|Mrs|Ms)\.?\s+/i, '')   // drop title
    .replace(/\b[A-Z]\.\s*/g, '')             // drop single-letter initials like "P."
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')              // spaces/punct -> dot
    .replace(/^\.+|\.+$/g, '');
  return `${slug || 'faculty'}@siet.edu`;
}

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
  // The attendance model changed from (date, subject) to a 9-period-per-day model.
  // If the legacy attendance_sessions table exists without a `period` column, rebuild it.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'attendance_sessions')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'attendance_sessions' AND column_name = 'period') THEN
        DROP TABLE IF EXISTS attendance_records;
        DROP TABLE IF EXISTS attendance_sessions;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      department TEXT,
      role TEXT NOT NULL CHECK (role IN ('admin','staff','hod','faculty'))
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      roll_no TEXT,
      reg_no TEXT UNIQUE NOT NULL,
      semester INTEGER NOT NULL DEFAULT 5,
      email TEXT,
      password_hash TEXT NOT NULL,
      photo TEXT
    );
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      period INTEGER NOT NULL,
      subject TEXT NOT NULL,
      faculty_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      locked BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (date, period)
    );
    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('present','absent','late','od')),
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

  // Idempotent migrations for databases created before these columns/roles existed.
  await pool.query('ALTER TABLE marks ADD COLUMN IF NOT EXISTS submission_date TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS photo TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS roll_no TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT');
  // Widen the role constraint so hod/faculty are allowed on pre-existing databases.
  await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','staff','hod','faculty'))");
  // Allow the OD status on databases whose attendance_records predate it.
  await pool.query('ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check');
  await pool.query("ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check CHECK (status IN ('present','absent','late','od'))");
}

/* ---------- seed ---------- */
// Insert a user only if the email is not already present (idempotent).
async function ensureUser(name, email, password, role, department) {
  const exists = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) return;
  await pool.query(
    'INSERT INTO users (name, email, password_hash, role, department) VALUES ($1,$2,$3,$4,$5)',
    [name, email, bcrypt.hashSync(password, 10), role, department || null]);
}

async function seedIfEmpty() {
  // Admin (kept on the original address so existing logins keep working).
  await ensureUser('Department Admin', 'admin@ece.edu', 'Admin@123', 'admin', COLLEGE.department);

  // HOD + faculty accounts. Password depends on role.
  for (const f of FACULTY) {
    const pw = f.role === 'hod' ? 'Hod@123' : 'Faculty@123';
    await ensureUser(f.name, facultyEmail(f.name), pw, f.role, f.department);
  }

  const studentCount = Number((await one('SELECT COUNT(*)::int AS c FROM students')).c);
  if (studentCount === 0) {
    const studentPw = bcrypt.hashSync('Student@123', 10);
    let i = 0;
    for (const [reg, name] of STUDENTS) {
      i += 1;
      const rollNo = String(i).padStart(2, '0');
      const email = name.split(' ')[0].toLowerCase() + '@eevlsi.edu';
      await pool.query(
        'INSERT INTO students (name, roll_no, reg_no, semester, email, password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [name, rollNo, reg, 5, email, studentPw]);
    }
    console.log(`🌱 Seeded ${STUDENTS.length} students.`);
  }

  // Backfill roll numbers for any students that predate the roll_no column.
  const missingRoll = await q('SELECT id FROM students WHERE roll_no IS NULL ORDER BY reg_no');
  for (let j = 0; j < missingRoll.length; j++) {
    await pool.query('UPDATE students SET roll_no = $1 WHERE id = $2', [String(j + 1).padStart(2, '0'), missingRoll[j].id]);
  }

  console.log(`🌱 Ensured admin + ${FACULTY.length} teaching staff (HOD: ${COLLEGE.hod}).`);
}

async function init() {
  await createSchema();
  await seedIfEmpty();
}

// Convenience: just the subject names, used where only the label matters.
const SUBJECT_NAMES = SUBJECTS.map(s => s.name);

module.exports = { pool, q, one, tx, init, COLLEGE, SUBJECTS, SUBJECT_NAMES, FACULTY, PERIODS, MARK_TYPES, STUDENTS, facultyEmail };
