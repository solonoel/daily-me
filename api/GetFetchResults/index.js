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
      .query(`
        SELECT h.SourceID AS EntityID, 'SharedSource' AS EntityType, h.Name AS DisplayName, h.SourceType,
               act.LastRetrieved, ISNULL(act.Count30d,0) AS Count30d
        FROM HeadlineSource h
        INNER JOIN UserHeadlineSource uhs ON h.SourceID = uhs.SourceID AND uhs.UserID=@UserID
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d
          FROM SourceActivityLog
          WHERE EntityType='SharedSource' AND EntityID=h.SourceID AND UserID=@UserID
        ) act
        WHERE h.SourceType IN ('API','RSS') OR (h.SourceType='URL' AND h.URL LIKE '%youtube.com%')

        UNION ALL

        SELECT u.UserOwnedSourceID, 'MySource', u.SourceName, u.SourceType,
               act.LastRetrieved, ISNULL(act.Count30d,0)
        FROM UserOwnedSource u
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d
          FROM SourceActivityLog
          WHERE EntityType='MySource' AND EntityID=u.UserOwnedSourceID AND UserID=@UserID
        ) act
        WHERE u.UserID=@UserID AND u.SourceType IN ('RSS','YT Subscription')

        UNION ALL

        SELECT k.KeywordID, 'Keyword', k.Keyword, 'Keyword',
               act.LastRetrieved, ISNULL(act.Count30d,0)
        FROM HeadlineKeyword k
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d
          FROM SourceActivityLog
          WHERE EntityType='Keyword' AND EntityID=k.KeywordID AND UserID=@UserID
        ) act
        WHERE k.UserID=@UserID

        ORDER BY EntityType, DisplayName
      `);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};