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
    const userID = parseInt(req.query.userID || 1);
    const includeInactive = req.query.includeInactive === 'true';
    const whereInactive = includeInactive ? '' : 'AND IsInactive = 0';
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserOwnedSourceID, SourceName, Description, SourceType, URL,
                     ThumbnailURL, Exclusions, Sequence, IsInactive, DateAdded,
                     UserMenuID, GroupLabel
              FROM UserOwnedSource
              WHERE UserID = @UserID ${whereInactive}
              ORDER BY Sequence, UserOwnedSourceID`);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.recordset) };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};