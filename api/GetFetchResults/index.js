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
    const profileID = parseInt(req.query.profileID || 0) || null;
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('UserProfileID', sql.Int, profileID)
      .query(`
        SELECT h.SourceID AS EntityID, 'SharedSource' AS EntityType, h.Name AS DisplayName, h.SourceType,
               CASE WHEN uhs.IsActive=0 THEN 'N' ELSE 'Y' END AS IsActive,
               CASE WHEN uhs.IsFiltered=1 THEN 'Y' ELSE 'N' END AS IsFiltered,
               um.UserMenuName AS MenuName,
               CAST(NULL AS NVARCHAR(255)) AS SourceName,
               act.LastRetrieved, ISNULL(act.Count30d,0) AS Count30d, ISNULL(act.Count90d,0) AS Count90d
        FROM HeadlineSource h
        INNER JOIN UserHeadlineSource uhs ON h.SourceID = uhs.SourceID AND uhs.UserID=@UserID
        LEFT JOIN UserMenu um ON uhs.UserMenuID = um.UserMenuID
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-90,GETDATE()) THEN 1 ELSE 0 END) AS Count90d
          FROM SourceActivityLog
          WHERE EntityType='SharedSource' AND EntityID=h.SourceID AND UserID=@UserID
        ) act
        WHERE (@UserProfileID IS NULL OR uhs.UserProfileID=@UserProfileID)

        UNION ALL

        SELECT u.UserOwnedSourceID, 'MySource', u.SourceName, u.SourceType,
               CASE WHEN u.IsInactive=1 THEN 'N' ELSE 'Y' END AS IsActive,
               CAST(NULL AS VARCHAR(1)) AS IsFiltered,
               um2.UserMenuName AS MenuName,
               CAST(NULL AS NVARCHAR(255)) AS SourceName,
               act.LastRetrieved, ISNULL(act.Count30d,0), ISNULL(act.Count90d,0)
        FROM UserOwnedSource u
        LEFT JOIN UserMenu um2 ON u.UserMenuID = um2.UserMenuID
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-90,GETDATE()) THEN 1 ELSE 0 END) AS Count90d
          FROM SourceActivityLog
          WHERE EntityType='MySource' AND EntityID=u.UserOwnedSourceID AND UserID=@UserID
        ) act
        WHERE u.UserID=@UserID AND (@UserProfileID IS NULL OR u.UserProfileID=@UserProfileID)

        UNION ALL

        SELECT k.KeywordID, 'Keyword', k.Keyword, 'Keyword',
               CASE WHEN k.IsActive='Y' THEN 'Y' ELSE 'N' END AS IsActive,
               CAST(NULL AS VARCHAR(1)) AS IsFiltered,
               um3.UserMenuName AS MenuName,
               COALESCE(hs.Name, uos.SourceName) AS SourceName,
               act.LastRetrieved, ISNULL(act.Count30d,0), ISNULL(act.Count90d,0)
        FROM HeadlineKeyword k
        LEFT JOIN UserMenu um3 ON k.UserMenuID = um3.UserMenuID
        LEFT JOIN HeadlineSource hs ON k.SourceID = hs.SourceID
        LEFT JOIN UserOwnedSource uos ON k.UserOwnedSourceID = uos.UserOwnedSourceID AND uos.UserID=@UserID
        OUTER APPLY (
          SELECT MAX(OccurredDate) AS LastRetrieved,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d,
                 SUM(CASE WHEN OccurredDate >= DATEADD(day,-90,GETDATE()) THEN 1 ELSE 0 END) AS Count90d
          FROM SourceActivityLog
          WHERE EntityType='Keyword' AND EntityID=k.KeywordID AND UserID=@UserID
        ) act
        WHERE k.UserID=@UserID AND (@UserProfileID IS NULL OR k.UserProfileID=@UserProfileID)

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