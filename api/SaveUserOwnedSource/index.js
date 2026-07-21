const sql = require('mssql');
const https = require('https');
const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

async function resolveYoutubeChannelID(url, apiKey) {
  const channelMatch = url.match(/\/channel\/(UC[\w-]+)/);
  if (channelMatch) return channelMatch[1];

  const handleMatch = url.match(/@([\w-]+)/);
  if (!handleMatch) throw new Error('Could not parse YouTube URL. Use https://www.youtube.com/@ChannelName format.');
  const handle = handleMatch[1];

  function fetchText(fetchUrl) {
    return new Promise((resolve, reject) => {
      const client = fetchUrl.startsWith('https') ? https : require('http');
      const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } };
      client.get(fetchUrl, options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchText(res.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  function fetchJson(apiUrl) {
    return new Promise((resolve, reject) => {
      https.get(apiUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Parse error')); } });
      }).on('error', reject);
    });
  }

  try {
    const d1 = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`);
    if (d1?.items?.[0]?.id) return d1.items[0].id;
  } catch(e) {}

  try {
    const d2 = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(handle)}&key=${apiKey}`);
    if (d2?.items?.[0]?.id) return d2.items[0].id;
  } catch(e) {}

  try {
    const html = await fetchText(`https://www.youtube.com/@${handle}`);
    const match = html.match(/"channelId"\s*:\s*"(UC[\w-]+)"/) ||
                  html.match(/itemprop="channelId"\s+content="(UC[\w-]+)"/) ||
                  html.match(/"externalId"\s*:\s*"(UC[\w-]+)"/);
    if (match) return match[1];
  } catch(e) {}

  try {
    const d4 = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1&key=${apiKey}`);
    if (d4?.items?.[0]?.id?.channelId) return d4.items[0].id.channelId;
  } catch(e) {}

  throw new Error(`YouTube channel not found for @${handle}. Verify the URL is correct.`);
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { action, userID, sourceID, sourceName, description, sourceType, url,
            thumbnailURL, exclusions, isInactive, userMenuID, groupLabel, sequences, isSysHeader, targetProfileID, profileID } = req.body;

    if (action === 'copyToProfile') {
      if (!targetProfileID) {
        context.res = { status: 400, body: JSON.stringify({ error: 'targetProfileID is required' }) };
        return;
      }
      const srcResult = await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('UserID', sql.Int, userID)
        .query(`SELECT SourceName, Description, SourceType, URL, ThumbnailURL, Exclusions, UserMenuID, GroupLabel, IsSysHeader, YoutubeChannelID
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
        .input('YoutubeChannelID', sql.NVarChar(50), src.YoutubeChannelID || null)
        .input('UserProfileID', sql.Int, targetProfileID)
        .query(`INSERT INTO UserOwnedSource
                  (UserID,SourceName,Description,SourceType,URL,ThumbnailURL,Exclusions,Sequence,IsInactive,UserMenuID,GroupLabel,IsSysHeader,YoutubeChannelID,UserProfileID)
                VALUES (@UserID,@SourceName,@Description,@SourceType,@URL,@ThumbnailURL,@Exclusions,@Sequence,0,@UserMenuID,@GroupLabel,@IsSysHeader,@YoutubeChannelID,@UserProfileID);
                SELECT SCOPE_IDENTITY() AS sourceID`);
      context.res = { status: 200, body: JSON.stringify({ success: true, sourceID: copyResult.recordset[0].sourceID }) };

    } else if (action === 'add') {
      context.log(`[DEBUG SaveUserOwnedSource add] ENTRY userID=${userID} profileID=${profileID} (type=${typeof profileID}) sourceName=${JSON.stringify(sourceName)} url=${JSON.stringify(url)} (len=${url?.length}) urlType=${typeof url} sourceType=${sourceType} userMenuID=${userMenuID} groupLabel=${groupLabel}`);
      if (!profileID) {
        context.log(`[DEBUG SaveUserOwnedSource add] REJECTED — profileID falsy`);
        context.res = { status: 400, body: JSON.stringify({ error: 'profileID is required' }) };
        return;
      }
      let youtubeChannelID = null;
      if (sourceType === 'YT Sub') {
        try {
          youtubeChannelID = await resolveYoutubeChannelID(url, process.env.YOUTUBE_API_KEY);
        } catch(e) {
          context.log(`[DEBUG SaveUserOwnedSource add] YT channel resolve failed: ${e.message}`);
          context.res = { status: 400, body: JSON.stringify({ error: e.message }) };
          return;
        }
      }
      const maxSeq = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT ISNULL(MAX(Sequence),0)+1 AS nextSeq FROM UserOwnedSource WHERE UserID=@UserID`);
      const nextSeq = maxSeq.recordset[0].nextSeq;
      context.log(`[DEBUG SaveUserOwnedSource add] about to INSERT: nextSeq=${nextSeq}, url charCodes sample=${url ? Array.from(url.slice(0,20)).map(c=>c.charCodeAt(0)).join(',') : 'N/A'}`);
      try {
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
          .input('YoutubeChannelID', sql.NVarChar(50), youtubeChannelID)
          .input('UserProfileID', sql.Int, profileID)
          .query(`INSERT INTO UserOwnedSource
                    (UserID,SourceName,Description,SourceType,URL,ThumbnailURL,Exclusions,Sequence,IsInactive,UserMenuID,GroupLabel,IsSysHeader,YoutubeChannelID,UserProfileID)
                  VALUES (@UserID,@SourceName,@Description,@SourceType,@URL,@ThumbnailURL,@Exclusions,@Sequence,0,@UserMenuID,@GroupLabel,@IsSysHeader,@YoutubeChannelID,@UserProfileID);
                  SELECT SCOPE_IDENTITY() AS sourceID`);
        context.log(`[DEBUG SaveUserOwnedSource add] SUCCESS sourceID=${result.recordset[0].sourceID}`);
        context.res = { status: 200, body: JSON.stringify({ sourceID: result.recordset[0].sourceID, youtubeChannelID }) };
      } catch(insertErr) {
        context.log(`[DEBUG SaveUserOwnedSource add] INSERT FAILED: ${insertErr.message}`);
        throw insertErr;
      }

    } else if (action === 'update') {
      let youtubeChannelID = null;
      if (sourceType === 'YT Sub') {
        try {
          youtubeChannelID = await resolveYoutubeChannelID(url, process.env.YOUTUBE_API_KEY);
        } catch(e) {
          context.res = { status: 400, body: JSON.stringify({ error: e.message }) };
          return;
        }
      }
      const request = pool.request()
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
        .input('YoutubeChannelID', sql.NVarChar(50), youtubeChannelID);
      let profileSet = '';
      if (profileID) {
        request.input('UserProfileID', sql.Int, profileID);
        profileSet = ', UserProfileID=@UserProfileID';
      }
      await request.query(`UPDATE UserOwnedSource
                SET SourceName=@SourceName, Description=@Description, SourceType=@SourceType,
                    URL=@URL, ThumbnailURL=@ThumbnailURL, Exclusions=@Exclusions,
                    IsInactive=@IsInactive, UserMenuID=@UserMenuID, GroupLabel=@GroupLabel,
                    IsSysHeader=@IsSysHeader, YoutubeChannelID=@YoutubeChannelID${profileSet}
                WHERE UserOwnedSourceID=@SourceID AND UserID=@UserID`);
      context.res = { status: 200, body: JSON.stringify({ success: true, youtubeChannelID }) };

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

    } else if (action === 'clearAllExclusions') {
      if (!profileID) {
        context.res = { status: 400, body: JSON.stringify({ error: 'profileID is required' }) };
        return;
      }
      const clearResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('ProfileID', sql.Int, profileID)
        .query(`UPDATE UserOwnedSource SET Exclusions=NULL
                WHERE UserID=@UserID AND UserProfileID=@ProfileID AND Exclusions IS NOT NULL;
                SELECT @@ROWCOUNT AS ClearedCount;`);
      context.res = { status: 200, body: JSON.stringify({ success: true, clearedCount: clearResult.recordset[0].ClearedCount }) };

    } else if (action === 'backfillYoutubeChannelIDs') {
      const pending = await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`SELECT UserOwnedSourceID, URL FROM UserOwnedSource
                WHERE UserID=@UserID AND SourceType='YT Sub' AND YoutubeChannelID IS NULL`);
      const results = [];
      for (const row of pending.recordset) {
        try {
          const channelID = await resolveYoutubeChannelID(row.URL, process.env.YOUTUBE_API_KEY);
          await pool.request()
            .input('SourceID', sql.Int, row.UserOwnedSourceID)
            .input('YoutubeChannelID', sql.NVarChar(50), channelID)
            .query(`UPDATE UserOwnedSource SET YoutubeChannelID=@YoutubeChannelID WHERE UserOwnedSourceID=@SourceID`);
          results.push({ sourceID: row.UserOwnedSourceID, url: row.URL, success: true, channelID });
        } catch(e) {
          results.push({ sourceID: row.UserOwnedSourceID, url: row.URL, success: false, error: e.message });
        }
      }
      context.res = { status: 200, body: JSON.stringify({ success: true, count: results.length, results }) };

    } else {
      context.res = { status: 400, body: 'Unknown action' };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};