const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('GetHeadlines', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const userID = parseInt(request.query.get('userID') || '1');
      const categoryID = request.query.get('categoryID');
      const recencyDays = parseInt(request.query.get('recencyDays') || '7');

      let query = `
        SELECT h.HeadlineID, h.UserID, h.CategoryID, h.HeadlineName,
               h.Link, h.CreatedDate, h.LastViewedDate, h.Retain,
               h.KeywordID, h.TopicID,
               c.Name AS CategoryName,
               k.Keyword, t.Topic
        FROM [Headline] h
        LEFT JOIN [Category] c ON h.CategoryID = c.CategoryID
        LEFT JOIN [HeadlineKeyword] k ON h.KeywordID = k.KeywordID
        LEFT JOIN [HeadlineTopic] t ON h.TopicID = t.TopicID
        WHERE h.UserID = @UserID
        AND h.CreatedDate >= DATEADD(day, -@RecencyDays, GETDATE())
      `;

      if (categoryID) {
        query += ` AND h.CategoryID = @CategoryID`;
      }

      query += ` ORDER BY h.CreatedDate DESC`;

      const req = pool.request()
        .input('UserID', sql.Int, userID)
        .input('RecencyDays', sql.Int, recencyDays);

      if (categoryID) {
        req.input('CategoryID', sql.Int, parseInt(categoryID));
      }

      const result = await req.query(query);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset)
      };
    } catch (err