const sql = require('mssql');
const Anthropic = require('@anthropic-ai/sdk');

const config = {
  server: 'brunsusa-sql.database.windows.net',
  database: 'DailyMeDB',
  user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

module.exports = async function(context, req) {
  try {
    const { language, moodEng, moodName, tenseEng, tenseName } = req.body;
    if (!language || !moodEng || !tenseEng) {
      context.res = { status: 400, body: 'language, moodEng, tenseEng required' };
      return;
    }

    const pool = await sql.connect(config);

    // ── 1. Resolve LanguageID ──────────────────────────────────────────────
    const langResult = await pool.request()
      .input('LanguageNameEng', sql.NVarChar(100), language)
      .query(`SELECT LanguageID FROM Language WHERE LanguageNameEng = @LanguageNameEng`);
    if (!langResult.recordset.length) {
      context.res = { status: 400, body: `Unknown language: ${language}` };
      return;
    }
    const languageID = langResult.recordset[0].LanguageID;

    // ── 2. Check DB for existing tips ──────────────────────────────────────
    const existing = await pool.request()
      .input('LanguageID', sql.Int, languageID)
      .input('MoodEng',    sql.NVarChar(100), moodEng)
      .input('TenseEng',   sql.NVarChar(100), tenseEng)
      .query(`SELECT LanguageVerbTipsID, Usage, ExamplesJSON
              FROM LanguageVerbTips
              WHERE LanguageID=@LanguageID AND MoodEng=@MoodEng AND TenseEng=@TenseEng`);

    if (existing.recordset.length > 0) {
      const row = existing.recordset[0];
      const tips = await loadTipsFromDB(pool, row.LanguageVerbTipsID, row);
      context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, tips }) };
      return;
    }

    // ── 3. Generate via Anthropic ──────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `You are a ${language} language teacher. Generate conjugation tips for the ${moodEng} mood, ${tenseEng} tense (${language} name: ${moodName} / ${tenseName}).

Return ONLY valid JSON with this exact structure, no markdown, no extra text:
{
  "usage": "One paragraph explaining when and how this tense/mood is used.",
  "tips": ["tip 1", "tip 2", "tip 3"],
  "verbGroups": [
    { "group": "-AR verbs", "example": "hablar", "endings": [{"pronoun":"yo","ending":"-é"},{"pronoun":"tú","ending":"-aste"},{"pronoun":"él/ella/usted","ending":"-ó"},{"pronoun":"nosotros","ending":"-amos"},{"pronoun":"vosotros","ending":"-asteis"},{"pronoun":"ellos/ellas/ustedes","ending":"-aron"}] },
    { "group": "-ER verbs", "example": "comer", "endings": [{"pronoun":"yo","ending":"-í"},{"pronoun":"tú","ending":"-iste"},{"pronoun":"él/ella/usted","ending":"-ió"},{"pronoun":"nosotros","ending":"-imos"},{"pronoun":"vosotros","ending":"-isteis"},{"pronoun":"ellos/ellas/ustedes","ending":"-ieron"}] },
    { "group": "-IR verbs", "example": "vivir", "endings": [{"pronoun":"yo","ending":"-í"},{"pronoun":"tú","ending":"-iste"},{"pronoun":"él/ella/usted","ending":"-ió"},{"pronoun":"nosotros","ending":"-imos"},{"pronoun":"vosotros","ending":"-isteis"},{"pronoun":"ellos/ellas/ustedes","ending":"-ieron"}] }
  ],
  "irregulars": [
    { "verb": "ser/ir", "forms": "fui, fuiste, fue, fuimos, fuisteis, fueron", "note": "Identical forms for both verbs" }
  ],
  "examples": [
    { "sentence": "Ayer comí una manzana.", "translation": "Yesterday I ate an apple." },
    { "sentence": "Ella habló con su madre.", "translation": "She spoke with her mother." },
    { "sentence": "Ellos vivieron en Madrid.", "translation": "They lived in Madrid." }
  ]
}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const generated = JSON.parse(clean);

    // ── 4. Save to DB ──────────────────────────────────────────────────────
    const examplesJSON = generated.examples?.length ? JSON.stringify(generated.examples) : null;

    const insertResult = await pool.request()
      .input('LanguageID',   sql.Int, languageID)
      .input('MoodEng',      sql.NVarChar(100), moodEng)
      .input('TenseEng',     sql.NVarChar(100), tenseEng)
      .input('Usage',        sql.NVarChar(2000), generated.usage || null)
      .input('ExamplesJSON', sql.NVarChar(sql.MAX), examplesJSON)
      .query(`INSERT INTO LanguageVerbTips (LanguageID, MoodEng, TenseEng, Usage, ExamplesJSON)
              VALUES (@LanguageID, @MoodEng, @TenseEng, @Usage, @ExamplesJSON);
              SELECT SCOPE_IDENTITY() AS tipsID`);
    const tipsID = insertResult.recordset[0].tipsID;

    // Shortcuts
    if (generated.tips?.length) {
      for (let i = 0; i < generated.tips.length; i++) {
        await pool.request()
          .input('LanguageVerbTipsID', sql.Int, tipsID)
          .input('Sequence',     sql.Int, i + 1)
          .input('ShortcutText', sql.NVarChar(1000), generated.tips[i])
          .query(`INSERT INTO LanguageVerbTips_Shortcuts (LanguageVerbTipsID, Sequence, ShortcutText)
                  VALUES (@LanguageVerbTipsID, @Sequence, @ShortcutText)`);
      }
    }

    // Endings
    if (generated.verbGroups?.length) {
      for (let i = 0; i < generated.verbGroups.length; i++) {
        const g = generated.verbGroups[i];
        await pool.request()
          .input('LanguageVerbTipsID', sql.Int, tipsID)
          .input('GroupName',   sql.NVarChar(100), g.group)
          .input('Example',     sql.NVarChar(100), g.example)
          .input('Sequence',    sql.Int, i + 1)
          .input('EndingsJSON', sql.NVarChar(sql.MAX), JSON.stringify(g.endings))
          .query(`INSERT INTO LanguageVerbTips_Endings (LanguageVerbTipsID, GroupName, Example, Sequence, EndingsJSON)
                  VALUES (@LanguageVerbTipsID, @GroupName, @Example, @Sequence, @EndingsJSON)`);
      }
    }

    // Irregulars
    if (generated.irregulars?.length) {
      for (let i = 0; i < generated.irregulars.length; i++) {
        const ir = generated.irregulars[i];
        await pool.request()
          .input('LanguageVerbTipsID', sql.Int, tipsID)
          .input('Verb',     sql.NVarChar(100), ir.verb)
          .input('Forms',    sql.NVarChar(500),  ir.forms)
          .input('Note',     sql.NVarChar(500),  ir.note || null)
          .input('Sequence', sql.Int, i + 1)
          .query(`INSERT INTO LanguageVerbTips_Irregulars (LanguageVerbTipsID, Verb, Forms, Note, Sequence)
                  VALUES (@LanguageVerbTipsID, @Verb, @Forms, @Note, @Sequence)`);
      }
    }

    // ── 5. Return ──────────────────────────────────────────────────────────
    const tips = buildTipsObject(
      generated.usage, generated.tips,
      generated.verbGroups, generated.irregulars, generated.examples
    );
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, tips }) };

  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};

async function loadTipsFromDB(pool, tipsID, row) {
  const shortcuts = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT ShortcutText FROM LanguageVerbTips_Shortcuts
            WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);
  const endings = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT GroupName, Example, EndingsJSON FROM LanguageVerbTips_Endings
            WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);
  const irregulars = await pool.request()
    .input('ID', sql.Int, tipsID)
    .query(`SELECT Verb, Forms, Note FROM LanguageVerbTips_Irregulars
            WHERE LanguageVerbTipsID=@ID ORDER BY Sequence`);

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