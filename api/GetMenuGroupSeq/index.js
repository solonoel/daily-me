const sql = require('mssql');
const config = {
  user: 'noeladmin', password: process.env.DB_PASSWORD,
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB',
  options: { encrypt: true, trustServerCertificate: false }
};

module.exports = async function(context, req) {
  const userID = parseInt(req.query.userID);
  const menuID = parseInt(req.query.menuID);
  if (!userID || !menuID) {
    context.res = { status: 400, body: { error: 'Missing userID or menuID' } };
    return;
  }
  try {
    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('userID', sql.Int, userID)
      .input('menuID', sql.Int, menuID)
      .query('SELECT GroupLabel, GroupSeq FROM UserMenuGroup WHERE UserID=@userID AND MenuID=@menuID ORDER BY GroupSeq');
    context.res = { body: result.recordset };
  } catch (e) {
    context.log.error('GetMenuGroupSeq error:', e.message);
    context.res = { status: 500, body: { error: e.message } };
  }
};