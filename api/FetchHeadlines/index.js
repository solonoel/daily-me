const sql = require('mssql');
const https = require('https');
const http = require('http');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

const langCodeMap = {
  'Spanish': 'es', 'French': 'fr', 'Italian': 'it',
  'Portuguese': 'pt', 'Romanian': 'ro', 'English': 'en'
};

let francDetect = null;
async function detectLang(text) {
  try {
    if (!francDetect) { const m = await import('franc'); francDetect = m.franc; }
    return francDetect(text, { minLength: 20 });
  } catch(e) { return 'und'; }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'DailyMe/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseRSS(xml) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const link = (item.match(/<link>(.*?)<\/link>/) || item.match(/<guid[^>]*>(.*?)<\/guid>/) || [])[1] || '';
    const description = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    if (title && link) {
      articles.push({
        title: title.trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"'),
        link: link.trim(),
        summary: description.replace(/<[^>]+>/g,'').trim().substring(0, 500),
        pubDate: pubDate ? new Date(pubDate) : new Date()
      });
    }
  }
  return articles;
}

function containsCJK(text) { return /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text); }
function containsArabicOrHebrew(text) { return /[\u0600-\u06FF\u0590-\u05FF]/.test(text); }
function containsCyrillic(text) { return /[\u0400-\u04FF]/.test(text); }

async function filterByLanguage(articles, allowedCodes) {
  const filtered = [];
  for (const a of articles) {
    const text = `${a.title || ''} ${a.summary || ''}`.trim();
    if (containsCJK(text)) continue;
    if (containsArabicOrHebrew(text)) continue;
    if (containsCyrillic(text) && !allowedCodes.includes('ru') && !allowedCodes.includes('uk')) continue;
    if (text.length < 20) { filtered.push(a); continue; }
    const detected = await detectLang(text);
    const iso3to2 = { 'eng':'en','spa':'es','fra':'fr','ita':'it','por':'pt','ron':'ro','und':'en','zho':'zh','jpn':'ja','kor':'ko' };
    const detected2 = iso3to2[detected] || detected.substring(0,2);
    if (detected === 'und' || allowedCodes.includes(detected2)) filtered.push(a);
  }
  return filtered;
}

async function fetchGuardian(source, keywords, topics, fromDateStr, langCodes, otherPerKeyword) {
  const apiKey = process.env.GUARDIAN_API_KEY;
  const articles = [];
  const terms = [...keywords, ...topics];
  for (const term of terms) {
    const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(term.text)}&from-date=${fromDateStr}&show-fields=trailText&order-by=newest&page-size=${otherPerKeyword}&api-key=${apiKey}`;
    try {
      const data = JSON.parse(await fetchUrl(url));
      for (const a of (data.response?.results || []).slice(0, otherPerKeyword)) {
        articles.push({
          title: a.webTitle, link: a.webUrl,
          summary: a.fields?.trailText?.replace(/<[^>]+>/g,'') || '',
          categoryID: term.categoryID, keywordID: term.keywordID || null,
          topicID: term.topicID || null, pubDate: new Date(a.webPublicationDate)
        });
      }
    } catch(e) {}
  }
  return articles;
}

async function fetchNYT(source) {
  const apiKey = process.env.NYT_API_KEY;
  const data = JSON.parse(await fetchUrl(`https://api.nytimes.com/svc/topstories/v2/home.json?api-key=${apiKey}`));
  return (data.results || []).map(a => ({
    title: a.title, link: a.url, summary: a.abstract || '', pubDate: new Date(a.published_date)
  }));
}

async function fetchGNews(source, langCodes) {
  const apiKey = process.env.GNEWS_API_KEY;
  const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const data = JSON.parse(await fetchUrl(`https://gnews.io/api/v4/top-headlines?lang=${lang}&max=20&apikey=${apiKey}`));
  return (data.articles || []).map(a => ({
    title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.publishedAt)
  }));
}

async function fetchCurrents(source) {
  const apiKey = process.env.CURRENTS_API_KEY;
  const data = JSON.parse(await fetchUrl(`https://api.currentsapi.services/v1/latest-news?language=en&apiKey=${apiKey}`));
  return (data.news || []).map(a => ({
    title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.published)
  }));
}

async function fetchMediaStack(source) {
  const apiKey = process.env.MEDIASTACK_API_KEY;
  const data = JSON.parse(await fetchUrl(`http://api.mediastack.com/v1/news?access_key=${apiKey}&languages=en&limit=20`));
  return (data.data || []).map(a => ({
    title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.published_at)
  }));
}

async function fetchNewsAPI(source, langCodes) {
  const apiKey = process.env.NEWSAPI_KEY;
  const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const data = JSON.parse(await fetchUrl(`https://newsapi.org/v2/top-headlines?language=${lang}&pageSize=20&apiKey=${apiKey}`));
  return (data.articles || []).map(a => ({
    title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.publishedAt)
  }));
}

async function fetchRSS(source) {
  const xml = await fetchUrl(source.URL);
  return parseRSS(xml);
}

function uploadsPlaylistID(channelID) {
  return 'UU' + channelID.substring(2);
}

function parseISO8601Duration(duration) {
  if (!duration) return null;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1] || 0);
  const m = parseInt(match[2] || 0);
  const s = parseInt(match[3] || 0);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

async function fetchYouTubeDurations(videoIDs, apiKey, context) {
  const durations = {};
  // Batch in groups of 50
  for (let i = 0; i < videoIDs.length; i += 50) {
    const batch = videoIDs.slice(i, i + 50);
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${apiKey}`;
      const data = JSON.parse(await fetchUrl(url));
      for (const item of (data.items || [])) {
        durations[item.id] = parseISO8601Duration(item.contentDetails?.duration);
      }
    } catch(e) {
      context.log(`Duration fetch error: ${e.message}`);
    }
  }
  return durations;
}

async function fetchYouTubeUnfiltered(source, maxResults, fromDate, context) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const playlistID = uploadsPlaylistID(source.YoutubeChannelID);
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistID}&maxResults=${maxResults}&key=${apiKey}`;
  const articles = [];
  try {
    const data = JSON.parse(await fetchUrl(url));
    context.log(`YouTube unfiltered [${source.Name}]: ${data.items?.length || 0} items`);
    for (const item of (data.items || [])) {
      const snippet = item.snippet;
      const videoID = snippet?.resourceId?.videoId;
      if (!videoID) continue;
      const pubDate = new Date(snippet.publishedAt);
      if (pubDate < fromDate) continue;
      articles.push({
        title: snippet.title,
        link: `https://www.youtube.com/watch?v=${videoID}`,
        summary: (snippet.description || '').substring(0, 500),
        thumbnailURL: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
        channelName: snippet.channelTitle,
        channelURL: `https://www.youtube.com/channel/${snippet.channelId}`,
        pubDate
      });
    }
  } catch(e) {
    context.log(`YouTube unfiltered error [${source.Name}]: ${e.message}`);
  }
  return articles;
}

async function fetchYouTubeFiltered(source, keywords, maxResults, langCodes, fromDateStr, context) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const relevanceLang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const channelID = source.YoutubeChannelID;
  const articles = [];
  for (const term of keywords) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(term.text)}&type=video&order=date&maxResults=${maxResults}&channelId=${channelID}&publishedAfter=${fromDateStr}T00:00:00Z&relevanceLanguage=${relevanceLang}&key=${apiKey}`;
      const data = JSON.parse(await fetchUrl(url));
      context.log(`YouTube filtered [${source.Name}] term "${term.text}": ${data.items?.length || 0} results`);
      for (const item of (data.items || []).slice(0, maxResults)) {
        const videoID = item.id?.videoId;
        if (!videoID) continue;
        articles.push({
          title: item.snippet.title,
          link: `https://www.youtube.com/watch?v=${videoID}`,
          summary: (item.snippet.description || '').substring(0, 500),
          thumbnailURL: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
          channelName: item.snippet.channelTitle,
          channelURL: `https://www.youtube.com/channel/${item.snippet.channelId}`,
          categoryID: term.categoryID, keywordID: term.keywordID || null,
          topicID: term.topicID || null, pubDate: new Date(item.snippet.publishedAt)
        });
      }
    } catch(e) {
      context.log(`YouTube filtered error [${source.Name}] term "${term.text}": ${e.message}`);
    }
  }
  return articles;
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = parseInt(req.body?.userID || req.query?.userID || 1);

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines, YouTubeMaxResults, OtherHeadlinesPerKeyword, LastYouTubeFetch
              FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const settings = settingResult.recordset[0] || {};
    const recencyDays = settings.RecencyDays || 7;
    const maxHeadlines = settings.MaxHeadlines || 50;
    const youTubeMaxResults = settings.YouTubeMaxResults || 3;
    const otherPerKeyword = settings.OtherHeadlinesPerKeyword || 3;
    const lastYouTubeFetch = settings.LastYouTubeFetch;

    const today = new Date().toISOString().split('T')[0];
    const lastFetchDate = lastYouTubeFetch ? new Date(lastYouTubeFetch).toISOString().split('T')[0] : null;
    const youtubeAlreadyFetched = lastFetchDate === today;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - recencyDays);
    const fromDateStr = fromDate.toISOString().split('T')[0];

    const langResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT l.LanguageNameEng FROM UserLanguage ul
              JOIN Language l ON l.LanguageID = ul.LanguageID
              WHERE ul.UserID = @UserID AND ul.IsActive = 'Y'`);
    const uniqueLangCodes = [...new Set(['en', ...langResult.recordset.map(r => langCodeMap[r.LanguageNameEng] || 'en')])];

    const sourcesResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT h.SourceID, h.Name, h.URL, h.SourceType, h.CategoryID, h.IsActive,
                     h.Sequence, h.YoutubeChannelID,
                     uhs.IsSubscription AS YoutubeUnfiltered
              FROM [HeadlineSource] h
              INNER JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID
              WHERE uhs.UserID = @UserID AND h.IsActive = 'Y'
              ORDER BY h.Sequence, h.SourceID`);
    const sources = sourcesResult.recordset;

    const kwResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT KeywordID, Keyword AS text, CategoryID FROM [HeadlineKeyword] WHERE UserID=@UserID AND IsActive='Y'`);
    const tpResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT TopicID, Topic AS text, CategoryID FROM [HeadlineTopic] WHERE UserID=@UserID AND IsActive='Y'`);
    const keywords = kwResult.recordset.map(k => ({ ...k, keywordID: k.KeywordID, topicID: null }));
    const topics = tpResult.recordset.map(t => ({ ...t, keywordID: null, topicID: t.TopicID }));

    const existingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT Link FROM [Headline] WHERE UserID=@UserID`);
    const existingLinks = new Set(existingResult.recordset.map(r => r.Link));

    const catNamesResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT CategoryID, Name FROM [Category] WHERE UserID=@UserID AND IsActive='Y' AND Headlines='Y'`);
    const catLimitsResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT CategoryID, MaxItems FROM [UserCategorySetting] WHERE UserID=@UserID`);
    const catLimits = {};
    catLimitsResult.recordset.forEach(r => catLimits[r.CategoryID] = r.MaxItems);
    const numCats = catNamesResult.recordset.length || 5;
    const defaultPerCat = Math.ceil(maxHeadlines / numCats);

    let allArticles = [];
    let youtubeFetched = false;
    const usedSubscriptionChannelIDs = new Set();

    // Process unfiltered subscription YouTube sources first
    for (const source of sources) {
      if (source.SourceType === 'Youtube' && source.YoutubeUnfiltered) {
        if (youtubeAlreadyFetched) continue;
        if (!source.YoutubeChannelID) continue;
        try {
          let articles = await fetchYouTubeUnfiltered(source, 20, fromDate, context);
          articles = await filterByLanguage(articles, uniqueLangCodes);
          articles.forEach(a => {
            a.isSubscription = true;
            a.sourceName = source.Name;
            a.sourceID = source.SourceID;
            a.sourceType = source.SourceType;
            a.categoryID = null;
            a.keywordID = null;
            a.topicID = null;
            if (!a.thumbnailURL) a.thumbnailURL = null;
            if (!a.channelName) a.channelName = null;
            if (!a.channelURL) a.channelURL = null;
            if (!a.duration) a.duration = null;
          });
          allArticles = allArticles.concat(articles);
          usedSubscriptionChannelIDs.add(source.YoutubeChannelID);
          youtubeFetched = true;
        } catch(err) {
          context.log(`Error fetching subscription source ${source.Name}: ${err.message}`);
        }
      }
    }

    for (const source of sources) {
      try {
        let articles = [];
        switch(source.SourceType) {
          case 'API':
            if (source.Name.includes('Guardian'))    articles = await fetchGuardian(source, keywords, topics, fromDateStr, uniqueLangCodes, otherPerKeyword);
            else if (source.Name.includes('NYT'))    articles = await fetchNYT(source);
            else if (source.Name.includes('GNews'))  articles = await fetchGNews(source, uniqueLangCodes);
            else if (source.Name.includes('Currents')) articles = await fetchCurrents(source);
            else if (source.Name.includes('MediaStack')) articles = await fetchMediaStack(source);
            else if (source.Name.includes('NewsAPI'))    articles = await fetchNewsAPI(source, uniqueLangCodes);
            break;
          case 'RSS':
            if (source.YoutubeUnfiltered) {
              articles = await fetchRSS(source);
              articles = await filterByLanguage(articles, uniqueLangCodes);
              articles.forEach(a => a.isSubscription = true);
            } else {
              articles = await fetchRSS(source);
              articles = await filterByLanguage(articles, uniqueLangCodes);
            }
            break;
          case 'Youtube':
            if (source.YoutubeUnfiltered) continue; // already handled above
            if (youtubeAlreadyFetched) {
              context.log(`YouTube skipped — already fetched today`);
              continue;
            }
            if (!source.YoutubeChannelID) {
              context.log(`YouTube skipped [${source.Name}] — no YoutubeChannelID`);
              continue;
            }
            if (usedSubscriptionChannelIDs.has(source.YoutubeChannelID)) continue;
            articles = await fetchYouTubeFiltered(source, keywords, youTubeMaxResults, uniqueLangCodes, fromDateStr, context);
            articles = await filterByLanguage(articles, uniqueLangCodes);
            youtubeFetched = true;
            break;
        }

        articles.forEach(a => {
          a.sourceName = source.Name;
          a.sourceID = source.SourceID;
          a.sourceType = source.SourceType;
          if (!a.categoryID) a.categoryID = source.CategoryID || null;
          if (!a.keywordID) a.keywordID = null;
          if (!a.topicID) a.topicID = null;
          if (!a.thumbnailURL) a.thumbnailURL = null;
          if (!a.channelName) a.channelName = null;
          if (!a.channelURL) a.channelURL = null;
          if (!a.duration) a.duration = null;
          if (!a.isSubscription) a.isSubscription = false;
        });
        allArticles = allArticles.concat(articles);
      } catch(err) {
        context.log(`Error fetching from ${source.Name}: ${err.message}`);
      }
    }

    if (youtubeFetched) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`UPDATE [HeadlineSetting] SET LastYouTubeFetch = GETDATE() WHERE UserID = @UserID`);
      // Fetch durations for all YouTube articles in one batch (including unfiltered)
      const ytArticles = allArticles.filter(a => a.sourceType === 'Youtube');
      const videoIDs = ytArticles.map(a => {
        const m = a.link?.match(/[?&]v=([^&]+)/);
        return m ? m[1] : null;
      }).filter(Boolean);
      if (videoIDs.length) {
        const durations = await fetchYouTubeDurations(videoIDs, process.env.YOUTUBE_API_KEY, context);
        ytArticles.forEach(a => {
          const m = a.link?.match(/[?&]v=([^&]+)/);
          if (m) a.duration = durations[m[1]] || null;
        });
      }
    }

    const seen = new Set();
    const unique = allArticles.filter(a => {
      if (!a.link || seen.has(a.link) || existingLinks.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    for (const a of unique) {
      if (a.isSubscription) { a.categoryID = null; a.keywordID = null; a.topicID = null; continue; }
      if (a.categoryID) continue;
      const text = `${a.title} ${a.summary}`.toLowerCase();
      let matched = false;
      for (const kw of kwResult.recordset) {
        const escaped = kw.text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
          a.categoryID = kw.CategoryID; a.keywordID = kw.KeywordID;
          matched = true; break;
        }
      }
      if (matched) continue;
      for (const tp of tpResult.recordset) {
        const words = tp.text.toLowerCase().split(' ').filter(w => w.length > 3);
        const matchCount = words.filter(w => text.includes(w)).length;
        if (matchCount >= Math.ceil(words.length * 0.5)) {
          a.categoryID = tp.CategoryID; a.topicID = tp.TopicID;
          break;
        }
      }
    }

    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

    const selected = [];
    const catCounts = {};
    const keywordSourceCounts = {};

    for (const a of unique) {
      const cat = a.categoryID !== null && a.categoryID !== undefined ? a.categoryID : 'none';
      if (!(cat in catCounts)) catCounts[cat] = 0;

      if (cat !== 'none') {
        const limit = catLimits[cat] || defaultPerCat;
        if (catCounts[cat] >= limit) continue;
      }

      if (a.sourceType !== 'Youtube' && (a.keywordID || a.topicID)) {
        const termKey = `${a.keywordID || 'tp' + a.topicID}-${a.sourceID}`;
        keywordSourceCounts[termKey] = (keywordSourceCounts[termKey] || 0);
        if (keywordSourceCounts[termKey] >= otherPerKeyword) continue;
        keywordSourceCounts[termKey]++;
      }

      selected.push(a);
      if (cat !== 'none') catCounts[cat]++;
    }

    context.log(`unique: ${unique.length}, selected: ${selected.length}`);

    let totalInserted = 0;
    for (const a of selected) {
      try {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('CategoryID', sql.Int, a.categoryID || null)
          .input('HeadlineName', sql.NVarChar(500), (a.title || '').substring(0, 500))
          .input('Link', sql.NVarChar(500), (a.link || '').substring(0, 500))
          .input('Summary', sql.NVarChar(1000), (a.summary || '').substring(0, 1000))
          .input('KeywordID', sql.Int, a.keywordID || null)
          .input('TopicID', sql.Int, a.topicID || null)
          .input('ThumbnailURL', sql.NVarChar(500), a.thumbnailURL || null)
          .input('ChannelName', sql.NVarChar(200), a.channelName || null)
          .input('ChannelURL', sql.NVarChar(500), a.channelURL || null)
          .input('SourceID', sql.Int, a.sourceID || null)
          .input('Duration', sql.VarChar(20), a.duration || null)
          .input('IsSubscription', sql.Bit, a.isSubscription ? 1 : 0)
          .query(`INSERT INTO [Headline]
                    (UserID, CategoryID, HeadlineName, Link, Summary, CreatedDate, Retain,
                     KeywordID, TopicID, ThumbnailURL, ChannelName, ChannelURL, SourceID, Duration, IsSubscription)
                  VALUES
                    (@UserID, @CategoryID, @HeadlineName, @Link, @Summary, GETDATE(), 'N',
                     @KeywordID, @TopicID, @ThumbnailURL, @ChannelName, @ChannelURL, @SourceID, @Duration, @IsSubscription)`);
        totalInserted++;
      } catch(insertErr) {
        context.log(`Insert error: ${insertErr.message} | title: ${a.title?.substring(0,50)}`);
      }
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true, inserted: totalInserted,
        duplicates: allArticles.length - unique.length,
        sourcesProcessed: sources.length,
        youtubeSkipped: youtubeAlreadyFetched
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};