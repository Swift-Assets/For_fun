// WhatsApp listener for the family bot.
//
// Keeps a WhatsApp Web session open (via Baileys) and watches ONE group.
// Messages that start with TRIGGER ("!" by default) are sent to the brain
// (a Netlify function) and its reply is posted back into the group.
// Every other message is ignored.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// Settings come from listener/.env or the repo-root .env (see .env.example).
// Variables already set in the real environment always win.
for (const file of ['./.env', '../.env']) {
  const url = new URL(file, import.meta.url);
  if (existsSync(url)) process.loadEnvFile(url);
}

const TARGET_GROUP_ID = process.env.TARGET_GROUP_ID?.trim();
const BRAIN_WEBHOOK_URL = process.env.BRAIN_WEBHOOK_URL?.trim();
const TRIGGER = process.env.TRIGGER?.trim() || '!';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim();
const AUTH_DIR = fileURLToPath(new URL('./auth_session', import.meta.url));

if (!TARGET_GROUP_ID) {
  console.warn('TARGET_GROUP_ID is not set: every message is ignored. Your groups are listed once connected.');
}
if (!BRAIN_WEBHOOK_URL) {
  console.warn('BRAIN_WEBHOOK_URL is not set: commands cannot be answered until it is.');
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
    // Stay "offline" so the phone keeps getting its usual notifications.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Scan this QR code in WhatsApp > Settings > Linked devices > Link a device:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('Connected to WhatsApp.');
      if (!TARGET_GROUP_ID) listGroups(sock);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      // Exit code 0 tells PM2 not to restart (see ecosystem.config.js):
      // reconnecting in these two cases would only loop.
      if (code === DisconnectReason.loggedOut) {
        console.error('WhatsApp logged this session out. Delete listener/auth_session/ and run `npm start` to scan a new QR code.');
        process.exit(0);
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.error('Another listener is using this WhatsApp session. Stopping this one.');
        process.exit(0);
      }

      console.warn(`Connection closed (code ${code ?? 'unknown'}), reconnecting in 3s...`);
      setTimeout(() => start().catch(crash), 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // 'notify' = live incoming messages. 'append' covers the bot's own replies
    // and anything that arrived while the listener was offline: skip those.
    if (type !== 'notify') return;

    for (const msg of messages) {
      handleMessage(sock, msg).catch((err) => console.error('Error handling message:', err));
    }
  });
}

async function handleMessage(sock, msg) {
  if (!TARGET_GROUP_ID || msg.key.remoteJid !== TARGET_GROUP_ID) return;

  const content = normalizeMessageContent(msg.message);
  const text = (content?.conversation || content?.extendedTextMessage?.text || '').trim();
  if (!text.startsWith(TRIGGER)) return;

  const command = text.slice(TRIGGER.length).trim();
  if (!command) return;

  const sender = msg.pushName || msg.key.participant || 'unknown';
  console.log(`Command from ${sender}: ${command}`);

  try {
    const reply = await askBrain(command, sender);
    if (reply) await sock.sendMessage(TARGET_GROUP_ID, { text: reply }, { quoted: msg });
  } catch (err) {
    console.error('Could not answer command:', err.message ?? err);
  }
}

async function askBrain(command, sender) {
  if (!BRAIN_WEBHOOK_URL) throw new Error('BRAIN_WEBHOOK_URL is not set');

  const res = await fetch(BRAIN_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(WEBHOOK_SECRET && { 'x-webhook-secret': WEBHOOK_SECRET }),
    },
    body: JSON.stringify({ command, sender }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`brain answered HTTP ${res.status}`);

  const { reply } = await res.json();
  return typeof reply === 'string' ? reply.trim() : '';
}

async function listGroups(sock) {
  try {
    const groups = Object.values(await sock.groupFetchAllParticipating());
    console.log('Groups this account is in (copy one ID into TARGET_GROUP_ID, then restart):');
    for (const group of groups) console.log(`  ${group.id}  ${group.subject}`);
  } catch (err) {
    console.error('Could not list groups:', err.message ?? err);
  }
}

function crash(err) {
  console.error('Fatal error:', err);
  process.exit(1);
}

start().catch(crash);
