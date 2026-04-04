const sql = require('mssql');
const https = require('https');
const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

async function resolveYoutubeChannelID(url, apiKey) {
  const handleMatch = url.match(/@([\w-]+)/);
  const channelMatch = url.match(/\/channel\/(UC[\w-]+)/);
  if (channelMatch) return channelMatch[1];
  if (!handleMatch) throw new Error('Could not parse YouTube URL. Use https://www.youtube.com/@ChannelName format.');
  const handle = handleMatch[1];

  function fetchJson(apiUrl) {
    return new Promise((resolve, reject) => {
      https.get(apiUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Parse error')); } });
      }).on('error', reject);
    });
  }

  // Method 1: forHandle (works for most handles)
  try {
    const d1 = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`);
    if (d1?.items?.[0]?.id) return d1.items[0].id;
  } catch(e) {}

  // Method 2: forUsername (works for older channels)
  try {
    const d2 = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(handle)}&key=${apiKey}`);
    if (d2?.items?.[0]?.id) return d2.items[0].id;
  } catch(e) {}

  // Method 3: search.list by channel name (100 units but most reliable fallback)
  try {
    const d3 = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(handle)}&type=channel&maxResults=1&key=${apiKey}`);
    if (d3?.items?.[0]?.snippet?.channelId) return d3.items[0].snippet.channelId;
    if (d3?.items?.[0]?.id?.channelId) return d3.items[0].id.channelId;
  } catch(e) {}

  throw new Error(`YouTube channel not found for @${handle}. Verify the URL is correct.`);
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { action, sourceID, name, url, sourceType, categoryID, isActive,
            sequence, youtubeUnfiltered, userID = 1 } = req.body;

    if (action === 'add') {
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
          .input('CategoryID', sql.Int, categoryID || null)
          .input('Sequence', sql.Int, nextSeq)
          .input('YoutubeChannelID', sql.NVarChar(50), youtubeChannelID)
          .query(`
            INSERT INTO [HeadlineSource] (Name, URL, SourceType, IsActive, CategoryID, Sequence, DateAdded, YoutubeChannelID)
            VALUES (@Name, @URL, @SourceType, 'Y', @CategoryID, @Sequence, CAST(GETDATE() AS DATE), @YoutubeChannelID);
            SELECT SCOPE_IDENTITY() AS SourceID;
          `);
        const newSourceID = result.recordset[0].SourceID;
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID: newSourceID, youtubeChannelID }) };

      } else if (sourceID) {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('SourceID', sql.Int, sourceID)
          .query(`
            IF NOT EXISTS (SELECT 1 FROM [UserHeadlineSource] WHERE UserID=@UserID AND SourceID=@SourceID)
            INSERT INTO [UserHeadlineSource] (UserID, SourceID, YoutubeUnfiltered) VALUES (@UserID, @SourceID, 0)
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
          .input('CategoryID', sql.Int, categoryID || null)
          .input('Sequence', sql.Int, sequence || nextSeq)
          .query(`
            INSERT INTO [HeadlineSource] (Name, URL, SourceType, IsActive, CategoryID, Sequence, DateAdded)
            VALUES (@Name, @URL, @SourceType, 'Y', @CategoryID, @Sequence, CAST(GETDATE() AS DATE));
            SELECT SCOPE_IDENTITY() AS SourceID;
          `);
        const newSourceID = result.recordset[0].SourceID;
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, sourceID: newSourceID }) };
      }

    } else if (action === 'update') {
      await pool.request()
        .input('SourceID', sql.Int, sourceID)
        .input('Name', sql.NVarChar(200), name)
        .input('URL', sql.NVarChar(500), url)
        .input('SourceType', sql.NVarChar(20), sourceType)
        .input('CategoryID', sql.Int, categoryID || null)
        .input('Sequence', sql.Int, sequence || null)
        .input('IsActive', sql.Char(1), isActive ? 'Y' : 'N')
        .query(`
          UPDATE [HeadlineSource]
          SET Name=@Name, URL=@URL, SourceType=@SourceType, CategoryID=@CategoryID,
              Sequence=ISNULL(@Sequence, Sequence), IsActive=@IsActive
          WHERE SourceID=@SourceID
        `);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }) };

    } else if (action === 'updateUnfiltered') {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('SourceID', sql.Int, sourceID)
        .input('YoutubeUnfiltered', sql.Bit, youtubeUnfiltered ? 1 : 0)
        .query(`
          UPDATE [UserHeadlineSource]
          SET YoutubeUnfiltered = @YoutubeUnfiltered
          WHERE UserID=@UserID AND SourceID=@SourceID
        `);
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