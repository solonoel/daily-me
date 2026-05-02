const sql = require('mssql');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 60000,
    requestTimeout: 60000
  }
};

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = parseInt(req.query.userID || '1');

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT k.KeywordID, k.CategoryID, k.Keyword, k.IsActive, k.Sequence,
               k.GroupLabel, k.ImageURL, k.SourceID, c.Name AS CategoryName,
               h.Name AS SourceName
        FROM [HeadlineKeyword] k
        LEFT JOIN [Category] c ON k.CategoryID = c.CategoryID
        LEFT JOIN [HeadlineSource] h ON k.SourceID = h.SourceID
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