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
    const { action, userID, menuID, menuName, menuImage, isInactive, sequence, sequences, profileID, targetProfileID } = req.body;

    if (action === 'add') {
      const seq = parseInt(sequence || 99);
      let resolvedProfileID = profileID || null;
      if (!resolvedProfileID) {
        const homeResult = await pool.request()
          .input('UserID', sql.Int, userID)
          .query(`SELECT UserProfileID FROM [UserProfile] WHERE UserID=@UserID AND Name='Home'`);
        resolvedProfileID = homeResult.recordset[0]?.UserProfileID || null;
      }
      const r = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('UserMenuSeq', sql.SmallInt, seq)
        .input('UserMenuName', sql.VarChar(60), menuName)
        .input('UserMenuImage', sql.NVarChar(sql.MAX), menuImage || null)
        .input('UserProfileID', sql.Int, resolvedProfileID)
        .query(`INSERT INTO [UserMenu] (UserID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive, UserProfileID)
                OUTPUT INSERTED.UserMenuID
                VALUES (@UserID, @UserMenuSeq, @UserMenuName, @UserMenuImage, 0, @UserProfileID)`);
      context.res = { status: 200, body: { menuID: r.recordset[0].UserMenuID } };

    } else if (action === 'copyToProfile') {
      const srcResult = await pool.request()
        .input('MenuID', sql.Int, menuID)
        .input('UserID', sql.Int, userID)
        .query(`SELECT UserMenuName, UserMenuImage FROM [UserMenu] WHERE UserMenuID=@MenuID AND UserID=@UserID`);
      const src = srcResult.recordset[0];
      if (!src) { context.res = { status: 404, body: { error: 'Menu not found' } }; return; }

      const existing = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('TargetProfileID', sql.Int, targetProfileID)
        .input('MenuName', sql.VarChar(60), src.UserMenuName)
        .query(`SELECT UserMenuID FROM [UserMenu]
                WHERE UserID=@UserID AND UserProfileID=@TargetProfileID AND LOWER(LTRIM(RTRIM(UserMenuName)))=LOWER(LTRIM(RTRIM(@MenuName)))`);
      if (existing.recordset.length > 0) {
        context.res = { status: 200, body: { success: true, menuID: existing.recordset[0].UserMenuID, created: false } };
      } else {
        const seqResult = await pool.request()
          .input('UserID', sql.Int, userID)
          .input('TargetProfileID', sql.Int, targetProfileID)
          .query(`SELECT ISNULL(MAX(UserMenuSeq),0)+1 AS NextSeq FROM [UserMenu] WHERE UserID=@UserID AND UserProfileID=@TargetProfileID`);
        const nextSeq = seqResult.recordset[0].NextSeq;
        const r2 = await pool.request()
          .input('UserID', sql.Int, userID)
          .input('UserMenuSeq', sql.SmallInt, nextSeq)
          .input('UserMenuName', sql.VarChar(60), src.UserMenuName)
          .input('UserMenuImage', sql.NVarChar(sql.MAX), src.UserMenuImage)
          .input('TargetProfileID', sql.Int, targetProfileID)
          .query(`INSERT INTO [UserMenu] (UserID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive, UserProfileID)
                  OUTPUT INSERTED.UserMenuID
                  VALUES (@UserID, @UserMenuSeq, @UserMenuName, @UserMenuImage, 0, @TargetProfileID)`);
        context.res = { status: 200, body: { success: true, menuID: r2.recordset[0].UserMenuID, created: true } };
      }

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