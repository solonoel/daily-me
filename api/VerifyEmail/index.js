const sql = require('mssql');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

module.exports = async function(context, req) {
  try {
    const token = req.query.token;

    if (!token) {
      context.res = { status: 400, body: 'Verification token is required' };
      return;
    }

    const pool = await sql.connect(config);

    const result = await pool.request()
      .input('Token', sql.NVarChar(100), token)
      .query(`
        SELECT UserID, VerifyExpiry, EmailVerified
        FROM [User]
        WHERE VerifyToken = @Token
      `);

    if (result.recordset.length === 0) {
      context.res = { status: 400, body: 'Invalid verification token' };
      return;
    }

    const user = result.recordset[0];

    if (user.EmailVerified === 'Y') {
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: 'Email already verified' })
      };
      return;
    }

    if (new Date() > new Date(user.VerifyExpiry)) {
      context.res = { status: 400, body: 'Verification token has expired. Please register again.' };
      return;
    }

    await pool.request()
      .input('UserID', sql.Int, user.UserID)
      .query(`
        UPDATE [User]
        SET EmailVerified = 'Y', VerifyToken = NULL, VerifyExpiry = NULL
        WHERE UserID = @UserID
      `);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Email verified successfully. You can now log in.' })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};