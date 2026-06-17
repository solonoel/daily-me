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
    const { action, userID, sourceID, sourceName, description, sourceType, url,
            thumbnailURL, exclusions, isInactive, userMenuID, groupLabel, sequences, isSysHeader, targetProfileID } = req.body;

    if (action === 'copyToProfile') {
      const srcResult = await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('UserID', sql.Int, userID)
        .query(`SELECT SourceName, Description, SourceType, URL, ThumbnailURL, Exclusions, UserMenuID, GroupLabel, IsSysHeader
                FROM UserOwnedSource WHERE UserOwnedSourceID=@SourceID AND UserID=@UserID`);
      const src = srcResult.recordset[0];
      if (!src) { context.res = { status: 404, body: JSON.stringify({ error: 'Source not found' }) }; return; }

      let targetMenuID = null;
      if (src.UserMenuID) {
        const menuRowResult = await pool.request()
          .input('UserMenuID', sql.Int, src.UserMenuID)
          .input('UserID', sql.Int, userID)
          .query(`SELECT UserMenuName, UserMenuImage FROM [UserMenu] WHERE UserMenuID=@UserMenuID AND UserID=@UserID`);
        const menuRow = menuRowResult.recordset[0];
        if (menuRow) {
          const existingMenu = await pool.request()
            .input('UserID', sql.Int, userID)
            .input('TargetProfileID', sql.Int, targetProfileID)
            .input('MenuName', sql.VarChar(60), menuRow.UserMenuName)
            .query(`SELECT UserMenuID FROM [UserMenu]
                    WHERE UserID=@UserID AND UserProfileID=@TargetProfileID AND LOWER(LTRIM(RTRIM(UserMenuName)))=LOWER(LTRIM(RTRIM(@MenuName)))`);
          if (existingMenu.recordset.length > 0) {
            targetMenuID = existingMenu.recordset[0].UserMenuID;
          } else {
            const seqResult = await pool.request()
              .input('UserID', sql.Int, userID)
              .input('TargetProfileID', sql.Int, targetProfileID)
              .query(`SELECT ISNULL(MAX(UserMenuSeq),0)+1 AS NextSeq FROM [UserMenu] WHERE UserID=@UserID AND UserProfileID=@TargetProfileID`);
            const nextSeq = seqResult.recordset[0].NextSeq;
            const newMenu = await pool.request()
              .input('UserID', sql.Int, userID)
              .input('UserMenuSeq', sql.SmallInt, nextSeq)
              .input('UserMenuName', sql.VarChar(60), menuRow.UserMenuName)
              .input('UserMenuImage', sql.NVarChar(sql.MAX), menuRow.UserMenuImage)
              .input('TargetProfileID', sql.Int, targetProfileID)
              .query(`INSERT INTO [UserMenu] (UserID, UserMenuSeq, UserMenuName, UserMenuImage, IsInactive, UserProfileID)
                      OUTPUT INSERTED.UserMenuID
                      VALUES (@UserID, @UserMenuSeq, @UserMenuName, @UserMenuImage, 0, @TargetProfileID)`);
            targetMenuID = newMenu.recordset[0].UserMenuID;
          }
        }
      }

      const maxSeq = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT ISNULL(MAX(Sequence),0)+1 AS nextSeq FROM UserOwnedSource WHERE UserID=@UserID`);
      const nextSourceSeq = maxSeq.recordset[0].nextSeq;
      const copyResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceName', sql.NVarChar(200), src.SourceName)
        .input('Description', sql.NVarChar(1000), src.Description)
        .input('SourceType', sql.VarChar(20), src.SourceType)
        .input('URL', sql.NVarChar(500), src.URL)
        .input('ThumbnailURL', sql.NVarChar(sql.MAX), src.ThumbnailURL)
        .input('Exclusions', sql.NVarChar(500), src.Exclusions)
        .input('Sequence', sql.Int, nextSourceSeq)
        .input('UserMenuID', sql.Int, targetMenuID)
        .input('GroupLabel', sql.VarChar(100), src.GroupLabel)
        .input('IsSysHeader', sql.Bit, src.IsSysHeader)
        .query(`INSERT INTO UserOwnedSource
                  (UserID,SourceName,Description,SourceType,URL,ThumbnailURL,Exclusions,Sequence,IsInactive,UserMenuID,GroupLabel,IsSysHeader)
                VALUES (@UserID,@SourceName,@Description,@SourceType,@URL,@ThumbnailURL,@Exclusions,@Sequence,0,@UserMenuID,@GroupLabel,@IsSysHeader);
                SELECT SCOPE_IDENTITY() AS sourceID`);
      context.res = { status: 200, body: JSON.stringify({ success: true, sourceID: copyResult.recordset[0].sourceID }) };

    } else if (action === 'add') {
      const maxSeq = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT ISNULL(MAX(Sequence),0)+1 AS nextSeq FROM UserOwnedSource WHERE UserID=@UserID`);
      const nextSeq = maxSeq.recordset[0].nextSeq;
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceName', sql.NVarChar(200), sourceName)
        .input('Description', sql.NVarChar(1000), description || null)
        .input('SourceType', sql.VarChar(20), sourceType || 'Website')
        .input('URL', sql.NVarChar(500), url)
        .input('ThumbnailURL', sql.NVarChar(sql.MAX), thumbnailURL || null)
        .input('Exclusions', sql.NVarChar(500), exclusions || null)
        .input('Sequence', sql.Int, nextSeq)
        .input('UserMenuID', sql.Int, userMenuID || null)
        .input('GroupLabel', sql.VarChar(100), groupLabel || null)
        .input('IsSysHeader', sql.Bit, isSysHeader ? 1 : 0)
        .query(`INSERT INTO UserOwnedSource
                  (UserID,SourceName,Description,SourceType,URL,ThumbnailURL,Exclusions,Sequence,IsInactive,UserMenuID,GroupLabel,IsSysHeader)
                VALUES (@UserID,@SourceName,@Description,@SourceType,@URL,@ThumbnailURL,@Exclusions,@Sequence,0,@UserMenuID,@GroupLabel,@IsSysHeader);
                SELECT SCOPE_IDENTITY() AS sourceID`);
      context.res = { status: 200, body: JSON.stringify({ sourceID: result.recordset[0].sourceID }) };

    } else if (action === 'update') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('UserID', sql.Int, userID)
        .input('SourceName', sql.NVarChar(200), sourceName)
        .input('Description', sql.NVarChar(1000), description || null)
        .input('SourceType', sql.VarChar(20), sourceType || 'Website')
        .input('URL', sql.NVarChar(500), url)
        .input('ThumbnailURL', sql.NVarChar(sql.MAX), thumbnailURL || null)
        .input('Exclusions', sql.NVarChar(500), exclusions || null)
        .input('IsInactive', sql.Bit, isInactive ? 1 : 0)
        .input('UserMenuID', sql.Int, userMenuID || null)
        .input('GroupLabel', sql.VarChar(100), groupLabel || null)
        .input('IsSysHeader', sql.Bit, isSysHeader ? 1 : 0)
        .query(`UPDATE UserOwnedSource
                SET SourceName=@SourceName, Description=@Description, SourceType=@SourceType,
                    URL=@URL, ThumbnailURL=@ThumbnailURL, Exclusions=@Exclusions,
                    IsInactive=@IsInactive, UserMenuID=@UserMenuID, GroupLabel=@GroupLabel,
                    IsSysHeader=@IsSysHeader
                WHERE UserOwnedSourceID=@SourceID AND UserID=@UserID`);
      context.res = { status: 200, body: JSON.stringify({ success: true }) };

    } else if (action === 'delete') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM UserOwnedSource WHERE UserOwnedSourceID=@SourceID AND UserID=@UserID`);
      context.res = { status: 200, body: JSON.stringify({ success: true }) };

    } else if (action === 'reorder') {
      for (const s of sequences) {
        await pool.request()
          .input('SourceID', sql.Int, s.sourceID)
          .input('Sequence', sql.Int, s.sequence)
          .input('UserID', sql.Int, userID)
          .query(`UPDATE UserOwnedSource SET Sequence=@Sequence WHERE UserOwnedSourceID=@SourceID AND UserID=@UserID`);
      }
      context.res = { status: 200, body: JSON.stringify({ success: true }) };

    } else {
      context.res = { status: 400, body: 'Unknown action' };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};