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
    const { email, password } = req.body;

    if (!email || !password) {
      context.res = { status: 400, body: 'Email and password are required' };
      return;
    }

    const pool = await sql.connect(config);

    const result = await pool.request()
      .input('Email', sql.NVarChar(200), email.toLowerCase())
      .query(`
        SELECT UserID, Name, Email, PasswordHash, Salt, EmailVerified, IsActive
        FROM [User]
        WHERE Email = @Email
      `);

    if (result.recordset.length === 0) {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Invalid email or password' }) };
      return;
    }

    const user = result.recordset[0];

    if (user.IsActive !== 'Y') {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Account is inactive' }) };
      return;
    }

    if (user.EmailVerified !== 'Y') {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Please verify your email before logging in' }) };
      return;
    }

    const hash = hashPassword(password, user.Salt);
    if (hash !== user.PasswordHash) {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Invalid email or password' }) };
      return;
    }

    // Update last login
    await pool.request()
      .input('UserID', sql.Int, user.UserID)
      .query(`UPDATE [User] SET LastLogin = GETDATE() WHERE UserID = @UserID`);

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        userID: user.UserID,
        name: user.Name,
        email: user.Email,
        sessionToken
      })
    };
  } catch(err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Server error. Please try again.' }) };
  }
};