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
    const userID = parseInt(req.query.userID || '1');
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT k.KeywordID, k.Keyword, k.IsActive, k.Sequence, k.CreatedDate,
               k.GroupLabel, k.ImageURL, k.SourceID, k.UserMenuID, k.UserOwnedSourceID,
               COALESCE(h.Name, u.SourceName) AS SourceName,
               ISNULL(act.Count30d,0) AS Count30d
        FROM [HeadlineKeyword] k
        LEFT JOIN [HeadlineSource] h ON k.SourceID = h.SourceID
        LEFT JOIN [UserOwnedSource] u ON k.UserOwnedSourceID = u.UserOwnedSourceID AND u.UserID = @UserID
        OUTER APPLY (
          SELECT SUM(CASE WHEN OccurredDate >= DATEADD(day,-30,GETDATE()) THEN 1 ELSE 0 END) AS Count30d
          FROM SourceActivityLog
          WHERE EntityType='Keyword' AND EntityID=k.KeywordID AND UserID=@UserID
        ) act
        WHERE k.UserID = @UserID
        ORDER BY k.Sequence, k.Keyword
      `);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch (err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};