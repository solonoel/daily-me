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
    const { userID, userLanguageWordsID, presentParticiple, pastParticiple } = req.body;
    const pool = await sql.connect(config);
    await pool.request()
      .input('UserID', sql.Int, userID)
      .input('WordID', sql.Int, userLanguageWordsID)
      .input('PresentParticiple', sql.NVarChar(200), presentParticiple || null)
      .input('PastParticiple', sql.NVarChar(200), pastParticiple || null)
      .query(`MERGE UserVerbParticiple AS target
              USING (SELECT @UserID AS UserID, @WordID AS UserLanguageWordsID) AS source
              ON target.UserID = source.UserID AND target.UserLanguageWordsID = source.UserLanguageWordsID
              WHEN MATCHED THEN UPDATE SET PresentParticiple=@PresentParticiple, PastParticiple=@PastParticiple
              WHEN NOT MATCHED THEN INSERT (UserID, UserLanguageWordsID, PresentParticiple, PastParticiple)
                VALUES (@UserID, @WordID, @PresentParticiple, @PastParticiple);`);
    context.res = { status: 200, body: JSON.stringify({ success: true }) };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};