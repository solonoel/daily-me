const https = require('https');
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
module.exports = async function(context, req) {
  try {
    const { word, languageCode } = req.body;
    const apiKey = process.env.DEEPL_API_KEY;
    const langMap = {
      'Spanish':    'ES',
      'French':     'FR',
      'Italian':    'IT',
      'Portuguese': 'PT-PT',
      'Romanian':   'RO'
    };
    const targetLang = langMap[languageCode] || 'ES';
    const body = JSON.stringify({
      text: [word],
      target_lang: 'EN-US',
      source_lang: targetLang
    });
    const options = {
      hostname: 'api-free.deepl.com',
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const response = await fetchUrl('https://api-free.deepl.com/v2/translate', options, body);
    const data = JSON.parse(response);
    let translation = data.translations?.[0]?.text || '';
    let gender = null, isVerb = false, presentParticiple = null, pastParticiple = null, wordWithRegion = null;
    try {
      const anthropicBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Classify this ${languageCode} word: "${word}"

Respond with ONLY a JSON object, no markdown, no explanation. Example for a verb:
{"isVerb":true,"gender":null,"synonyms":["to speak","to talk"],"presentParticiple":"hablando","pastParticiple":"hablado","wordWithRegion":"hablar"}

Example for a noun:
{"isVerb":false,"gender":"M","synonyms":["book","text"],"presentParticiple":null,"pastParticiple":null,"wordWithRegion":"el libro"}

Rules:
- isVerb: boolean true if this is a verb, false otherwise. A verb expresses an action or state (hablar, comer, ser, estar, etc.)
- gender: "M" masculine noun, "F" feminine noun, "N" neuter, null for verbs and non-nouns
- synonyms: 2-3 additional English translations. Prefix verbs with "to ". Empty array if none.
- presentParticiple: gerund form for verbs only (e.g. "hablando"), null otherwise
- pastParticiple: past participle for verbs only (e.g. "hablado"), null otherwise
- wordWithRegion: nouns get definite article (e.g. "el libro"), verbs return infinitive as-is`
        }]
      });
      const anthropicOptions = {
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
      const anthropicResponse = await fetchUrl('https://api.anthropic.com/v1/messages', anthropicOptions, anthropicBody);
      const anthropicData = JSON.parse(anthropicResponse);
      const raw = anthropicData.content?.[0]?.text || '';
      context.log(`GetWordTranslation Claude raw: ${raw}`);
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      gender = parsed.gender || null;
      isVerb = parsed.isVerb === true || parsed.isVerb === 'true' || parsed.isVerb === 'Y';
      if (!isVerb && (parsed.presentParticiple || parsed.pastParticiple)) isVerb = true;
      presentParticiple = parsed.presentParticiple || null;
      pastParticiple = parsed.pastParticiple || null;
      wordWithRegion = parsed.wordWithRegion || null;
      const synonyms = Array.isArray(parsed.synonyms) ? parsed.synonyms : [];
      const seen = new Set();
      const parts = [translation, ...synonyms].map(t => t.trim()).filter(t => {
        const key = t.toLowerCase().replace(/^to\s+/, '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (isVerb) {
        translation = parts.map(t => t.toLowerCase().startsWith('to ') ? t : 'to ' + t).join(', ');
      } else {
        translation = parts.join(', ');
      }
    } catch(e) {
      context.log(`GetWordTranslation error: ${e.message}`);
      const lower = translation.toLowerCase().trim();
      const wordLower = word.toLowerCase().trim();
      isVerb = lower.startsWith('to ') || lower.startsWith('to\u00a0') ||
               /[aeiou]r$/i.test(wordLower) ||
               /[aeiou]re$/i.test(wordLower);
    }
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, translation, gender, isVerb, presentParticiple, pastParticiple, wordWithRegion })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};