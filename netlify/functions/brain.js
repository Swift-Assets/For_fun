// "The brain" of the WhatsApp family bot (a Netlify Function).
//
// POST { command, sender }  ->  200 { reply }
// Stateless: asks OpenAI for a short, teasing (roast-style) reply in Syrian
// Arabic that pokes fun at the sender by name, and returns it.
// If OpenAI fails for any reason it still answers 200 with a friendly fallback.

import { timingSafeEqual } from 'node:crypto';

// The family asked for a merciless roast bot: only sex and religion are off-limits.
// The few safety lines at the end (self-harm, real bad news, ethnic groups) stay.
const SYSTEM_PROMPT = [
  'You are "المتنمّر", the savage roast bot of a Syrian family WhatsApp group that loves brutal teasing. Everyone knows you are a bot and wants you merciless.',
  'Your job: roast the person talking to you as hard and as funny as you can (their looks, weight, age, laziness, cooking, job, love life, failures, anything), then still answer or do what they asked.',
  'How to be funny: one sharp, specific exaggeration or unexpected comparison, with the punchline at the very end, in 1-2 short sentences. Pick the most savage and surprising angle, not the obvious one, and avoid stock gags (like something «بيطلب لجوء»). Vary your openings; do not always start with the name.',
  'Never soften it: no compliments, no "بس بصراحة قلبك طيب", no apologies, no explaining the joke.',
  'Use emojis generously: 2-4 per reply that match this joke\'s topic (food, sleep, phone, money, cars...), a different mix each time rather than the same set, but no laughing emojis when someone shares bad news.',
  'When asked for a joke, tell a short, savage Syrian-style joke, ideally at the asker\'s expense. No riddles, no puns translated from English.',
  'Style examples (tone only, never reuse their wording):',
  '«رسالة من أبو خالد: شو رأيك فيني؟» → «يا أبو خالد، لو الغباء بينباع بالكيلو كنت فتحت فرع بكل محافظة.»',
  '«رسالة من ريم: شو عاصمة ألمانيا؟» → «برلين يا عبقرية… المعلومة الوحيدة اللي رح تعرفيها اليوم، فاستمتعي فيها.»',
  '«رسالة من أحمد: نزلت 3 كيلو» → «مبروك يا أحمد! بقي عليك 40 وبتصير بني آدم طبيعي 🎉»',
  '«رسالة من لمى: صباح الخير» → «صباح الخير عالساعة تنتين الضهر؟ إنتِ ما بتصحي يا لمى، إنتِ بتعملي ريستارت متل ويندوز XP.»',
  'Messages usually say who sent them ("رسالة من NAME: ..."). Use the name naturally (e.g. «يا أحمد»); never start your reply with "NAME:".',
  'Always reply in Syrian colloquial Arabic.',
  'The only limits: nothing sexual (no sexual jokes, innuendo or sexual swear words, including insults about someone\'s mother or sisters) and nothing about religion.',
  'Also: never tell anyone to hurt or kill themselves, roast the person and not ethnic groups or nationalities, and if someone shares real bad news or distress (illness, a death, an accident) drop the roast and be kind.',
].join(' ');
// Personal roast material comes from the FAMILY_NOTES env var in Netlify; it must
// never be committed, since this repository is public. Format:
//   # NAME (alias, alias) optional note, e.g. that someone is sensitive
//   - one fact per line
const FAMILY_NOTES_INTRO =
  'Family notes (roast material about the real members; "# NAME (aliases) note" starts a person, "-" lines are their facts): ' +
  'base personal jokes on them, one fact per reply, exaggerating freely, and keep rotating: never lean on the same fact or topic (like food) reply after reply. ' +
  'Match the sender\'s display name to a member loosely (English spelling, nicknames, emojis) and call them by the NAME. ' +
  'Tease anyone marked as sensitive more lightly, and never insult the children mentioned.';
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

  const notes = Netlify.env.get('FAMILY_NOTES')?.trim();
  const systemPrompt = notes ? `${SYSTEM_PROMPT} ${familyContext(notes, sender, message)}` : SYSTEM_PROMPT;
  const reply = await askOpenAI(systemPrompt, sender ? `رسالة من ${sender.slice(0, 50)}: ${message}` : message);
  return Response.json({ reply });
};

async function askOpenAI(systemPrompt, userMessage) {
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
          { role: 'system', content: systemPrompt },
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

// The model has no memory between messages and tends to reach for the same
// "best" fact every time, so the variety comes from here: every request shuffles
// each person's facts and names one random fact for the sender and for anyone the
// message mentions.
function familyContext(notes, sender, message) {
  const people = parseFamilyNotes(notes);
  const who = normalizeName(sender);
  const text = normalizeName(message);

  const involved = people.filter((p) =>
    p.names.some((n) => (who.length >= 2 && (who.includes(n) || n.includes(who))) || text.includes(n)),
  );
  const angles = involved.filter((p) => p.facts.length).map((p) => `${p.name}: ${pick(p.facts)}`);

  const listing = people
    .map((p) => [p.header && `# ${p.header}`, ...shuffle(p.facts).map((f) => `- ${f}`)].filter(Boolean).join('\n'))
    .join('\n');
  const focus = angles.length
    ? `\nFor variety, build this reply around these randomly picked facts (unless the message clearly calls for others): ${angles.join(' | ')}`
    : '';
  return `${FAMILY_NOTES_INTRO}\n${listing}${focus}`;
}

function parseFamilyNotes(notes) {
  const people = [];
  for (const raw of notes.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const header = line.replace(/^#+\s*/, '');
      const [name, rest = ''] = header.split('(');
      const aliases = rest.split(')')[0].split(/[,،]/);
      const names = [name, ...aliases].map(normalizeName).filter((n) => n.length >= 2);
      people.push({ header, name: name.trim(), names, facts: [] });
    } else {
      if (!people.length) people.push({ header: '', name: '', names: [], facts: [] });
      people.at(-1).facts.push(line.replace(/^-+\s*/, ''));
    }
  }
  return people;
}

// Lower-case and unify common Arabic spelling variants so "هدى"/"هدي" or
// "Ghaid"/"ghaid" still match.
function normalizeName(s) {
  return s.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function replyLimits(model) {
  // Older chat models (gpt-4o, gpt-4.1, ...) take max_tokens.
  if (!model.startsWith('gpt-5')) return { max_tokens: 150 };
  // gpt-5 family models "think" before answering. A little thinking picks sharper
  // roasts (about 15 extra tokens, same speed in tests); the token cap covers both.
  return { max_completion_tokens: 1000, reasoning_effort: 'low' };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
