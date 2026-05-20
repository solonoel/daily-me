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

async function autoConjugateVerb(pool, userID, wordID, wordsName, languageID) {
  try {
    const langResult = await pool.request()
      .input('LanguageID', sql.Int, languageID)
      .query(`SELECT LanguageNameEng FROM Language WHERE LanguageID=@LanguageID`);
    const langName = langResult.recordset[0]?.LanguageNameEng || 'Spanish';

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

    const moodTenseList = moods.flatMap(m =>
      tenses.map(t => `${m.LanguageMoodEng} / ${t.LanguageTenseEng}`)
    ).join('\n');

    const prompt = `You are a ${langName} conjugation engine.

Conjugate the ${langName} verb "${wordsName}" for every valid mood/tense combination listed below.
Skip any combination that is grammatically invalid or does not exist in ${langName}.

Mood/Tense combinations to attempt:
${moodTenseList}

For each valid combination, return conjugated forms — one per pronoun in this exact order: ${pronounList}
PronounIDs in order: ${pronounIDs}

Also include the English translation for each form (e.g. for "correr": "I run", "you run", "he/she runs", "we run", "you all run", "they run").

Return ONLY a raw JSON array (no markdown, no explanation) in this format:
[
  {
    "mood": "<mood in English>",
    "tense": "<tense in English>",
    "forms": [
      {"pronounID": <number>, "form": "<conjugated form>", "englishForm": "<English translation>"},
      ...
    ]
  },
  ...
]`;

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
    const raw = data.content?.[0]?.text || '[]';
    const results = JSON.parse(raw.replace(/```json|```/g, '').trim());

    for (const combo of results) {
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
  } catch(e) {
    console.error('Auto-conjugate failed:', e.message);
  }
}

module.exports = async function(context, req) {
  try {
    const pool = await sql.connect(config);
    const { action, userID = 1, languageID, wordID, wordsName, wordsTranslation,
            wordsImage, wordsTranslationAudio, isVerb, gender, flag, mastered } = req.body;

    if (action === 'add') {
      // Strip pronouns (el, la, le, il, o, a) from stored words before comparing
      const stripPronoun = w => (w||'').trim().replace(/^(el|la|le|il|los|las|les|un|una|o|a)\s+/i, '').toLowerCase();
      const incoming = stripPronoun(wordsName);
      const existingResult = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .query(`SELECT WordsName FROM [UserLanguageWords] WHERE UserID=@UserID AND LanguageID=@LanguageID`);
      const isDuplicate = existingResult.recordset.some(r => stripPronoun(r.WordsName) === incoming);
      if (isDuplicate) {
        context.res = {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, duplicate: true })
        };
        return;
      }
      const result = await pool.request()
        .input('UserID', sql.Int, userID)
        .input('LanguageID', sql.Int, languageID)
        .input('WordsName', sql.NVarChar(200), wordsName)
        .input('WordsTranslation', sql.NVarChar(1000), wordsTranslation || null)
        .input('WordsTranslationAudio', sql.NVarChar(500), wordsTranslationAudio || null)
        .input('WordsImage', sql.NVarChar(sql.MAX), wordsImage || null)
        .input('IsVerb', sql.Char(1), isVerb ? 'Y' : 'N')
        .input('Gender', sql.Char(1), gender || null)
        .query(`INSERT INTO [UserLanguageWords]
                  (UserID, LanguageID, WordsName, WordsTranslation, WordsTranslationAudio,
                   WordsImage, IsVerb, Gender, DateAdded, Flag, DateMastered)
                VALUES
                  (@UserID, @LanguageID, @WordsName, @WordsTranslation, @WordsTranslationAudio,
                   @WordsImage, @IsVerb, @Gender, GETDATE(), 0, NULL);
                SELECT SCOPE_IDENTITY() AS WordID;`);

      const newWordID = result.recordset[0].WordID;

      if (isVerb) {
        await autoConjugateVerb(pool, userID, newWordID, wordsName, languageID);
      }

      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, wordID: newWordID })
      };

    } else if (action === 'update') {
      const { mastered } = req.body;
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .input('WordsName', sql.NVarChar(200), wordsName)
        .input('WordsTranslation', sql.NVarChar(1000), wordsTranslation || null)
        .input('WordsTranslationAudio', sql.NVarChar(500), wordsTranslationAudio || null)
        .input('WordsImage', sql.NVarChar(sql.MAX), wordsImage || null)
        .input('IsVerb', sql.Char(1), isVerb ? 'Y' : 'N')
        .input('Gender', sql.Char(1), gender || null)
        .input('DateMastered', sql.DateTime, mastered ? new Date() : null)
        .input('SampleSentence1', sql.NVarChar(500), req.body.sampleSentence1 || null)
        .input('SampleSentence2', sql.NVarChar(500), req.body.sampleSentence2 || null)
        .input('SampleSentence3', sql.NVarChar(500), req.body.sampleSentence3 || null)
        .input('EnglishSentence1', sql.NVarChar(500), req.body.englishSentence1 || null)
        .input('EnglishSentence2', sql.NVarChar(500), req.body.englishSentence2 || null)
        .input('EnglishSentence3', sql.NVarChar(500), req.body.englishSentence3 ||  null)
        .query(`UPDATE [UserLanguageWords]
                SET WordsName=@WordsName, WordsTranslation=@WordsTranslation,
                    WordsTranslationAudio=@WordsTranslationAudio, WordsImage=@WordsImage,
                    IsVerb=@IsVerb, Gender=@Gender,
                    DateMastered=CASE WHEN @DateMastered IS NOT NULL THEN @DateMastered
                                      ELSE NULL END,
                    SampleSentence1=COALESCE(@SampleSentence1, SampleSentence1),
                    SampleSentence2=COALESCE(@SampleSentence2, SampleSentence2),
                    SampleSentence3=COALESCE(@SampleSentence3, SampleSentence3),
                    EnglishSentence1=COALESCE(@EnglishSentence1, EnglishSentence1),
                    EnglishSentence2=COALESCE(@EnglishSentence2, EnglishSentence2),
                    EnglishSentence3=COALESCE(@EnglishSentence3, EnglishSentence3)
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'flag') {
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .input('Flag', sql.Bit, flag ? 1 : 0)
        .query(`UPDATE [UserLanguageWords] SET Flag=@Flag
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'mastered') {
      const setMastered = req.body.mastered !== false;
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .query(`UPDATE [UserLanguageWords] SET DateMastered=${setMastered?'GETDATE()':'NULL'}
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };

    } else if (action === 'delete') {
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .query(`DELETE FROM [UserLanguageWordsDeckWords] WHERE UserLanguageWordsID=@WordID`);
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .query(`DELETE FROM [UserVerbConjugation] WHERE UserLanguageWordsID=@WordID`);
      await pool.request()
        .input('WordID', sql.Int, wordID)
        .input('UserID', sql.Int, userID)
        .query(`DELETE FROM [UserLanguageWords]
                WHERE UserLanguageWordsID=@WordID AND UserID=@UserID`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
