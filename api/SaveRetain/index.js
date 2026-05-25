const sql = require('mssql');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const headlineID = req.body.headlineID;

    if (req.body.deleteIt) {
      // Fetch link + published date before deleting
      const hResult = await pool.request()
        .input('HeadlineID', sql.Int, headlineID)
        .query(`SELECT UserID, Link, PublishedDate FROM [Headline] WHERE HeadlineID = @HeadlineID`);

      if (hResult.recordset.length > 0) {
        const { UserID, Link, PublishedDate } = hResult.recordset[0];
        if (Link) {
          await pool.request()
            .input('UserID', sql.Int, UserID)
            .input('Link', sql.NVarChar(2000), Link)
            .input('PublishedDate', sql.DateTime, PublishedDate || null)
            .query(`
              IF NOT EXISTS (SELECT 1 FROM HeadlineExclusion WHERE UserID=@UserID AND Link=@Link)
                INSERT INTO HeadlineExclusion (UserID, Link, PublishedDate, DeletedDate)
                VALUES (@UserID, @Link, @PublishedDate, GETDATE())
            `);
        }
      }

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

    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};