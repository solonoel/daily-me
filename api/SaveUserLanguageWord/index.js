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
    const { action, userID = 1, languageID, wordID, wordsName, wordsTranslation,
            wordsImage, wordsTranslationAudio, isVerb, gender, flag, mastered } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('WordsName', sql.NVarChar(200), wordsName)
        .input('WordsTranslation', sql.NVarChar(1000), wordsTranslation || null)
        .input('WordsTranslationAudio', sql.NVarChar(500), wordsTranslationAudio || null)
        .input('WordsImage', sql.NVarChar(sql.MAX), wordsImage || null)
        .input('IsVerb', sql.Char(1), isVerb ? 'Y' : 'N')
        .input('Gender', sql.Char(1), gender || null)
        .query(`INSERT INTO [UserLanguageWords]
                  (UserID, LanguageID, WordsName, WordsTranslation, WordsTranslationAudio,
                   WordsImage, IsVerb, Gender, DateAdded, Flag, DateMastered)
                VALUES
                  (@UserID, @LanguageID, @WordsName, @WordsTranslation, @WordsTranslationAudio,
                   @WordsImage, @IsVerb, @Gender, GETDATE(), 0, NULL);
                SELECT SCOPE_IDENTITY() AS WordID;`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, wordID: result.recordset[0].WordID })
      };

    } else if (action === 'update') {
      const { mastered } = req.body;
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .input('WordsName', sql.NVarChar(200), wordsName)
        .input('WordsTranslation', sql.NVarChar(1000), wordsTranslation || null)
        .input('WordsTranslationAudio', sql.NVarChar(500), wordsTranslationAudio || null)
        .input('WordsImage', sql.NVarChar(sql.MAX), wordsImage || null)
        .input('IsVerb', sql.Char(1), isVerb ? 'Y' : 'N')
        .input('Gender', sql.Char(1), gender || null)
        .input('DateMastered', sql.DateTime, mastered ? new Date() : null)
        .query(`UPDATE [UserLanguageWords]
                SET WordsName=@WordsName, WordsTranslation=@WordsTranslation,
                    WordsTranslationAudio=@WordsTranslationAudio, WordsImage=@WordsImage,
                    IsVerb=@IsVerb, Gender=@Gender,
                    DateMastered=CASE WHEN @DateMastered IS NOT NULL THEN @DateMastered
                                      ELSE NULL END
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'flag') {
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .input('Flag', sql.Bit, flag ? 1 : 0)
        .query(`UPDATE [UserLanguageWords] SET Flag=@Flag
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'mastered') {
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .query(`UPDATE [UserLanguageWords] SET DateMastered=GETDATE()
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [UserLanguageWords]
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
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
