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
    const { action, userID, menuID, menuName, menuImage, isInactive, sequence, sequences } = req.body;

    if (action === 'add') {
      const seq = parseInt(sequence || 99);
      const r = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('UserMenuSeq', sql.SmallInt, seq)
        .input('UserMenuName', sql.VarChar(60), menuName)
        .input('UserMenuImage', sql.NVarChar(sql.MAX), menuImage || null)
        .query(`INSERT INTO [UserMenu] (UserID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive)
                OUTPUT INSERTED.UserMenuID
                VALUES (@UserID, @UserMenuSeq, @UserMenuName, @UserMenuImage, 0)`);
      context.res = { status: 200, body: { menuID: r.recordset[0].UserMenuID } };

    } else if (action === 'update') {
      await pool.request()
        .input('UserMenuID', sql.Int, menuID)
        .input('UserID', sql.Int, userID)
        .input('UserMenuName', sql.VarChar(60), menuName)
        .input('UserMenuImage', sql.NVarChar(sql.MAX), menuImage || null)
        .input('IsInactive', sql.Bit, isInactive ? 1 : 0)
        .query(`UPDATE [UserMenu] SET UserMenuName=@UserMenuName, UserMenuImage=@UserMenuImage,
                IsInactive=@IsInactive WHERE UserMenuID=@UserMenuID AND UserID=@UserID`);
      context.res = { status: 200, body: { success: true } };

    } else if (action === 'toggle') {
      await pool.request()
        .input('UserMenuID', sql.Int, menuID)
        .input('UserID', sql.Int, userID)
        .input('IsInactive', sql.Bit, isInactive ? 1 : 0)
        .query(`UPDATE [UserMenu] SET IsInactive=@IsInactive
                WHERE UserMenuID=@UserMenuID AND UserID=@UserID`);
      context.res = { status: 200, body: { success: true } };

    } else if (action === 'delete') {
      await pool.request()
        .input('UserMenuID', sql.Int, menuID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [UserMenu] WHERE UserMenuID=@UserMenuID AND UserID=@UserID`);
      context.res = { status: 200, body: { success: true } };

    } else if (action === 'reorder') {
      for (const s of (sequences || [])) {
        await pool.request()
          .input('UserMenuID', sql.Int, s.menuID)
          .input('UserID', sql.Int, userID)
          .input('UserMenuSeq', sql.SmallInt, s.sequence)
          .query(`UPDATE [UserMenu] SET UserMenuSeq=@UserMenuSeq
                  WHERE UserMenuID=@UserMenuID AND UserID=@UserID`);
      }
      context.res = { status: 200, body: { success: true } };

    } else {
      context.res = { status: 400, body: { error: 'Unknown action' } };
    }
  } catch(e) {
    context.res = { status: 500, body: { error: e.message } };
  }
};