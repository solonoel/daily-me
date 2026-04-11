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
    const categoryID = req.query.categoryID;
    const recencyDays = parseInt(req.query.recencyDays || '7');
    const unlimited = req.query.unlimited === 'true';

    let query = `
SELECT h.HeadlineID, h.UserID, h.CategoryID, h.HeadlineName,
             h.Link, h.Summary, h.CreatedDate, h.LastViewedDate, h.Retain,
             h.KeywordID, h.TopicID, h.ThumbnailURL, h.ChannelName, h.ChannelURL, h.Duration,
             CASE WHEN uhs.IsFiltered = 0 THEN 1 ELSE 0 END AS IsSubscription,
             c.Name AS CategoryName, k.Keyword, k.Sequence AS KeywordSequence,
             k.GroupLabel AS KeywordGroupLabel, t.GroupLabel AS TopicGroupLabel,
             t.Topic, t.Sequence AS TopicSequence,
             hs.Name AS SourceName
      FROM [Headline] h
      LEFT JOIN [Category] c ON h.CategoryID = c.CategoryID
      LEFT JOIN [HeadlineKeyword] k ON h.KeywordID = k.KeywordID
      LEFT JOIN [HeadlineTopic] t ON h.TopicID = t.TopicID
      LEFT JOIN [HeadlineSource] hs ON h.SourceID = hs.SourceID
      LEFT JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID AND uhs.UserID = @UserID
      WHERE h.UserID = @UserID
      AND h.CreatedDate >= DATEADD(day, -@RecencyDays, GETDATE())
    `;

    if (categoryID) query += ` AND h.CategoryID = @CategoryID`;
    query += ` ORDER BY h.CategoryID,
                COALESCE(k.Sequence, t.Sequence, 999),
                CASE WHEN h.KeywordID IS NOT NULL THEN 0 ELSE 1 END,
                h.CreatedDate DESC`;

    const request = pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays);

    if (categoryID) request.input('CategoryID', sql.Int, parseInt(categoryID));

    const result = await request.query(query);
    let headlines = result.recordset;

    // Apply per-category display limits when not filtering by a single category
    if (!categoryID && !unlimited) {
      const catLimitsResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT CategoryID, MaxItems FROM [UserCategorySetting] WHERE UserID = @UserID`);
      const catLimits = {};
      catLimitsResult.recordset.forEach(r => catLimits[r.CategoryID] = r.MaxItems);

      const settingResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT MaxHeadlines FROM [HeadlineSetting] WHERE UserID = @UserID`);
      const maxHeadlines = settingResult.recordset[0]?.MaxHeadlines || 50;
      const numCats = Object.keys(catLimits).length || 5;
      const defaultPerCat = Math.ceil(maxHeadlines / numCats);

      const catCounts = {};
      headlines = headlines.filter(h => {
        if (h.IsSubscription === true || h.IsSubscription === 1) return true;
        const cat = h.CategoryID || 'none';
        const limit = cat === 'none' ? defaultPerCat : (catLimits[cat] || defaultPerCat);
        catCounts[cat] = (catCounts[cat] || 0);
        if (catCounts[cat] < limit) {
          catCounts[cat]++;
          return true;
        }
        return false;
      });
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(headlines)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};