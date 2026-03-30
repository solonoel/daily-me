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
    const { userID = 1, languageID } = req.body;
    const today = new Date().toISOString().split('T')[0];

    const existing = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('LanguageID', sql.Int, languageID)
      .query(`SELECT StreakDays, LastVisitDate FROM UserLanguageStreak
              WHERE UserID=@UserID AND LanguageID=@LanguageID`);

    let streakDays = 1;

    if (existing.recordset.length > 0) {
      const { StreakDays, LastVisitDate } = existing.recordset[0];
      const last = new Date(LastVisitDate).toISOString().split('T')[0];

      if (last === today) {
        // Already visited today — return current streak, no update needed
        context.res = {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, streakDays: StreakDays })
        };
        return;
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      if (last === yesterdayStr) {
        streakDays = StreakDays + 1; // Continuing streak
      } else {
        streakDays = 1; // Streak broken
      }

      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('StreakDays', sql.Int, streakDays)
        .input('Today', sql.Date, today)
        .query(`UPDATE UserLanguageStreak
                SET StreakDays=@StreakDays, LastVisitDate=@Today
                WHERE UserID=@UserID AND LanguageID=@LanguageID`);
    } else {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('Today', sql.Date, today)
        .query(`INSERT INTO UserLanguageStreak (UserID, LanguageID, StreakDays, LastVisitDate)
                VALUES (@UserID, @LanguageID, 1, @Today)`);
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, streakDays })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};