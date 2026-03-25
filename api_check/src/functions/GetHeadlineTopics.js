const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('GetHeadlineTopics', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const userID = parseInt(request.query.get('userID') || '1');
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          SELECT t.TopicID, t.CategoryID, t.Topic, t.IsActive,
                 c.Name AS CategoryName
          FROM [HeadlineTopic] t
          LEFT JOIN [Category] c ON t.CategoryID = c.CategoryID
          WHERE t.UserID = @UserID
          ORDER BY c.Name, t.Topic
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