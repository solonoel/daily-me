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
    const pool = await sql.connect(config);
    const wordID = parseInt(req.query.wordID || '0');

    const result = await pool.request()
      .input('WordID', sql.Int, wordID)
      .query(`SELECT d.UserLanguageWordsDeckID, d.UserLanguageWordsDeckName
              FROM UserLanguageWordsDeckWords dw
              JOIN UserLanguageWordsDeck d ON d.UserLanguageWordsDeckID = dw.UserLanguageWordsDeckID
              WHERE dw.UserLanguageWordsID = @WordID
              ORDER BY d.UserLanguageWordsDeckName`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};