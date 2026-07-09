const sql = require('mssql');
const https = require('https');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
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
    const { action, sourceID, name, url, sourceType, isActive,
            sequence, isFiltered, userID = 1, userHeadlineSourceID, targetProfileID, profileID } = req.body;

    if (action === 'copyToProfile') {
      const lookupRequest = pool.request().input('UserID', sql.Int, userID);
      let lookupQuery;
      if (userHeadlineSourceID) {
        lookupRequest.input('UserHeadlineSourceID', sql.Int, userHeadlineSourceID);
        lookupQuery = `SELECT UserHeadlineSourceID, SourceID, IsFiltered, Exclusions, GroupLabel, UserMenuID, ImageURL
                       FROM [UserHeadlineSource] WHERE UserHeadlineSourceID=@UserHeadlineSourceID AND UserID=@UserID`;
      } else {
        lookupRequest.input('SourceID', sql.Int, sourceID);
        lookupQuery = `SELECT UserHeadlineSourceID, SourceID, IsFiltered, Exclusions, GroupLabel, UserMenuID, ImageURL
                       FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID`;
      }
      const srcResult = await lookupRequest.query(lookupQuery);
      const src = srcResult.recordset[0];
      if (!src) { context.res = { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Source not found' }) }; return; }

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

      const dupCheck = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, src.SourceID)
        .input('TargetMenuID', sql.Int, targetMenuID)
        .input('TargetProfileID', sql.Int, targetProfileID)
        .query(`SELECT UserHeadlineSourceID FROM [UserHeadlineSource]
                WHERE UserID=@UserID AND SourceID=@SourceID AND UserProfileID=@TargetProfileID AND (UserMenuID=@TargetMenuID OR (UserMenuID IS NULL AND @TargetMenuID IS NULL))`);
      if (dupCheck.recordset.length > 0) {
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, userHeadlineSourceID: dupCheck.recordset[0].UserHeadlineSourceID, created: false }) };
        return;
      }

      const copyResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, src.SourceID)
        .input('IsFiltered', sql.Bit, src.IsFiltered)
        .input('Exclusions', sql.NVarChar(500), src.Exclusions)
        .input('GroupLabel', sql.NVarChar(100), src.GroupLabel)
        .input('UserMenuID', sql.Int, targetMenuID)
        .input('ImageURL', sql.NVarChar(sql.MAX), src.ImageURL)
        .input('TargetProfileID', sql.Int, targetProfileID)
        .query(`INSERT INTO [UserHeadlineSource] (UserID, SourceID, IsFiltered, IsActive, Exclusions, GroupLabel, UserMenuID, ImageURL, UserProfileID)
                OUTPUT INSERTED.UserHeadlineSourceID
                VALUES (@UserID, @SourceID, @IsFiltered, 1, @Exclusions, @GroupLabel, @UserMenuID, @ImageURL, @TargetProfileID)`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, userHeadlineSourceID: copyResult.recordset[0].UserHeadlineSourceID, created: true }) };

    } else if (action === 'add') {
      if (sourceType === 'Youtube') {
        const apiKey = process.env.YOUTUBE_API_KEY;
        let youtubeChannelID;
        try {
          youtubeChannelID = await resolveYoutubeChannelID(url, apiKey);
        } catch(e) {
          context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: e.message }) };
          return;
        }
        const seqResult = await pool.request()
          .query(`SELECT ISNULL(MAX(Sequence), 0) + 1 AS NextSeq FROM [HeadlineSource]`);
        const nextSeq = seqResult.recordset[0].NextSeq;
        const result = await pool.request()
          .input('Name', sql.NVarChar(200), name)
          .input('URL', sql.NVarChar(500), url)
          .input('SourceType', sql.NVarChar(20), 'Youtube')
          .input('Sequence', sql.Int, nextSeq)
          .input('YoutubeChannelID', sql.NVarChar(50), youtubeChannelID)
          .query(`
            INSERT INTO [HeadlineSource] (Name, URL, SourceType, IsActive, Sequence, DateAdded, YoutubeChannelID)
            VALUES (@Name, @URL, @SourceType, 1, @Sequence, CAST(GETDATE() AS DATE), @YoutubeChannelID);
            SELECT SCOPE_IDENTITY() AS SourceID;
          `);
        const newSourceID = result.recordset[0].SourceID;
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, newSourceID)
          .input('ProfileID', sql.Int, profileID || null)
          .query(`
            IF NOT EXISTS (SELECT 1 FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID AND (UserProfileID=@ProfileID OR (UserProfileID IS NULL AND @ProfileID IS NULL)))
            INSERT INTO [UserHeadlineSource] (UserID, SourceID, IsFiltered, IsActive, UserProfileID) VALUES (@UserID, @SourceID, 0, 1, @ProfileID)
          `);
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID: newSourceID, youtubeChannelID }) };

      } else if (sourceID) {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, sourceID)
          .input('ProfileID', sql.Int, profileID || null)
          .query(`
            IF NOT EXISTS (SELECT 1 FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID AND (UserProfileID=@ProfileID OR (UserProfileID IS NULL AND @ProfileID IS NULL)))
            INSERT INTO [UserHeadlineSource] (UserID, SourceID, IsFiltered, IsActive, UserProfileID) VALUES (@UserID, @SourceID, 1, 1, @ProfileID)
          `);
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID }) };

      } else {
        const seqResult = await pool.request()
          .query(`SELECT ISNULL(MAX(Sequence), 0) + 1 AS NextSeq FROM [HeadlineSource]`);
        const nextSeq = seqResult.recordset[0].NextSeq;
        const result = await pool.request()
          .input('Name', sql.NVarChar(200), name)
          .input('URL', sql.NVarChar(500), url)
          .input('SourceType', sql.NVarChar(20), sourceType || 'RSS')
          .input('Sequence', sql.Int, sequence || nextSeq)
          .query(`
            INSERT INTO [HeadlineSource] (Name, URL, SourceType, IsActive, Sequence, DateAdded)
            VALUES (@Name, @URL, @SourceType, 1, @Sequence, CAST(GETDATE() AS DATE));
            SELECT SCOPE_IDENTITY() AS SourceID;
          `);
        const newSourceID = result.recordset[0].SourceID;
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, newSourceID)
          .input('ProfileID', sql.Int, profileID || null)
          .query(`
            IF NOT EXISTS (SELECT 1 FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID AND (UserProfileID=@ProfileID OR (UserProfileID IS NULL AND @ProfileID IS NULL)))
            INSERT INTO [UserHeadlineSource] (UserID, SourceID, IsFiltered, IsActive, UserProfileID) VALUES (@UserID, @SourceID, 1, 1, @ProfileID)
          `);
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID: newSourceID }) };
      }

    } else if (action === 'update') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('Name', sql.NVarChar(200), name)
        .input('URL', sql.NVarChar(500), url)
        .input('SourceType', sql.NVarChar(20), sourceType)
        .input('Sequence', sql.Int, sequence || null)
        .input('IsActive', sql.Bit, isActive ? 1 : 0)
        .query(`
          UPDATE [HeadlineSource]
          SET Name=@Name, URL=@URL, SourceType=@SourceType,
              Sequence=ISNULL(@Sequence, Sequence), IsActive=@IsActive
          WHERE SourceID=@SourceID
        `);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'toggleGlobalActive') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('IsActive', sql.Bit, isActive ? 1 : 0)
        .query(`UPDATE [HeadlineSource] SET IsActive=@IsActive WHERE SourceID=@SourceID`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'toggleUserActive') {
      const request1 = pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .input('IsActive', sql.Bit, isActive ? 1 : 0);
      const where1 = userHeadlineSourceID ? 'UserHeadlineSourceID=@UserHeadlineSourceID' : 'UserID=@UserID AND SourceID=@SourceID';
      if (userHeadlineSourceID) request1.input('UserHeadlineSourceID', sql.Int, userHeadlineSourceID);
      await request1.query(`UPDATE [UserHeadlineSource] SET IsActive=@IsActive WHERE ${where1}`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'toggleAllUserActive') {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('IsActive', sql.Bit, isActive ? 1 : 0)
        .query(`UPDATE [UserHeadlineSource] SET IsActive=@IsActive WHERE UserID=@UserID`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'updateFiltered') {
      const request2 = pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .input('IsFiltered', sql.Bit, req.body.isFiltered ? 1 : 0);
      const where2 = userHeadlineSourceID ? 'UserHeadlineSourceID=@UserHeadlineSourceID' : 'UserID=@UserID AND SourceID=@SourceID';
      if (userHeadlineSourceID) request2.input('UserHeadlineSourceID', sql.Int, userHeadlineSourceID);
      await request2.query(`UPDATE [UserHeadlineSource] SET IsFiltered=@IsFiltered WHERE ${where2}`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'updateSubscription') {
      const request3 = pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .input('GroupLabel', sql.NVarChar(100), req.body.groupLabel || null)
        .input('UserMenuID', sql.Int, req.body.userMenuID || null)
        .input('ImageURL', sql.NVarChar(sql.MAX), req.body.imageURL || null);
      const where3 = userHeadlineSourceID ? 'UserHeadlineSourceID=@UserHeadlineSourceID' : 'UserID=@UserID AND SourceID=@SourceID';
      if (userHeadlineSourceID) request3.input('UserHeadlineSourceID', sql.Int, userHeadlineSourceID);
      await request3.query(`UPDATE [UserHeadlineSource] SET GroupLabel=@GroupLabel, UserMenuID=@UserMenuID, ImageURL=@ImageURL WHERE ${where3}`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'updateExclusions') {
      const request4 = pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .input('Exclusions', sql.NVarChar(500), req.body.exclusions || null);
      const where4 = userHeadlineSourceID ? 'UserHeadlineSourceID=@UserHeadlineSourceID' : 'UserID=@UserID AND SourceID=@SourceID';
      if (userHeadlineSourceID) request4.input('UserHeadlineSourceID', sql.Int, userHeadlineSourceID);
      await request4.query(`UPDATE [UserHeadlineSource] SET Exclusions=@Exclusions WHERE ${where4}`);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'resequence') {
      if (Array.isArray(req.body.sequences)) {
        for (const s of req.body.sequences) {
          await pool.request()
            .input('SourceID', sql.Int, s.sourceID)
            .input('Sequence', sql.Int, s.sequence)
            .query(`UPDATE [HeadlineSource] SET Sequence=@Sequence WHERE SourceID=@SourceID`);
        }
      }
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'delete') {
      if (req.body.globalDelete === true) {
        await pool.request().input('SourceID', sql.Int, sourceID)
          .query(`DELETE FROM [UserHeadlineSource] WHERE SourceID=@SourceID`);
        await pool.request().input('SourceID', sql.Int, sourceID)
          .query(`DELETE FROM [HeadlineSource] WHERE SourceID=@SourceID`);
      } else {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, sourceID)
          .query(`DELETE FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID`);
      }
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

  } catch(err) {
    context.log('SaveSource error:', err.message, err.stack);
    context.res = { status: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }) };
  }
};