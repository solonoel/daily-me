const sql = require('mssql');
const config = {
  user: 'noeladmin', password: process.env.DB_PASSWORD,
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB',
  options: { encrypt: true, trustServerCertificate: false }
};

module.exports = async function(context, req) {
  const { userID, menuID, groups } = req.body || {};
  if (!userID || !menuID || !Array.isArray(groups) || !groups.length) {
    context.res = { status: 400, body: { error: 'Missing required fields' } };
    return;
  }
  try {
    const pool = await sql.connect(config);
    await pool.request()
      .input('userID', sql.Int, userID)
      .input('menuID', sql.Int, menuID)
      .query('DELETE FROM UserMenuGroup WHERE UserID=@userID AND MenuID=@menuID');
    for (const g of groups) {
      if (!g.groupLabel) continue;
      await pool.request()
        .input('userID', sql.Int, userID)
        .input('menuID', sql.Int, menuID)
        .input('groupLabel', sql.NVarChar(200), g.groupLabel)
        .input('groupSeq', sql.Int, g.groupSeq || 99)
        .query('INSERT INTO UserMenuGroup (UserID, MenuID, GroupLabel, GroupSeq) VALUES (@userID, @menuID, @groupLabel, @groupSeq)');
    }
    context.log(`SaveMenuGroupSeq: saved ${groups.length} groups for menuID=${menuID}`);
    context.res = { body: { success: true, saved: groups.length } };
  } catch (e) {
    context.log.error('SaveMenuGroupSeq error:', e.message);
    context.res = { status: 500, body: { error: e.message } };
  }
};