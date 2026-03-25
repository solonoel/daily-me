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
    const userID = 1;
    const apiKey = process.env.GUARDIAN_API_KEY;

    // Get recency setting
    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const recencyDays = settingResult.recordset[0]?.RecencyDays || 7;

    // Calculate from-date
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - recencyDays);
    const fromDateStr = fromDate.toISOString().split('T')[0];

    // Get active keywords
    const keywordsResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT k.KeywordID, k.Keyword, k.CategoryID
        FROM [HeadlineKeyword] k
        WHERE k.UserID = @UserID AND k.IsActive = 'Y'
      `);

    // Get active topics
    const topicsResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`
        SELECT t.TopicID, t.Topic, t.CategoryID
        FROM [HeadlineTopic] t
        WHERE t.UserID = @UserID AND t.IsActive = 'Y'
      `);

    const keywords = keywordsResult.recordset;
    const topics = topicsResult.recordset;
    let totalInserted = 0;
    let totalDuplicates = 0;

    async function fetchAndInsert(searchTerm, categoryID, keywordID, topicID) {
      const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(searchTerm)}&from-date=${fromDateStr}&show-fields=trailText&order-by=newest&page-size=10&api-key=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.response?.results) {
        for (const article of data.response.results) {
          const dupCheck = await pool.request()
            .input('Link', sql.NVarChar(500), article.webUrl)
            .input('UserID', sql.Int, userID)
            .query(`
              SELECT COUNT(*) AS cnt 
              FROM [Headline] 
              WHERE Link = @Link AND UserID = @UserID
            `);

          if (dupCheck.recordset[0].cnt === 0) {
            await pool.request()
              .input('UserID', sql.Int, userID)
              .input('CategoryID', sql.Int, categoryID)
              .input('HeadlineName', sql.NVarChar(500), article.webTitle.substring(0, 500))
              .input('Link', sql.NVarChar(500), article.webUrl)
              .input('KeywordID', sql.Int, keywordID || null)
              .input('TopicID', sql.Int, topicID || null)
              .query(`
                INSERT INTO [Headline] 
                  (UserID, CategoryID, HeadlineName, Link, CreatedDate, Retain, KeywordID, TopicID)
                VALUES 
                  (@UserID, @CategoryID, @HeadlineName, @Link, GETDATE(), 'N', @KeywordID, @TopicID)
              `);
            totalInserted++;
          } else {
            totalDuplicates++;
          }
        }
      }
    }

    for (const kw of keywords) {
      await fetchAndInsert(kw.Keyword, kw.CategoryID, kw.KeywordID, null);
    }

    for (const tp of topics) {
      await fetchAndInsert(tp.Topic, tp.CategoryID, null, tp.TopicID);
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        inserted: totalInserted,
        duplicates: totalDuplicates,
        keywordsSearched: keywords.length,
        topicsSearched: topics.length
      })
    };
  } catch (err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};