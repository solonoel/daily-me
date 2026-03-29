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
    const userID = parseInt(req.query.userID || '1');
    const languageID = parseInt(req.query.languageID || '0');
    const filter = req.query.filter || 'active';

    let whereClause = 'WHERE w.UserID = @UserID AND w.LanguageID = @LanguageID';
    if (filter === 'active') whereClause += ' AND w.DateMastered IS NULL';
    else if (filter === 'flagged') whereClause += ' AND w.Flag = 1';
    else if (filter === 'mastered') whereClause += ' AND w.DateMastered IS NOT NULL';

    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('LanguageID', sql.Int, languageID)
      .query(`SELECT w.UserLanguageWordsID, w.WordsName, w.WordsTranslation,
                     w.WordsTranslationAudio, w.WordsImage, w.DateAdded,
                     w.Flag, w.DateMastered, w.IsVerb, w.Gender
              FROM [UserLanguageWords] w
              ${whereClause}
              ORDER BY w.DateAdded DESC`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
