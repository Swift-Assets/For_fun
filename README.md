# WhatsApp Family Bot

A small hobby bot for a family/friends WhatsApp group. Anyone in the group can
send a message that starts with `!` (for example `!tell us a joke`) and the bot
answers briefly in Syrian Arabic, with a savage roast of whoever asked.
Every other message is ignored.

## How it works

```
WhatsApp group
   │  "!tell us a joke"
   ▼
listener/  (Node.js + Baileys, runs on a VPS under PM2)
   │  POST { command, sender }
   ▼
netlify/functions/brain.js  (Netlify Function)
   │  asks OpenAI (gpt-5.5 by default)
   ▼
{ reply }  ──► the listener posts it back into the group
```

There are two parts:

| Part | Runs on | What it does |
| --- | --- | --- |
| `listener/` | A VPS (e.g. Hetzner), kept alive by PM2 | Holds the WhatsApp Web session, watches **one** group, forwards `!` commands to the brain and posts the replies. It needs a long-running process, so it is **never** deployed to Netlify. |
| `netlify/functions/brain.js` | Netlify Functions (serverless) | Stateless. Receives `{ command, sender }`, asks OpenAI (`gpt-5.5` by default, set `OPENAI_MODEL` to change it) for a short, savage roast of the sender (by name) in Syrian Arabic, plus the actual answer (only sexual content and religion are off-limits; real bad news gets a kind reply) and returns `{ reply }`. If OpenAI fails, it still answers `200` with a friendly fallback reply. |

## Repository layout

```
.
├── README.md
├── .env.example              every environment variable, documented
├── .gitignore
├── netlify.toml              functions directory = netlify/functions
├── package.json              root package for the brain (ES module, no dependencies)
├── public/index.html         placeholder page, so Netlify publishes nothing else
├── netlify/functions/brain.js
├── listener/
│   ├── package.json          npm start / npm run pm2:start / ...
│   ├── index.js
│   └── ecosystem.config.js   PM2 process file
└── .github/workflows/ci.yml  installs dependencies and syntax-checks every PR
```

## Configuration

All variables are described in [`.env.example`](.env.example). Real values
never go into git.

| Variable | Used by | Where to set it |
| --- | --- | --- |
| `OPENAI_API_KEY` | brain | Netlify: *Site configuration > Environment variables* |
| `TARGET_GROUP_ID` | listener | `.env` on the VPS |
| `BRAIN_WEBHOOK_URL` | listener | `.env` on the VPS |
| `TRIGGER` | listener | `.env` on the VPS (optional, default `!`) |
| `WEBHOOK_SECRET` | both (optional) | the **same** value in Netlify and in the VPS `.env` |
| `OPENAI_MODEL` | brain (optional) | Netlify; default `gpt-5.5`, e.g. `gpt-5.4-mini` or `gpt-4.1` for faster replies |

## 1. Deploy the brain on Netlify

1. On [netlify.com](https://app.netlify.com): *Add new project > Import an existing project > GitHub*
   and choose this repository. The build settings come from `netlify.toml`
   (no build command, publish directory `public`, functions in `netlify/functions`).
2. *Site configuration > Environment variables*: add `OPENAI_API_KEY`
   (and `WEBHOOK_SECRET` if you use it).
3. *Deploys > Trigger deploy*: environment variable changes only apply after a new deploy.
4. The function URL (your `BRAIN_WEBHOOK_URL`) is
   `https://<your-site>.netlify.app/.netlify/functions/brain`.

Test it:

```bash
curl -X POST https://<your-site>.netlify.app/.netlify/functions/brain \
  -H 'content-type: application/json' \
  -d '{"command": "say hello to the family", "sender": "test"}'
```

## 2. Run the listener on the VPS

Needs Node.js 22.12 or newer (the current LTS is a good choice) and PM2 (`npm install -g pm2`).

```bash
git clone <this repo> whatsapp-family-bot && cd whatsapp-family-bot
cp .env.example .env    # fill in BRAIN_WEBHOOK_URL; leave TARGET_GROUP_ID empty for now
cd listener
npm ci
npm start               # first run: scan the QR code, copy your group's ID, then Ctrl+C
nano ../.env            # set TARGET_GROUP_ID to that ID
npm run pm2:start       # same as: pm2 start ecosystem.config.js
pm2 save && pm2 startup # optional: start again automatically after a reboot
```

Good to know:

- The QR code is scanned only once. The login is stored in `listener/auth_session/`
  (gitignored). Anyone with that folder can use the WhatsApp account, so keep it private.
- If the listener crashes, PM2 restarts it (waiting a little longer after each repeated crash).
- If WhatsApp logs the session out, the listener exits and PM2 does not restart it
  (`pm2 ls` may still say *waiting restart*; it stays down). Delete `listener/auth_session/`
  and run `npm start` again to link it anew.
- Only live messages are answered: commands sent while the listener is offline are skipped.
- The listener does not mark the account as "online", so the phone keeps getting notifications.
- Logs: `npm run pm2:logs` (or `pm2 logs whatsapp-family-bot`).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request:
it runs `npm ci` for the root and `listener/`, then `node --check` on every JavaScript file.
