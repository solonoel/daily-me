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

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines, YouTubeMaxResults, OtherHeadlinesPerKeyword, FetchHour, DisableYoutubeToday, QuotaUsed, QuotaDate FROM [HeadlineSetting] WHERE UserID = @UserID`);

    const catSettingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT ucs.CategoryID, ucs.MaxItems, c.Name AS CategoryName
        FROM [UserCategorySetting] ucs
        JOIN [Category] c ON ucs.CategoryID = c.CategoryID
        WHERE ucs.UserID = @UserID
      `);

    const userResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserID, Name, Email, IsActive, ZipCode FROM [User] WHERE UserID = @UserID`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userResult.recordset[0] || null,
        headlineSetting: settingResult.recordset[0] || { RecencyDays: 7, MaxHeadlines: 50, YouTubeMaxResults: 3 },
        categorySettings: catSettingResult.recordset
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};