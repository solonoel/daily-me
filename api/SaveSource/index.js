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
  const apiUrl = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
  return new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const channelID = parsed?.items?.[0]?.id;
          if (!channelID) reject(new Error(`YouTube channel not found for @${handle}`));
          else resolve(channelID);
        } catch(e) { reject(new Error('YouTube API parse error')); }
      });
    }).on('error', reject);
  });
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