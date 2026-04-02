const sql = require('mssql');
const crypto = require('crypto');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

module.exports = async function(context, req) {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Token and password are required' }) };
      return;
    }

    // Password length restriction temporarily disabled
    // if (password.length < 8) { ... }

    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('Token', sql.NVarChar(100), token)
      .query(`SELECT UserID, VerifyExpiry FROM [User] WHERE VerifyToken=@Token AND IsActive='Y'`);

    if (!result.recordset.length) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Invalid or expired reset link.' }) };
      return;
    }

    const { UserID, VerifyExpiry } = result.recordset[0];
    if (new Date() > new Date(VerifyExpiry)) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'This reset link has expired. Please request a new one.' }) };
      return;
    }

    const salt = crypto.randomBytes(32).toString('hex');
    const passwordHash = hashPassword(password, salt);

    await pool.request()
      .input('UserID', sql.Int, UserID)
      .input('Hash', sql.NVarChar(256), passwordHash)
      .input('Salt', sql.NVarChar(64), salt)
      .query(`UPDATE [User] SET PasswordHash=@Hash, Salt=@Salt, VerifyToken=NULL, VerifyExpiry=NULL WHERE UserID=@UserID`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Password updated successfully. You can now log in.' })
    };
  } catch(err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Server error. Please try again.' }) };
  }
};
