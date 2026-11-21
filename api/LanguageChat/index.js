// LanguageChat - Spanish conversation practice
// POST body: { action, userID, ... }
// actions: start | continue | turn | end | save | discard | notes | list | delete | load | assess | voices | setVoice | speak
const sql = require('mssql');
const https = require('https');

const config = {
  server: 'brunsusa-sql.database.windows.net', database: 'DailyMeDB', user: 'noeladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60000, requestTimeout: 60000 }
};

const MODEL = process.env.LANGCHAT_MODEL || 'claude-sonnet-5-5';
const DEFAULT_VOICE = 'es-PE-CamilaNeural';

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
  const sys = system + `\n\nIMPORTANT: Always respond by calling the "${tool.name}" tool. Do not reply with plain text.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await callClaude({
      model: MODEL, max_tokens: maxTokens || 2000, system: sys, messages,
      tools: [tool], tool_choice: { type: 'auto' }
    });
    const block = (resp.content || []).find(c => c.type === 'tool_use' && c.name === tool.name);
    if (block) return block.input;
  }
  throw new Error('Claude did not return structured output');
}

function fmtFinding(f) {
  return {
    id: f.LangFindingID, type: f.FindingType, category: f.Category, isFocus: f.IsFocus, severity: f.Severity,
    original: f.Original, corrected: f.Corrected, explanation: f.Explanation, spainNote: f.SpainNote, voided: !!f.Voided
  };
}

function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }
function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
function clampInt(v, lo, hi, dflt) { const n = parseInt(v); return isNaN(n) ? dflt : Math.min(hi, Math.max(lo, n)); }

async function loadSession(pool, sessionID, userID) {
  const r = await pool.request()
    .input('S', sql.Int, sessionID).input('U', sql.Int, userID)
    .query(`SELECT * FROM LangSession WHERE LangSessionID = @S AND UserID = @U`);
  if (!r.recordset.length) throw new Error('Session not found');
  return r.recordset[0];
}

async function loadTurns(pool, sessionID) {
  const r = await pool.request().input('S', sql.Int, sessionID)
    .query(`SELECT LangTurnID, TurnNumber, Role, TurnType, Content, MetaJson, CreatedDate FROM LangTurn WHERE LangSessionID = @S ORDER BY TurnNumber`);
  return r.recordset;
}

async function loadFindings(pool, sessionID) {
  const r = await pool.request().input('S', sql.Int, sessionID)
    .query(`SELECT * FROM LangFinding WHERE LangSessionID = @S ORDER BY LangFindingID`);
  return r.recordset;
}

// Messages for the chat screen ('resume' turns are internal markers and are not shown).
function visibleMessages(turns, findings) {
  const byTurn = {};
  findings.filter(f => f.FindingType !== 'strength').forEach(f => { (byTurn[f.LangTurnID] = byTurn[f.LangTurnID] || []).push(fmtFinding(f)); });
  return turns.filter(t => t.TurnType !== 'resume').map(t => {
    if (t.Role === 'U') return { role: 'U', text: t.Content, findings: byTurn[t.LangTurnID] || [] };
    const m = parseJson(t.MetaJson, {});
    return { role: 'A', text: t.Content, type: t.TurnType, speaker: m.speaker || null, spoken: m.spoken || '' };
  });
}

// Words from: '__none__' = don't use My Words, '' = all words, otherwise a deck ID
function wordsChoice(v) {
  if (v === '__none__') return { useWords: false, deckID: null };
  const d = parseInt(v);
  return { useWords: true, deckID: isNaN(d) ? null : d };
}

// Up to 9 prioritised active words + 1 random mastered word
async function pickWords(pool, userID, languageID, deckID, useWords) {
  if (useWords === false) return [];
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
  return wr.recordset.map(w => ({ id: w.UserLanguageWordsID, word: w.WordsName, translation: w.WordsTranslation, flagged: !!w.Flag }));
}

// ---------- voices ----------
async function activeVoices(pool) {
  const r = await pool.request().query(`SELECT VoiceCode, Region, VoiceName, Gender FROM SpeechVoice WHERE IsActive = 1 ORDER BY Sequence`);
  return r.recordset;
}

async function sessionVoices(pool, sessionID) {
  const r = await pool.request().input('S', sql.Int, sessionID)
    .query(`SELECT CharacterName, VoiceCode FROM LangSessionVoice WHERE LangSessionID = @S`);
  const map = {};
  r.recordset.forEach(v => { map[v.CharacterName] = v.VoiceCode; });
  return map;
}

// The user's default voice for new conversations (last voice chosen for a main character)
async function userDefaultVoice(pool, userID, voices) {
  const r = await pool.request().input('U', sql.Int, userID).query(`SELECT LastVoiceCode FROM [User] WHERE UserID = @U`);
  const last = r.recordset[0] && r.recordset[0].LastVoiceCode;
  return voices.some(v => v.VoiceCode === last) ? last : (voices.some(v => v.VoiceCode === DEFAULT_VOICE) ? DEFAULT_VOICE : (voices[0] ? voices[0].VoiceCode : DEFAULT_VOICE));
}

async function saveDefaultVoice(pool, userID, voiceCode) {
  await pool.request().input('U', sql.Int, userID).input('V', sql.NVarChar(60), voiceCode)
    .query(`UPDATE [User] SET LastVoiceCode = @V WHERE UserID = @U`);
}

// Gives a character a voice if it doesn't have one yet. voiceCode = explicit choice;
// otherwise an unused voice of the character's gender, preferring the main character's region.
async function assignVoice(pool, s, name, gender, voiceCode) {
  const map = await sessionVoices(pool, s.LangSessionID);
  if (map[name]) return map;
  const voices = await activeVoices(pool);
  let pick = voices.find(v => v.VoiceCode === voiceCode);
  if (!pick) {
    const used = new Set(Object.values(map));
    const main = voices.find(v => v.VoiceCode === map[s.AIName]);
    const free = voices.filter(v => !used.has(v.VoiceCode));
    const g = String(gender || '').toUpperCase();
    pick = free.find(v => v.Gender === g && main && v.Region === main.Region)
      || free.find(v => v.Gender === g)
      || free.find(v => main && v.Region === main.Region)
      || free[0] || voices[0];
  }
  if (!pick) return map;
  await pool.request().input('S', sql.Int, s.LangSessionID).input('N', sql.NVarChar(50), name).input('V', sql.NVarChar(60), pick.VoiceCode)
    .query(`IF NOT EXISTS (SELECT 1 FROM LangSessionVoice WHERE LangSessionID = @S AND CharacterName = @N)
              INSERT INTO LangSessionVoice (LangSessionID, CharacterName, VoiceCode) VALUES (@S, @N, @V)`);
  map[name] = pick.VoiceCode;
  return map;
}

// Older conversations have no voice yet: give the main character the user's default.
async function ensureMainVoice(pool, s) {
  const map = await sessionVoices(pool, s.LangSessionID);
  if (map[s.AIName]) return map;
  return assignVoice(pool, s, s.AIName, '', await userDefaultVoice(pool, s.UserID, await activeVoices(pool)));
}

// Who is speaking, and the Spanish dialogue to voice. Corrections, asides and warm-up items are never voiced.
function aiTurnMeta(s, out, aiType) {
  out.reply = String(out.reply || '').replace(/^\s*\[[^\]]{1,60} speaking\]\s*/i, '');
  let speaker = String(out.speaker || '').trim().slice(0, 50);
  if (!speaker || speaker.toLowerCase() === String(s.AIName || '').toLowerCase()) speaker = s.AIName;
  else speaker = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  const voiced = !['correction', 'aside', 'warmup'].includes(aiType);
  const spoken = voiced ? (String(out.spoken || '').trim() || String(out.reply || '').trim()) : '';
  return { speaker, spoken, gender: out.speaker_gender || '' };
}

async function voicesAction(pool, b) {
  const voices = await activeVoices(pool);
  return {
    voices: voices.map(v => ({ code: v.VoiceCode, label: `${v.Region} - ${v.VoiceName}`, region: v.Region })),
    defaultVoice: await userDefaultVoice(pool, parseInt(b.userID), voices)
  };
}

// Change one character's voice. Changing the main character's voice also sets the default for new conversations.
async function setVoice(pool, b) {
  const userID = parseInt(b.userID);
  const s = await loadSession(pool, parseInt(b.sessionID), userID);
  const name = String(b.character || '').trim().slice(0, 50) || s.AIName;
  const voice = (await activeVoices(pool)).find(v => v.VoiceCode === b.voiceCode);
  if (!voice) throw new Error('Unknown voice');
  await pool.request().input('S', sql.Int, s.LangSessionID).input('N', sql.NVarChar(50), name).input('V', sql.NVarChar(60), voice.VoiceCode)
    .query(`UPDATE LangSessionVoice SET VoiceCode = @V WHERE LangSessionID = @S AND CharacterName = @N;
            IF @@ROWCOUNT = 0 INSERT INTO LangSessionVoice (LangSessionID, CharacterName, VoiceCode) VALUES (@S, @N, @V);`);
  if (name === s.AIName) await saveDefaultVoice(pool, userID, voice.VoiceCode);
  return { voices: await sessionVoices(pool, s.LangSessionID) };
}

// Text to speech via Azure AI Speech. Returns base64 MP3.
function speak(b) {
  const voice = String(b.voiceCode || '');
  const text = String(b.text || '').trim().slice(0, 1500);
  if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(voice)) return Promise.reject(new Error('Invalid voice'));
  if (!text) return Promise.reject(new Error('Nothing to say'));
  const key = process.env.SPEECH_KEY, region = process.env.SPEECH_REGION;
  if (!key || !region) return Promise.reject(new Error('Speech is not configured (SPEECH_KEY / SPEECH_REGION)'));
  const rate = process.env.SPEECH_RATE || '-10%';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.slice(0, 5)}"><voice name="${voice}"><prosody rate="${rate}">${esc}</prosody></voice></speak>`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${region}.tts.speech.microsoft.com`, path: '/cognitiveservices/v1', method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'DailyMe',
        'Content-Length': Buffer.byteLength(ssml)
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`Speech ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        resolve({ audio: buf.toString('base64') });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Speech request timed out')));
    req.write(ssml);
    req.end();
  });
}

// ---------- system prompt ----------
function buildSystemPrompt(s, minutesLeft) {
  const words = parseJson(s.WordsJson, []);
  const warmup = parseJson(s.WarmupJson, []);
  const isReview = s.SessionType === 'review';
  const name = s.AIName || 'Raúl';
  const wordLines = words.map(w => `  [${w.id}] ${w.word}${w.translation ? ' = ' + w.translation : ''}${w.flagged ? ' (TROUBLE WORD)' : ''}`).join('\n');
  const warmLines = warmup.map((w, i) => `  ${i + 1}. ${w.prompt}  (target: ${w.target})`).join('\n');

  const warmSection = !warmLines
    ? 'No warm-up; carry on with the conversation.'
    : isReview
      ? `REVIEW SESSION: this session reviews earlier mistakes. Work through these review items one at a time (turn_type "warmup"): give the prompt and check his answer. If his answer is correct, the reply is exactly "Correct." followed by the next item (or, after the last item, the start of the conversation). If it is wrong, correct it as usual and ask him to try again. After the items, hold a short conversation on the same theme that makes him reuse the corrected forms and vocabulary.\n${warmLines}`
      : `WARM-UP (from his past mistakes): Start by working through these one at a time (turn_type "warmup"): give the prompt, check his answer, correct if needed, move on. If he says to skip, skip. Then start the scene.\n${warmLines}`;

  return `You are ${name}, a Spanish conversation partner and tutor for Noel, an adult English speaker learning conversational Spanish. His goal is real conversation, not vocabulary drills. Your name is ${name}; the app shows it before your messages, so never write your own name at the start of a reply.

DIALECT: Latin American Spanish (neutral, Peru-friendly). ${s.IncludeSpainNotes ? 'Noel also talks weekly with friends in Spain: whenever a correction or phrase differs in Spain (vosotros, vocabulary, use of the present perfect, expressions), add a short spain_note.' : 'Do not add Spain notes.'}

LEVEL ${s.Level}/10: ${LEVEL_GUIDE[s.Level]}
Match your own Spanish to this level. Keep your replies short (1-3 sentences at low levels, up to 4-5 at high levels) and end with something that invites Noel to keep talking. One question at a time.

SETTING (Noel's description): ${s.Setting}
YOUR ROLE: ${s.AIRole || 'conversation partner'}
CHARACTERS: You are mainly ${name}. If the scene naturally brings in another character (a vendor, a driver, a waiter), that character may speak for a reply: set speaker to that character's first name (keep the same name every time they speak) and speaker_gender to "F" or "M". Otherwise speaker is "${name}". One character per reply. Never write a name at the start of the reply; the app shows it.
SPOKEN: The app reads the in-character Spanish dialogue aloud. Put exactly that dialogue in spoken (no English, no corrections, no notes). For corrections, asides and warm-up items, spoken is "".
${s.FocusGrammar ? `GRAMMAR FOCUS: ${s.FocusGrammar}. This is an emphasis, not a restriction: Noel may use any tense or mood. Steer the conversation so he gets plenty of chances to use the focus grammar, and set is_focus=true on findings about it.` : 'No specific grammar focus.'}

NOEL'S WORDS (weave these in naturally, favour TROUBLE WORDs; report each one Noel uses in words_used with its id):
${wordLines || '  (none)'}

${warmSection}

NO PRAISE: Never tell Noel he was right. Do not write "¡Perfecto!", "¡Muy bien!", "¡Correcto!", "¡Exacto!", "Good" or anything similar, in the reply or in findings. When his message is correct, simply continue (or go straight to the next warm-up item). The only exception is review items in a REVIEW SESSION, which get "Correct." as described above. Only corrections, better phrasings, gaps and answers to his questions are worth saying.

CORRECTION RULES (apply to every message Noel writes in Spanish, covering ALL aspects: conjugation, tense/mood choice, agreement, ser/estar, por/para, prepositions, pronouns, articles, word choice, word order, spelling and accents, and naturalness):
- If his message is perfect: no findings at all; just continue the conversation.
- If correct but a more natural phrasing exists: add an "improvement" finding and continue.
- If wrong: add "error" findings (one per distinct problem), set ask_retry=true, and make the reply ONLY a short request to try again (e.g. "Casi. Inténtalo otra vez."). Do not continue the scene until the retry.
- RULE: any "error" or "gap" finding on a Spanish message means ask_retry=true and a short try-again reply. Never continue the conversation in that case.
- On a retry turn (turn_type "retry"), judge the new attempt the same way; if it is right, continue the scene without comment.
- Be critical and thorough, but every explanation must be brief (one short English sentence).
- When Noel lacks a word or phrase and falls back to English inside a Spanish message, record a "gap" finding with the Spanish he needed, set ask_retry=true, and ask him to say it again fully in Spanish.
- Put feedback ONLY in findings. The reply is the conversational message, not a list of corrections.

ASIDES: Noel may write questions or comments in English at any time ("How do I say...?", "Is there a better way to say that?", "Why imperfect here?", "Slow down", "I think I was right"). Treat these as turn_type "aside": answer briefly in English with Spanish examples, then add one short Spanish line that resumes the conversation where it left off. Do not create error findings for asides. Instructions like "slow down" or "use simpler words" apply for the rest of the session.
- If an aside asks how to say something, also add a "gap" finding (original = his English, corrected = the Spanish).
- If he disputes an earlier correction (each earlier correction is labelled with #id in the history), reconsider it honestly. Report it in disputed_findings with upheld=true if he was actually right (the correction was wrong or overly strict, or the usage is valid regionally), otherwise upheld=false and explain briefly why.
- A message beginning with "?" is always an aside.
- A user message in parentheses such as "(Noel is back...)" is a note from the app, not something Noel wrote: never correct it.

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
      reply: { type: 'string', description: 'The message shown to Noel in the chat (without your name in front).' },
      speaker: { type: 'string', description: 'First name of the character speaking in this reply.' },
      speaker_gender: { type: 'string', enum: ['F', 'M'] },
      spoken: { type: 'string', description: 'Only the in-character Spanish dialogue from the reply, to be read aloud. Empty for corrections, asides and warm-up items.' },
      ask_retry: { type: 'boolean' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['error', 'improvement', 'gap'] },
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
function buildMessages(turns, findings, newMessage, aiName) {
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
      const sp = parseJson(t.MetaJson, {}).speaker;
      if (sp && aiName && sp !== aiName) content = `[${sp} speaking] ` + content;
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
  if (newMessage != null) msgs.push({ role: 'user', content: newMessage });
  return msgs;
}

const PREPARE_TOOL = (maxItems) => ({
  name: 'prepare_session',
  description: 'Prepare the session.',
  input_schema: {
    type: 'object',
    properties: {
      ai_name: { type: 'string', description: 'The tutor\'s first name. If the setting gives the tutor a name, use it; otherwise use the suggested name, or choose a common Latin American first name.' },
      ai_role: { type: 'string', description: 'Short English description of the role the tutor plays, e.g. "Listener to your story" or "Porter on the Inca Trail, day 2".' },
      focus_grammar: { type: 'string', description: 'Grammar Noel wants to focus on, e.g. "imperfect". Empty string if none was mentioned; you may add one weak category if it fits naturally.' },
      warmup: {
        type: 'array', maxItems,
        items: { type: 'object', properties: {
          prompt: { type: 'string', description: 'Short instruction to Noel, e.g. "Last time you wrote \'si yo tendría\'. Say: If I had time, I would go." ' },
          target: { type: 'string', description: 'The correct Spanish answer.' } }, required: ['prompt', 'target'] }
      }
    },
    required: ['ai_name', 'ai_role', 'focus_grammar', 'warmup']
  }
});

// ---------- actions ----------
async function startSession(pool, b) {
  const userID = parseInt(b.userID);
  const languageID = parseInt(b.languageID) || 1;
  const { useWords, deckID } = wordsChoice(b.deckID);
  const level = clampInt(b.level, 1, 10, 5);
  const minutes = clampInt(b.minutes, 1, 120, 15);
  const includeSpain = !!b.includeSpain;
  const reviewOf = b.reviewOf ? await loadSession(pool, parseInt(b.reviewOf), userID) : null;
  const userSetting = String(b.setting || '').trim();

  const words = await pickWords(pool, userID, languageID, deckID, useWords);
  let setting, prepareMsg, maxItems;

  if (reviewOf) {
    const pf = (await loadFindings(pool, reviewOf.LangSessionID))
      .filter(f => !f.Voided && ['error', 'improvement', 'gap'].includes(f.FindingType));
    setting = `Review of an earlier conversation ("${reviewOf.Title || reviewOf.AIRole || 'conversation'}"). Original setting: ${reviewOf.Setting}${userSetting ? `\nExtra instructions from Noel: ${userSetting}` : ''}`;
    maxItems = 8;
    prepareMsg =
`This is a REVIEW session of an earlier conversation.
Original setting: """${reviewOf.Setting}"""
${userSetting ? `Extra instructions from Noel: """${userSetting}"""\n` : ''}Level: ${level}/10.
Suggested tutor name: ${reviewOf.AIName || '(none)'}
Corrections, better phrasings and gaps from that conversation (pick up to 8 of the most important as review items, covering different problems; if fewer exist, use what there is):
${pf.map(e => `- [${e.FindingType}/${e.Category}] "${e.Original}" -> "${e.Corrected}" (${e.Explanation || ''})`).join('\n') || '(none - build items from the key vocabulary of the original setting instead)'}`;
  } else if (b.personalReview) {
    // Personal Review: drill recent mistakes from all conversations, then a short conversation that reuses them
    const recent = async days => (await pool.request().input('U', sql.Int, userID).input('D', sql.Int, days)
      .query(`SELECT TOP 20 FindingType, Category, Original, Corrected, Explanation FROM LangFinding
              WHERE UserID = @U AND FindingType IN ('error', 'gap') AND Voided = 0
                AND (@D IS NULL OR CreatedDate >= DATEADD(day, -@D, GETDATE()))
              ORDER BY ISNULL(Severity, 1) DESC, CreatedDate DESC`)).recordset;
    let pf = await recent(30);
    if (!pf.length) pf = await recent(null);
    if (!pf.length) throw new Error('No mistakes to review yet. Have a conversation first.');
    setting = `Personal review of Noel's recent mistakes.${userSetting ? ` Setting for the conversation afterwards: ${userSetting}` : ' Afterwards, a short everyday conversation.'}`;
    maxItems = 8;
    prepareMsg =
`This is a PERSONAL REVIEW session: drill Noel's recent mistakes from all his conversations.
${userSetting ? `Setting for the short conversation after the review items: """${userSetting}"""\n` : ''}Level: ${level}/10.
Recent mistakes (pick up to 8 of the most instructive as review items, covering different problems; skip duplicates):
${pf.map(e => `- [${e.FindingType}/${e.Category}] "${e.Original}" -> "${e.Corrected}" (${e.Explanation || ''})`).join('\n')}`;
  } else {
    // New conversation: no warm-up (that's what Personal Review is for). Weak categories may suggest a focus.
    setting = userSetting || 'Free conversation about everyday life.';
    maxItems = 0;
    const cr = await pool.request().input('U', sql.Int, userID)
      .query(`SELECT TOP 3 Category, COUNT(*) AS N FROM LangFinding
              WHERE UserID = @U AND FindingType = 'error' AND Voided = 0 AND CreatedDate >= DATEADD(day, -30, GETDATE())
              GROUP BY Category ORDER BY COUNT(*) DESC`);
    prepareMsg =
`Setting description from Noel: """${setting}"""
Level: ${level}/10.
No warm-up: return an empty warmup list.
Weakest categories recently: ${cr.recordset.map(r => r.Category).join(', ') || '(none)'}`;
  }

  // Main character's voice: the one picked on the setup screen, else the user's default
  const allVoices = await activeVoices(pool);
  const dfltVoice = await userDefaultVoice(pool, userID, allVoices);
  const mainVoice = allVoices.find(v => v.VoiceCode === b.voiceCode) || allVoices.find(v => v.VoiceCode === dfltVoice);
  if (mainVoice) prepareMsg += `\nThe tutor's voice is ${mainVoice.Gender === 'F' ? 'female' : 'male'}: unless the setting names the tutor, choose a ${mainVoice.Gender === 'F' ? 'female' : 'male'} first name (the suggested name only if it fits).`;

  const setup = await callTool(
    'You prepare Spanish conversation practice sessions. Interpret the learner\'s setting description and prepare the session.',
    [{ role: 'user', content: prepareMsg }], PREPARE_TOOL(maxItems), 1500);
  if (!maxItems) setup.warmup = [];

  const ins = await pool.request()
    .input('U', sql.Int, userID).input('L', sql.Int, languageID).input('D', sql.Int, deckID)
    .input('P', sql.Int, reviewOf ? reviewOf.LangSessionID : null)
    .input('Level', sql.TinyInt, level).input('Min', sql.SmallInt, minutes)
    .input('Setting', sql.NVarChar(2000), setting.slice(0, 2000))
    .input('Focus', sql.NVarChar(400), (setup.focus_grammar || '').slice(0, 400) || null)
    .input('Spain', sql.Bit, includeSpain)
    .input('Role', sql.NVarChar(200), (setup.ai_role || '').slice(0, 200))
    .input('Name', sql.NVarChar(50), (setup.ai_name || 'Raúl').slice(0, 50))
    .input('Type', sql.NVarChar(20), (reviewOf || b.personalReview) ? 'review' : 'conversation')
    .input('Words', sql.NVarChar(sql.MAX), JSON.stringify(words))
    .input('Warm', sql.NVarChar(sql.MAX), JSON.stringify(setup.warmup || []))
    .input('UseW', sql.Bit, useWords)
    .query(`INSERT INTO LangSession (UserID, LanguageID, DeckID, ParentSessionID, Level, DurationMinutes, Setting, FocusGrammar,
                                     IncludeSpainNotes, AIRole, AIName, SessionType, WordsJson, WarmupJson, SegmentStart, ResumeTurnNumber, UseMyWords)
            OUTPUT INSERTED.*
            VALUES (@U, @L, @D, @P, @Level, @Min, @Setting, @Focus, @Spain, @Role, @Name, @Type, @Words, @Warm, GETDATE(), 0, @UseW)`);
  const session = ins.recordset[0];

  const open = await callTool(buildSystemPrompt(session, minutes),
    [{ role: 'user', content: '(Session start. Please begin: either the first warm-up/review item, or set the scene in one or two sentences and invite Noel to start. If Noel said he will tell a story, briefly invite him to begin.)' }],
    RESPOND_TOOL, 800);

  const openType = open.turn_type === 'warmup' ? 'warmup' : 'practice';
  const openMeta = aiTurnMeta(session, open, openType);
  let voices = {};
  if (mainVoice) {
    voices = await assignVoice(pool, session, session.AIName, mainVoice.Gender, mainVoice.VoiceCode);
    await saveDefaultVoice(pool, userID, mainVoice.VoiceCode);
  }
  if (openMeta.speaker !== session.AIName && openMeta.spoken) voices = await assignVoice(pool, session, openMeta.speaker, openMeta.gender);

  await pool.request()
    .input('S', sql.Int, session.LangSessionID)
    .input('Type', sql.NVarChar(20), openType)
    .input('C', sql.NVarChar(sql.MAX), open.reply)
    .input('M', sql.NVarChar(sql.MAX), JSON.stringify({ speaker: openMeta.speaker, spoken: openMeta.spoken }))
    .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content, MetaJson) VALUES (@S, 1, 'A', @Type, @C, @M)`);

  return {
    sessionID: session.LangSessionID, aiName: session.AIName, aiRole: session.AIRole, focusGrammar: session.FocusGrammar,
    sessionType: session.SessionType, title: reviewOf ? `Review: ${reviewOf.Title || 'conversation'}` : b.personalReview ? 'Personal Review' : '',
    minutes, voices, messages: [{ role: 'A', text: open.reply, type: openType, speaker: openMeta.speaker, spoken: openMeta.spoken }]
  };
}

async function continueSession(pool, b) {
  const userID = parseInt(b.userID);
  const s = await loadSession(pool, parseInt(b.sessionID), userID);
  const { useWords, deckID } = wordsChoice(b.deckID);
  const level = clampInt(b.level, 1, 10, s.Level);
  const minutes = clampInt(b.minutes, 1, 120, s.DurationMinutes);
  const words = await pickWords(pool, userID, s.LanguageID, deckID, useWords);
  const turns = await loadTurns(pool, s.LangSessionID);
  const lastNum = turns.length ? turns[turns.length - 1].TurnNumber : 0;

  await pool.request()
    .input('S', sql.Int, s.LangSessionID).input('D', sql.Int, deckID).input('Level', sql.TinyInt, level)
    .input('Min', sql.SmallInt, minutes).input('Spain', sql.Bit, !!b.includeSpain)
    .input('Words', sql.NVarChar(sql.MAX), JSON.stringify(words)).input('R', sql.Int, lastNum).input('UseW', sql.Bit, useWords)
    .query(`UPDATE LangSession SET Status = 'Active', DeckID = @D, UseMyWords = @UseW, Level = @Level, DurationMinutes = @Min, IncludeSpainNotes = @Spain,
              WordsJson = @Words, WarmupJson = '[]', SegmentStart = GETDATE(), ResumeTurnNumber = @R, EndedDate = NULL
            WHERE LangSessionID = @S`);
  const s2 = await loadSession(pool, s.LangSessionID, userID);
  const findings = await loadFindings(pool, s.LangSessionID);

  const note = '(Noel is back to continue this conversation. Greet him briefly and pick up where you left off.)';
  const out = await callTool(buildSystemPrompt(s2, minutes), buildMessages(turns, findings, note, s2.AIName), RESPOND_TOOL, 800);
  const outType = out.turn_type === 'aside' ? 'practice' : out.turn_type;
  const meta = aiTurnMeta(s2, out, outType);
  let voices = await ensureMainVoice(pool, s2);   // resumed conversations keep their saved voices
  if (meta.speaker !== s2.AIName && meta.spoken) voices = await assignVoice(pool, s2, meta.speaker, meta.gender);

  await pool.request()
    .input('S', sql.Int, s.LangSessionID).input('N', sql.Int, lastNum + 1).input('C', sql.NVarChar(sql.MAX), note)
    .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content) VALUES (@S, @N, 'U', 'resume', @C)`);
  await pool.request()
    .input('S', sql.Int, s.LangSessionID).input('N', sql.Int, lastNum + 2).input('C', sql.NVarChar(sql.MAX), out.reply)
    .input('Type', sql.NVarChar(20), outType)
    .input('M', sql.NVarChar(sql.MAX), JSON.stringify({ speaker: meta.speaker, spoken: meta.spoken }))
    .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content, MetaJson) VALUES (@S, @N, 'A', @Type, @C, @M)`);

  const turns2 = await loadTurns(pool, s.LangSessionID);
  return {
    sessionID: s2.LangSessionID, aiName: s2.AIName, aiRole: s2.AIRole, focusGrammar: s2.FocusGrammar,
    sessionType: s2.SessionType, title: s2.Title || '', minutes, voices, messages: visibleMessages(turns2, findings)
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
  const segStart = new Date(s.SegmentStart || s.StartedDate).getTime();
  const minutesLeft = s.DurationMinutes - (Date.now() - segStart) / 60000;

  const sys = buildSystemPrompt(s, minutesLeft);
  const msgs = buildMessages(turns, findings, message, s.AIName);
  const needsRetry = o => o.turn_type !== 'aside' && (o.findings || []).some(f => f.type === 'error' || f.type === 'gap');
  let out = await callTool(sys, msgs, RESPOND_TOOL, 2000);
  if (needsRetry(out) && !out.ask_retry) {
    // The reply carried on with the conversation despite errors - ask again, then force a retry if needed
    try {
      const out2 = await callTool(sys + '\n\nYOUR PREVIOUS DRAFT continued the conversation even though his message had errors or missing words. This time set ask_retry=true and make the reply only a short request to try again.', msgs, RESPOND_TOOL, 2000);
      if (needsRetry(out2) && out2.ask_retry) out = out2;
    } catch (e) { /* fall through */ }
    if (!out.ask_retry) { out.ask_retry = true; out.reply = 'Casi. Inténtalo otra vez.'; }
  }
  if (needsRetry(out)) out.ask_retry = true;
  const aiType = out.ask_retry ? 'correction' : out.turn_type;
  const aiMeta = aiTurnMeta(s, out, aiType);
  let voices = await ensureMainVoice(pool, s);
  if (aiMeta.speaker !== s.AIName && aiMeta.spoken) voices = await assignVoice(pool, s, aiMeta.speaker, aiMeta.gender);

  const validWordIDs = new Set(parseJson(s.WordsJson, []).map(w => w.id));
  const usedWords = (out.words_used || []).filter(w => validWordIDs.has(w.word_id));
  const nextNum = (turns.length ? turns[turns.length - 1].TurnNumber : 0) + 1;
  const userType = ['aside', 'retry', 'warmup'].includes(out.turn_type) ? out.turn_type : 'practice';
  const meta = {
    tenses: out.tenses_used || [], englishUsed: !!out.english_used, words: wordCount(message),
    wordsUsed: usedWords.map(w => ({ id: w.word_id, ok: !!w.correct }))
  };

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
      if (f.type === 'strength') continue;
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

    for (const w of usedWords) {
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
      .input('Type', sql.NVarChar(20), aiType).input('C', sql.NVarChar(sql.MAX), out.reply)
      .input('M', sql.NVarChar(sql.MAX), JSON.stringify({ speaker: aiMeta.speaker, spoken: aiMeta.spoken }))
      .query(`INSERT INTO LangTurn (LangSessionID, TurnNumber, Role, TurnType, Content, MetaJson) VALUES (@S, @N, 'A', @Type, @C, @M)`);

    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }

  return {
    reply: out.reply, turnType: aiType, askRetry: !!out.ask_retry,
    speaker: aiMeta.speaker, spoken: aiMeta.spoken, voices,
    findings: saved.map(fmtFinding),
    disputed: out.disputed_findings || [],
    minutesLeft: Math.max(0, minutesLeft)
  };
}

async function buildSummary(pool, s) {
  const turns = await loadTurns(pool, s.LangSessionID);
  const allFindings = await loadFindings(pool, s.LangSessionID);
  const findings = allFindings.filter(f => !f.Voided && f.FindingType !== 'strength');
  const userTurns = turns.filter(t => t.Role === 'U');
  const spoken = userTurns.filter(t => ['practice', 'retry', 'warmup'].includes(t.TurnType));  // Spanish messages he wrote (not questions/asides)
  const metas = spoken.map(t => parseJson(t.MetaJson, {}));
  const tenses = [...new Set(metas.flatMap(m => m.tenses || []))];
  const byCat = {};
  findings.filter(f => f.FindingType === 'error').forEach(f => { byCat[f.Category] = (byCat[f.Category] || 0) + 1; });

  // Active minutes: gaps between turns, each capped at 5 minutes (so breaks between sittings don't count)
  let ms = 0;
  for (let i = 1; i < turns.length; i++) {
    const gap = new Date(turns[i].CreatedDate) - new Date(turns[i - 1].CreatedDate);
    if (gap > 0) ms += Math.min(gap, 5 * 60000);
  }

  // Score 0-100: accuracy per message (errors weighted by severity, better phrasings and gaps count
  // less), small penalties for English mixed in and for asking questions, scaled by level (level 10 = full value).
  const spokenIDs = new Set(spoken.map(t => t.LangTurnID));
  const pen = {};
  findings.forEach(f => {
    if (!spokenIDs.has(f.LangTurnID)) return;
    const p = f.FindingType === 'error' ? (f.Severity || 1) : f.FindingType === 'gap' ? 1 : f.FindingType === 'improvement' ? 0.5 : 0;
    pen[f.LangTurnID] = (pen[f.LangTurnID] || 0) + p;
  });
  const asideCount = userTurns.filter(t => t.TurnType === 'aside').length;
  let score = null;
  if (spoken.length) {
    const errPenalty = spoken.reduce((a, t) => a + Math.min(1, (pen[t.LangTurnID] || 0) / 3), 0) / spoken.length;
    const engFrac = metas.filter(m => m.englishUsed).length / spoken.length;
    const askFrac = Math.min(1, asideCount / spoken.length);
    const raw = Math.max(0, 1 - 0.75 * errPenalty - 0.15 * engFrac - 0.10 * askFrac);
    score = Math.round(100 * raw * (0.8 + 0.02 * s.Level));
  }

  return {
    score,
    minutes: Math.round(ms / 60000),
    messages: spoken.length,
    correct: spoken.filter(t => !findings.some(f => f.LangTurnID === t.LangTurnID && (f.FindingType === 'error' || f.FindingType === 'gap'))).length,
    avgWordsPerMessage: spoken.length ? Math.round(10 * metas.reduce((a, m) => a + (m.words || 0), 0) / spoken.length) / 10 : 0,
    englishMixRate: spoken.length ? Math.round(100 * metas.filter(m => m.englishUsed).length / spoken.length) : 0,
    tensesUsed: tenses,
    asides: asideCount,
    retries: userTurns.filter(t => t.TurnType === 'retry').length,
    errors: findings.filter(f => f.FindingType === 'error').length,
    focusErrors: findings.filter(f => f.FindingType === 'error' && f.IsFocus).length,
    improvements: findings.filter(f => f.FindingType === 'improvement').length,
    gaps: findings.filter(f => f.FindingType === 'gap').length,
    errorsByCategory: byCat,
    withdrawnAfterDispute: allFindings.filter(f => f.Voided).length
  };
}

// End Session: stop the clock, compute stats and score. Notes are cleared so they cover everything next time.
async function endSession(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  await pool.request().input('S', sql.Int, s.LangSessionID)
    .query(`UPDATE LangSession SET Status = 'Completed', EndedDate = GETDATE() WHERE LangSessionID = @S`);
  const summary = await buildSummary(pool, s);
  await pool.request().input('S', sql.Int, s.LangSessionID).input('J', sql.NVarChar(sql.MAX), JSON.stringify(summary))
    .input('Score', sql.TinyInt, summary.score)
    .query(`UPDATE LangSession SET SummaryJson = @J, Score = @Score, StudyNotes = NULL, SuggestedLevel = NULL WHERE LangSessionID = @S`);
  return { summary };
}

// Save & Close: add to (or refresh in) the saved list.
async function saveSession(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  let title = s.Title;
  if (!title) {
    if (s.SessionType === 'review' && s.ParentSessionID) {
      const p = await pool.request().input('P', sql.Int, s.ParentSessionID).query(`SELECT Title FROM LangSession WHERE LangSessionID = @P`);
      title = `Review: ${(p.recordset[0] && p.recordset[0].Title) || 'conversation'}`;
    } else if (s.SessionType === 'review' && /^Personal review/.test(s.Setting || '')) {
      title = `Personal Review ${new Date(s.StartedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    } else {
      const turns = await loadTurns(pool, s.LangSessionID);
      const opening = turns.slice(0, 8).map(t => `${t.Role === 'U' ? 'NOEL' : 'TUTOR'}: ${t.Content}`).join('\n');
      try {
        const out = await callTool('You name saved Spanish conversation practice sessions.',
          [{ role: 'user', content: `Setting: ${s.Setting}\nRole: ${s.AIRole || ''}\nOpening of the conversation:\n${opening}\n\nGive a short, specific English title of 3-6 words.` }],
          { name: 'name_session', description: 'Return the title.', input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, 300);
        title = String(out.title || '').trim();
      } catch (e) { /* fall back below */ }
    }
    if (!title) title = (s.AIRole || s.Setting || 'Conversation').slice(0, 60);
  }
  await pool.request().input('S', sql.Int, s.LangSessionID).input('T', sql.NVarChar(200), title.slice(0, 200))
    .query(`UPDATE LangSession SET Title = @T, IsSaved = 1, SavedDate = GETDATE() WHERE LangSessionID = @S`);
  return { title };
}

// Cancel: remove everything from this sitting, including corrections and word history.
// A continued saved conversation keeps its earlier part; a new session is deleted entirely.
async function discardSession(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  const keepUpTo = s.ResumeTurnNumber || 0;
  const turns = (await loadTurns(pool, s.LangSessionID)).filter(t => t.TurnNumber > keepUpTo);
  const deleteAll = keepUpTo === 0;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const t of turns.filter(t => t.Role === 'U')) {
      for (const w of (parseJson(t.MetaJson, {}).wordsUsed || [])) {
        await new sql.Request(tx).input('U', sql.Int, s.UserID).input('W', sql.Int, w.id).input('Ok', sql.Bit, !!w.ok)
          .query(`UPDATE LangWordProgress SET
                    TimesUsed = CASE WHEN TimesUsed > 0 THEN TimesUsed - 1 ELSE 0 END,
                    TimesCorrect = CASE WHEN @Ok = 1 AND TimesCorrect > 0 THEN TimesCorrect - 1 ELSE TimesCorrect END,
                    TimesWrong = CASE WHEN @Ok = 0 AND TimesWrong > 0 THEN TimesWrong - 1 ELSE TimesWrong END
                  WHERE UserID = @U AND UserLanguageWordsID = @W`);
      }
    }
    await new sql.Request(tx).input('S', sql.Int, s.LangSessionID).input('K', sql.Int, keepUpTo)
      .query(`DELETE FROM LangFinding WHERE LangSessionID = @S AND LangTurnID IN (SELECT LangTurnID FROM LangTurn WHERE LangSessionID = @S AND TurnNumber > @K);
              DELETE FROM LangTurn WHERE LangSessionID = @S AND TurnNumber > @K;`);
    if (deleteAll) {
      await new sql.Request(tx).input('S', sql.Int, s.LangSessionID)
        .query(`UPDATE LangSession SET ParentSessionID = NULL WHERE ParentSessionID = @S;
                DELETE FROM LangSessionVoice WHERE LangSessionID = @S;
                DELETE FROM LangSession WHERE LangSessionID = @S;`);
    } else {
      await new sql.Request(tx).input('S', sql.Int, s.LangSessionID)
        .query(`UPDATE LangSession SET Status = 'Completed', SegmentStart = NULL, EndedDate = ISNULL(EndedDate, GETDATE()) WHERE LangSessionID = @S`);
    }
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }
  if (!deleteAll) {
    // Restore the earlier part's stats and score
    const s2 = await loadSession(pool, s.LangSessionID, s.UserID);
    const summary = await buildSummary(pool, s2);
    await pool.request().input('S', sql.Int, s.LangSessionID).input('J', sql.NVarChar(sql.MAX), JSON.stringify(summary))
      .input('Score', sql.TinyInt, summary.score)
      .query(`UPDATE LangSession SET SummaryJson = @J, Score = @Score WHERE LangSessionID = @S`);
  }
  return { success: true };
}

async function listSessions(pool, b) {
  const r = await pool.request().input('U', sql.Int, parseInt(b.userID)).input('L', sql.Int, parseInt(b.languageID) || 1)
    .query(`SELECT LangSessionID AS id, Title AS title, ISNULL(SavedDate, StartedDate) AS date, Score AS score,
                   TRY_CAST(JSON_VALUE(SummaryJson, '$.minutes') AS int) AS actualMinutes,
                   Level AS level, DurationMinutes AS minutes, DeckID AS deckID, UseMyWords AS useWords, IncludeSpainNotes AS spain, SessionType AS type
            FROM LangSession WHERE UserID = @U AND LanguageID = @L AND IsSaved = 1
            ORDER BY ISNULL(SavedDate, StartedDate) DESC`);
  return { sessions: r.recordset };
}

// Removes a conversation from the saved list. Its corrections stay in the progress history.
async function deleteSession(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  await pool.request().input('S', sql.Int, s.LangSessionID)
    .query(`UPDATE LangSession SET IsSaved = 0 WHERE LangSessionID = @S`);
  return { success: true };
}

async function loadConversation(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  const turns = await loadTurns(pool, s.LangSessionID);
  const findings = await loadFindings(pool, s.LangSessionID);
  let summary = parseJson(s.SummaryJson, null);
  if (!summary || summary.score === undefined) summary = await buildSummary(pool, s);
  return {
    sessionID: s.LangSessionID, title: s.Title, aiName: s.AIName, aiRole: s.AIRole, focusGrammar: s.FocusGrammar,
    sessionType: s.SessionType, date: s.SavedDate || s.StartedDate, summary,
    notes: s.StudyNotes ? s.StudyNotes + await myWordsSection(pool, s) : null,
    messages: visibleMessages(turns, findings)
  };
}

// "My Words used" section: which of Noel's words he used in this conversation (✗ = used incorrectly at least once)
async function myWordsSection(pool, s) {
  const turns = await loadTurns(pool, s.LangSessionID);
  const uses = {};
  turns.filter(t => t.Role === 'U').forEach(t => (parseJson(t.MetaJson, {}).wordsUsed || []).forEach(w => {
    uses[w.id] = uses[w.id] || { ok: 0, bad: 0 };
    if (w.ok) uses[w.id].ok++; else uses[w.id].bad++;
  }));
  const ids = Object.keys(uses).map(Number).filter(n => !isNaN(n));
  if (!ids.length) return '\n\n## My Words used\n- None of your words were used in this session.';
  const r = await pool.request().input('U', sql.Int, s.UserID)
    .query(`SELECT UserLanguageWordsID, WordsName, WordsTranslation FROM UserLanguageWords
            WHERE UserID = @U AND UserLanguageWordsID IN (${ids.join(',')}) ORDER BY WordsName`);
  const lines = r.recordset.map(w => {
    const u = uses[w.UserLanguageWordsID];
    return `- ${u.bad ? '✗ ' : ''}**${w.WordsName}**${w.WordsTranslation ? ' - ' + w.WordsTranslation : ''}`;
  });
  const anyBad = r.recordset.some(w => uses[w.UserLanguageWordsID].bad);
  return '\n\n## My Words used\n' + lines.join('\n') + (anyBad ? '\n✗ = used incorrectly at least once' : '');
}

async function studyNotes(pool, b) {
  const s = await loadSession(pool, parseInt(b.sessionID), parseInt(b.userID));
  if (s.StudyNotes && !b.regenerate) return { notes: s.StudyNotes + await myWordsSection(pool, s), suggestedLevel: s.SuggestedLevel };
  const turns = (await loadTurns(pool, s.LangSessionID)).filter(t => t.TurnType !== 'resume');
  const findings = await loadFindings(pool, s.LangSessionID);
  const summary = parseJson(s.SummaryJson, null) || await buildSummary(pool, s);
  const name = s.AIName || 'TUTOR';

  // A continued conversation: mark what happened in the latest sitting so the notes can lead with it
  const resumeAt = s.ResumeTurnNumber || 0;
  const continued = resumeAt > 0 && turns.some(t => t.TurnNumber > resumeAt);
  const turnNum = {};
  turns.forEach(t => { turnNum[t.LangTurnID] = t.TurnNumber; });
  let marked = false;
  const transcript = turns.map(t => {
    let line = `${t.Role === 'U' ? 'NOEL' : name.toUpperCase()} (${t.TurnType}): ${t.Content}`;
    if (continued && !marked && t.TurnNumber > resumeAt) { marked = true; line = '----- LATEST SITTING STARTS HERE -----\n' + line; }
    return line;
  }).join('\n');
  const fbLines = findings.filter(f => !f.Voided && f.FindingType !== 'strength').map(f =>
    `- ${f.FindingType}/${f.Category}${f.IsFocus ? ' [focus]' : ''}${continued && turnNum[f.LangTurnID] > resumeAt ? ' [latest sitting]' : ''}: "${f.Original}" -> "${f.Corrected}" - ${f.Explanation || ''}${f.SpainNote ? ' | Spain: ' + f.SpainNote : ''}`).join('\n');

  const out = await callTool(
    'You write concise, practical study notes for an adult learner of conversational Spanish after a practice session. Write in English with Spanish examples. Use markdown: ## headings and - bullets, **bold** for key Spanish. No filler and no praise.',
    [{ role: 'user', content:
`Session: level ${s.Level}/10, setting: ${s.Setting}. Focus grammar: ${s.FocusGrammar || 'none'}.

Stats: ${JSON.stringify(summary)}

Feedback recorded:
${fbLines || '(none)'}

Transcript:
${transcript}

BE CONCISE. Short lines, no repetition, no "Noel:" labels, no restating the same rule in different words.

Write study notes with these sections, in this order:
${continued ? '## This sitting - 2-4 bullets on the LATEST SITTING only: new problems, and earlier problems he now gets right or still gets wrong.\n' : ''}## Main errors and fixes - one bullet per error pattern, most important first${continued ? ' (include the whole conversation, latest sitting first)' : ''}. Format each one exactly like this:
- "what he wrote" → **corrected Spanish**
  - the rule in one short line, with an example only if it adds something
Use at most two indented sub-bullets per error. Add "(focus)" after the corrected Spanish if it is focus grammar.
## Phrases worth keeping - at most 6. Each as a bullet "- **Spanish phrase**", followed on the next line by the English translation indented with two spaces. Leave a blank line between phrases.
## Vocabulary - at most 12 key words used by either Noel or the tutor, one bullet each: "- **word** - English meaning". Put ⚠ at the start of any word Noel did not understand (he asked about it, misused it, or it had to be explained). End the section with the line "⚠ = not understood" if any are marked.
${s.IncludeSpainNotes ? '## Spain vs Latin America - only if relevant, at most 3 bullets.\n' : ''}## Practice - 3-4 sentences to translate into Spanish, with answers at the end.
## Fluency - one line interpreting the stats.
Do not include a strengths or praise section. Also suggest the level for the next session.` }],
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
  return { notes: notes + await myWordsSection(pool, s), suggestedLevel: out.suggested_level };
}

// Estimated CEFR level from all conversation practice so far
async function assessLevel(pool, b) {
  const userID = parseInt(b.userID);
  const languageID = parseInt(b.languageID) || 1;
  const req = () => pool.request().input('U', sql.Int, userID).input('L', sql.Int, languageID);

  const sess = (await req().query(`SELECT TOP 30 LangSessionID, Level, Score, SessionType, SummaryJson, StartedDate, Setting
      FROM LangSession WHERE UserID = @U AND LanguageID = @L AND Status = 'Completed' ORDER BY StartedDate DESC`)).recordset;
  if (!sess.length) return { empty: true };

  const cats = (await req().query(`SELECT f.Category,
        SUM(CASE WHEN f.CreatedDate >= DATEADD(day, -14, GETDATE()) THEN 1 ELSE 0 END) AS Last14,
        SUM(CASE WHEN f.CreatedDate < DATEADD(day, -14, GETDATE()) THEN 1 ELSE 0 END) AS Earlier
      FROM LangFinding f JOIN LangSession s ON s.LangSessionID = f.LangSessionID
      WHERE f.UserID = @U AND s.LanguageID = @L AND f.Voided = 0 AND f.FindingType = 'error'
      GROUP BY f.Category ORDER BY COUNT(*) DESC`)).recordset;
  const examples = (await req().query(`SELECT TOP 25 f.FindingType, f.Category, f.Original, f.Corrected
      FROM LangFinding f JOIN LangSession s ON s.LangSessionID = f.LangSessionID
      WHERE f.UserID = @U AND s.LanguageID = @L AND f.Voided = 0 AND f.FindingType IN ('error', 'gap')
      ORDER BY f.CreatedDate DESC`)).recordset;
  const samples = (await req().query(`SELECT TOP 40 t.Content
      FROM LangTurn t JOIN LangSession s ON s.LangSessionID = t.LangSessionID
      WHERE s.UserID = @U AND s.LanguageID = @L AND t.Role = 'U' AND t.TurnType IN ('practice', 'retry')
      ORDER BY t.CreatedDate DESC`)).recordset;
  const wp = (await req().query(`SELECT COUNT(*) AS Words, SUM(g.TimesCorrect) AS Correct, SUM(g.TimesWrong) AS Wrong
      FROM LangWordProgress g JOIN UserLanguageWords w ON w.UserLanguageWordsID = g.UserLanguageWordsID
      WHERE g.UserID = @U AND w.LanguageID = @L`)).recordset[0] || {};

  const sessLines = sess.map(x => {
    const m = parseJson(x.SummaryJson, {});
    return `- ${new Date(x.StartedDate).toISOString().slice(0, 10)} ${x.SessionType} L${x.Level} score ${x.Score ?? '-'} msgs ${m.messages ?? '-'} correct ${m.correct ?? '-'} words/msg ${m.avgWordsPerMessage ?? '-'} english% ${m.englishMixRate ?? '-'} tenses: ${(m.tensesUsed || []).join(', ')}`;
  }).join('\n');

  const out = await callTool(
    'You are an experienced Spanish teacher and CEFR examiner. Estimate a learner\'s CEFR level from his written conversation practice data. Be honest and specific. Keep everything brief: the whole report must fit on one printed page.',
    [{ role: 'user', content:
`Learner: Noel, adult English speaker practising conversational Spanish (written chat, Latin American Spanish).

Sessions (newest first; app level 1-10 is the difficulty he chose):
${sessLines}

Error counts by category (last 14 days / earlier):
${cats.map(c => `- ${c.Category}: ${c.Last14} / ${c.Earlier}`).join('\n') || '(none)'}

Recent errors and gaps:
${examples.map(e => `- [${e.FindingType}/${e.Category}] "${e.Original}" -> "${e.Corrected}"`).join('\n') || '(none)'}

Samples of his recent Spanish messages:
${samples.map(x => `- ${x.Content}`).join('\n') || '(none)'}

My Words tracking: ${wp.Words || 0} words used in conversation, ${wp.Correct || 0} correct uses, ${wp.Wrong || 0} incorrect uses.

Give a best-estimate CEFR level, sub-skill estimates for what written chat can show, and brief strengths, weaknesses and focus areas. If there is little data, say so via confidence "low".` }],
    {
      name: 'cefr_report',
      description: 'Return the level report.',
      input_schema: {
        type: 'object',
        properties: {
          level: { type: 'string', description: 'Best estimate, e.g. "A2", "B1" or "B1+"' },
          level_name: { type: 'string', description: 'e.g. "Intermediate"' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          summary: { type: 'string', description: 'Two or three sentences.' },
          skills: {
            type: 'array', maxItems: 5,
            items: { type: 'object', properties: { skill: { type: 'string' }, level: { type: 'string' }, note: { type: 'string', description: 'Under 12 words.' } }, required: ['skill', 'level', 'note'] }
          },
          strengths: { type: 'array', maxItems: 4, items: { type: 'string', description: 'One short line.' } },
          weaknesses: { type: 'array', maxItems: 4, items: { type: 'string', description: 'One short line.' } },
          focus: { type: 'array', maxItems: 4, items: { type: 'string', description: 'One concrete action, one short line.' } }
        },
        required: ['level', 'level_name', 'confidence', 'summary', 'skills', 'strengths', 'weaknesses', 'focus']
      }
    }, 2500);

  return Object.assign(out, { sessions: sess.length, date: new Date() });
}

// ---------- entry ----------
module.exports = async function (context, req) {
  try {
    const b = req.body || {};
    if (!b.userID) return respond(context, 400, { error: 'userID required' });
    if (b.action === 'speak') return respond(context, 200, await speak(b));   // no database needed
    const pool = await sql.connect(config);
    let result;
    switch (b.action) {
      case 'start': result = await startSession(pool, b); break;
      case 'continue': result = await continueSession(pool, b); break;
      case 'turn': result = await takeTurn(pool, b); break;
      case 'end': result = await endSession(pool, b); break;
      case 'save': result = await saveSession(pool, b); break;
      case 'discard': result = await discardSession(pool, b); break;
      case 'notes': result = await studyNotes(pool, b); break;
      case 'list': result = await listSessions(pool, b); break;
      case 'delete': result = await deleteSession(pool, b); break;
      case 'load': result = await loadConversation(pool, b); break;
      case 'assess': result = await assessLevel(pool, b); break;
      case 'voices': result = await voicesAction(pool, b); break;
      case 'setVoice': result = await setVoice(pool, b); break;
      default: return respond(context, 400, { error: 'Unknown action' });
    }
    respond(context, 200, result);
  } catch (err) {
    context.log.error('LanguageChat error:', err);
    respond(context, 500, { error: err.message });
  }
};
