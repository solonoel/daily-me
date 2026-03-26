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

    let query = `
      SELECT h.HeadlineID, h.UserID, h.CategoryID, h.HeadlineName,
             h.Link, h.Summary, h.CreatedDate, h.LastViewedDate, h.Retain,
             h.KeywordID, h.TopicID, h.ThumbnailURL, h.ChannelName, h.ChannelURL,
             c.Name AS CategoryName,
             k.Keyword, t.Topic
      FROM [Headline] h
      LEFT JOIN [Category] c ON h.CategoryID = c.CategoryID
      LEFT JOIN [HeadlineKeyword] k ON h.KeywordID = k.KeywordID
      LEFT JOIN [HeadlineTopic] t ON h.TopicID = t.TopicID
      WHERE h.UserID = @UserID
      AND h.CreatedDate >= DATEADD(day, -@RecencyDays, GETDATE())
    `;

    if (categoryID) query += ` AND h.CategoryID = @CategoryID`;
    query += ` ORDER BY h.CreatedDate DESC`;

    const request = pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays);

    if (categoryID) request.input('CategoryID', sql.Int, parseInt(categoryID));

    const result = await request.query(query);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};