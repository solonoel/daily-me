const https = require('https');

module.exports = async function (context, req) {
  const { groups } = req.body || {};
  if (!groups || !groups.length) {
    context.res = { status: 400, body: { error: 'No groups provided' } };
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    context.res = { status: 500, body: { error: 'API key not configured' } };
    return;
  }
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const headlineText = groups.map(g => `${g.name} (${g.count} stories): ${g.titles.join(', ')}`).join('\n');
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `You are a concise morning briefing assistant. Given news headline groups, write 2 natural engaging sentences summarizing what's happening today. Be specific and conversational. Today is ${today}.`,
    messages: [{ role: 'user', content: `My morning headlines:\n${headlineText}` }]
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const r = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      r.on('error', reject);
      r.setTimeout(10000, () => r.destroy(new Error('timeout')));
      r.write(payload);
      r.end();
    });
    const text = result?.content?.[0]?.text || '';
    context.res = { status: 200, body: { summary: text } };
  } catch(e) {
    context.res = { status: 500, body: { error: e.message } };
  }
};