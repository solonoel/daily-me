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
    const result = await pool.request()
      .query(`SELECT LanguageID, SequenceNo, LanguageName, LanguageNameEng, FlagImage
              FROM [Language] ORDER BY SequenceNo`);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
