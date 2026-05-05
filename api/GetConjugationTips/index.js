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
    const { language, moodEng, moodName, tenseEng, tenseName } = req.body;

    if (!language || !moodEng || !tenseEng) {
      context.res = { status: 400, body: 'Missing required fields' };
      return;
    }

    const prompt = `You are an expert ${language} grammar teacher. A student is studying the ${moodEng} mood, ${tenseEng} tense (${moodName} / ${tenseName}) in ${language}.

Produce a rich, helpful grammar reference card in JSON format. Return ONLY raw JSON, no markdown, no explanation.

{
  "title": "<mood + tense in ${language}>",
  "subtitle": "<one-sentence description of when this tense is used>",
  "usage": "<2-3 sentences explaining when and how this tense is used, with any important nuances>",
  "tips": ["<memory tip or shortcut 1>", "<memory tip or shortcut 2>", "<tip 3 if applicable>"],
  "verbGroups": [
    {
      "group": "<verb group name, e.g. -AR verbs>",
      "example": "<example infinitive>",
      "endings": [
        {"pronoun": "<pronoun>", "ending": "<ending>"},
        ...
      ]
    }
  ],
  "irregulars": [
    {"verb": "<infinitive>", "forms": "<all conjugated forms as a string>", "note": "<optional note about irregularity pattern>"},
    ...
  ],
  "examples": [
    {"sentence": "<example sentence in ${language}>", "translation": "<English translation>"},
    {"sentence": "<example sentence>", "translation": "<English translation>"},
    {"sentence": "<example sentence>", "translation": "<English translation>"}
  ]
}

Include 3-5 verb groups as appropriate for ${language}. Include 5-8 common irregulars. Include exactly 3 example sentences. Be thorough and pedagogically useful.`;

    const anthropicBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
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
        'Content-Length': Buffer.byteLength(anthropicBody)
      }
    };

    const response = await fetchUrl('https://api.anthropic.com/v1/messages', options, anthropicBody);
    const data = JSON.parse(response);
    const raw = data.content?.[0]?.text || '{}';
    const tips = JSON.parse(raw.replace(/```json|```/g, '').trim());

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, tips })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};