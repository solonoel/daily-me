const sql = require('mssql');
const https = require('https');
const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

function fetchUrl(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function generateAllConjugations(pool, userID, wordID, wordsName, languageID, langName) {
  const moodsResult = await pool.request()
    .input('LanguageID', sql.Int, languageID)
    .query(`SELECT LanguageMoodID, LanguageMoodEng FROM LanguageMood WHERE LanguageID=@LanguageID ORDER BY LanguageMoodID`);
  const tensesResult = await pool.request()
    .input('LanguageID', sql.Int, languageID)
    .query(`SELECT LanguageTenseID, LanguageTenseEng FROM LanguageTense WHERE LanguageID=@LanguageID ORDER BY LanguageTenseID`);
  const pronounsResult = await pool.request()
    .input('LanguageID', sql.Int, languageID)
    .query(`SELECT PronounID, PronounName FROM LanguagePronoun WHERE LanguageID=@LanguageID ORDER BY PronounID`);

  const moods = moodsResult.recordset;
  const tenses = tensesResult.recordset;
  const pronouns = pronounsResult.recordset;
  const pronounList = pronouns.map(p => p.PronounName).join(', ');
  const pronounIDs = pronouns.map(p => p.PronounID).join(', ');
  const moodTenseList = moods.flatMap(m => tenses.map(t => `${m.LanguageMoodEng} / ${t.LanguageTenseEng}`)).join('\n');

  const prompt = `You are a ${langName} conjugation engine.

Conjugate the ${langName} verb "${wordsName}" for every valid mood/tense combination listed below.
Skip any combination that is grammatically invalid or does not exist in ${langName}.

Mood/Tense combinations to attempt:
${moodTenseList}

For each valid combination, return conjugated forms — one per pronoun in this exact order: ${pronounList}
PronounIDs in order: ${pronounIDs}

Also return the present participle (gerund) and past participle for this verb.

Return ONLY a raw JSON object (no markdown, no explanation) in this format:
{
  "presentParticiple": "<present participle form>",
  "pastParticiple": "<past participle form>",
  "conjugations": [
    {
      "mood": "<mood in English>",
      "tense": "<tense in English>",
      "forms": [
        {"pronounID": <number>, "form": "<conjugated form>", "englishForm": "<English translation e.g. I run, you run>"},
        ...
      ]
    },
    ...
  ]
}`;

  const anthropicBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(anthropicBody)
    }
  };

  const response = await fetchUrl('https://api.anthropic.com/v1/messages', options, anthropicBody);
  const data = JSON.parse(response);
  const raw = data.content?.[0]?.text || '{}';
  const result = JSON.parse(raw.replace(/```json|```/g, '').trim());

  const conjugations = result.conjugations || [];
  const presentParticiple = result.presentParticiple || null;
  const pastParticiple = result.pastParticiple || null;

  // Save conjugations
  await pool.request()
    .input('UserID', sql.Int, userID)
    .input('WordID', sql.Int, wordID)
    .query(`DELETE FROM UserVerbConjugation WHERE UserID=@UserID AND UserLanguageWordsID=@WordID`);

  for (const combo of conjugations) {
    const mood = moods.find(m => m.LanguageMoodEng === combo.mood);
    const tense = tenses.find(t => t.LanguageTenseEng === combo.tense);
    if (!mood || !tense) continue;
    for (const form of combo.forms) {
      await pool.request()
        .input('UserID', sql.Int, userID)
        .input('WordID', sql.Int, wordID)
        .input('MoodID', sql.Int, mood.LanguageMoodID)
        .input('TenseID', sql.Int, tense.LanguageTenseID)
        .input('PronounID', sql.Int, form.pronounID)
        .input('Form', sql.NVarChar(200), form.form)
        .input('EnglishForm', sql.NVarChar(200), form.englishForm || null)
        .query(`INSERT INTO UserVerbConjugation
                (UserID, UserLanguageWordsID, LanguageMoodID, LanguageTenseID, PronounID, ConjugatedForm, EnglishForm, CreatedDate)
                VALUES (@UserID, @WordID, @MoodID, @TenseID, @PronounID, @Form, @EnglishForm, GETDATE())`);
    }
  }

  // Save participles
  if (presentParticiple || pastParticiple) {
    await pool.request()
      .input('UserID', sql.Int, userID)
      .input('WordID', sql.Int, wordID)
      .input('PresentParticiple', sql.NVarChar(200), presentParticiple)
      .input('PastParticiple', sql.NVarChar(200), pastParticiple)
      .query(`MERGE UserVerbParticiple AS target
              USING (SELECT @UserID AS UserID, @WordID AS UserLanguageWordsID) AS source
              ON target.UserID = source.UserID AND target.UserLanguageWordsID = source.UserLanguageWordsID
              WHEN MATCHED THEN UPDATE SET PresentParticiple=@PresentParticiple, PastParticiple=@PastParticiple
              WHEN NOT MATCHED THEN INSERT (UserID, UserLanguageWordsID, PresentParticiple, PastParticiple)
                VALUES (@UserID, @WordID, @PresentParticiple, @PastParticiple);`);
  }

  return { presentParticiple, pastParticiple };
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { userID = 1, userLanguageWordsID, regenerate } = req.body;

    const wordResult = await pool.request()
      .input('WordID', sql.Int, userLanguageWordsID)
      .input('UserID', sql.Int, userID)
      .query(`SELECT w.WordsName, l.LanguageNameEng, w.LanguageID
              FROM UserLanguageWords w
              JOIN Language l ON l.LanguageID = w.LanguageID
              WHERE w.UserLanguageWordsID = @WordID AND w.UserID = @UserID`);

    if (!wordResult.recordset.length) {
      context.res = { status: 404, body: 'Word not found' }; return;
    }

    const { WordsName, LanguageNameEng, LanguageID } = wordResult.recordset[0];

    const cacheCheck = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('WordID', sql.Int, userLanguageWordsID)
      .query(`SELECT COUNT(*) AS cnt FROM UserVerbConjugation WHERE UserID=@UserID AND UserLanguageWordsID=@WordID`);

    const hasCached = cacheCheck.recordset[0].cnt > 0;

    let presentParticiple = null, pastParticiple = null;

    if (!hasCached || regenerate) {
      const participles = await generateAllConjugations(pool, userID, userLanguageWordsID, WordsName, LanguageID, LanguageNameEng);
      presentParticiple = participles.presentParticiple;
      pastParticiple = participles.pastParticiple;
    } else {
      // Load participles from cache
      const partResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('WordID', sql.Int, userLanguageWordsID)
        .query(`SELECT PresentParticiple, PastParticiple FROM UserVerbParticiple
                WHERE UserID=@UserID AND UserLanguageWordsID=@WordID`);
      if (partResult.recordset.length) {
        presentParticiple = partResult.recordset[0].PresentParticiple;
        pastParticiple = partResult.recordset[0].PastParticiple;
      }
    }

    const allResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .input('WordID', sql.Int, userLanguageWordsID)
      .query(`SELECT
                m.LanguageMoodID, m.LanguageMoodName, m.LanguageMoodEng,
                t.LanguageTenseID, t.LanguageTenseName, t.LanguageTenseEng,
                p.PronounID, p.PronounName, p.PronounEng,
                c.ConjugatedForm, c.EnglishForm
              FROM UserVerbConjugation c
              JOIN LanguageMood m ON m.LanguageMoodID = c.LanguageMoodID
              JOIN LanguageTense t ON t.LanguageTenseID = c.LanguageTenseID
              JOIN LanguagePronoun p ON p.PronounID = c.PronounID
              WHERE c.UserID=@UserID AND c.UserLanguageWordsID=@WordID
              ORDER BY m.LanguageMoodID, t.LanguageTenseID, p.PronounID`);

    const moodsMap = {};
    for (const row of allResult.recordset) {
      if (!moodsMap[row.LanguageMoodID]) {
        moodsMap[row.LanguageMoodID] = {
          moodID: row.LanguageMoodID, moodName: row.LanguageMoodName, moodEng: row.LanguageMoodEng, tenses: {}
        };
      }
      const mood = moodsMap[row.LanguageMoodID];
      if (!mood.tenses[row.LanguageTenseID]) {
        mood.tenses[row.LanguageTenseID] = {
          tenseID: row.LanguageTenseID, tenseName: row.LanguageTenseName, tenseEng: row.LanguageTenseEng, forms: []
        };
      }
      mood.tenses[row.LanguageTenseID].forms.push({
        pronounID: row.PronounID, pronounName: row.PronounName, pronounEng: row.PronounEng, form: row.ConjugatedForm, englishForm: row.EnglishForm || null
      });
    }

    const moodsArr = Object.values(moodsMap).map(m => ({ ...m, tenses: Object.values(m.tenses) }));

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true, verb: WordsName, language: LanguageNameEng,
        fromCache: hasCached && !regenerate,
        presentParticiple, pastParticiple,
        moods: moodsArr
      })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};