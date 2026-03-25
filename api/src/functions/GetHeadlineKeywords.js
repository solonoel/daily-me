const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('GetHeadlineKeywords', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const userID = parseInt(request.query.get('userID') || '1');
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          SELECT k.KeywordID, k.CategoryID, k.Keyword, k.IsActive,
                 c.Name AS CategoryName
          FROM [HeadlineKeyword] k
          LEFT JOIN [Category] c ON k.CategoryID = c.CategoryID
          WHERE k.UserID = @UserID
          ORDER BY c.Name, k.Keyword
        `);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset)
      };
    } catch (err) {
      return { status: 500, body: 'Error: ' + err.message };
    }
  }
});