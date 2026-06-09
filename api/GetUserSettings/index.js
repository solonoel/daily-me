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
      .query(`SELECT hs.RecencyDays, hs.MaxHeadlines, hs.YouTubeMaxResults, hs.OtherHeadlinesPerKeyword, hs.FetchHour, hs.DisableYoutubeToday, hs.CollapseThreshold, hs.WeatherURL, hs.LaunchMode, hs.NavButtonsPerRow, yq.QuotaUsed, yq.QuotaDate FROM [HeadlineSetting] hs CROSS JOIN YouTubeQuota yq WHERE hs.UserID=@UserID AND yq.QuotaID=1`);

    const userResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserID, Name, Email, IsActive, ZipCode FROM [User] WHERE UserID = @UserID`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userResult.recordset[0] || null,
        headlineSetting: settingResult.recordset[0] || { RecencyDays: 7, MaxHeadlines: 50, YouTubeMaxResults: 3, CollapseThreshold: 5, LaunchMode: 'Full', NavButtonsPerRow: 4 },
        categorySettings: []
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};