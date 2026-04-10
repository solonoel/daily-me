const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function (context, req) {
  const { prompt } = req.body || {};
  if (!prompt) {
    context.res = { status: 400, body: { error: 'prompt required' } };
    return;
  }
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = message.content?.find(b => b.type === 'text')?.text || '';
    context.res = { status: 200, body: { text } };
  } catch (e) {
    context.res = { status: 500, body: { error: e.message } };
  }
};