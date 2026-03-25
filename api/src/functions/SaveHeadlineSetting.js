const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('SaveHeadlineSetting', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const body = await request.json();
      const userID = body.userID || 1;
      const recencyDays = body.recencyDays || 7;

      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('RecencyDays', sql.Int, recencyDays)
        .query(`
          UPDATE [HeadlineSetting]
          SET RecencyDays = @RecencyDays
          WHERE UserID = @UserID
        `);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, recencyDays })
      };
    } catch (err) {
      return { status: 500, body: 'Error: ' + err.message };
    }
  }
});