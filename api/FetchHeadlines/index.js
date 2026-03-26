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

// Generic HTTP fetch helper
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

// Parse RSS XML into articles array
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

// Source handlers
async function fetchGuardian(source, keywords, topics, fromDate) {
  const apiKey = process.env.GUARDIAN_API_KEY;
  const articles = [];
  const terms = [...keywords, ...topics];
  for (const term of terms) {
    const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(term.text)}&from-date=${fromDate}&show-fields=trailText&order-by=newest&page-size=10&api-key=${apiKey}`;
    const data = JSON.parse(await fetchUrl(url));
    if (data.response?.results) {
      for (const a of data.response.results) {
        articles.push({
          title: a.webTitle,
          link: a.webUrl,
          summary: a.fields?.trailText?.replace(/<[^>]+>/g,'') || '',
          categoryID: term.categoryID,
          keywordID: term.keywordID || null,
          topicID: term.topicID || null,
          pubDate: new Date(a.webPublicationDate)
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
    title: a.title,
    link: a.url,
    summary: a.abstract || '',
    pubDate: new Date(a.published_date)
  }));
}

async function fetchGNews(source) {
  const apiKey = process.env.GNEWS_API_KEY;
  const url = `https://gnews.io/api/v4/top-headlines?lang=en&max=20&apikey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.articles || []).map(a => ({
    title: a.title,
    link: a.url,
    summary: a.description || '',
    pubDate: new Date(a.publishedAt)
  }));
}

async function fetchCurrents(source) {
  const apiKey = process.env.CURRENTS_API_KEY;
  const url = `https://api.currentsapi.services/v1/latest-news?language=en&apiKey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.news || []).map(a => ({
    title: a.title,
    link: a.url,
    summary: a.description || '',
    pubDate: new Date(a.published)
  }));
}

async function fetchMediaStack(source) {
  const apiKey = process.env.MEDIASTACK_API_KEY;
  const url = `http://api.mediastack.com/v1/news?access_key=${apiKey}&languages=en&limit=20`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.data || []).map(a => ({
    title: a.title,
    link: a.url,
    summary: a.description || '',
    pubDate: new Date(a.published_at)
  }));
}

async function fetchNewsAPI(source) {
  const apiKey = process.env.NEWSAPI_KEY;
  const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=20&apiKey=${apiKey}`;
  const data = JSON.parse(await fetchUrl(url));
  return (data.articles || []).map(a => ({
    title: a.title,
    link: a.url,
    summary: a.description || '',
    pubDate: new Date(a.publishedAt)
  }));
}

async function fetchRSS(source) {
  const xml = await fetchUrl(source.URL);
  return parseRSS(xml);
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = 1;

    // Get settings
    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const recencyDays = settingResult.recordset[0]?.RecencyDays || 7;
    const maxHeadlines = settingResult.recordset[0]?.MaxHeadlines || 50;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - recencyDays);
    const fromDateStr = fromDate.toISOString().split('T')[0];

    // Get active sources
    const sourcesResult = await pool.request()
      .query(`SELECT * FROM [HeadlineSource] WHERE IsActive = 'Y'`);
    const sources = sourcesResult.recordset;

    // Get keywords and topics for Guardian/search-based sources
    const kwResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT k.KeywordID, k.Keyword AS text, k.CategoryID, 'keyword' AS termType FROM [HeadlineKeyword] k WHERE k.UserID = @UserID AND k.IsActive = 'Y'`);
    const tpResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT t.TopicID, t.Topic AS text, t.CategoryID, 'topic' AS termType FROM [HeadlineTopic] t WHERE t.UserID = @UserID AND t.IsActive = 'Y'`);

    const keywords = kwResult.recordset.map(k => ({ ...k, keywordID: k.KeywordID, topicID: null }));
    const topics = tpResult.recordset.map(t => ({ ...t, keywordID: null, topicID: t.TopicID }));

    // Get existing links to deduplicate
    const existingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT Link FROM [Headline] WHERE UserID = @UserID`);
    const existingLinks = new Set(existingResult.recordset.map(r => r.Link));

    // Fetch from all sources
    let allArticles = [];

    for (const source of sources) {
      try {
        let articles = [];
        switch(source.SourceType) {
          case 'Guardian':  articles = await fetchGuardian(source, keywords, topics, fromDateStr); break;
          case 'NYT':       articles = await fetchNYT(source); break;
          case 'GNews':     articles = await fetchGNews(source); break;
          case 'Currents':  articles = await fetchCurrents(source); break;
          case 'MediaStack':articles = await fetchMediaStack(source); break;
          case 'NewsAPI':   articles = await fetchNewsAPI(source); break;
          case 'RSS':       articles = await fetchRSS(source); break;
        }
        // Tag with source info
        articles.forEach(a => {
          a.sourceName = source.Name;
          a.sourceID = source.SourceID;
          if (!a.categoryID) a.categoryID = null;
          if (!a.keywordID) a.keywordID = null;
          if (!a.topicID) a.topicID = null;
        });
        allArticles = allArticles.concat(articles);
      } catch(err) {
        context.log(`Error fetching from ${source.Name}: ${err.message}`);
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    const unique = allArticles.filter(a => {
      if (!a.link || seen.has(a.link) || existingLinks.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    // Sort by date descending
    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

    // Apply MaxHeadlines limit with category spread
    const selected = [];
    const catCounts = {};
    const maxPerCat = Math.ceil(maxHeadlines / 5);

    // First pass — spread across categories
    for (const a of unique) {
      if (selected.length >= maxHeadlines) break;
      const cat = a.categoryID || 'none';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
      if (catCounts[cat] <= maxPerCat) selected.push(a);
    }

    // Second pass — fill remaining slots
    for (const a of unique) {
      if (selected.length >= maxHeadlines) break;
      if (!selected.includes(a)) selected.push(a);
    }

    // Insert into database
    let totalInserted = 0;
    for (const a of selected) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('CategoryID', sql.Int, a.categoryID)
        .input('HeadlineName', sql.NVarChar(500), (a.title || '').substring(0, 500))
        .input('Link', sql.NVarChar(500), (a.link || '').substring(0, 500))
        .input('Summary', sql.NVarChar(1000), (a.summary || '').substring(0, 1000))
        .input('KeywordID', sql.Int, a.keywordID)
        .input('TopicID', sql.Int, a.topicID)
        .query(`
          INSERT INTO [Headline]
            (UserID, CategoryID, HeadlineName, Link, Summary, CreatedDate, Retain, KeywordID, TopicID)
          VALUES
            (@UserID, @CategoryID, @HeadlineName, @Link, @Summary, GETDATE(), 'N', @KeywordID, @TopicID)
        `);
      totalInserted++;
    }

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        inserted: totalInserted,
        duplicates: allArticles.length - unique.length,
        sourcesProcessed: sources.length
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};