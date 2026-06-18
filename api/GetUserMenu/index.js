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
    const profileID = req.query.profileID ? parseInt(req.query.profileID) : null;

    const request = pool.request().input('UserID', sql.Int, userID);
    let query = `SELECT UserMenuID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive
              FROM [UserMenu] WHERE UserID = @UserID`;

    if (profileID) {
      request.input('ProfileID', sql.Int, profileID);
      query += ` AND UserProfileID = @ProfileID`;
    }

    query += ` ORDER BY UserMenuSeq, UserMenuID`;

    const result = await request.query(query);
    context.res = { status: 200, body: result.recordset };
  } catch(e) {
    context.res = { status: 500, body: { error: e.message } };
  }
};