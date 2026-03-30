const sql = require('mssql');
const https = require('https');
const http = require('http');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 60000,
    requestTimeout: 60000
  }
};

// Language code mappings
const langCodeMap = {
  'Spanish': 'es', 'French': 'fr', 'Italian': 'it',
  'Portuguese': 'pt', 'Romanian': 'ro', 'English': 'en'
};

// franc language detection - loaded dynamically to handle ESM module
let francDetect = null;
async function detectLang(text) {
  try {
    if (!francDetect) {
      const francModule = await import('franc');
      francDetect = francModule.franc;
    }
    return francDetect(text, { minLength: 20 });
  } catch(e) {
    return 'und'; // undetermined
  }
}

function isAllowedLanguage(text, allowedCodes) {
  if (!text || text.length < 20) return true; // too short to detect, allow
  // Quick ASCII check - if mostly ASCII it's likely English
  const asciiRatio = (text.match(/[\x00-\x7F]/g) || []).length / text.length;
  if (asciiRatio > 0.95 && allowedCodes.includes('en')) return true;
  return true; // Will do async filtering after fetch for now
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

async function fetchGuardian(source, keywords, topics, fromDate, langCodes) {
  const apiKey = process.env.GUARDIAN_API_KEY;
  const articles = [];
  const terms = [...keywords, ...topics];
  const langParam = langCodes.includes('en') ? '' : `&lang=${langCodes[0]}`;
  for (const term of terms) {
    const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(term.text)}&from-date=${fromDate}&show-fields=trailText&order-by=newest&page-size=10${langParam}&api-key=${apiKey}`;
    const data = JSON.parse(await fetchUrl(url));
    if (data.response?.results) {
      for (const a of data.response.results) {
        articles.push({
          title: a.webTitle, link: a.webUrl,
          summary: a.fields?.trailText?.replace(/<[^>]+>/g,'') || '',
          categoryID: term.categoryID, keywordID: term.keywordID || null,
          topicID: term.topicID || null, pubDate: new Date(a.webPublicationDate)
        });
      }
    }
  }
  return articles;
}

async function fetchNYT(source) {
  const apiKey = process.env.NYT_API_KEY;
  const url = `https://api.nytimes.com/svc/topstories/v2/home.json?api-key=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.results || []).map(a => ({
    title: a.title, link: a.url,
    summary: a.abstract || '', pubDate: new Date(a.published_date)
  }));
}

async function fetchGNews(source, langCodes) {
  const apiKey = process.env.GNEWS_API_KEY;
  const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const url = `https://gnews.io/api/v4/top-headlines?lang=${lang}&max=20&apikey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.articles || []).map(a => ({
    title: a.title, link: a.url,
    summary: a.description || '', pubDate: new Date(a.publishedAt)
  }));
}

async function fetchCurrents(source) {
  const apiKey = process.env.CURRENTS_API_KEY;
  const url = `https://api.currentsapi.services/v1/latest-news?language=en&apiKey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.news || []).map(a => ({
    title: a.title, link: a.url,
    summary: a.description || '', pubDate: new Date(a.published)
  }));
}

async function fetchMediaStack(source) {
  const apiKey = process.env.MEDIASTACK_API_KEY;
  const url = `http://api.mediastack.com/v1/news?access_key=${apiKey}&languages=en&limit=20`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.data || []).map(a => ({
    title: a.title, link: a.url,
    summary: a.description || '', pubDate: new Date(a.published_at)
  }));
}

async function fetchNewsAPI(source, langCodes) {
  const apiKey = process.env.NEWSAPI_KEY;
  const lang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  const url = `https://newsapi.org/v2/top-headlines?language=${lang}&pageSize=20&apiKey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.articles || []).map(a => ({
    title: a.title, link: a.url,
    summary: a.description || '', pubDate: new Date(a.publishedAt)
  }));
}

async function fetchRSS(source) {
  const xml = await fetchUrl(source.URL);
  return parseRSS(xml);
}

async function fetchYouTube(source, keywords, maxResults, langCodes, context) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const articles = [];
  const relevanceLang = langCodes.includes('en') ? 'en' : langCodes[0] || 'en';
  context.log(`YouTube: ${keywords.length} keywords, maxResults: ${maxResults}, lang: ${relevanceLang}`);
  for (const term of keywords) {
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(term.text)}&type=video&order=date&maxResults=${maxResults}&relevanceLanguage=${relevanceLang}&key=${apiKey}`;
      const searchData = JSON.parse(await fetchUrl(searchUrl));
      context.log(`YouTube term "${term.text}": ${searchData.items?.length || 0} results, error: ${JSON.stringify(searchData.error || null)}`);
      for (const item of (searchData.items || [])) {
        const videoID = item.id?.videoId;
        if (!videoID) continue;
        articles.push({
          title: item.snippet.title,
          link: `https://www.youtube.com/watch?v=${videoID}`,
          summary: item.snippet.description?.substring(0, 500) || '',
          thumbnailURL: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
          channelName: item.snippet.channelTitle,
          channelURL: `https://www.youtube.com/channel/${item.snippet.channelId}`,
          categoryID: term.categoryID, keywordID: term.keywordID || null,
          topicID: term.topicID || null, pubDate: new Date(item.snippet.publishedAt)
        });
      }
    } catch(e) {
      context.log(`YouTube fetch error for term "${term.text}": ${e.message}`);
    }
  }
  return articles;
}

function containsCJK(text) {
  // Detect Chinese, Japanese, Korean characters
  return /[\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
}

function containsArabicOrHebrew(text) {
  return /[\u0600-\u06FF\u0590-\u05FF]/.test(text);
}

function containsCyrillic(text) {
  return /[\u0400-\u04FF]/.test(text);
}

async function filterByLanguage(articles, allowedCodes) {
  const filtered = [];
  for (const a of articles) {
    const text = `${a.title || ''} ${a.summary || ''}`.trim();

    // Hard block CJK unless user has a CJK language (none currently supported)
    if (containsCJK(text)) continue;

    // Hard block Arabic/Hebrew unless user has those languages
    if (containsArabicOrHebrew(text)) continue;

    // Hard block Cyrillic unless user explicitly has Russian etc.
    if (containsCyrillic(text) && !allowedCodes.includes('ru') && !allowedCodes.includes('uk')) continue;

    if (text.length < 20) { filtered.push(a); continue; }

    const detected = await detectLang(text);
    const iso3to2 = { 'eng':'en','spa':'es','fra':'fr','ita':'it','por':'pt','ron':'ro','und':'en','zho':'zh','jpn':'ja','kor':'ko' };
    const detected2 = iso3to2[detected] || detected.substring(0,2);

    // If franc detects a language not in user's list, block it
    // But allow 'und' (undetermined) through since it's usually short English text
    if (detected === 'und' || allowedCodes.includes(detected2)) {
      filtered.push(a);
    }
  }
  return filtered;
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = req.body?.userID || req.query?.userID || 1;

    // Get settings including LastYouTubeFetch
    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines, YouTubeMaxResults, LastYouTubeFetch FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const recencyDays = settingResult.recordset[0]?.RecencyDays || 7;
    const maxHeadlines = settingResult.recordset[0]?.MaxHeadlines || 50;
    const youTubeMaxResults = settingResult.recordset[0]?.YouTubeMaxResults || 3;
    const lastYouTubeFetch = settingResult.recordset[0]?.LastYouTubeFetch;

    // Check if YouTube was already fetched today
    const today = new Date().toISOString().split('T')[0];
    const lastFetchDate = lastYouTubeFetch ? new Date(lastYouTubeFetch).toISOString().split('T')[0] : null;
    const youtubeAlreadyFetched = lastFetchDate === today;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - recencyDays);
    const fromDateStr = fromDate.toISOString().split('T')[0];

    // Get user's active languages
    const langResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT l.LanguageNameEng FROM UserLanguage ul
              JOIN Language l ON l.LanguageID = ul.LanguageID
              WHERE ul.UserID = @UserID AND ul.IsActive = 'Y'`);
    const userLangCodes = ['en', ...langResult.recordset.map(r => langCodeMap[r.LanguageNameEng] || 'en')];
    const uniqueLangCodes = [...new Set(userLangCodes)];

    const sourcesResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT h.* FROM [HeadlineSource] h
              INNER JOIN [UserHeadlineSource] uhs ON h.SourceID = uhs.SourceID
              WHERE uhs.UserID = @UserID AND h.IsActive = 'Y'`);
    const sources = sourcesResult.recordset;

    const kwResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT k.KeywordID, k.Keyword AS text, k.CategoryID FROM [HeadlineKeyword] k WHERE k.UserID = @UserID AND k.IsActive = 'Y'`);
    const tpResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT t.TopicID, t.Topic AS text, t.CategoryID FROM [HeadlineTopic] t WHERE t.UserID = @UserID AND t.IsActive = 'Y'`);

    const keywords = kwResult.recordset.map(k => ({ ...k, keywordID: k.KeywordID, topicID: null }));
    const topics = tpResult.recordset.map(t => ({ ...t, keywordID: null, topicID: t.TopicID }));

    const existingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT Link FROM [Headline] WHERE UserID = @UserID`);
    const existingLinks = new Set(existingResult.recordset.map(r => r.Link));

    let allArticles = [];
    let youtubeFetched = false;

    for (const source of sources) {
      try {
        let articles = [];
        switch(source.SourceType) {
          case 'Guardian':   articles = await fetchGuardian(source, keywords, topics, fromDateStr, uniqueLangCodes); break;
          case 'NYT':        articles = await fetchNYT(source); break;
          case 'GNews':      articles = await fetchGNews(source, uniqueLangCodes); break;
          case 'Currents':   articles = await fetchCurrents(source); break;
          case 'MediaStack': articles = await fetchMediaStack(source); break;
          case 'NewsAPI':    articles = await fetchNewsAPI(source, uniqueLangCodes); break;
          case 'RSS':        articles = await fetchRSS(source); break;
          case 'YouTube':
            if (youtubeAlreadyFetched) {
              context.log(`YouTube skipped — already fetched today`);
              continue;
            }
            articles = await fetchYouTube(source, keywords, youTubeMaxResults, uniqueLangCodes, context);
            articles = await filterByLanguage(articles, uniqueLangCodes);
            youtubeFetched = true;
            break;
        }

        // Post-filter by language for RSS sources
        if (source.SourceType === 'RSS') {
          articles = await filterByLanguage(articles, uniqueLangCodes);
        }

        articles.forEach(a => {
          a.sourceName = source.Name;
          a.sourceID = source.SourceID;
          if (!a.categoryID) a.categoryID = source.CategoryID || null;
          if (!a.keywordID) a.keywordID = null;
          if (!a.topicID) a.topicID = null;
          if (!a.thumbnailURL) a.thumbnailURL = null;
          if (!a.channelName) a.channelName = null;
          if (!a.channelURL) a.channelURL = null;
        });
        allArticles = allArticles.concat(articles);
      } catch(err) {
        context.log(`Error fetching from ${source.Name}: ${err.message}`);
      }
    }

    // Update LastYouTubeFetch if YouTube was fetched
    if (youtubeFetched) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .query(`UPDATE [HeadlineSetting] SET LastYouTubeFetch = GETDATE() WHERE UserID = @UserID`);
    }

    const seen = new Set();
    const unique = allArticles.filter(a => {
      if (!a.link || seen.has(a.link) || existingLinks.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    const catNamesResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT CategoryID, Name FROM [Category] WHERE UserID = @UserID AND IsActive = 'Y' AND Headlines = 'Y'`);

    for (const a of unique) {
      if (a.categoryID) continue;
      const text = `${a.title} ${a.summary}`.toLowerCase();
      let matched = false;
      for (const kw of kwResult.recordset) {
        const escaped = kw.text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(text)) {
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
          matched = true; break;
        }
      }
    }

    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

    const catLimitsResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT CategoryID, MaxItems FROM [UserCategorySetting] WHERE UserID = @UserID`);
    const catLimits = {};
    catLimitsResult.recordset.forEach(r => catLimits[r.CategoryID] = r.MaxItems);
    const numCats = catNamesResult.recordset.length || 5;
    const defaultPerCat = Math.ceil(maxHeadlines / numCats);

    const selected = [];
    const catCounts = {};
    for (const a of unique) {
      const cat = a.categoryID !== null && a.categoryID !== undefined ? a.categoryID : 'none';
      if (!(cat in catCounts)) catCounts[cat] = 0;
      if (cat === 'none') {
        selected.push(a);
      } else {
        const limit = catLimits[cat] || defaultPerCat;
        if (catCounts[cat] < limit) { selected.push(a); catCounts[cat]++; }
      }
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
          .query(`INSERT INTO [Headline]
                    (UserID, CategoryID, HeadlineName, Link, Summary, CreatedDate, Retain,
                     KeywordID, TopicID, ThumbnailURL, ChannelName, ChannelURL, SourceID)
                  VALUES
                    (@UserID, @CategoryID, @HeadlineName, @Link, @Summary, GETDATE(), 'N',
                     @KeywordID, @TopicID, @ThumbnailURL, @ChannelName, @ChannelURL, @SourceID)`);
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
