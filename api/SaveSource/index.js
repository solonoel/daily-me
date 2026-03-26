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
    const { action, sourceID, name, url, sourceType, isActive, userID = 1 } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('Name', sql.NVarChar(200), name)
        .input('URL', sql.NVarChar(500), url)
        .input('SourceType', sql.NVarChar(20), sourceType || 'RSS')
        .input('IsActive', sql.Char(1), 'Y')
        .query(`
          INSERT INTO [HeadlineSource] (UserID, Name, URL, SourceType, IsActive, CreatedDate)
          VALUES (@UserID, @Name, @URL, @SourceType, @IsActive, GETDATE());
          SELECT SCOPE_IDENTITY() AS SourceID;
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, sourceID: result.recordset[0].SourceID })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('Name', sql.NVarChar(200), name)
        .input('URL', sql.NVarChar(500), url)
        .input('SourceType', sql.NVarChar(20), sourceType)
        .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
        .query(`
          UPDATE [HeadlineSource]
          SET Name = @Name, URL = @URL, SourceType = @SourceType, IsActive = @IsActive
          WHERE SourceID = @SourceID
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      // Check if global (UserID null) or user-specific
      const check = await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .query(`SELECT UserID FROM [HeadlineSource] WHERE SourceID = @SourceID`);

      if (check.recordset[0]?.UserID === null) {
        // Global source — disable for this user by inserting user-specific inactive record
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, sourceID)
          .query(`
            UPDATE [HeadlineSource]
            SET IsActive = 'N'
            WHERE SourceID = @SourceID AND UserID IS NULL
          `);
      } else {
        // User-specific — actually delete
        await pool.request()
          .input('SourceID', sql.Int, sourceID)
          .input('UserID', sql.Int, userID)
          .query(`
            DELETE FROM [HeadlineSource]
            WHERE SourceID = @SourceID AND UserID = @UserID
          `);
      }
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};