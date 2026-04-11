const sql = require('mssql');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};
module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = parseInt(req.query.userID || '1');
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT LastFetchLog FROM HeadlineSetting WHERE UserID = @UserID`);
    const log = result.recordset[0]?.LastFetchLog;
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: log || JSON.stringify({ error: 'No fetch log available' })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};