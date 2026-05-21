const sql = require('mssql');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB',
  user: 'noeladmin', password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false }
};
module.exports = async function(context, req) {
  const userID = parseInt(req.body?.userID || 1);
  const menuID = parseInt(req.body?.menuID || 0);
  const groups = req.body?.groups || [];
  if (!menuID || !groups.length) { context.res = { status: 400, body: 'menuID and groups required' }; return; }
  try {
    const pool = await sql.connect(config);
    for (const g of groups) {
      await pool.request()
        .input('UserID',     sql.Int,          userID)
        .input('MenuID',     sql.Int,          menuID)
        .input('GroupLabel', sql.NVarChar(100), g.groupLabel)
        .input('GroupSeq',   sql.Int,          g.groupSeq)
        .query(`MERGE UserMenuGroup AS t
                USING (SELECT @UserID u, @MenuID m, @GroupLabel g) AS s
                  ON t.UserID=s.u AND t.UserMenuID=s.m AND t.GroupLabel=s.g
                WHEN MATCHED THEN UPDATE SET GroupSeq=@GroupSeq
                WHEN NOT MATCHED THEN INSERT (UserID,UserMenuID,GroupLabel,GroupSeq)
                  VALUES (@UserID,@MenuID,@GroupLabel,@GroupSeq);`);
    }
    context.res = { status: 200, body: JSON.stringify({ success: true }) };
  } catch(e) { context.res = { status: 500, body: 'Error: ' + e.message }; }
};