/* ------------------------------------------------------------------
   One-off maintenance script: replace the entire student roster with
   the official class list in db.js (STUDENTS). DESTRUCTIVE — clears
   existing students and all their attendance/marks first.

   Usage:  DATABASE_URL="postgres://..." node reseedStudents.js
------------------------------------------------------------------ */
const bcrypt = require('bcryptjs');
const { pool, STUDENTS } = require('./db');

(async () => {
  const pw = bcrypt.hashSync('Student@123', 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear dependent data first (also removed via cascade, but explicit is clearer).
    await client.query('DELETE FROM marks');
    await client.query('DELETE FROM attendance_records');
    await client.query('DELETE FROM attendance_sessions');
    await client.query('DELETE FROM students');
    for (const [reg, name] of STUDENTS) {
      const email = name.split(' ')[0].toLowerCase() + '@eevlsi.edu';
      await client.query(
        'INSERT INTO students (name, reg_no, semester, email, password_hash) VALUES ($1,$2,$3,$4,$5)',
        [name, reg, 5, email, pw]);
    }
    await client.query('COMMIT');
    const c = (await client.query('SELECT COUNT(*)::int AS c FROM students')).rows[0].c;
    console.log(`✅ Roster replaced. Student count = ${c}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Reseed failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
