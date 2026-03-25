const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('GetHeadlineSetting', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const userID = parseInt(request.query.get('userID') || '1');
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          SELECT SettingID, UserID, RecencyDays
          FROM [HeadlineSetting]
          WHERE UserID = @UserID
        `);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.recordset[0] || { RecencyDays: 7 })
      };
    } catch (err) {
      return { status: 500, body: 'Error: ' + err.message };
    }
  }
});