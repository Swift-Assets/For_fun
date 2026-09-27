// "The brain" of the WhatsApp family bot (a Netlify Function).
//
// POST { command, sender }  ->  200 { reply }
// Stateless: asks OpenAI for a short, teasing (roast-style) reply in Syrian
// Arabic that pokes fun at the sender by name, and returns it.
// If OpenAI fails for any reason it still answers 200 with a friendly fallback.

import { timingSafeEqual } from 'node:crypto';

const SYSTEM_PROMPT = [
  'You are the cheeky roast bot of a Syrian family/friends WhatsApp group whose members love teasing each other.',
  'Style: cheeky, lively ("نغش") and savage but good-natured roasting ("قصف جبهات"): mock the person talking to you with sarcastic, witty jabs, then still answer or do what they asked.',
  'Be genuinely funny: short punchlines, exaggeration and surprising comparisons from everyday Syrian family life (for inspiration only, pick a fresh angle each time: the relatives\' group chat, mum\'s marriage questions, the cousin who became a doctor, sleeping till noon, being late, exam results, food at family gatherings). Never explain a joke.',
  'When asked for a joke, tell a short Syrian-style joke with a clever twist (e.g. about أبو العبد or a stingy neighbour). No riddles, no puns translated from English, no "why did the chicken..." jokes.',
  'Messages usually say who sent them ("رسالة من NAME: ..."). Talk to that person directly and use their name naturally inside your sentence (e.g. «يا أحمد»); never start your reply with "NAME:".',
  'Always reply in Syrian colloquial Arabic, in 1-3 short sentences.',
  'The family knows you are a bot and is fine with jokes about looks, weight and politics, as long as they stay playful.',
  'Hard limits, also inside jokes about made-up characters: no swearing or vulgar/sexual words, no threats, and never mock religion, origin, disability or illness.',
  'If someone is genuinely upset or asks about something serious (health, safety, bad news), drop the roast completely and reply with warm, kind support.',
].join(' ');
// Overridable with the OPENAI_MODEL env var in Netlify, no code change needed.
const DEFAULT_MODEL = 'gpt-5.5';
const FALLBACK_REPLY = 'عذرًا، عقلي في استراحة قصيرة 🤖 جرّبوا مرة ثانية بعد قليل!';
const MAX_COMMAND_LENGTH = 1000;

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json(
      { error: 'Use POST with a JSON body: { "command": "..." }' },
      { status: 405, headers: { allow: 'POST' } },
    );
  }

  // Optional shared secret: when WEBHOOK_SECRET is set, only the listener
  // (which sends the same value) may call this function.
  const secret = Netlify.env.get('WEBHOOK_SECRET');
  if (secret && !safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const command = typeof body?.command === 'string' ? body.command.trim() : '';
  if (!command) {
    return Response.json({ error: 'Missing "command" in the JSON body' }, { status: 400 });
  }

  // Prefix the sender's display name so the bot can tease them by name. Skip raw
  // WhatsApp IDs (they contain "@"), which the listener sends when there is no name.
  const sender = typeof body.sender === 'string' && !body.sender.includes('@') ? body.sender.trim() : '';
  const message = command.slice(0, MAX_COMMAND_LENGTH);

  const reply = await askOpenAI(sender ? `رسالة من ${sender.slice(0, 50)}: ${message}` : message);
  return Response.json({ reply });
};

async function askOpenAI(userMessage) {
  const apiKey = Netlify.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set');
    return FALLBACK_REPLY;
  }

  const model = Netlify.env.get('OPENAI_MODEL') || DEFAULT_MODEL;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        ...replyLimits(model),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
      // Give up before Netlify's function timeout so the fallback still gets sent.
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.error(`OpenAI answered HTTP ${res.status}: ${await res.text()}`);
      return FALLBACK_REPLY;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || FALLBACK_REPLY;
  } catch (err) {
    console.error('OpenAI request failed:', err);
    return FALLBACK_REPLY;
  }
}

function replyLimits(model) {
  // Older chat models (gpt-4o, gpt-4.1, ...) take max_tokens.
  if (!model.startsWith('gpt-5')) return { max_tokens: 150 };
  // gpt-5 family models can "think" before answering; switch that off for quick,
  // cheap chat replies. The original gpt-5 / gpt-5-mini only go down to "minimal".
  return {
    max_completion_tokens: 300,
    reasoning_effort: /^gpt-5(-|$)/.test(model) ? 'minimal' : 'none',
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
