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
    const deckID = parseInt(req.query.deckID || '0');

    const result = await pool.request()
      .input('DeckID', sql.Int, deckID)
      .query(`
        SELECT w.UserLanguageWordsID, w.WordsName, w.WordsTranslation, w.Gender,
               w.IsVerb, w.Flag, w.DateMastered, w.WordsImage
        FROM [UserLanguageWordsDeckWords] dw
        JOIN [UserLanguageWords] w ON dw.UserLanguageWordsID = w.UserLanguageWordsID
        WHERE dw.UserLanguageWordsDeckID = @DeckID
        ORDER BY w.WordsName
      `);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};