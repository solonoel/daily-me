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
    const contentEncoded = (item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/) || item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const fullText = (contentEncoded || description).replace(/<[^>]+>/g,'').trim();
    const summary = description.replace(/<[^>]+>/g,'').trim().substring(0, 500);
    if (title && link) {
      articles.push({
        title: title.trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"'),
        link: link.trim(), summary,
        fullText: fullText.substring(0, 2000),
        pubDate: pubDate ? new Date(pubDate.replace(/\b(EDT|EST|CDT|CST|MDT|MST|PDT|PST)\b/, d => ({EDT:'-0400',EST:'-0500',CDT:'-0500',CST:'-0600',MDT:'-0600',MST:'-0700',PDT:'-0700',PST:'-0800'})[d])) : new Date()
      });
    }
  }
  return articles;
}

function containsCJK(text) { return /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text); }
function containsArabicOrHebrew(text) { return /[\u0600-\u06FF\u0590-\u05FF]/.test(text); }
function containsCyrillic(text) { return /[\u0400-\u04FF]/.test(text); }

async function filterByLanguage(articles, allowedCodes) {
  const filtered = [], langFiltered = [];
  for (const a of articles) {
    const text = `${a.title || ''} ${a.summary || ''}`.trim();
    if (containsCJK(text)) { langFiltered.push(a.title); continue; }
    if (containsArabicOrHebrew(text)) { langFiltered.push(a.title); continue; }
    if (containsCyrillic(text) && !allowedCodes.includes('ru') && !allowedCodes.includes('uk')) { langFiltered.push(a.title); continue; }
    if (text.length < 20) { filtered.push(a); continue; }
    const detected = await detectLang(text);
    const iso3to2 = { 'eng':'en','spa':'es','fra':'fr','ita':'it','por':'pt','ron':'ro','und':'en','zho':'zh','jpn':'ja','kor':'ko' };
    const detected2 = iso3to2[detected] || detected.substring(0,2);
    if (detected === 'und' || allowedCodes.includes(detected2)) filtered.push(a);
    else langFiltered.push(a.title);
  }
  filtered._langFiltered = langFiltered;
  return filtered;
}

function matchesKeyword(text, keywordText) {
  const lowerText = text.toLowerCase();
  function termMatches(raw) {
    const isPhrase = raw.startsWith('"') && raw.endsWith('"');
    const word = isPhrase ? raw.slice(1, -1) : raw;
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = isPhrase ? new RegExp(escaped, 'i') : new RegExp(`\\b${escaped}\\b`, 'i');
    return pattern.test(lowerText);
  }
  const clauses = keywordText.split(',').map(c => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const exclusions = [];
    let workingClause = clause;
    workingClause = workingClause.replace(/-"[^"]+"|(-\S+)/g, (match) => {
      exclusions.push(match.substring(1).trim());
      return '';
    });
    const andGroups = workingClause.split('+').map(g => g.trim()).filter(Boolean);
    let clauseMatch = andGroups.length > 0;
    for (const group of andGroups) {
      const orTerms = group.split('/').map(t => t.trim()).filter(Boolean);
      if (!orTerms.some(t => termMatches(t))) { clauseMatch = false; break; }
    }
    if (!clauseMatch) continue;
    if (exclusions.some(ex => termMatches(ex))) continue;
    return true;
  }
  return false;
}

function isTeamsKeyword(kw) { return kw.GroupLabel?.toLowerCase() === 'teams'; }
function isExclusionKeyword(kw) { return kw.Keyword && kw.Keyword.trim().startsWith('-'); }
function exclusionTerm(kw) { return kw.Keyword.trim().substring(1).trim(); }

// Teams identified by GroupLabel='Teams', not by CategoryID
function applyKeywordMatching(articles, keywords) {
  const teamsKeywords = keywords.filter(isTeamsKeyword);
  const nonTeamsKeywords = keywords.filter(kw => !isTeamsKeyword(kw));
  // Pass 1: Teams — claim exclusively
  for (const a of articles) {
    if (a.teamsOnly) continue;
    const text = `${a.title} ${a.summary} ${a.fullText||''}`.toLowerCase();
    for (const kw of teamsKeywords) {
      if (kw.SourceID && kw.SourceID !== a.sourceID) continue;
      if (kw.UserOwnedSourceID && kw.UserOwnedSourceID !== a.userOwnedSourceID) continue;
      if (matchesKeyword(text, kw.text)) {
        a.keywordID = kw.KeywordID; a.teamsOnly = true; break;
      }
    }
  }
  // Pass 2: Non-Teams
  for (const a of articles) {
    if (a.teamsOnly || a.keywordID) continue;
    const text = `${a.title} ${a.summary} ${a.fullText||''}`.toLowerCase();
    for (const kw of nonTeamsKeywords) {
      if (kw.SourceID && kw.SourceID !== a.sourceID) continue;
      if (kw.UserOwnedSourceID && kw.UserOwnedSourceID !== a.userOwnedSourceID) continue;
      if (matchesKeyword(text, kw.text)) {
        a.keywordID = kw.KeywordID; break;
      }
    }
  }
  return articles;
}

async function fetchGuardian(source, keywords, fromDateStr) {
  const apiKey = process.env.GUARDIAN_API_KEY;
  const articles = [];
  for (const term of keywords) {
    const searchText = term.text.split(',')[0].split('+')[0].split('/')[0].replace(/"/g,'').trim();
    try {
      const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(searchText)}&from-date=${fromDateStr}&show-fields=trailText&order-by=newest&page-size=50&api-key=${apiKey}`;
      const data = JSON.parse(await fetchUrl(url));
      for (const a of (data.response?.results || [])) {
        articles.push({
          title: a.webTitle, link: a.webUrl,
          summary: a.fields?.trailText?.replace(/<[^>]+>/g,'') || '',
          keywordID: term.keywordID || null,
          pubDate: new Date(a.webPublicationDate)
        });
      }
    } catch(e) {}
  }
  return articles;
}

async function fetchNYT(source) {
  try {
    const data = JSON.parse(await fetchUrl(`https://api.nytimes.com/svc/topstories/v2/home.json?api-key=${process.env.NYT_API_KEY}`));
    return (data.results || []).map(a => ({ title: a.title, link: a.url, summary: a.abstract || '', pubDate: new Date(a.published_date) }));
  } catch(e) { return []; }
}

async function fetchGNews(source, langCodes) {
  try {
    const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
    const data = JSON.parse(await fetchUrl(`https://gnews.io/api/v4/top-headlines?lang=${lang}&max=50&apikey=${process.env.GNEWS_API_KEY}`));
    return (data.articles || []).map(a => ({ title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.publishedAt) }));
  } catch(e) { return []; }
}

async function fetchCurrents(source) {
  try {
    const data = JSON.parse(await fetchUrl(`https://api.currentsapi.services/v1/latest-news?language=en&apiKey=${process.env.CURRENTS_API_KEY}`));
    return (data.news || []).map(a => ({ title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.published) }));
  } catch(e) { return []; }
}

async function fetchMediaStack(source) {
  try {
    const data = JSON.parse(await fetchUrl(`http://api.mediastack.com/v1/news?access_key=${process.env.MEDIASTACK_API_KEY}&languages=en&limit=100`));
    return (data.data || []).map(a => ({ title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.published_at) }));
  } catch(e) { return []; }
}

async function fetchNewsAPI(source, keywords, fromDateStr, langCodes) {
  const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const articles = [];
  try {
    const data = JSON.parse(await fetchUrl(`https://newsapi.org/v2/top-headlines?language=${lang}&pageSize=100&apiKey=${process.env.NEWSAPI_KEY}`));
    for (const a of (data.articles || [])) {
      if (!a.title || !a.url) continue;
      articles.push({ title: a.title, link: a.url, summary: a.description || '', pubDate: new Date(a.publishedAt) });
    }
  } catch(e) {}
  for (const kw of keywords) {
    const searchText = kw.text.split(',')[0].split('+')[0].split('/')[0].replace(/"/g,'').trim();
    try {
      const data = JSON.parse(await fetchUrl(`https://newsapi.org/v2/everything?q=${encodeURIComponent(searchText)}&language=${lang}&sortBy=publishedAt&from=${fromDateStr}&pageSize=20&apiKey=${process.env.NEWSAPI_KEY}`));
      for (const a of (data.articles || [])) {
        if (!a.title || !a.url) continue;
        articles.push({ title: a.title, link: a.url, summary: a.description || '', keywordID: kw.keywordID || null, pubDate: new Date(a.publishedAt) });
      }
    } catch(e) {}
  }
  return articles;
}

async function fetchRSS(source) {
  try { return parseRSS(await fetchUrl(source.URL)); } catch(e) { return []; }
}

async function fetchPageURL(source) {
  try {
    const html = await fetchUrl(source.URL);
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#039;/g,"'").replace(/&quot;/g,'"').trim()
      : source.Name || source.URL;
    return [{ title, link: source.URL, summary: '', pubDate: new Date() }];
  } catch(e) { return []; }
}

function uploadsPlaylistID(channelID) { return 'UU' + channelID.substring(2); }

function parseISO8601Duration(duration) {
  if (!duration) return null;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1] || 0), m = parseInt(match[2] || 0), s = parseInt(match[3] || 0);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

async function fetchYouTubeDurations(videoIDs, apiKey, context) {
  const durations = {};
  for (let i = 0; i < videoIDs.length; i += 50) {
    const batch = videoIDs.slice(i, i + 50);
    try {
      const data = JSON.parse(await fetchUrl(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${apiKey}`));
      for (const item of (data.items || [])) durations[item.id] = parseISO8601Duration(item.contentDetails?.duration);
    } catch(e) { context.log(`Duration fetch error: ${e.message}`); }
  }
  return durations;
}

// Teams identified by GroupLabel='Teams' — no CategoryID needed
async function fetchYouTube(source, fromDate, isFiltered, keywords, youTubeMaxResults, context, quotaUsed) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const playlistID = uploadsPlaylistID(source.YoutubeChannelID);
  const articles = [];
  let fetched = 0, recencyFiltered = 0;
  try {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistID}&maxResults=50&key=${apiKey}`;
    const data = JSON.parse(await fetchUrl(url));
    quotaUsed.units += 1;
    fetched = data.items?.length || 0;
    context.log(`YouTube [${source.Name}] isFiltered=${isFiltered}: ${fetched} items fetched`);
    for (const item of (data.items || [])) {
      const snippet = item.snippet;
      const videoID = snippet?.resourceId?.videoId;
      if (!videoID) continue;
      const pubDate = new Date(snippet.publishedAt);
      if (pubDate < fromDate) { recencyFiltered++; continue; }
      articles.push({
        title: snippet.title,
        link: `https://www.youtube.com/watch?v=${videoID}`,
        summary: (snippet.description || '').substring(0, 500),
        fullText: (snippet.description || '').substring(0, 2000),
        thumbnailURL: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
        channelName: isFiltered ? snippet.channelTitle : source.Name,
        channelURL: `https://www.youtube.com/channel/${source.YoutubeChannelID}`,
        pubDate
      });
    }
  } catch(e) { context.log(`YouTube error [${source.Name}]: ${e.message}`); }

  if (isFiltered) {
    const matched = [];
    const kwCounts = {};
    const teamsKws = keywords.filter(isTeamsKeyword);
    const otherKws = keywords.filter(kw => !isTeamsKeyword(kw));
    const bySpecificity = arr => [
      ...arr.filter(kw => kw.SourceID && kw.SourceID === source.SourceID),
      ...arr.filter(kw => !kw.SourceID)
    ];
    const orderedKws = [...bySpecificity(teamsKws), ...bySpecificity(otherKws)];
    for (const a of articles) {
      const text = `${a.title} ${a.summary}`.toLowerCase();
      for (const kw of orderedKws) {
        if (kw.SourceID && kw.SourceID !== source.SourceID) continue;
        if (kw.UserOwnedSourceID) continue;
        if (matchesKeyword(text, kw.text)) {
          const key = kw.KeywordID;
          if (!kwCounts[key]) kwCounts[key] = 0;
          if (kwCounts[key] >= youTubeMaxResults) continue;
          kwCounts[key]++;
          a.keywordID = kw.KeywordID;
          if (isTeamsKeyword(kw)) a.teamsOnly = true;
          matched.push(a); break;
        }
      }
    }
    return { articles: matched, fetched, recencyFiltered };
  }
  return { articles, fetched, recencyFiltered };
}

module.exports = async function(context, req) {
  const fetchStart = Date.now();
  const isPreview = req.body?.preview === true;
  try {
    const pool = await sql.connect(config);
    const userID = parseInt(req.body?.userID || req.query?.userID || 1);
    const disableYoutube = req.body?.disableYoutube === true;

    // ── PREVIEW MODE ──
    if (isPreview) {
      const previewSourceType = req.body?.sourceType || 'RSS';
      const previewURL = req.body?.url || '';
      const previewKeyword = req.body?.keyword || '';
      if (!previewURL && previewSourceType !== 'API') {
        context.res = { status: 400, body: JSON.stringify({ error: 'URL is required' }) };
        return;
      }
      let articles = [];
      try {
        if (previewSourceType === 'RSS') {
          articles = await fetchRSS({ URL: previewURL });
        } else if (previewSourceType === 'Youtube') {
          const apiKey = process.env.YOUTUBE_API_KEY;
          const handle = previewURL.split('@')[1]?.split('/')[0];
          if (!handle) throw new Error('Invalid YouTube URL — must contain @ChannelName');
          const chanData = JSON.parse(await fetchUrl(`https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`));
          const channelID = chanData.items?.[0]?.id;
          if (!channelID) throw new Error('YouTube channel not found for @' + handle);
          context._resolvedYoutubeChannelID = channelID;
          const videosData = JSON.parse(await fetchUrl(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelID}&type=video&order=date&maxResults=20&key=${apiKey}`));
          articles = (videosData.items || []).map(item => ({
            title: item.snippet.title,
            link: `https://www.youtube.com/watch?v=${item.id?.videoId}`,
            summary: item.snippet.description?.substring(0, 300) || '',
            pubDate: new Date(item.snippet.publishedAt)
          })).filter(a => a.link.includes('watch?v='));
        } else if (previewSourceType === 'URL') {
          articles = await fetchPageURL({ URL: previewURL, Name: 'URL Preview' });
        } else if (previewSourceType === 'API') {
          if (!previewKeyword) throw new Error('A keyword is required to preview API sources');
          const apiSourcesResult = await pool.request().query(`SELECT * FROM [HeadlineSource] WHERE IsActive = 1 AND SourceType NOT IN ('RSS','YouTube')`);
          const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 7);
          const fromDateStr = fromDate.toISOString().split('T')[0];
          const previewKwArr = [{ text: previewKeyword, keywordID: null }];
          for (const src of apiSourcesResult.recordset) {
            try {
              let srcArticles = [];
              if (src.Name.includes('Guardian'))  srcArticles = await fetchGuardian(src, previewKwArr, fromDateStr);
              else if (src.Name.includes('NewsAPI')) srcArticles = await fetchNewsAPI(src, previewKwArr, fromDateStr, ['en']);
              else if (src.Name.includes('GNews'))   srcArticles = await fetchGNews(src, ['en']);
              if (src.Name.includes('GNews') && previewKeyword) {
                const kw = previewKeyword.toLowerCase();
                srcArticles = srcArticles.filter(a => `${a.title} ${a.summary}`.toLowerCase().includes(kw));
              }
              srcArticles.forEach(a => { a.sourceName = src.Name; });
              articles = articles.concat(srcArticles);
            } catch(e) { context.log(`API preview error for ${src.Name}: ${e.message}`); }
          }
          if (!articles.length) throw new Error('No results found across active API sources for keyword: ' + previewKeyword);
        } else {
          articles = await fetchRSS({ URL: previewURL });
        }
      } catch(e) {
        context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message, articles: [] }) };
        return;
      }
      if (previewKeyword && previewSourceType === 'RSS') {
        articles = articles.filter(a => matchesKeyword(`${a.title} ${a.summary} ${a.fullText||''}`.toLowerCase(), previewKeyword));
      }
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articles: articles.slice(0, 50).map(a => ({ title: a.title, link: a.link, summary: a.summary || '', pubDate: a.pubDate ? new Date(a.pubDate).toISOString() : null })), youtubeChannelID: context._resolvedYoutubeChannelID || null }) };
      return;
    }

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines, YouTubeMaxResults, OtherHeadlinesPerKeyword,
              LastYouTubeFetch, QuotaUsed, QuotaDate
              FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const settings = settingResult.recordset[0] || {};
    const recencyDays = settings.RecencyDays || 7;
    const maxHeadlines = settings.MaxHeadlines || 50;
    const youTubeMaxResults = settings.YouTubeMaxResults || 3;
    const youtubeAlreadyFetched = false;

    const today = new Date().toISOString().split('T')[0];
    const quotaDate = settings.QuotaDate ? new Date(settings.QuotaDate).toISOString().split('T')[0] : null;
    const quotaUsed = { units: quotaDate === today ? (settings.QuotaUsed || 0) : 0 };

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
      .query(`SELECT h.SourceID, h.Name, h.URL, h.SourceType, h.IsActive,
                     h.Sequence, h.YoutubeChannelID, uhs.IsFiltered, uhs.Exclusions, uhs.IsActive AS UserIsActive,
                     uhs.UserMenuID AS SourceUserMenuID
              FROM [HeadlineSource] h
              INNER JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID
              WHERE uhs.UserID = @UserID AND h.IsActive = 1 AND uhs.IsActive = 1
              ORDER BY h.Sequence, h.SourceID`);
    const sources = sourcesResult.recordset;

    function parseExclusions(str) {
      if (!str) return [];
      const terms = [];
      const regex = /"([^"]+)"|([^,]+)/g;
      let m;
      while ((m = regex.exec(str)) !== null) {
        const term = (m[1] || m[2] || '').trim();
        if (term) terms.push(term.toLowerCase());
      }
      return terms;
    }
    function sourceExcludesArticle(source, article) {
      const terms = parseExclusions(source.Exclusions);
      if (!terms.length) return false;
      const text = `${article.title || ''} ${article.summary || ''} ${article.channelName || ''}`.toLowerCase();
      return terms.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    }

    // Keywords — GroupLabel='Teams' identifies teams keywords; no CategoryID
    const kwResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT k.KeywordID, k.Keyword AS text, k.GroupLabel, k.SourceID,
              k.UserOwnedSourceID, k.UserMenuID,
              u.URL AS OwnedSourceURL, u.SourceType AS OwnedSourceType, u.SourceName AS OwnedSourceName
              FROM [HeadlineKeyword] k
              LEFT JOIN [UserOwnedSource] u ON k.UserOwnedSourceID = u.UserOwnedSourceID
              WHERE k.UserID=@UserID AND k.IsActive='Y'`);
    const keywords = kwResult.recordset.map(k => ({ ...k, keywordID: k.KeywordID }));
    const hasActiveKeywords = keywords.length > 0;

    const menuResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT UserMenuID, UserMenuSeq FROM [UserMenu] WHERE UserID=@UserID AND IsInactive=0`);
    const menuSeqMap = {};
    for (const m of menuResult.recordset) menuSeqMap[m.UserMenuID] = m.UserMenuSeq ?? 99;
    const kwMenuMap = {};
    for (const k of keywords) {
      if (k.UserMenuID) kwMenuMap[k.KeywordID] = { userMenuID: k.UserMenuID, menuSeq: menuSeqMap[k.UserMenuID] ?? 99 };
    }

    const existingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT Link FROM [Headline] WHERE UserID=@UserID`);
    const existingLinks = new Set(existingResult.recordset.map(r => r.Link));

    const exclusionResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT Link FROM [HeadlineExclusion] WHERE UserID=@UserID`);
    const exclusionLinks = new Set(exclusionResult.recordset.map(r => r.Link));

    const logSources = {};
    const logErrors = [];
    let totalLangFiltered = 0, totalDuplicates = 0;
    let allArticles = [];
    let youtubeFetched = false;

    // ── MAIN SOURCE LOOP ──
    for (const source of sources) {
      try {
        let articles = [];
        const isFiltered = source.IsFiltered === true || source.IsFiltered === 1;
        const srcLog = { fetched: 0, langFiltered: 0, recencyFiltered: 0, matched: 0, unmatched: [] };
        logSources[source.Name] = srcLog;

        if (source.SourceType === 'Youtube') {
          if (disableYoutube) { srcLog.skipped = 'disabled'; continue; }
          if (youtubeAlreadyFetched) { srcLog.skipped = 'already fetched today'; continue; }
          if (!source.YoutubeChannelID) { srcLog.skipped = 'no channel ID'; continue; }
          const ytResult = await fetchYouTube(source, fromDate, isFiltered, keywords, youTubeMaxResults, context, quotaUsed);
          articles = ytResult.articles;
          srcLog.fetched = ytResult.fetched;
          srcLog.recencyFiltered = ytResult.recencyFiltered;
          const lr = await filterByLanguage(articles, uniqueLangCodes);
          srcLog.langFiltered = lr._langFiltered?.length || 0;
          totalLangFiltered += srcLog.langFiltered;
          articles = lr;
          articles.forEach(a => { a.isSubscription = !isFiltered; });
          youtubeFetched = true;
        } else {
          switch(source.SourceType) {
            case 'API': {
              const nonTeamsKws = keywords.filter(kw =>
                !kw.UserOwnedSourceID &&
                !isTeamsKeyword(kw) &&
                (!kw.SourceID || kw.SourceID === source.SourceID)
              );
              if (source.Name.includes('Guardian'))       articles = await fetchGuardian(source, nonTeamsKws, fromDateStr);
              else if (source.Name.includes('NYT'))        articles = await fetchNYT(source);
              else if (source.Name.includes('GNews'))      articles = await fetchGNews(source, uniqueLangCodes);
              else if (source.Name.includes('Currents'))   articles = await fetchCurrents(source);
              else if (source.Name.includes('MediaStack')) articles = await fetchMediaStack(source);
              else if (source.Name.includes('NewsAPI'))    articles = await fetchNewsAPI(source, nonTeamsKws, fromDateStr, uniqueLangCodes);
              break;
            }
            case 'RSS':  articles = await fetchRSS(source);     break;
            case 'URL':  articles = await fetchPageURL(source);  break;
            default:     articles = await fetchRSS(source);
          }
          srcLog.fetched = articles.length;
          const lr = await filterByLanguage(articles, uniqueLangCodes);
          srcLog.langFiltered = lr._langFiltered?.length || 0;
          totalLangFiltered += srcLog.langFiltered;
          articles = lr;
          const beforeRecency = articles.length;
          articles = articles.filter(a => !a.pubDate || a.pubDate >= fromDate);
          srcLog.recencyFiltered = beforeRecency - articles.length;
          if (isFiltered) {
            articles.forEach(a => { a.sourceID = source.SourceID; });
            const applicableKeywords = keywords.filter(kw => {
              if (kw.UserOwnedSourceID) return false;
              if (isTeamsKeyword(kw)) return kw.SourceID === source.SourceID;
              return !kw.SourceID || kw.SourceID === source.SourceID;
            });
            articles = applyKeywordMatching(articles, applicableKeywords);
            articles = articles.filter(a => a.keywordID);
          } else {
            articles.forEach(a => { a.isSubscription = false; });
          }
        }

        articles = articles.filter(a => !sourceExcludesArticle(source, a));
        articles.forEach(a => {
          a.sourceName = source.Name;
          a.sourceID = source.SourceID;
          a.sourceType = source.SourceType;
          a.sourceUserMenuID = source.SourceUserMenuID || null;
          if (!a.keywordID) a.keywordID = null;
          if (!a.thumbnailURL) a.thumbnailURL = null;
          if (!a.channelName) a.channelName = null;
          if (!a.channelURL) a.channelURL = null;
          if (!a.duration) a.duration = null;
          if (a.isSubscription === undefined) a.isSubscription = false;
        });
        context.log(`Source [${source.Name}]: ${articles.length} articles`);
        allArticles = allArticles.concat(articles);
      } catch(err) {
        context.log(`Error fetching from ${source.Name}: ${err.message}`);
        logErrors.push({ source: source.Name, error: err.message });
        if (logSources[source.Name]) logSources[source.Name].error = err.message;
      }
    }

    // ── FETCH USER-OWNED SOURCES (keyword-linked) ──
    const uosKeywords = keywords.filter(k => k.UserOwnedSourceID && k.OwnedSourceURL);
    const uniqueUOSIDs = [...new Set(uosKeywords.map(k => k.UserOwnedSourceID))];
    for (const uosID of uniqueUOSIDs) {
      const uosKw = uosKeywords.find(k => k.UserOwnedSourceID === uosID);
      if (!uosKw) continue;
      const uosSource = { URL: uosKw.OwnedSourceURL, SourceType: uosKw.OwnedSourceType, Name: uosKw.OwnedSourceName || 'My Source' };
      if (!logSources[uosSource.Name]) logSources[uosSource.Name] = { fetched: 0, langFiltered: 0, recencyFiltered: 0, matched: 0, unmatched: [] };
      try {
        let uosArticles = [];
        if (uosKw.OwnedSourceType === 'File') { srcLog.skipped = 'local file — not fetched server-side'; continue; }
        if (uosKw.OwnedSourceType === 'RSS') uosArticles = await fetchRSS(uosSource);
        else if (uosKw.OwnedSourceType === 'URL') uosArticles = await fetchPageURL(uosSource);
        logSources[uosSource.Name].fetched += uosArticles.length;
        const beforeRecency = uosArticles.length;
        uosArticles = uosArticles.filter(a => !a.pubDate || a.pubDate >= fromDate);
        logSources[uosSource.Name].recencyFiltered += beforeRecency - uosArticles.length;
        const uosSpecificKws = keywords.filter(k => k.UserOwnedSourceID === uosID);
        for (const a of uosArticles) {
          a.userOwnedSourceID = uosID;
          a.sourceName = uosSource.Name;
          a.sourceID = null;
          a.sourceType = uosSource.SourceType;
          a.thumbnailURL = null; a.channelName = null; a.channelURL = null;
          a.duration = null; a.isSubscription = false;
          const text = `${a.title} ${a.summary} ${a.fullText||''}`.toLowerCase();
          for (const kw of uosSpecificKws) {
            if (matchesKeyword(text, kw.text)) {
              a.keywordID = kw.KeywordID;
              if (isTeamsKeyword(kw)) a.teamsOnly = true;
              break;
            }
          }
        }
        const matched = uosArticles.filter(a => a.keywordID);
        logSources[uosSource.Name].matched += matched.length;
        allArticles = allArticles.concat(matched);
        context.log(`UserOwnedSource [${uosSource.Name}]: ${uosArticles.length} fetched, ${matched.length} matched`);
      } catch(err) {
        context.log(`Error fetching UserOwnedSource ${uosSource.Name}: ${err.message}`);
        logErrors.push({ source: uosSource.Name, error: err.message });
        logSources[uosSource.Name].error = err.message;
      }
    }

    if (youtubeFetched) {
      await pool.request().input('UserID', sql.Int, userID)
        .query(`UPDATE [HeadlineSetting] SET LastYouTubeFetch = GETDATE() WHERE UserID = @UserID`);
      const ytArticles = allArticles.filter(a => a.sourceType === 'Youtube');
      const videoIDs = ytArticles.map(a => { const m = a.link?.match(/[?&]v=([^&]+)/); return m ? m[1] : null; }).filter(Boolean);
      if (videoIDs.length) {
        quotaUsed.units += Math.ceil(videoIDs.length / 50);
        const durations = await fetchYouTubeDurations(videoIDs, process.env.YOUTUBE_API_KEY, context);
        ytArticles.forEach(a => { const m = a.link?.match(/[?&]v=([^&]+)/); if (m) a.duration = durations[m[1]] || null; });
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = allArticles.filter(a => {
      if (!a.link || seen.has(a.link) || existingLinks.has(a.link) || exclusionLinks.has(a.link)) return false;
      seen.add(a.link); return true;
    });
    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

    // Selection — no per-category limits
    const placedLinks = new Set();
    const selected = [];

    // Pass 1: Subscriptions (unfiltered, no keyword match)
    for (const a of unique) {
      if (a.isSubscription && !a.keywordID) {
        placedLinks.add(a.link);
        selected.push(a);
      }
    }
    // Pass 2: Teams
    if (hasActiveKeywords) {
      for (const a of unique) {
        if (placedLinks.has(a.link)) continue;
        if (a.teamsOnly) { placedLinks.add(a.link); selected.push(a); }
      }
    }
    // Pass 3: All remaining keyword-matched
    if (hasActiveKeywords) {
      for (const a of unique) {
        if (placedLinks.has(a.link)) continue;
        placedLinks.add(a.link);
        selected.push(a);
      }
    }

    context.log(`unique: ${unique.length}, selected: ${selected.length}`);

    // Build log stats
    const keywordMatchCounts = {};
    const unmatchedBySource = {};
    for (const a of unique) {
      if (a.isSubscription) continue;
      if (a.keywordID) {
        const kw = kwResult.recordset.find(k => k.KeywordID === a.keywordID);
        if (kw) keywordMatchCounts[kw.text] = (keywordMatchCounts[kw.text] || 0) + 1;
      } else if (!a.teamsOnly) {
        const src = a.sourceName || 'Unknown';
        if (!unmatchedBySource[src]) unmatchedBySource[src] = [];
        unmatchedBySource[src].push(a.title);
      }
    }
    const zeroKeywords = kwResult.recordset.filter(k => !keywordMatchCounts[k.text]).map(k => k.text);

    let totalInserted = 0;
    for (const a of selected) {
      try {
        await pool.request()
          .input('UserID', sql.Int, userID)
          .input('HeadlineName', sql.NVarChar(500), (a.title || '').substring(0, 500))
          .input('Link', sql.NVarChar(500), (a.link || '').substring(0, 500))
          .input('Summary', sql.NVarChar(1000), (a.summary || '').substring(0, 1000))
          .input('KeywordID', sql.Int, a.keywordID || null)
          .input('ThumbnailURL', sql.NVarChar(500), a.thumbnailURL || null)
          .input('ChannelName', sql.NVarChar(200), a.channelName || null)
          .input('ChannelURL', sql.NVarChar(500), a.channelURL || null)
          .input('SourceID', sql.Int, a.sourceID || null)
          .input('Duration', sql.VarChar(20), a.duration || null)
          .input('PublishedDate', sql.DateTime, a.pubDate || null)
          .input('UserMenuID', sql.Int, a.keywordID ? (kwMenuMap[a.keywordID]?.userMenuID || null) : (a.sourceUserMenuID || null))
          .input('MenuSeq', sql.SmallInt, a.keywordID ? (kwMenuMap[a.keywordID]?.menuSeq || null) : (a.sourceUserMenuID ? (menuSeqMap[a.sourceUserMenuID] ?? null) : null))
          .query(`INSERT INTO [Headline]
                    (UserID, HeadlineName, Link, Summary, CreatedDate, Retain,
                     KeywordID, ThumbnailURL, ChannelName, ChannelURL, SourceID, Duration, PublishedDate,
                     UserMenuID, MenuSeq)
                  VALUES
                    (@UserID, @HeadlineName, @Link, @Summary, GETDATE(), 'N',
                     @KeywordID, @ThumbnailURL, @ChannelName, @ChannelURL, @SourceID, @Duration, @PublishedDate,
                     @UserMenuID, @MenuSeq)`);
        totalInserted++;
        if (logSources[a.sourceName]) {
          if (a.keywordID) logSources[a.sourceName].matched++;
          else logSources[a.sourceName].unmatched.push(a.title);
        }
      } catch(insertErr) {
        context.log(`Insert error: ${insertErr.message} | title: ${a.title?.substring(0,50)}`);
      }
    }

    const fetchDuration = ((Date.now() - fetchStart) / 1000).toFixed(1);
    const fetchLog = {
      timestamp: new Date().toISOString(),
      durationSeconds: parseFloat(fetchDuration),
      recencyDays,
      totalFetched: allArticles.length,
      totalUnique: unique.length,
      totalInserted,
      totalDuplicates,
      totalLangFiltered,
      youtubeQuotaUsed: quotaUsed.units,
      youtubeQuotaRemaining: Math.max(0, 10000 - quotaUsed.units),
      youtubeSkipped: youtubeAlreadyFetched || disableYoutube,
      errors: logErrors,
      sourceResults: Object.entries(logSources)
        .map(([name, s]) => ({ name, fetched: s.fetched || 0, langFiltered: s.langFiltered || 0, recencyFiltered: s.recencyFiltered || 0, matched: s.matched || 0, skipped: s.skipped || null, error: s.error || null }))
        .sort((a, b) => b.fetched - a.fetched),
      keywordResults: Object.entries(keywordMatchCounts).map(([kw, count]) => ({ keyword: kw, count })).sort((a, b) => b.count - a.count),
      zeroHitKeywords: zeroKeywords,
      unmatchedBySource: Object.entries(unmatchedBySource).sort((a, b) => a[0].localeCompare(b[0])).map(([source, titles]) => ({ source, count: titles.length, titles })),
      gerdesVideos: selected.filter(a => a.sourceID === 34).map(a => ({ title: a.title, pubDate: a.pubDate ? new Date(a.pubDate).toLocaleDateString('en-US') : '—' }))
    };

    // Accumulate global quota across all users and all runs today
    const gqRes = await pool.request()
      .query(`SELECT QuotaUsed, QuotaDate FROM YouTubeQuota WHERE QuotaID=1`);
    const gq = gqRes.recordset[0];
    const todayStr = new Date().toISOString().split('T')[0];
    const gqDate = gq?.QuotaDate ? new Date(gq.QuotaDate).toISOString().split('T')[0] : null;
    const newQuotaUsed = (gqDate === todayStr ? (gq?.QuotaUsed || 0) : 0) + quotaUsed.units;
    const quotaRemaining = Math.max(0, 10000 - newQuotaUsed);

    await pool.request()
      .input('QuotaUsed', sql.Int, newQuotaUsed)
      .input('QuotaDate', sql.Date, new Date())
      .query(`UPDATE YouTubeQuota SET QuotaUsed=@QuotaUsed, QuotaDate=@QuotaDate WHERE QuotaID=1`);

    if (youtubeFetched && quotaRemaining <= 500) {
      await pool.request().input('UserID', sql.Int, userID)
        .query(`UPDATE [HeadlineSetting] SET DisableYoutubeToday=1 WHERE UserID=@UserID`);
      fetchLog.youtubeQuotaAutoDisabled = true;
    }

    await pool.request()
      .input('UserID', sql.Int, userID)
      .input('LastFetchLog', sql.NVarChar(sql.MAX), JSON.stringify(fetchLog))
      .query(`UPDATE [HeadlineSetting] SET LastFetchLog=@LastFetchLog WHERE UserID=@UserID`);

    // Purge exclusions older than recencyDays
    await pool.request()
      .input('UserID', sql.Int, userID)
      .input('RecencyDays', sql.Int, recencyDays||7)
      .query(`DELETE FROM HeadlineExclusion WHERE UserID=@UserID AND DeletedDate < DATEADD(day, -@RecencyDays, GETDATE())`);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true, inserted: totalInserted, duplicates: totalDuplicates,
        sourcesProcessed: sources.length,
        youtubeSkipped: youtubeAlreadyFetched || disableYoutube,
        quotaUsed: quotaUsed.units,
        quotaRemaining: Math.max(0, 10000 - quotaUsed.units)
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};