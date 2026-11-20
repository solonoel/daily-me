// LanguageChat - Spanish conversation practice
// POST body: { action: 'start' | 'turn' | 'end' | 'notes', userID, ... }
const sql = require('mssql');
const https = require('https');

const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

const MODEL = process.env.LANGCHAT_MODEL || 'claude-sonnet-5-5';

const CATEGORIES = [
  'conjugation', 'tense-mood', 'agreement', 'ser-estar', 'por-para', 'preposition',
  'pronoun', 'article', 'word-choice', 'word-order', 'spelling-accents', 'naturalness',
  'vocabulary-gap', 'comprehension'
];

const LEVEL_GUIDE = {
  1: 'Absolute beginner. Very short sentences, present tense only, high-frequency words. English hints in parentheses are fine.',
  2: 'Beginner. Short sentences, present tense plus "ir a" future. Simple questions. Occasional English hints.',
  3: 'Upper beginner. Present, preterite and near future. Simple connectors (y, pero, porque). Slow, clear phrasing.',
  4: 'Lower intermediate. Add the imperfect and reflexive verbs. Everyday vocabulary, sentences of moderate length.',
  5: 'Intermediate. All indicative tenses, occasional present subjunctive, common idioms, natural sentence length.',
  6: 'Solid intermediate. Regular present subjunctive, conditional, compound tenses. Some colloquial expressions.',
  7: 'Upper intermediate. Imperfect subjunctive, si-clauses, wider vocabulary, natural conversational pace.',
  8: 'Advanced. Natural native-like speech, idioms, nuance; correct subtle naturalness issues, not only errors.',
  9: 'Near-native. Full complexity, regional expressions, rapid topic shifts; hold the learner to a high standard.',
  10: 'Native level. No simplification at all. Correct anything a native speaker would find unnatural.'
};

// ---------- helpers ----------
function respond(context, status, obj) {
  context.res = { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let j;
        try { j = JSON.parse(body); } catch (e) { return reject(new Error('Claude returned non-JSON: ' + body.slice(0, 300))); }
        if (res.statusCode >= 400) return reject(new Error(`Claude ${res.statusCode}: ${(j.error && j.error.message) || body.slice(0, 300)}`));
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Claude request timed out')));
    req.write(data);
    req.end();
  });
}

async function callTool(system, messages, tool, maxTokens) {
  const resp = await callClaude({
    model: MODEL, max_tokens: maxTokens || 2000, system, messages,
    tools: [tool], tool_choice: { type: 'tool', name: tool.name }
  });
  const block = (resp.content || []).find(c => c.type === 'tool_use' && c.name === tool.name);
  if (!block) throw new Error('Claude did not return structured output');
  return block.input;
}

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }
function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

async function loadSession(pool, sessionID, userID) {
  const r = await pool.request()
    .input('S', sql.Int, sessionID).input('U', sql.Int, userID)
    .query(`SELECT * FROM LangSession WHERE LangSessionID = @S AND UserID = @U`);
  if (!r.recordset.length) throw new Error('Session not found');
  return r.recordset[0];
}

async function loadTurns(pool, sessionID) {
  const r = await pool.request().input('S', sql.Int, sessionID)
    .query(`SELECT LangTurnID, TurnNumber, Role, TurnType, Content, MetaJson FROM LangTurn WHERE LangSessionID = @S ORDER BY TurnNumber`);
  return r.recordset;
}

async function loadFindings(pool, sessionID) {
  const r = await pool.request().input('S', sql.Int, sessionID)
    .query(`SELECT * FROM LangFinding WHERE LangSessionID = @S ORDER BY LangFindingID`);
  return r.recordset;
}

// ---------- system prompt ----------
function buildSystemPrompt(s, minutesLeft) {
  const words = parseJson(s.WordsJson, []);
  const warmup = parseJson(s.WarmupJson, []);
  const wordLines = words.map(w => `  [${w.id}] ${w.word}${w.translation ? ' = ' + w.translation : ''}${w.flagged ? ' (TROUBLE WORD)' : ''}`).join('\n');
  const warmLines = warmup.map((w, i) => `  ${i + 1}. ${w.prompt}  (target: ${w.target})`).join('\n');

  return `You are a Spanish conversation partner and tutor for Noel, an adult English speaker learning conversational Spanish. His goal is real conversation, not vocabulary drills.

DIALECT: Latin American Spanish (neutral, Peru-friendly). ${s.IncludeSpainNotes ? 'Noel also talks weekly with friends in Spain: whenever a correction or phrase differs in Spain (vosotros, vocabulary, use of the present perfect, expressions), add a short spain_note.' : 'Do not add Spain notes.'}

LEVEL ${s.Level}/10: ${LEVEL_GUIDE[s.Level]}
Match your own Spanish to this level. Keep your replies short (1-3 sentences at low levels, up to 4-5 at high levels) and end with something that invites Noel to keep talking. One question at a time.

SETTING (Noel's description): ${s.Setting}
YOUR ROLE: ${s.AIRole || 'conversation partner'}
${s.FocusGrammar ? `GRAMMAR FOCUS: ${s.FocusGrammar}. This is an emphasis, not a restriction: Noel may use any tense or mood. Steer the conversation so he gets plenty of chances to use the focus grammar, and set is_focus=true on findings about it.` : 'No specific grammar focus.'}

NOEL'S WORDS (weave these in naturally, favour TROUBLE WORDs; report each one Noel uses in words_used with its id):
${wordLines || '  (none)'}

${warmLines ? `WARM-UP (from his past mistakes): Start the session by working through these one at a time (turn_type "warmup"): give the prompt, check his answer, correct briefly, move on. If he says to skip, skip. Then start the scene.\n${warmLines}` : 'No warm-up this session; start the scene directly.'}

CORRECTION RULES (apply to every message Noel writes in Spanish, covering ALL aspects: conjugation, tense/mood choice, agreement, ser/estar, por/para, prepositions, pronouns, articles, word choice, word order, spelling and accents, and naturalness):
- If his message is perfect: no findings except optional strengths; continue the conversation.
- If correct but a more natural phrasing exists: add an "improvement" finding and continue.
- If wrong: add "error" findings (one per distinct problem), set ask_retry=true, and in reply ask him briefly to try again (e.g. "Casi. Inténtalo otra vez."). Do not continue the scene until the retry.
- On a retry turn (turn_type "retry"), judge the new attempt the same way; if it is right, acknowledge briefly and continue the scene.
- Be critical and thorough, but every explanation must be brief (one short English sentence).
- Record genuine strengths (correct use of a difficult structure) as "strength" findings, sparingly.
- When Noel lacks a word or phrase and falls back to English, record a "gap" finding with the Spanish he needed.
- Put feedback ONLY in findings. The reply is the conversational message, not a list of corrections.

ASIDES: Noel may write questions or comments in English at any time ("How do I say...?", "Is there a better way to say that?", "Why imperfect here?", "Slow down", "I think I was right"). Treat these as turn_type "aside": answer briefly in English with Spanish examples, then add one short Spanish line that resumes the conversation where it left off. Do not create error findings for asides. Instructions like "slow down" or "use simpler words" apply for the rest of the session.
- If an aside asks how to say something, also add a "gap" finding (original = his English, corrected = the Spanish).
- If he disputes an earlier correction (each earlier correction is labelled with #id in the history), reconsider it honestly. Report it in disputed_findings with upheld=true if he was actually right (the correction was wrong or overly strict, or the usage is valid regionally), otherwise upheld=false and explain briefly why.
- A message beginning with "?" is always an aside.

TIME: ${minutesLeft > 0 ? `About ${Math.ceil(minutesLeft)} minute(s) left.` : 'Time is up. Still give feedback on his last message, then wrap up warmly in Spanish in one or two sentences (turn_type "wrapup"). Do not ask a new question.'}

Also report, for each Spanish message from Noel: tenses_used (e.g. "present", "preterite", "imperfect", "present subjunctive") and english_used (true if he relied on English words inside his Spanish).`;
}

const RESPOND_TOOL = {
  name: 'respond',
  description: 'Reply to Noel and report structured feedback on his latest message.',
  input_schema: {
    type: 'object',
    properties: {
      turn_type: { type: 'string', enum: ['warmup', 'practice', 'retry', 'aside', 'wrapup'] },
      reply: { type: 'string', description: 'The message shown to Noel in the chat.' },
      ask_retry: { type: 'boolean' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['error', 'improvement', 'strength', 'gap'] },
            category: { type: 'string', enum: CATEGORIES },
            is_focus: { type: 'boolean' },
            severity: { type: 'integer', minimum: 1, maximum: 3, description: '1 minor, 2 moderate, 3 major (errors only)' },
            original: { type: 'string' },
            corrected: { type: 'string' },
            explanation: { type: 'string' },
            spain_note: { type: 'string' }
          },
          required: ['type', 'category', 'original', 'corrected', 'explanation']
        }
      },
      words_used: {
        type: 'array',
        items: { type: 'object', properties: { word_id: { type: 'integer' }, correct: { type: 'boolean' } }, required: ['word_id', 'correct'] }
      },
      tenses_used: { type: 'array', items: { type: 'string' } },
      english_used: { type: 'boolean' },
      disputed_findings: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'integer' }, upheld: { type: 'boolean' } }, required: ['id', 'upheld'] }
      }
    },
    required: ['turn_type', 'reply', 'ask_retry', 'findings', 'words_used']
  }
};

// Rebuild the conversation for Claude from the stored transcript.
function buildMessages(turns, findings, newMessage) {
  const byTurn = {};
  findings.forEach(f => { (byTurn[f.LangTurnID] = byTurn[f.LangTurnID] || []).push(f); });
  const msgs = [{ role: 'user', content: '(Session start. Please begin.)' }];
  let lastUserTurnID = null;
  for (const t of turns) {
    if (t.Role === 'U') {
      msgs.push({ role: 'user', content: t.Content });
      lastUserTurnID = t.LangTurnID;
    } else {
      let content = t.Content;
      const fb = lastUserTurnID ? byTurn[lastUserTurnID] : null;
      if (fb && fb.length) {
        content += '\n\n[Feedback given on his previous message: ' + fb.map(f =>
          `#${f.LangFindingID} ${f.FindingType}/${f.Category}: "${f.Original}" -> "${f.Corrected}"${f.Voided ? ' (WITHDRAWN after dispute)' : ''}`
        ).join('; ') + ']';
      }
      msgs.push({ role: 'assistant', content });
      lastUserTurnID = null;
    }
  }
  msgs.push({ role: 'user', content: newMessage });
  return msgs;
}

// ---------- actions ----------
async function startSession(pool, b) {
  const userID = parseInt(b.userID);
  const languageID = parseInt(b.languageID) || 1;
  const deckID = b.deckID ? parseInt(b.deckID) : null;
  const level = Math.min(10, Math.max(1, parseInt(b.level) || 5));
  const minutes = Math.min(120, Math.max(1, parseInt(b.minutes) || 15));
  const setting = String(b.setting || '').trim() || 'Free conversation about everyday life.';
  const includeSpain = !!b.includeSpain;

  // Words: up to 9 prioritised active words + 1 random mastered word
  const wr = await pool.request()
    .input('U', sql.Int, userID).input('L', sql.Int, languageID).input('D', sql.Int, deckID)
    .query(`
      WITH Pool AS (
        SELECT w.UserLanguageWordsID, w.WordsName, w.WordsTranslation, w.Flag, w.DateMastered
        FROM UserLanguageWords w
        WHERE w.UserID = @U AND w.LanguageID = @L
          AND (@D IS NULL OR EXISTS (SELECT 1 FROM UserLanguageWordsDeckWords dw
                                     WHERE dw.UserLanguageWordsDeckID = @D AND dw.UserLanguageWordsID = w.UserLanguageWordsID))
      )
      SELECT * FROM (
        SELECT TOP 9 p.UserLanguageWordsID, p.WordsName, p.WordsTranslation, p.Flag
        FROM Pool p
        LEFT JOIN LangWordProgress g ON g.UserID = @U AND g.UserLanguageWordsID = p.UserLanguageWordsID
        WHERE p.DateMastered IS NULL
        ORDER BY (CASE WHEN p.Flag = 1 THEN 4 ELSE 0 END)
               + (CASE WHEN g.NextDueDate <= GETDATE() THEN 3 ELSE 0 END)
               + (CASE WHEN g.TimesWrong > g.TimesCorrect THEN 2 ELSE 0 END)
               + (CASE WHEN g.UserID IS NULL THEN 1 ELSE 0 END) DESC, NEWID()
      ) a
      UNION ALL
      SELECT * FROM (
        SELECT TOP 1 p.UserLanguageWordsID, p.WordsName, p.WordsTranslation, p.Flag
        FROM Pool p WHERE p.DateMastered IS NOT NULL ORDER BY NEWID()
      ) m`);
  const words = wr.recordset.map(w => ({ id: w.UserLanguageWordsID, word: w.WordsName, translation: w.WordsTranslation, flagged: !!w.Flag }));

  // Past errors for the warm-up
  const er = await pool.request().input('U', sql.Int, userID)
    .query(`SELECT TOP 12 Category, Original, Corrected, Explanation FROM LangFinding
            WHERE UserID = @U AND FindingType = 'error' AND Voided = 0 AND CreatedDate >= DATEADD(day, -30, GETDATE())
            ORDER BY ISNULL(Severity, 1) DESC, CreatedDate DESC`);
  const pastErrors = er.recordset;

  // Weakest categories over the last 30 days
  const cr = await pool.request().input('U', sql.Int, userID)
    .query(`SELECT TOP 3 Category, COUNT(*) AS N FROM LangFinding
            WHERE UserID = @U AND FindingType = 'error' AND Voided = 0 AND CreatedDate >= DATEADD(day, -30, GETDATE())
            GROUP BY Category ORDER BY COUNT(*) DESC`);
  const weak = cr.recordset.map(r => r.Category);

  // Ask Claude to interpret the setting and pick warm-up items
  const setup = await callTool(
    'You prepare Spanish conversation practice sessions. Interpret the learner\'s setting description and prepare the session.',
    [{ role: 'user', content:
`Setting description from Noel: """${setting}"""
Level: ${level}/10.
Recent mistakes (pick up to 4 of the most instructive for a quick warm-up; skip duplicates; return none if the list is empty):
${pastErrors.map(e => `- [${e.Category}] "${e.Original}" -> "${e.Corrected}" (${e.Explanation || ''})`).join('\n') || '(none)'}
Weakest categories recently: ${weak.join(', ') || '(none)'}` }],
    {
      name: 'prepare_session',
      description: 'Prepare the session.',
      input_schema: {
        type: 'object',
        properties: {
          ai_role: { type: 'string', description: 'Short English description of the role Claude plays, e.g. "Listener to your story" or "Porter on the Inca Trail, day 2".' },
          focus_grammar: { type: 'string', description: 'Grammar Noel wants to focus on, e.g. "imperfect". Empty string if none was mentioned; you may add one weak category if it fits naturally.' },
          warmup: {
            type: 'array', maxItems: 4,
            items: { type: 'object', properties: {
              prompt: { type: 'string', description: 'Short instruction to Noel, e.g. "Last time you wrote \'si yo tendría\'. Say: If I had time, I would go." ' },
              target: { type: 'string', description: 'The correct Spanish answer.' } }, required: ['prompt', 'target'] }
          }
        },
        required: ['ai_role', 'focus_grammar', 'warmup']
      }
    }, 1200);

  const ins = await pool.request()
    .input('U', sql.Int, userID).input('L', sql.Int, languageID).input('D', sql.Int, deckID)
    .input('P', sql.Int, b.parentSessionID ? parseInt(b.parentSessionID) : null)
    .input('Level', sql.TinyInt, level).input('Min', sql.SmallInt, minutes)
    .input('Setting', sql.NVarChar(2000), setting.slice(0, 2000))
    .input('Focus', sql.NVarChar(400), (setup.focus_grammar || '').slice(0, 400) || null)
    .input('Spain', sql.Bit, includeSpain)
    .input('Role', sql.NVarChar(200), (setup.ai_role || '').slice(0, 200))
    .input('Words', sql.NVarChar(sql.MAX), JSON.stringify(words))
    .input('Warm', sql.NVarChar(sql.MAX), JSON.stringify(setup.warmup || []))
    .query(`INSERT INTO LangSession (UserID, LanguageID, DeckID, ParentSessionID, Level, DurationMinutes, Setting, FocusGrammar, IncludeSpainNotes, AIRole, WordsJson, WarmupJson)
            OUTPUT INSERTED.*
            VALUES (@U, @L, @D, @P, @Level, @Min, @Setting, @Focus, @Spain, @Role, @Words, @Warm)`);
  const session = ins.recordset[0];

  // Opening message
  const open = await callTool(buildSystemPrompt(session, minutes),
    [{ role: 'user', content: '(Session start. Please begin: either the first warm-up item, or set the scene in one or two sentences and invite Noel to start. If Noel said he will tell a story, briefly invite him to begin.)' }],
    RESPOND_TOOL, 800);

  await pool.request()
    .input('S', sql.Int, session.LangSessionID)
    .input('Type', sql.NVarChar(20), open.turn_type === 'warmup' ? 'warmup' : 'practice')
    .input('C', sql.NVarChar(sql.MAX), open.reply)
    .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content) VALUES (@S, 1, 'A', @Type, @C)`);

  return {
    sessionID: session.LangSessionID, aiRole: session.AIRole, focusGrammar: session.FocusGrammar,
    words, warmupCount: (setup.warmup || []).length, minutes, startedDate: session.StartedDate,
    reply: open.reply, turnType: open.turn_type
  };
}

async function takeTurn(pool, b) {
  const userID = parseInt(b.userID);
  const message = String(b.message || '').trim();
  if (!message) throw new Error('Empty message');
  const s = await loadSession(pool, parseInt(b.sessionID), userID);
  if (s.Status !== 'Active') throw new Error('This session has ended');

  const turns = await loadTurns(pool, s.LangSessionID);
  const findings = await loadFindings(pool, s.LangSessionID);
  const minutesLeft = s.DurationMinutes - (Date.now() - new Date(s.StartedDate).getTime()) / 60000;

  const out = await callTool(buildSystemPrompt(s, minutesLeft), buildMessages(turns, findings, message), RESPOND_TOOL, 2000);

  const validWordIDs = new Set(parseJson(s.WordsJson, []).map(w => w.id));
  const nextNum = (turns.length ? turns[turns.length - 1].TurnNumber : 0) + 1;
  const userType = out.turn_type === 'aside' ? 'aside' : out.turn_type === 'retry' ? 'retry' : out.turn_type === 'warmup' ? 'warmup' : 'practice';
  const meta = { tenses: out.tenses_used || [], englishUsed: !!out.english_used, words: wordCount(message) };

  const tx = new sql.Transaction(pool);
  await tx.begin();
  const saved = [];
  try {
    const ut = await new sql.Request(tx)
      .input('S', sql.Int, s.LangSessionID).input('N', sql.Int, nextNum)
      .input('Type', sql.NVarChar(20), userType).input('C', sql.NVarChar(sql.MAX), message)
      .input('M', sql.NVarChar(sql.MAX), JSON.stringify(meta))
      .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content, MetaJson)
              OUTPUT INSERTED.LangTurnID VALUES (@S, @N, 'U', @Type, @C, @M)`);
    const userTurnID = ut.recordset[0].LangTurnID;

    for (const f of (out.findings || [])) {
      const r = await new sql.Request(tx)
        .input('S', sql.Int, s.LangSessionID).input('T', sql.Int, userTurnID).input('U', sql.Int, userID)
        .input('Type', sql.NVarChar(20), f.type).input('Cat', sql.NVarChar(50), CATEGORIES.includes(f.category) ? f.category : 'naturalness')
        .input('Focus', sql.Bit, !!f.is_focus).input('Sev', sql.TinyInt, f.type === 'error' ? (f.severity || 1) : null)
        .input('O', sql.NVarChar(1000), String(f.original || '').slice(0, 1000))
        .input('Cor', sql.NVarChar(1000), String(f.corrected || '').slice(0, 1000))
        .input('E', sql.NVarChar(1000), String(f.explanation || '').slice(0, 1000))
        .input('Sp', sql.NVarChar(500), s.IncludeSpainNotes && f.spain_note ? String(f.spain_note).slice(0, 500) : null)
        .query(`INSERT INTO LangFinding (LangSessionID, LangTurnID, UserID, FindingType, Category, IsFocus, Severity, Original, Corrected, Explanation, SpainNote)
                OUTPUT INSERTED.* VALUES (@S, @T, @U, @Type, @Cat, @Focus, @Sev, @O, @Cor, @E, @Sp)`);
      saved.push(r.recordset[0]);
    }

    for (const d of (out.disputed_findings || [])) {
      await new sql.Request(tx)
        .input('ID', sql.Int, d.id).input('S', sql.Int, s.LangSessionID).input('V', sql.Bit, !!d.upheld)
        .query(`UPDATE LangFinding SET Disputed = 1, Voided = CASE WHEN @V = 1 THEN 1 ELSE Voided END
                WHERE LangFindingID = @ID AND LangSessionID = @S`);
    }

    for (const w of (out.words_used || [])) {
      if (!validWordIDs.has(w.word_id)) continue;
      await new sql.Request(tx)
        .input('U', sql.Int, userID).input('W', sql.Int, w.word_id).input('Ok', sql.Bit, !!w.correct)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM LangWordProgress WHERE UserID = @U AND UserLanguageWordsID = @W)
            INSERT INTO LangWordProgress (UserID, UserLanguageWordsID) VALUES (@U, @W);
          UPDATE LangWordProgress SET
            TimesUsed = TimesUsed + 1,
            TimesCorrect = TimesCorrect + CASE WHEN @Ok = 1 THEN 1 ELSE 0 END,
            TimesWrong = TimesWrong + CASE WHEN @Ok = 1 THEN 0 ELSE 1 END,
            LastUsedDate = GETDATE(),
            NextDueDate = CASE WHEN @Ok = 1
                               THEN DATEADD(day, POWER(2, CASE WHEN TimesCorrect > 5 THEN 5 ELSE TimesCorrect END), GETDATE())
                               ELSE GETDATE() END
          WHERE UserID = @U AND UserLanguageWordsID = @W;`);
    }

    await new sql.Request(tx)
      .input('S', sql.Int, s.LangSessionID).input('N', sql.Int, nextNum + 1)
      .input('Type', sql.NVarChar(20), out.turn_type).input('C', sql.NVarChar(sql.MAX), out.reply)
      .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content) VALUES (@S, @N, 'A', @Type, @C)`);

    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }

  return {
    reply: out.reply, turnType: out.turn_type, askRetry: !!out.ask_retry,
    findings: saved.map(f => ({
      id: f.LangFindingID, type: f.FindingType, category: f.Category, isFocus: f.IsFocus, severity: f.Severity,
      original: f.Original, corrected: f.Corrected, explanation: f.Explanation, spainNote: f.SpainNote
    })),
    disputed: out.disputed_findings || [],
    minutesLeft: Math.max(0, minutesLeft)
  };
}

async function buildSummary(pool, s) {
  const turns = await loadTurns(pool, s.LangSessionID);
  const findings = (await loadFindings(pool, s.LangSessionID)).filter(f => !f.Voided);
  const userTurns = turns.filter(t => t.Role === 'U');
  const spoken = userTurns.filter(t => t.TurnType === 'practice' || t.TurnType === 'retry');
  const metas = spoken.map(t => parseJson(t.MetaJson, {}));
  const tenses = [...new Set(metas.flatMap(m => m.tenses || []))];
  const byCat = {};
  findings.filter(f => f.FindingType === 'error').forEach(f => { byCat[f.Category] = (byCat[f.Category] || 0) + 1; });
  const ended = s.EndedDate ? new Date(s.EndedDate) : new Date();
  return {
    minutes: Math.round((ended - new Date(s.StartedDate)) / 60000),
    messages: spoken.length,
    avgWordsPerMessage: spoken.length ? Math.round(10 * metas.reduce((a, m) => a + (m.words || 0), 0) / spoken.length) / 10 : 0,
    englishMixRate: spoken.length ? Math.round(100 * metas.filter(m => m.englishUsed).length / spoken.length) : 0,
    tensesUsed: tenses,
    asides: userTurns.filter(t => t.TurnType === 'aside').length,
    retries: userTurns.filter(t => t.TurnType === 'retry').length,
    errors: findings.filter(f => f.FindingType === 'error').length,
    focusErrors: findings.filter(f => f.FindingType === 'error' && f.IsFocus).length,
    improvements: findings.filter(f => f.FindingType === 'improvement').length,
    strengths: findings.filter(f => f.FindingType === 'strength').length,
    gaps: findings.filter(f => f.FindingType === 'gap').length,
    errorsByCategory: byCat,
    withdrawnAfterDispute: (await loadFindings(pool, s.LangSessionID)).filter(f => f.Voided).length
  };
}

async function endSession(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  if (s.Status === 'Active') {
    await pool.request().input('S', sql.Int, s.LangSessionID)
      .query(`UPDATE LangSession SET Status = 'Completed', EndedDate = GETDATE() WHERE LangSessionID = @S`);
    s.EndedDate = new Date();
  }
  const summary = await buildSummary(pool, s);
  await pool.request().input('S', sql.Int, s.LangSessionID).input('J', sql.NVarChar(sql.MAX), JSON.stringify(summary))
    .query(`UPDATE LangSession SET SummaryJson = @J WHERE LangSessionID = @S`);
  return { summary };
}

async function studyNotes(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  if (s.StudyNotes && !b.regenerate) return { notes: s.StudyNotes, suggestedLevel: s.SuggestedLevel };
  const turns = await loadTurns(pool, s.LangSessionID);
  const findings = await loadFindings(pool, s.LangSessionID);
  const summary = parseJson(s.SummaryJson, null) || await buildSummary(pool, s);

  const transcript = turns.map(t => `${t.Role === 'U' ? 'NOEL' : 'TUTOR'} (${t.TurnType}): ${t.Content}`).join('\n');
  const fbLines = findings.filter(f => !f.Voided).map(f =>
    `- ${f.FindingType}/${f.Category}${f.IsFocus ? ' [focus]' : ''}: "${f.Original}" -> "${f.Corrected}" - ${f.Explanation || ''}${f.SpainNote ? ' | Spain: ' + f.SpainNote : ''}`).join('\n');

  const out = await callTool(
    'You write concise, practical study notes for an adult learner of conversational Spanish after a practice session. Write in English with Spanish examples. Use markdown: ## headings and - bullets, **bold** for key Spanish. No filler.',
    [{ role: 'user', content:
`Session: level ${s.Level}/10, setting: ${s.Setting}. Focus grammar: ${s.FocusGrammar || 'none'}. ${s.IncludeSpainNotes ? 'Include a short "Spain vs Latin America" section if relevant.' : ''}

Stats: ${JSON.stringify(summary)}

Feedback recorded:
${fbLines || '(none)'}

Transcript:
${transcript}

Write study notes with these sections: Main errors and fixes (grouped by pattern, most important first), Phrases worth keeping, Strengths, ${s.IncludeSpainNotes ? 'Spain vs Latin America, ' : ''}Practice (4-5 sentences to translate into Spanish, with answers at the end), and a one-line Fluency note interpreting the stats. Also suggest the level for the next session.` }],
    {
      name: 'study_notes',
      description: 'Return the study notes.',
      input_schema: {
        type: 'object',
        properties: {
          notes_markdown: { type: 'string' },
          suggested_level: { type: 'integer', minimum: 1, maximum: 10 },
          suggested_level_reason: { type: 'string' }
        },
        required: ['notes_markdown', 'suggested_level', 'suggested_level_reason']
      }
    }, 4000);

  const notes = `${out.notes_markdown}\n\n## Next session\n- Suggested level: **${out.suggested_level}** - ${out.suggested_level_reason}`;
  await pool.request().input('S', sql.Int, s.LangSessionID)
    .input('N', sql.NVarChar(sql.MAX), notes).input('L', sql.TinyInt, out.suggested_level)
    .query(`UPDATE LangSession SET StudyNotes = @N, SuggestedLevel = @L WHERE LangSessionID = @S`);
  return { notes, suggestedLevel: out.suggested_level };
}

// ---------- entry ----------
module.exports = async function (context, req) {
  try {
    const b = req.body || {};
    if (!b.userID) return respond(context, 400, { error: 'userID required' });
    const pool = await sql.connect(config);
    let result;
    switch (b.action) {
      case 'start': result = await startSession(pool, b); break;
      case 'turn': result = await takeTurn(pool, b); break;
      case 'end': result = await endSession(pool, b); break;
      case 'notes': result = await studyNotes(pool, b); break;
      default: return respond(context, 400, { error: 'Unknown action' });
    }
    respond(context, 200, result);
  } catch (err) {
    context.log.error('LanguageChat error:', err);
    respond(context, 500, { error: err.message });
  }
};
