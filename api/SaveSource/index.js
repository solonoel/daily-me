const sql = require('mssql');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { action, sourceID, name, url, sourceType, categoryID, isActive, sequences, userID = 1 } = req.body;

    if (action === 'add') {
      // For admin (userID=1): insert new global source then add to UserHeadlineSource
      // For regular users: just add existing source to UserHeadlineSource
      if (userID === 1) {
        const result = await pool.request()
          .input('Name', sql.NVarChar(200), name)
          .input('URL', sql.NVarChar(500), url)
          .input('SourceType', sql.NVarChar(20), sourceType || 'RSS')
          .input('CategoryID', sql.Int, categoryID || null)
          .query(`
            INSERT INTO [HeadlineSource] (Name, URL, SourceType, IsActive, CategoryID, CreatedDate)
            VALUES (@Name, @URL, @SourceType, 'Y', @CategoryID, GETDATE());
            SELECT SCOPE_IDENTITY() AS SourceID;
          `);
        const newSourceID = result.recordset[0].SourceID;
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, newSourceID)
          .query(`INSERT INTO [UserHeadlineSource] (UserID, SourceID) VALUES (@UserID, @SourceID)`);
        context.res = {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID: newSourceID })
        };
      } else {
        // Regular user — add existing source to their list
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, sourceID)
          .query(`
            IF NOT EXISTS (SELECT 1 FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID)
            INSERT INTO [UserHeadlineSource] (UserID, SourceID) VALUES (@UserID, @SourceID)
          `);
        context.res = {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID })
        };
      }

    } else if (action === 'update') {
      // Only admin can update global source details
      if (userID === 1) {
        await pool.request()
          .input('SourceID', sql.Int, sourceID)
          .input('Name', sql.NVarChar(200), name)
          .input('URL', sql.NVarChar(500), url)
          .input('SourceType', sql.NVarChar(20), sourceType)
          .input('CategoryID', sql.Int, categoryID || null)
          .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
          .query(`
            UPDATE [HeadlineSource]
            SET Name=@Name, URL=@URL, SourceType=@SourceType, CategoryID=@CategoryID, IsActive=@IsActive
            WHERE SourceID=@SourceID
          `);
      }
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'reorder') {
      if (Array.isArray(sequences)) {
        for (const s of sequences) {
          await pool.request()
            .input('UserID', sql.Int, userID)
            .input('SourceID', sql.Int, s.sourceID)
            .input('Sequence', sql.Int, s.sequence)
            .query(`UPDATE [UserHeadlineSource] SET Sequence = @Sequence WHERE UserID = @UserID AND SourceID = @SourceID`);
        }
      }
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };

    } else if (action === 'delete') {
      // All users — remove from UserHeadlineSource
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .query(`DELETE FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID`);
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