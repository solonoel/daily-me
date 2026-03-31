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
    const { word, langName } = req.body;

    const prompt = `Generate 3 short, natural example sentences in ${langName} using the word "${word}" in the indicative present tense. Use 3 different subject pronouns (e.g., yo, tú, él/ella). Keep each sentence simple and under 10 words. Return ONLY a raw JSON array, no markdown:
[
  {"pronoun": "Yo", "sentence": "...", "translation": "..."},
  {"pronoun": "Tú", "sentence": "...", "translation": "..."},
  {"pronoun": "Él", "sentence": "...", "translation": "..."}
]`;

    const anthropicBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
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
    const sentences = JSON.parse(raw.replace(/```json|```/g, '').trim());

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sentences: Array.isArray(sentences) ? sentences : [] })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
