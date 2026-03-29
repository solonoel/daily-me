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
    const translation = data.translations?.[0]?.text || '';

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, translation })
    };
  } catch(err) {
    context.res = { status: 500, body: 'Error: ' + err.message };
  }
};
