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
    const { action, userID = 1, profileID, name, inactive } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`
          DECLARE @BaseName NVARCHAR(100) = 'New Profile';
          DECLARE @FinalName NVARCHAR(100) = @BaseName;
          DECLARE @Suffix INT = 1;
          WHILE EXISTS (SELECT 1 FROM [UserProfile] WHERE UserID=@UserID AND Name=@FinalName)
          BEGIN
            SET @Suffix = @Suffix + 1;
            SET @FinalName = @BaseName + ' ' + CAST(@Suffix AS NVARCHAR(10));
          END
          INSERT INTO [UserProfile] (UserID, Name, Inactive, DateAdded)
          VALUES (@UserID, @FinalName, 0, GETDATE());
          SELECT SCOPE_IDENTITY() AS ProfileID, @FinalName AS FinalName;
        `);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, profileID: result.recordset[0].ProfileID, name: result.recordset[0].FinalName })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('ProfileID', sql.Int, profileID)
        .input('UserID', sql.Int, userID)
        .input('Name', sql.NVarChar(100), name)
        .input('Inactive', sql.Bit, inactive ? 1 : 0)
        .query(`UPDATE [UserProfile] SET Name=@Name, Inactive=@Inactive
                WHERE UserProfileID=@ProfileID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      await pool.request()
        .input('ProfileID', sql.Int, profileID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [UserMenu] WHERE UserProfileID=@ProfileID AND UserID=@UserID;
                DELETE FROM [UserProfile] WHERE UserProfileID=@ProfileID AND UserID=@UserID;`);
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