const sql = require('mssql');
const https = require('https');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
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
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Anthropic response parse error: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractJSON(raw) {
  const attempts = [
    () => JSON.parse(raw.replace(/```json|```/g, '').trim()),
    () => JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]),
    () => JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  ];
  for (const attempt of attempts) {
    try { const r = attempt(); if (r && typeof r === 'object') return r; } catch(e) {}
  }
  return null;
}

function validateGenerated(g) {
  const warnings = [];
  if (!g.usage || typeof g.usage !== 'string' || g.usage.trim().length < 10) {
    warnings.push('usage is missing or too short');
    g.usage = g.usage || '';
  }
  if (!Array.isArray(g.tips) || g.tips.length === 0) {
    warnings.push('tips array is missing or empty');
    g.tips = [];
  }
  if (!Array.isArray(g.verbGroups) || g.verbGroups.length === 0) {
    warnings.push('verbGroups array is missing or empty');
    g.verbGroups = [];
  } else {
    g.verbGroups = g.verbGroups.filter((vg, i) => {
      if (!vg.group || !vg.example || !Array.isArray(vg.endings) || vg.endings.length === 0) {
        warnings.push(`verbGroups[${i}] ("${vg.group||'?'}") is malformed and was excluded`);
        return false;
      }
      return true;
    });
  }
  if (!Array.isArray(g.irregulars)) {
    g.irregulars = [];
  } else {
    g.irregulars = g.irregulars.filter((ir, i) => {
      if (!ir.verb || !ir.forms) {
        warnings.push(`irregulars[${i}] is malformed and was excluded`);
        return false;
      }
      return true;
    });
  }
  if (!Array.isArray(g.examples)) {
    g.examples = [];
  } else {
    g.examples = g.examples.filter((ex, i) => {
      if (!ex.sentence || !ex.translation) {
        warnings.push(`examples[${i}] is malformed and was excluded`);
        return false;
      }
      return true;
    });
  }
  return warnings;
}

module.exports = async function(context, req) {
  try {
    const { language, moodEng, moodName, tenseEng, tenseName } = req.body;
    if (!language || !moodEng || !tenseEng) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'language, moodEng, tenseEng required' }) };
      return;
    }

    context.log(`GetConjugationTips: ${language} / ${moodEng} / ${tenseEng}`);

    const pool = await sql.connect(config);

    // 1. Resolve LanguageID
    const langResult = await pool.request()
      .input('LanguageNameEng', sql.NVarChar(100), language)
      .query(`SELECT LanguageID FROM Language WHERE LanguageNameEng = @LanguageNameEng`);
    if (!langResult.recordset.length) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Unknown language: ${language}` }) };
      return;
    }
    const languageID = langResult.recordset[0].LanguageID;

    // 2. Check DB for existing tips
    const existing = await pool.request()
      .input('LanguageID', sql.Int, languageID)
      .input('MoodEng',    sql.NVarChar(100), moodEng)
      .input('TenseEng',   sql.NVarChar(100), tenseEng)
      .query(`SELECT LanguageVerbTipsID, Usage, ExamplesJSON
              FROM LanguageVerbTips
              WHERE LanguageID=@LanguageID AND MoodEng=@MoodEng AND TenseEng=@TenseEng`);

    if (existing.recordset.length > 0) {
      context.log(`Found existing tips for ${moodEng}/${tenseEng}, loading from DB`);
      const row = existing.recordset[0];
      const tips = await loadTipsFromDB(pool, row.LanguageVerbTipsID, row);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, tips }) };
      return;
    }

    // 3. Generate via Anthropic
    context.log(`Generating tips via Anthropic for ${moodEng}/${tenseEng}`);
    const prompt = `You are a ${language} language teacher. Generate conjugation tips for the ${moodEng} mood, ${tenseEng} tense (${language} name: ${moodName} / ${tenseName}).

Return ONLY valid JSON with this exact structure, no markdown, no extra text:
{
  "usage": "One paragraph explaining when and how this tense/mood is used.",
  "tips": ["tip 1", "tip 2", "tip 3"],
  "verbGroups": [
    {
      "group": "-AR verbs",
      "example": "hablar",
      "endings": [
        {"pronoun":"yo","ending":"..."},
        {"pronoun":"tu","ending":"..."},
        {"pronoun":"el/ella/usted","ending":"..."},
        {"pronoun":"nosotros","ending":"..."},
        {"pronoun":"vosotros","ending":"..."},
        {"pronoun":"ellos/ellas/ustedes","ending":"..."}
      ]
    }
  ],
  "irregulars": [
    { "verb": "ser/ir", "forms": "fui, fuiste, fue...", "note": "optional note" }
  ],
  "examples": [
    { "sentence": "Example sentence in ${language}.", "translation": "English translation." }
  ]
}
Fill in the actual correct endings and content for ${moodEng} ${tenseEng} in ${language}.`;

    let anthropicResponse;
    try {
      anthropicResponse = await callAnthropic(prompt);
    } catch(anthropicErr) {
      context.log('Anthropic call failed:', anthropicErr.message);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Anthropic API call failed: ' + anthropicErr.message }) };
      return;
    }

    context.log('Anthropic response type:', anthropicResponse.type, '| stop_reason:', anthropicResponse.stop_reason);

    if (anthropicResponse.error) {
      context.log('Anthropic returned error:', JSON.stringify(anthropicResponse.error));
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Anthropic error: ' + (anthropicResponse.error.message || JSON.stringify(anthropicResponse.error)) }) };
      return;
    }

    const raw = anthropicResponse.content?.[0]?.text || '';
    context.log('Raw response (first 400):', raw.slice(0, 400));

    if (!raw) {
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Anthropic returned empty response' }) };
      return;
    }

    const generated = extractJSON(raw);
    if (!generated) {
      context.log('JSON extraction failed. Full raw:', raw);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not parse Anthropic response as JSON. Raw: ' + raw.slice(0, 200) }) };
      return;
    }

    // 4. Validate and clean
    const warnings = validateGenerated(generated);
    if (warnings.length > 0) context.log('Validation warnings:', warnings.join('; '));

    // 5. Save to DB (only if we have at least usage)
    let tipsID = null;
    if (generated.usage) {
      try {
        const examplesJSON = generated.examples?.length ? JSON.stringify(generated.examples) : null;
        const insertResult = await pool.request()
          .input('LanguageID',   sql.Int, languageID)
          .input('MoodEng',      sql.NVarChar(100), moodEng)
          .input('TenseEng',     sql.NVarChar(100), tenseEng)
          .input('Usage',        sql.NVarChar(2000), generated.usage)
          .input('ExamplesJSON', sql.NVarChar(sql.MAX), examplesJSON)
          .query(`INSERT INTO LanguageVerbTips (LanguageID, MoodEng, TenseEng, Usage, ExamplesJSON)
                  VALUES (@LanguageID, @MoodEng, @TenseEng, @Usage, @ExamplesJSON);
                  SELECT SCOPE_IDENTITY() AS tipsID`);
        tipsID = insertResult.recordset[0].tipsID;
        context.log('Inserted LanguageVerbTips ID:', tipsID);

        for (let i = 0; i < generated.tips.length; i++) {
          await pool.request()
            .input('LanguageVerbTipsID', sql.Int, tipsID)
            .input('Sequence',     sql.Int, i + 1)
            .input('ShortcutText', sql.NVarChar(1000), generated.tips[i])
            .query(`INSERT INTO LanguageVerbTips_Shortcuts (LanguageVerbTipsID, Sequence, ShortcutText) VALUES (@LanguageVerbTipsID, @Sequence, @ShortcutText)`);
        }

        for (let i = 0; i < generated.verbGroups.length; i++) {
          const g = generated.verbGroups[i];
          await pool.request()
            .input('LanguageVerbTipsID', sql.Int, tipsID)
            .input('GroupName',   sql.NVarChar(100), g.group)
            .input('Example',     sql.NVarChar(100), g.example)
            .input('Sequence',    sql.Int, i + 1)
            .input('EndingsJSON', sql.NVarChar(sql.MAX), JSON.stringify(g.endings))
            .query(`INSERT INTO LanguageVerbTips_Endings (LanguageVerbTipsID, GroupName, Example, Sequence, EndingsJSON) VALUES (@LanguageVerbTipsID, @GroupName, @Example, @Sequence, @EndingsJSON)`);
        }

        for (let i = 0; i < generated.irregulars.length; i++) {
          const ir = generated.irregulars[i];
          await pool.request()
            .input('LanguageVerbTipsID', sql.Int, tipsID)
            .input('Verb',     sql.NVarChar(100), ir.verb)
            .input('Forms',    sql.NVarChar(500),  ir.forms)
            .input('Note',     sql.NVarChar(500),  ir.note || null)
            .input('Sequence', sql.Int, i + 1)
            .query(`INSERT INTO LanguageVerbTips_Irregulars (LanguageVerbTipsID, Verb, Forms, Note, Sequence) VALUES (@LanguageVerbTipsID, @Verb, @Forms, @Note, @Sequence)`);
        }

        context.log('DB save complete. Tips/Shortcuts/Endings/Irregulars saved.');
      } catch(dbErr) {
        context.log('DB save error:', dbErr.message);
        // Still return the tips even if DB save fails
        warnings.push('Note: tips generated but could not be saved to database (' + dbErr.message + ')');
      }
    } else {
      warnings.push('No usage text returned — tips not saved to database');
    }

    // 6. Return with any warnings surfaced to user
    const tips = buildTipsObject(
      generated.usage, generated.tips,
      generated.verbGroups, generated.irregulars, generated.examples
    );
    tips._warnings = warnings.length > 0 ? warnings : undefined;
    context.log('Returning tips. Warnings:', warnings);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, tips }) };

  } catch(err) {
    context.log('GetConjugationTips unhandled error:', err.message, err.stack);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unhandled error: ' + err.message }) };
  }
};

async function loadTipsFromDB(pool, tipsID, row) {
  const shortcuts = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT ShortcutText FROM LanguageVerbTips_Shortcuts WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);
  const endings = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT GroupName, Example, EndingsJSON FROM LanguageVerbTips_Endings WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);
  const irregulars = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT Verb, Forms, Note FROM LanguageVerbTips_Irregulars WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);

  return buildTipsObject(
    row.Usage,
    shortcuts.recordset.map(s => s.ShortcutText),
    endings.recordset.map(e => ({ group: e.GroupName, example: e.Example, endings: JSON.parse(e.EndingsJSON) })),
    irregulars.recordset.map(i => ({ verb: i.Verb, forms: i.Forms, note: i.Note })),
    row.ExamplesJSON ? JSON.parse(row.ExamplesJSON) : []
  );
}

function buildTipsObject(usage, tips, verbGroups, irregulars, examples) {
  return {
    usage:      usage      || '',
    tips:       tips       || [],
    verbGroups: verbGroups || [],
    irregulars: irregulars || [],
    examples:   examples   || []
  };
}