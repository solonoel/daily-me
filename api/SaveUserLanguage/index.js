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
    const { userID = 1, languageID, isActive, action, sequences, profileID } = req.body;

    if (action === 'reorder') {
      for (const s of (sequences || [])) {
        await pool.request()
          .input('UserProfileID', sql.Int, profileID)
          .input('LanguageID', sql.Int, s.languageID)
          .input('MenuSeq', sql.SmallInt, s.sequence)
          .query(`
            MERGE [UserLanguageProfile] AS target
            USING (SELECT @UserProfileID AS UserProfileID, @LanguageID AS LanguageID) AS src
              ON target.UserProfileID = src.UserProfileID AND target.LanguageID = src.LanguageID
            WHEN MATCHED THEN UPDATE SET MenuSeq = @MenuSeq
            WHEN NOT MATCHED THEN INSERT (UserProfileID, LanguageID, MenuSeq) VALUES (@UserProfileID, @LanguageID, @MenuSeq);
          `);
      }
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
      return;
    }

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

    if (isActiveChar === 'Y') {
      const flaggedDeckResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .query(`SELECT UserLanguageWordsDeckID FROM [UserLanguageWordsDeck]
                WHERE UserID = @UserID AND LanguageID = @LanguageID AND LOWER(LTRIM(RTRIM(UserLanguageWordsDeckName))) = 'flagged'`);
      if (flaggedDeckResult.recordset.length === 0) {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('LanguageID', sql.Int, languageID)
          .query(`INSERT INTO [UserLanguageWordsDeck] (UserID, LanguageID, UserLanguageWordsDeckName, DateAdded, Status)
                  VALUES (@UserID, @LanguageID, 'Flagged', GETDATE(), 'Active')`);
      }

      // Assign this language a fresh menu position in the current profile, if it doesn't already have one
      if (profileID) {
        const posCheck = await pool.request()
          .input('UserProfileID', sql.Int, profileID)
          .input('LanguageID', sql.Int, languageID)
          .query(`SELECT MenuSeq FROM [UserLanguageProfile] WHERE UserProfileID=@UserProfileID AND LanguageID=@LanguageID`);
        if (posCheck.recordset.length === 0) {
          const maxResult = await pool.request()
            .input('UserID', sql.Int, userID)
            .input('UserProfileID', sql.Int, profileID)
            .query(`
              SELECT MAX(seq) AS MaxSeq FROM (
                SELECT UserMenuSeq AS seq FROM [UserMenu] WHERE UserID=@UserID AND UserProfileID=@UserProfileID
                UNION ALL
                SELECT MenuSeq AS seq FROM [UserLanguageProfile] WHERE UserProfileID=@UserProfileID
              ) combined`);
          const nextSeq = (maxResult.recordset[0]?.MaxSeq || 0) + 1;
          await pool.request()
            .input('UserProfileID', sql.Int, profileID)
            .input('LanguageID', sql.Int, languageID)
            .input('MenuSeq', sql.SmallInt, nextSeq)
            .query(`INSERT INTO [UserLanguageProfile] (UserProfileID, LanguageID, MenuSeq) VALUES (@UserProfileID, @LanguageID, @MenuSeq)`);
        }
      }
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