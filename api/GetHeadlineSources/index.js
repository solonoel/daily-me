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
    const allSources = req.query.all === 'true';
    let result;
    if (allSources) {
      result = await pool.request()
        .query(`
          SELECT SourceID, Name, URL, SourceType, IsActive,
                 Sequence, DateAdded, YoutubeChannelID
          FROM [HeadlineSource]
          ORDER BY Sequence, Name
        `);
    } else {
      result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          SELECT h.SourceID, h.Name, h.URL, h.SourceType, h.IsActive AS GlobalIsActive,
                 h.Sequence, h.DateAdded, h.YoutubeChannelID, uhs.IsFiltered, uhs.Exclusions,
                 uhs.IsActive AS UserIsActive, uhs.GroupLabel, uhs.UserMenuID
          FROM [HeadlineSource] h
          INNER JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID
          WHERE uhs.UserID = @UserID
          ORDER BY h.Sequence, h.Name
        `);
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};