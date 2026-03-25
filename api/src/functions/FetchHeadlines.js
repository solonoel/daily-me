const { app } = require('@azure/functions');
const { getPool, sql } = require('../dbConfig');

app.http('SaveRetain', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const pool = await getPool();
      const body = await request.json();
      const headlineID = body.headlineID;
      const retain = body.retain ? 'Y' : 'N';

      await pool.request()
        .input('HeadlineID', sql.Int, headlineID)
        .input('Retain', sql.Char(1), retain)
        .query(`
          UPDATE [Headline]
          SET Retain = @Retain
          WHERE HeadlineID = @HeadlineID
        `);

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, headlineID, retain })
      };
    } catch (err) {
      return { status: 500, body: 'Error: ' + err.message };
    }
  }
});