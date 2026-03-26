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

async function fetchYouTube(source) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channelHandle = source.URL.split('@')[1];
  const articles = [];
  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelHandle)}&type=channel&key=${apiKey}`;
    const searchData = JSON.parse(await fetchUrl(searchUrl));
    const channelID = searchData.items?.[0]?.id?.channelId;
    if (!channelID) return articles;
    const videosUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelID}&type=video&order=date&maxResults=10&key=${apiKey}`;
    const videosData = JSON.parse(await fetchUrl(videosUrl));
    for (const item of (videosData.items || [])) {
      const videoID = item.id?.videoId;
      if (!videoID) continue;
      articles.push({
        title: item.snippet.title,
        link: `https://www.youtube.com/watch?v=${videoID}`,
        summary: item.snippet.description?.substring(0, 500) || '',
        thumbnailURL: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null,
        channelName: item.snippet.channelTitle,
        channelURL: `https://www.youtube.com/channel/${item.snippet.channelId}`,
        pubDate: new Date(item.snippet.publishedAt)
      });
    }
  } catch(e) {}
  return articles;
}

async function aiCategorize(title, summary, categoryNames) {
  try {
    const prompt = `You are a news categorizer. Given this headline and summary, assign it to exactly one of these categories: ${categoryNames.join(', ')}. If none fit well, reply "Other". Reply with only the category name, nothing else.\n\nHeadline: ${title}\nSummary: ${summary || 'none'}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text?.trim() || 'Other';
  } catch(e) {
    return 'Other';
  }
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const userID = 1;

    const settingResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT RecencyDays, MaxHeadlines FROM [HeadlineSetting] WHERE UserID = @UserID`);
    const recencyDays = settingResult.recordset[0]?.RecencyDays || 7;
    const maxHeadlines = settingResult.recordset[0]?.MaxHeadlines || 50;

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - recencyDays);
    const fromDateStr = fromDate.toISOString().split('T')[0];

    const sourcesResult = await pool.request()
      .query(`SELECT * FROM [HeadlineSource] WHERE IsActive = 'Y'`);
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
    for (const source of sources) {
      try {
        let articles = [];
        switch(source.SourceType) {
          case 'Guardian':   articles = await fetchGuardian(source, keywords, topics, fromDateStr); break;
          case 'NYT':        articles = await fetchNYT(source); break;
          case 'GNews':      articles = await fetchGNews(source); break;
          case 'Currents':   articles = await fetchCurrents(source); break;
          case 'MediaStack': articles = await fetchMediaStack(source); break;
          case 'NewsAPI':    articles = await fetchNewsAPI(source); break;
          case 'RSS':        articles = await fetchRSS(source); break;
          case 'YouTube':    articles = await fetchYouTube(source); break;
        }
        articles.forEach(a => {
          a.sourceName = source.Name;
          a.sourceID = source.SourceID;
          if (!a.categoryID) a.categoryID = null;
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

    const seen = new Set();
    const unique = allArticles.filter(a => {
      if (!a.link || seen.has(a.link) || existingLinks.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    const catNamesResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(`SELECT CategoryID, Name FROM [Category] WHERE UserID = @UserID AND IsActive = 'Y' AND Headlines = 'Y'`);
    const categoryNames = catNamesResult.recordset.map(c => c.Name);

    const vocabulary = new Set();
    [...kwResult.recordset, ...tpResult.recordset].forEach(t => {
      t.text.toLowerCase().split(' ')
        .filter(w => w.length > 4)
        .forEach(w => vocabulary.add(w));
    });

    for (const a of unique) {
      if (a.categoryID) continue;
      const text = `${a.title} ${a.summary}`.toLowerCase();
      let matched = false;

      for (const kw of kwResult.recordset) {
        if (text.includes(kw.text.toLowerCase())) {
          a.categoryID = kw.CategoryID;
          a.keywordID = kw.KeywordID;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      for (const kw of kwResult.recordset) {
        const words = kw.text.toLowerCase().split(' ').filter(w => w.length > 4);
        if (words.some(w => text.includes(w))) {
          a.categoryID = kw.CategoryID;
          a.keywordID = kw.KeywordID;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      for (const tp of tpResult.recordset) {
        const words = tp.text.toLowerCase().split(' ').filter(w => w.length > 3);
        const matchCount = words.filter(w => text.includes(w)).length;
        if (matchCount >= Math.ceil(words.length * 0.5)) {
          a.categoryID = tp.CategoryID;
          a.topicID = tp.TopicID;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const titleWords = a.title.toLowerCase().split(' ').filter(w => w.length > 4);
      const hasRecognizable = titleWords.some(w => vocabulary.has(w));
      if (!hasRecognizable) {
        const aiCategory = await aiCategorize(a.title, a.summary, categoryNames);
        if (aiCategory !== 'Other') {
          const cat = catNamesResult.recordset.find(c => c.Name.toLowerCase() === aiCategory.toLowerCase());
          if (cat) a.categoryID = cat.CategoryID;
        }
      }
    }

    unique.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));

    const selected = [];
    const catCounts = {};
    const maxPerCat = Math.ceil(maxHeadlines / 5);

    for (const a of unique) {
      if (selected.length >= maxHeadlines) break;
      const cat = a.categoryID || 'none';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
      if (catCounts[cat] <= maxPerCat) selected.push(a);
    }
    for (const a of unique) {
      if (selected.length >= maxHeadlines) break;
      if (!selected.includes(a)) selected.push(a);
    }

    let totalInserted = 0;
    for (const a of selected) {
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
        .query(`
          INSERT INTO [Headline]
            (UserID, CategoryID, HeadlineName, Link, Summary, CreatedDate, Retain,
             KeywordID, TopicID, ThumbnailURL, ChannelName, ChannelURL)
          VALUES
            (@UserID, @CategoryID, @HeadlineName, @Link, @Summary, GETDATE(), 'N',
             @KeywordID, @TopicID, @ThumbnailURL, @ChannelName, @ChannelURL)
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