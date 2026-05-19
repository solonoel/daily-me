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
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserMenuID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive
              FROM [UserMenu] WHERE UserID = @UserID
              ORDER BY UserMenuSeq, UserMenuID`);
    context.res = { status: 200, body: result.recordset };
  } catch(e) {
    context.res = { status: 500, body: { error: e.message } };
  }
};