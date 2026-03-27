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
    const { userID = 1, recencyDays, maxHeadlines, categorySettings } = req.body;

    if (recencyDays || maxHeadlines) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('RecencyDays', sql.Int, recencyDays || 7)
        .input('MaxHeadlines', sql.Int, maxHeadlines || 50)
        .query(`
          UPDATE [HeadlineSetting]
          SET RecencyDays = @RecencyDays, MaxHeadlines = @MaxHeadlines
          WHERE UserID = @UserID
        `);
    }

    if (categorySettings && Array.isArray(categorySettings)) {
      for (const cs of categorySettings) {
        const existing = await pool.request()
          .input('UserID', sql.Int, userID)
          .input('CategoryID', sql.Int, cs.categoryID)
          .query(`SELECT SettingID FROM [UserCategorySetting] WHERE UserID = @UserID AND CategoryID = @CategoryID`);

        if (existing.recordset.length > 0) {
          await pool.request()
            .input('UserID', sql.Int, userID)
            .input('CategoryID', sql.Int, cs.categoryID)
            .input('MaxItems', sql.Int, cs.maxItems)
            .query(`UPDATE [UserCategorySetting] SET MaxItems = @MaxItems WHERE UserID = @UserID AND CategoryID = @CategoryID`);
        } else {
          await pool.request()
            .input('UserID', sql.Int, userID)
            .input('CategoryID', sql.Int, cs.categoryID)
            .input('MaxItems', sql.Int, cs.maxItems)
            .query(`INSERT INTO [UserCategorySetting] (UserID, CategoryID, MaxItems) VALUES (@UserID, @CategoryID, @MaxItems)`);
        }
      }
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};