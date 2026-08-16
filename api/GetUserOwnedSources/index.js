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
      .query(`SELECT u.UserOwnedSourceID, u.SourceName, u.Description, u.SourceType, u.URL,
                     u.ThumbnailURL, u.Exclusions, u.Sequence, u.IsInactive, u.DateAdded,
                     u.UserMenuID, u.GroupLabel, u.IsSysHeader, u.YoutubeChannelID,
                     ISNULL(act.Count30d,0) AS Count30d
              FROM UserOwnedSource u
              OUTER APPLY (
                SELECT SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d
                FROM SourceActivityLog
                WHERE EntityType='MySource' AND EntityID=u.UserOwnedSourceID AND UserID=@UserID
              ) act
              WHERE u.UserID = @UserID ${whereInactive}
              ORDER BY u.Sequence, u.UserOwnedSourceID`);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result.recordset) };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};