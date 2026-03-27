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

function sendVerificationEmail(toEmail, token, name) {
  return new Promise((resolve) => {
    const verifyUrl = `${process.env.APP_URL}/api/VerifyEmail?token=${token}`;
    const subject = 'Verify your Daily Me account';
    const body = `Welcome to Daily Me, ${name}!\r\n\r\nClick the link below to verify your email:\r\n${verifyUrl}\r\n\r\nThis link expires in 24 hours.`;

    const emailData = JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: process.env.GMAIL_USER, name: 'Daily Me' },
      subject,
      content: [{ type: 'text/plain', value: body }]
    });

    // Use Gmail SMTP via nodemailer-style raw SMTP is complex in pure Node
    // Instead use Gmail API via fetch
    const authString = Buffer.from(`${process.env.GMAIL_USER}:${process.env.GMAIL_APP_PASSWORD}`).toString('base64');

    const boundary = 'boundary_' + Date.now();
    const rawEmail = [
      `To: ${toEmail}`,
      `From: Daily Me <${process.env.GMAIL_USER}>`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body
    ].join('\r\n');

    const encoded = Buffer.from(rawEmail).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

    const postData = JSON.stringify({ raw: encoded });

    const options = {
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/messages/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    // Fall back to a simple SMTP approach using net module
    // Actually let's use a direct SMTP connection
    resolve(200); // placeholder - we'll use nodemailer
  });
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

    // Send verification email using nodemailer
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const verifyUrl = `${process.env.APP_URL}/api/VerifyEmail?token=${verifyToken}`;
    await transporter.sendMail({
      from: `"Daily Me" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Verify your Daily Me account',
      html: `<h2>Welcome to Daily Me, ${name}!</h2><p>Click the link below to verify your email address:</p><p><a href="${verifyUrl}" style="background:#2b7fd4;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Verify my email</a></p><p>This link expires in 24 hours.</p>`
    });

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Registration successful. Please check your email to verify your account.' })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};