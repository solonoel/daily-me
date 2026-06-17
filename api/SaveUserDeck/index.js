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
    const { action, userID = 1, languageID, deckID, deckName, status, wordID } = req.body;

    if (action === 'add') {
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('DeckName', sql.NVarChar(200), deckName)
        .query(`
          INSERT INTO [UserLanguageWordsDeck] (UserID, LanguageID, UserLanguageWordsDeckName, DateAdded, Status)
          VALUES (@UserID, @LanguageID, @DeckName, GETDATE(), 'Active');
          SELECT SCOPE_IDENTITY() AS DeckID;
        `);
      const newDeckID = result.recordset[0].DeckID;

      if ((deckName || '').trim().toLowerCase() === 'flagged') {
        await pool.request()
          .input('DeckID', sql.Int, newDeckID)
          .input('UserID', sql.Int, userID)
          .input('LanguageID', sql.Int, languageID)
          .query(`
            INSERT INTO [UserLanguageWordsDeckWords] (UserLanguageWordsDeckID, UserLanguageWordsID, DateAdded)
            SELECT @DeckID, UserLanguageWordsID, GETDATE()
            FROM [UserLanguageWords]
            WHERE UserID = @UserID AND LanguageID = @LanguageID AND Flag = 1
          `);
      }

      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, deckID: newDeckID })
      };

    } else if (action === 'update') {
      await pool.request()
        .input('DeckID', sql.Int, deckID)
        .input('UserID', sql.Int, userID)
        .input('DeckName', sql.NVarChar(200), deckName)
        .input('Status', sql.NVarChar(20), status)
        .query(`UPDATE [UserLanguageWordsDeck]
                SET UserLanguageWordsDeckName = @DeckName, Status = @Status
                WHERE UserLanguageWordsDeckID = @DeckID AND UserID = @UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'status') {
      await pool.request()
        .input('DeckID', sql.Int, deckID)
        .input('UserID', sql.Int, userID)
        .input('Status', sql.NVarChar(20), status)
        .query(`UPDATE [UserLanguageWordsDeck]
                SET Status = @Status
                WHERE UserLanguageWordsDeckID = @DeckID AND UserID = @UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      await pool.request()
        .input('DeckID', sql.Int, deckID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [UserLanguageWordsDeckWords] WHERE UserLanguageWordsDeckID = @DeckID;
                DELETE FROM [UserLanguageWordsDeck] WHERE UserLanguageWordsDeckID = @DeckID AND UserID = @UserID;`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'addWord') {
      // Avoid duplicate
      await pool.request()
        .input('DeckID', sql.Int, deckID)
        .input('WordID', sql.Int, wordID)
        .query(`IF NOT EXISTS (
                  SELECT 1 FROM [UserLanguageWordsDeckWords]
                  WHERE UserLanguageWordsDeckID = @DeckID AND UserLanguageWordsID = @WordID
                )
                INSERT INTO [UserLanguageWordsDeckWords] (UserLanguageWordsDeckID, UserLanguageWordsID, DateAdded)
                VALUES (@DeckID, @WordID, GETDATE())`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'removeWord') {
      await pool.request()
        .input('DeckID', sql.Int, deckID)
        .input('WordID', sql.Int, wordID)
        .query(`DELETE FROM [UserLanguageWordsDeckWords]
                WHERE UserLanguageWordsDeckID = @DeckID AND UserLanguageWordsID = @WordID`);
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