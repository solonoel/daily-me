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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `For the ${languageCode} word or phrase "${word}", respond with JSON only, no markdown:
{"isVerb": true|false, "gender": "M"|"F"|"N"|null, "synonyms": ["word1","word2"], "presentParticiple": "<present participle if verb, else null>", "pastParticiple": "<past participle if verb, else null>", "wordWithRegion": "<word with article if noun, else the word as-is>"}
- gender: M=masculine, F=feminine, N=neuter, null=not applicable (verbs, plurals, proper nouns)
- synonyms: 2-3 additional English translations most relevant to this word. For verbs, include "to " prefix on each. For nouns, no prefix. Empty array if none.
- presentParticiple: the gerund/present participle form if this is a verb (e.g. Spanish "hablando"), null otherwise
- pastParticiple: the past participle form if this is a verb (e.g. Spanish "hablado"), null otherwise
- wordWithRegion: for nouns include the definite article (e.g. "el libro"), for verbs return the infinitive as-is`
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
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      gender = parsed.gender || null;
      isVerb = !!parsed.isVerb;
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
      // Claude call failed — return DeepL translation only
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