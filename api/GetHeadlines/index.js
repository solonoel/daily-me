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
    const recencyDays = parseInt(req.query.recencyDays || '7');
    const profileIDRaw = req.query.profileID;
    const profileID = (profileIDRaw !== undefined && profileIDRaw !== '') ? parseInt(profileIDRaw) : null;

    const query = `
      SELECT h.HeadlineID, h.UserID, h.HeadlineName,
             h.Link, h.Summary, h.CreatedDate, h.PublishedDate, h.LastViewedDate, h.Retain,
             h.KeywordID, h.ThumbnailURL, h.ChannelName, h.ChannelURL, h.Duration,
             h.UserMenuID, h.MenuSeq,
             CASE WHEN uhs.IsFiltered = 0 THEN 1 ELSE 0 END AS IsSubscription,
             k.Keyword, k.Sequence AS KeywordSequence,
             k.GroupLabel AS KeywordGroupLabel,
             k.ImageURL AS KeywordImage,
             h.SourceID, hs.Name AS SourceName,
             uhs.GroupLabel AS SourceGroupLabel,
             uhs.UserMenuID AS SourceUserMenuID,
             uos.GroupLabel AS OwnedSourceGroupLabel,
             (SELECT TOP 1 k2.ImageURL FROM [HeadlineKeyword] k2
              WHERE k2.UserID = @UserID AND k2.GroupLabel = k.GroupLabel
              AND k2.GroupLabel IS NOT NULL AND k2.ImageURL IS NOT NULL) AS KeywordGroupImage
      FROM [Headline] h
      LEFT JOIN [HeadlineKeyword] k ON h.KeywordID = k.KeywordID
      LEFT JOIN [HeadlineSource] hs ON h.SourceID = hs.SourceID
      LEFT JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID AND uhs.UserID = @UserID
      LEFT JOIN [UserOwnedSource] uos ON h.UserOwnedSourceID = uos.UserOwnedSourceID
      WHERE h.UserID = @UserID
      AND (h.UserProfileID = @ProfileID OR (@ProfileID IS NULL AND h.UserProfileID IS NULL))
      AND COALESCE(h.PublishedDate, h.CreatedDate) >= DATEADD(day, -@RecencyDays, GETDATE())
      ORDER BY
        COALESCE(k.Sequence, 999),
        CASE WHEN h.KeywordID IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(h.PublishedDate, h.CreatedDate) DESC
    `;

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays)
      .input('ProfileID', sql.Int, profileID)
      .query(query);

    let headlines = result.recordset;

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT MaxHeadlines FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const maxHeadlines = settingResult.recordset[0]?.MaxHeadlines || 50;

    let kwCount = 0;
    headlines = headlines.filter(h => {
      if (h.IsSubscription === 1) return true;
      if (kwCount < maxHeadlines) { kwCount++; return true; }
      return false;
    });

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(headlines)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};