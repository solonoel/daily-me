const sql = require('mssql');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 60000,
    requestTimeout: 60000
  }
};

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = req.body?.userID || 1;

    const recencyDays = req.body?.recencyDays || 7;

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays)
      .query(`
        DELETE FROM [HeadlineExclusion]
        WHERE UserID = @UserID
          AND DeletedDate < DATEADD(day, -@RecencyDays, GETUTCDATE());

        DELETE FROM [Headline]
        WHERE UserID = @UserID AND ISNULL(Retain, 'N') != 'Y';

        SELECT @@ROWCOUNT AS DeletedCount;
      `);

    const deleted = result.recordset[0]?.DeletedCount || 0;

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, deleted })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};