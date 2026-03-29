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
    const { userID = 1, languageID, isActive } = req.body;
    const isActiveChar = isActive ? 'Y' : 'N';
    const existing = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('LanguageID', sql.Int, languageID)
      .query(`SELECT UserLanguageID FROM [UserLanguage]
              WHERE UserID = @UserID AND LanguageID = @LanguageID`);
    if (existing.recordset.length > 0) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('IsActive', sql.Char(1), isActiveChar)
        .query(`UPDATE [UserLanguage] SET IsActive = @IsActive
                WHERE UserID = @UserID AND LanguageID = @LanguageID`);
    } else {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('IsActive', sql.Char(1), isActiveChar)
        .query(`INSERT INTO [UserLanguage] (UserID, LanguageID, IsActive, DateAdded)
                VALUES (@UserID, @LanguageID, @IsActive, GETDATE())`);
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
