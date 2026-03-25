const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('GetCategories', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const userID = parseInt(request.query.get('userID') || '1');
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          SELECT CategoryID, Name, IsActive, Headlines, MyWords
          FROM [Category]
          WHERE UserID = @UserID AND IsActive = 'Y'
          ORDER BY Name
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