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
    const { userID = 1, recencyDays, maxHeadlines, youTubeMaxResults, otherHeadlinesPerKeyword, categorySettings, disableYoutubeToday, fetchHour } = req.body;

    if (disableYoutubeToday !== undefined) {
      const resetYT = req.body.resetYouTubeFetch === true;
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('DisableYoutubeToday', sql.Bit, disableYoutubeToday ? 1 : 0)
        .query(`UPDATE [HeadlineSetting] SET DisableYoutubeToday = @DisableYoutubeToday${resetYT ? ', LastYouTubeFetch = NULL' : ''} WHERE UserID = @UserID`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
      return;
    }

    if (fetchHour !== undefined) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('FetchHour', sql.Int, fetchHour === null ? null : parseInt(fetchHour))
        .query(`UPDATE [HeadlineSetting] SET FetchHour = @FetchHour WHERE UserID = @UserID`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
      return;
    }

    if (recencyDays || maxHeadlines) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('RecencyDays', sql.Int, recencyDays || 7)
        .input('MaxHeadlines', sql.Int, maxHeadlines || 50)
        .input('YouTubeMaxResults', sql.Int, youTubeMaxResults || 3)
        .input('OtherHeadlinesPerKeyword', sql.Int, otherHeadlinesPerKeyword ?? 3)
        .query(`
          UPDATE [HeadlineSetting]
          SET RecencyDays = @RecencyDays, MaxHeadlines = @MaxHeadlines, YouTubeMaxResults = @YouTubeMaxResults,
              OtherHeadlinesPerKeyword = @OtherHeadlinesPerKeyword
          WHERE UserID = @UserID
        `);
    }

    let maxAdjusted = false;
    let newMaxHeadlines = maxHeadlines;

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

      const sumResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT SUM(MaxItems) AS Total FROM [UserCategorySetting] WHERE UserID = @UserID`);
      const catSum = sumResult.recordset[0]?.Total || 0;

      const currentMax = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT MaxHeadlines FROM [HeadlineSetting] WHERE UserID = @UserID`);
      const currentMaxVal = currentMax.recordset[0]?.MaxHeadlines || 50;

      if (catSum > currentMaxVal) {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('MaxHeadlines', sql.Int, catSum)
          .query(`UPDATE [HeadlineSetting] SET MaxHeadlines = @MaxHeadlines WHERE UserID = @UserID`);
        newMaxHeadlines = catSum;
        maxAdjusted = true;
      }
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, maxAdjusted, newMaxHeadlines })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};