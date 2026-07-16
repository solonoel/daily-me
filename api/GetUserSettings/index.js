const sql = require('mssql');

const DEFAULT_NAV_WIDTH = 328;

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
    const profileID = parseInt(req.query.profileID || '0') || null;

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT hs.RecencyDays, hs.MaxHeadlines, hs.YouTubeMaxResults, hs.OtherHeadlinesPerKeyword, hs.FetchHour, hs.DisableYoutubeToday, hs.CollapseThreshold, hs.WeatherURL, hs.LaunchMode, yq.QuotaUsed, yq.QuotaDate FROM [HeadlineSetting] hs CROSS JOIN YouTubeQuota yq WHERE hs.UserID=@UserID AND yq.QuotaID=1`);

    const userResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserID, Name, Email, IsActive, ZipCode FROM [User] WHERE UserID = @UserID`);

    let navWidth = DEFAULT_NAV_WIDTH;
    if (profileID) {
      const navWidthResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('UserProfileID', sql.Int, profileID)
        .query(`SELECT SettingValue FROM UserProfileSetting WHERE UserID = @UserID AND UserProfileID = @UserProfileID AND SettingKey = 'NavWidth'`);
      const raw = navWidthResult.recordset[0]?.SettingValue;
      if (raw !== undefined && raw !== null) {
        const parsed = parseInt(raw);
        if (!isNaN(parsed)) navWidth = parsed;
      }
    }

    const headlineSetting = settingResult.recordset[0] || { RecencyDays: 7, MaxHeadlines: 50, YouTubeMaxResults: 3, CollapseThreshold: 5, LaunchMode: 'Full' };
    headlineSetting.NavWidth = navWidth;

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: userResult.recordset[0] || null,
        headlineSetting,
        categorySettings: []
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};