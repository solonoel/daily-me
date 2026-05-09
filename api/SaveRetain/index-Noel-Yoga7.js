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
    const headlineID = req.body.headlineID;
    const userID = req.body.userID || 1;

    if (req.body.deleteIt) {
      // Insert link into exclusion list before deleting
      await pool.request()
        .input('HeadlineID', sql.Int, headlineID)
        .input('UserID', sql.Int, userID)
        .query(`
          INSERT INTO HeadlineExclusion (UserID, Link, DeletedDate)
          SELECT @UserID, Link, GETDATE()
          FROM [Headline]
          WHERE HeadlineID = @HeadlineID
            AND Link IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM HeadlineExclusion
              WHERE UserID = @UserID AND Link = Headline.Link
            )
        `);

      await pool.request()
        .input('HeadlineID', sql.Int, headlineID)
        .query(`DELETE FROM [Headline] WHERE HeadlineID = @HeadlineID`);
    } else {
      const retain = req.body.retain ? 'Y' : 'N';
      await pool.request()
        .input('HeadlineID', sql.Int, headlineID)
        .input('Retain', sql.Char(1), retain)
        .query(`UPDATE [Headline] SET Retain = @Retain WHERE HeadlineID = @HeadlineID`);
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};