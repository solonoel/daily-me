const sql = require('mssql');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB',
  user: 'noeladmin', password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false }
};
module.exports = async function(context, req) {
  const userID = parseInt(req.query.userID || 1);
  const menuID = parseInt(req.query.menuID || 0);
  if (!menuID) { context.res = { status: 200, body: JSON.stringify([]) }; return; }
  try {
    const pool = await sql.connect(config);
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('MenuID', sql.Int, menuID)
      .query(`SELECT GroupLabel, GroupSeq FROM UserMenuGroup
              WHERE UserID=@UserID AND UserMenuID=@MenuID ORDER BY GroupSeq`);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.recordset) };
  } catch(e) { context.res = { status: 500, body: 'Error: ' + e.message }; }
};