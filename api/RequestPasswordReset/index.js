const sql = require('mssql');
const crypto = require('crypto');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

module.exports = async function(context, req) {
  try {
    const { email } = req.body;
    const ok = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, message: 'If that email address is registered, a password reset link has been sent.' }) };

    if (!email) { context.res = ok; return; }

    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('Email', sql.NVarChar(200), email.toLowerCase())
      .query(`SELECT UserID, Name FROM [User] WHERE Email=@Email AND IsActive='Y'`);

    if (!result.recordset.length) { context.res = ok; return; }

    const { UserID, Name } = result.recordset[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.request()
      .input('UserID', sql.Int, UserID)
      .input('Token', sql.NVarChar(100), token)
      .input('Expiry', sql.DateTime, expiry)
      .query(`UPDATE [User] SET VerifyToken=@Token, VerifyExpiry=@Expiry WHERE UserID=@UserID`);

    const resetUrl = `${process.env.APP_URL}/reset.html?token=${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Daily Me <noreply@brunsusa.com>',
        to: email,
        subject: 'Reset your Daily Me password',
        html: `<h2>Password Reset</h2><p>Hi ${Name},</p><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="background:#2b7fd4;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Reset my password</a></p><p>If you didn't request this, you can ignore this email.</p>`
      })
    });

    context.res = ok;
  } catch(err) {
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Server error. Please try again.' }) };
  }
};
