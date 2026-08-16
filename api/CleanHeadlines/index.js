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
    const userID = req.body?.userID || 1;

    if (req.body?.action === 'clearAllExclusions') {
      const profileID = req.body?.profileID ? parseInt(req.body.profileID) : null;
      if (!profileID) {
        context.res = { status: 400, body: JSON.stringify({ error: 'profileID is required' }) };
        return;
      }
      const clearResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('ProfileID', sql.Int, profileID)
        .query(`
          DELETE FROM [HeadlineExclusion]
          WHERE UserID = @UserID AND UserProfileID = @ProfileID;
          SELECT @@ROWCOUNT AS ClearedCount;
        `);
      const cleared = clearResult.recordset[0]?.ClearedCount || 0;
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, cleared })
      };
      return;
    }

    // Legacy path: age-based HeadlineExclusion purge only. Headline expiry now happens
    // inside FetchHeadlines itself (fetch → dedup → insert → expire), so this function
    // no longer touches the Headline table at all.
    const recencyDays = req.body?.recencyDays || 7;

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays)
      .query(`
        DELETE FROM [HeadlineExclusion]
        WHERE UserID = @UserID
          AND DeletedDate < DATEADD(day, -@RecencyDays, GETUTCDATE());

        SELECT @@ROWCOUNT AS DeletedCount;
      `);

    const deleted = result.recordset[0]?.DeletedCount || 0;

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, deleted })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};