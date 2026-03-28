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
    const { action, keywordID, keyword, categoryID, isActive, userID = 1 } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Keyword', sql.NVarChar(200), keyword)
        .query(`
          INSERT INTO [HeadlineKeyword] (UserID, CategoryID, Keyword, IsActive, CreatedDate)
          VALUES (@UserID, @CategoryID, @Keyword, 'Y', GETDATE());
          SELECT SCOPE_IDENTITY() AS KeywordID;
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, keywordID: result.recordset[0].KeywordID })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('KeywordID', sql.Int, keywordID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Keyword', sql.NVarChar(200), keyword)
        .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
        .input('UserID', sql.Int, userID)
        .query(`
          UPDATE [HeadlineKeyword]
          SET Keyword = @Keyword, CategoryID = @CategoryID, IsActive = @IsActive
          WHERE KeywordID = @KeywordID AND UserID = @UserID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

} else if (action === 'delete') {
      await pool.request()
        .input('KeywordID', sql.Int, keywordID)
        .query(`UPDATE [Headline] SET KeywordID = NULL WHERE KeywordID = @KeywordID`);
      await pool.request()
        .input('KeywordID', sql.Int, keywordID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [HeadlineKeyword] WHERE KeywordID = @KeywordID AND UserID = @UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};