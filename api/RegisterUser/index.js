const sql = require('mssql');
const crypto = require('crypto');
const https = require('https');

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

async function sendVerificationEmail(toEmail, token, name) {
  const verifyUrl = `${process.env.APP_URL}/verify.html?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Daily Me <noreply@brunsusa.com>',
      to: toEmail,
      subject: 'Verify your Daily Me account',
      html: `<h2>Welcome to Daily Me, ${name}!</h2><p>Click the link below to verify your email address:</p><p><a href="${verifyUrl}" style="background:#2b7fd4;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Verify my email</a></p><p>This link expires in 24 hours.</p>`
    })
  });
   const body = await res.text();
  return `${res.status}: ${body}`;
}

module.exports = async function(context, req) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      context.res = { status: 400, body: 'Name, email and password are required' };
      return;
    }

    if (password.length < 8) {
      context.res = { status: 400, body: 'Password must be at least 8 characters' };
      return;
    }

    const pool = await sql.connect(config);

    const existing = await pool.request()
      .input('Email', sql.NVarChar(200), email.toLowerCase())
      .query(`SELECT UserID FROM [User] WHERE Email = @Email`);

    if (existing.recordset.length > 0) {
      context.res = { status: 409, body: 'An account with this email already exists' };
      return;
    }

    const salt = crypto.randomBytes(32).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await pool.request()
      .input('Name', sql.NVarChar(100), name)
      .input('Email', sql.NVarChar(200), email.toLowerCase())
      .input('PasswordHash', sql.NVarChar(256), passwordHash)
      .input('Salt', sql.NVarChar(64), salt)
      .input('VerifyToken', sql.NVarChar(100), verifyToken)
      .input('VerifyExpiry', sql.DateTime, verifyExpiry)
      .query(`
        INSERT INTO [User] (Name, Email, PasswordHash, Salt, CreatedDate, IsActive, EmailVerified, VerifyToken, VerifyExpiry)
        VALUES (@Name, @Email, @PasswordHash, @Salt, GETDATE(), 'Y', 'N', @VerifyToken, @VerifyExpiry);
        SELECT SCOPE_IDENTITY() AS UserID;
      `);

    const userID = result.recordset[0].UserID;

    await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`INSERT INTO [HeadlineSetting] (UserID, RecencyDays, MaxHeadlines) VALUES (@UserID, 7, 50)`);

    const emailStatus = await sendVerificationEmail(email, verifyToken, name);
    context.log(`Email send status: ${emailStatus}`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Registration successful. Please check your email to verify your account.' })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};