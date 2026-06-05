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
            thumbnailURL, exclusions, isInactive, userMenuID, groupLabel, sequences, isSysHeader } = req.body;

    if (action === 'add') {
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