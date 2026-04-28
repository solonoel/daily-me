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
    const { action, keywordID, keyword, categoryID, isActive, sequence, sequences, groupLabel, imageURL, userID = 1 } = req.body;

    const resetYouTube = async () => {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`UPDATE [HeadlineSetting] SET LastYouTubeFetch = NULL WHERE UserID = @UserID`);
    };

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Keyword', sql.NVarChar(200), keyword)
        .input('Sequence', sql.Int, sequence || 99)
        .input('GroupLabel', sql.VarChar(100), groupLabel || null)
        .input('ImageURL', sql.NVarChar(sql.MAX), imageURL || null)
        .query(`
          INSERT INTO [HeadlineKeyword] (UserID, CategoryID, Keyword, IsActive, Sequence, GroupLabel, ImageURL, CreatedDate)
          VALUES (@UserID, @CategoryID, @Keyword, 'Y', @Sequence, @GroupLabel, @ImageURL, GETDATE());
          SELECT SCOPE_IDENTITY() AS KeywordID;
        `);
      await resetYouTube();
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
        .input('Sequence', sql.Int, sequence || 99)
        .input('GroupLabel', sql.VarChar(100), groupLabel || null)
        .input('ImageURL', sql.NVarChar(sql.MAX), imageURL || null)
        .input('UserID', sql.Int, userID)
        .query(`
          UPDATE [HeadlineKeyword]
          SET Keyword = @Keyword, CategoryID = @CategoryID, IsActive = @IsActive,
              Sequence = @Sequence, GroupLabel = @GroupLabel, ImageURL = @ImageURL
          WHERE KeywordID = @KeywordID AND UserID = @UserID
        `);
      await resetYouTube();
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'reorder') {
      for (const s of sequences) {
        await pool.request()
          .input('KeywordID', sql.Int, s.keywordID)
          .input('Sequence', sql.Int, s.sequence)
          .input('UserID', sql.Int, userID)
          .query(`UPDATE [HeadlineKeyword] SET Sequence = @Sequence WHERE KeywordID = @KeywordID AND UserID = @UserID`);
      }
      await resetYouTube();
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };

    } else if (action === 'delete') {
      await pool.request()
        .input('KeywordID', sql.Int, keywordID)
        .query(`UPDATE [Headline] SET KeywordID = NULL WHERE KeywordID = @KeywordID`);
      await pool.request()
        .input('KeywordID', sql.Int, keywordID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [HeadlineKeyword] WHERE KeywordID = @KeywordID AND UserID = @UserID`);
      await resetYouTube();
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