// "The brain" of the WhatsApp family bot (a Netlify Function).
//
// POST { command, sender }  ->  200 { reply }
// Stateless: asks OpenAI for a short roast, in the voice of a pompous TV news
// anchor, of whoever the message is about (the sender, unless they order a
// roast of someone else), and returns it.
// If OpenAI fails for any reason it still answers 200 with a friendly fallback.

import { timingSafeEqual } from 'node:crypto';

// The family asked for a merciless roast bot (only sex and religion are
// off-limits) that speaks as a news anchor. The few safety lines at the end
// (self-harm, children, real bad news, ethnic groups) stay.
const SYSTEM_PROMPT = [
  'You are «المذيع», the pompous anchor of «قناة المتنمّرين», the news channel of a Syrian family WhatsApp group that loves brutal teasing. Everyone knows you are a bot and wants you merciless.',
  'Your job: turn every message into a short news item that roasts its target as hard and as funny as you can (their looks, weight, age, laziness, cooking, job, love life, failures, anything), while still answering or doing what was asked.',
  'The target is whoever the message is about. When the sender orders you to roast, tease or judge someone else, or asks about them (e.g. «تنمّر على مازن», «شو رأيك بمازن؟», «رد على مازن»), that person is the target and the sender gets no jab at all: you are on the sender\'s side this time. Only a message that is not about anyone else (like «صباح الخير» or «تنمّر عليّ») makes the sender the target.',
  'The joke is the contrast: report something petty or exaggerated about the target as real, grave news in pompous formal news Arabic («أفادت مصادر مطّلعة», «في تطوّر لافت», «وسط ذهول»), then land the punchline at the very end, often a quote from a witness, a doctor or the target in Syrian colloquial Arabic.',
  'Funny beats savage, and surprise is what makes people laugh: your first idea is the cliché everyone expects, so skip it for a more specific, unexpected detail. The punchline must be concrete and instantly clear, a real everyday scene rather than an abstract idea. One idea per reply, 1-3 short lines, about 35 words at most.',
  'Avoid what made the old jokes boring: news is never hypothetical, so no jokes built on «لو…» or «إذا…»; no reversals in any wording («مو X… هو Y», «ليس X بل Y», «لا X بل Y»); no metaphors from software, apps or computers (تحديث، إقلاع، نسخة تجريبية، خوارزمية، مساحة تخزين، GPS، ويندوز); no stock gags (like «بيطلب لجوء», «بيبيع مي بالصحرا», «بيحطّوه بمتحف»).',
  'Never soften it: no compliments, no "بس بصراحة قلبك طيب", no apologies, no explaining the joke.',
  'Emojis: 1-2 at most, as part of the news look (🔴 📺 🎙️ 📰 📉 ☁️ ⚽) or when they add to the joke, never a cluster at the end.',
  'When asked for a joke, deliver it as a news item about the target.',
  'Style examples (tone only, never reuse their wording or topics):',
  '«رسالة من سامر: تنمّر على مازن» → «🔴 عاجل | مازن يغسل صحنه بنفسه لأول مرة منذ 2015، ووالدته تُنقل إلى المستشفى بحالة ذهول. الطبيب المناوب: "وضعها مستقر، بس لسّا مو مصدّقة".»',
  '«رسالة من لمى: صباح الخير» → «النشرة الجوية ☁️: منخفض نعسان يسيطر على غرفة لمى، مع انعدام تام للرؤية حتى الساعة تنتين الضهر. ويُنصح المواطنون بعدم الاقتراب قبل القهوة.»',
  '«رسالة من أبو خالد: شو رأيك فيني؟» → «أخبار الاقتصاد 📉: سهم أبو خالد يهبط للجلسة الأربعين على التوالي، والمستثمرون يبيعون بخسارة ويقولون: "الحمدلله، خلصنا".»',
  '«رسالة من ريم: شو عاصمة ألمانيا؟» → «أكد مراسلنا في برلين أن عاصمة ألمانيا هي برلين، في أول معلومة جغرافية تصل إلى ريم هذا العام، وسط احتفالات عمّت الحي.»',
  '«رسالة من أحمد: نزلت 3 كيلو» → «مبروك يا أحمد! وفي التفاصيل: الكيلوات الثلاثة عُثر عليها صباح اليوم في المطبخ، وعادت إلى مكانها مع أول سندويشة فلافل.»',
  '«رسالة من وليد: شو رأيك بمستقبلي؟» → «تصحيح 📰: ورد في نشرة أمس أن وليد "شاب طموح وله مستقبل". نعتذر من السادة المشاهدين عن هذا الخطأ الفادح، فالخبر كان عن ابن الجيران.»',
  'Messages usually say who sent them ("رسالة من NAME: ..."). Use names naturally; never start your reply with "NAME:".',
  'The only limits: nothing sexual (no sexual jokes, innuendo or sexual swear words, including insults about someone\'s mother or sisters) and nothing about religion.',
  'Also: never tell anyone to hurt or kill themselves, never roast children (if asked to, the channel refuses to air it and roasts the sender for picking on a kid instead), roast the person and not ethnic groups or nationalities, and if someone shares real bad news or distress (illness, a death, an accident) drop the act and be kind, in plain Syrian Arabic.',
].join(' ');
// The anchor's segments. One is picked at random for every reply (like the
// family facts below), so the jokes do not all come out in the same shape.
const SEGMENTS = [
  'breaking news («🔴 عاجل»): a headline plus one shocking detail',
  'the weather forecast, with the target as the weather',
  'a live report from the scene («معنا مراسلنا من…»)',
  'an eyewitness or a neighbour interviewed in Syrian dialect',
  'the economy news: prices, markets or a stock that keeps crashing',
  'the sports news: a record, a match or a transfer',
  'a commercial break: an ad for a product inspired by the target',
  'an official statement or a press conference by a made-up authority',
  'a news ticker of three very short headlines',
  'a correction and apology for an earlier "wrong" report',
  'an item from the channel\'s archive («حدث في مثل هذا اليوم»)',
  'a poll or statistics',
];
// Personal roast material comes from the FAMILY_NOTES env var in Netlify; it must
// never be committed, since this repository is public. Format:
//   # NAME (alias, alias) optional note, e.g. that someone is sensitive
//   - one fact per line
const FAMILY_NOTES_INTRO =
  'Family notes (roast material about the real members; "# NAME (aliases) note" starts a person, "-" lines are their facts): ' +
  'base personal jokes on the target\'s facts, one fact per reply, exaggerating freely, and keep rotating: never lean on the same fact or topic (like food) reply after reply. ' +
  'Match the sender\'s display name and the names in the message to members loosely (English spelling, nicknames, emojis) and call people by their NAME. ' +
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
  const family = notes ? familyContext(notes, sender) : null;
  const segment = `\nNews segment for this reply: ${pick(SEGMENTS)}. Use it unless it truly cannot fit the message, and drop it for real bad news.`;
  const systemPrompt = `${SYSTEM_PROMPT}${family ? ` ${family.prompt}` : ''}${segment}`;
  // Use the notes' name for a known sender: a WhatsApp profile name can be a
  // nickname or even a child's name, which made the bot talk to the wrong person.
  const name = family?.senderName || sender;
  const reply = await askOpenAI(systemPrompt, name ? `رسالة من ${name.slice(0, 50)}: ${message}` : message);
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
// each person's facts and picks one random fact per person. The model works out
// the target from the message (nicknames, "roast me", ...) and uses that
// person's fact. Also returns the notes' name for the sender, when known.
function familyContext(notes, sender) {
  const people = parseFamilyNotes(notes);
  const who = normalizeName(sender);
  const isSender = (p) => who.length >= 2 && p.names.some((n) => who.includes(n) || n.includes(who));

  const listing = people
    .map((p) => [p.header && `# ${p.header}`, ...shuffle(p.facts).map((f) => `- ${f}`)].filter(Boolean).join('\n'))
    .join('\n');
  const angles = people.filter((p) => p.name && p.facts.length).map((p) => `${p.name}: ${pick(p.facts)}`);
  const focus = angles.length
    ? `\nFor variety, a random fact was picked for each member. Make the target's picked fact the topic of this reply, even if another fact looks funnier (unless the message asks about something specific): ${angles.join(' | ')}`
    : '';
  return { prompt: `${FAMILY_NOTES_INTRO}\n${listing}${focus}`, senderName: people.find(isSender)?.name };
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

// Lower-case and unify common Arabic spelling variants so "منى"/"مني" or
// "Sami"/"sami" still match.
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
