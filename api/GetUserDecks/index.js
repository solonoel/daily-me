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
    const status = req.query.status || 'all';

    let query = `
      SELECT d.UserLanguageWordsDeckID, d.UserLanguageWordsDeckName, d.DateAdded,
             d.LastStudiedDate, d.DateMastered, d.Status,
             COUNT(dw.DeckWordID) AS WordCount
      FROM [UserLanguageWordsDeck] d
      LEFT JOIN [UserLanguageWordsDeckWords] dw ON d.UserLanguageWordsDeckID = dw.UserLanguageWordsDeckID
      WHERE d.UserID = @UserID AND d.LanguageID = @LanguageID
    `;

    if (status !== 'all') query += ` AND d.Status = @Status`;

    query += ` GROUP BY d.UserLanguageWordsDeckID, d.UserLanguageWordsDeckName, d.DateAdded,
               d.LastStudiedDate, d.DateMastered, d.Status
               ORDER BY d.DateAdded DESC`;

    const request = pool.request()
      .input('UserID', sql.Int, userID)
      .input('LanguageID', sql.Int, languageID);
    if (status !== 'all') request.input('Status', sql.NVarChar(20), status);

    const result = await request.query(query);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset)
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};