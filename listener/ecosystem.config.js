// PM2 process file for the listener.
//
//   pm2 start ecosystem.config.js   start it; PM2 restarts it if it crashes
//   pm2 logs whatsapp-family-bot    follow the logs
//   pm2 save && pm2 startup         keep it running across server reboots
//
// This package is an ES module, so the config is the named `apps` export
// (PM2 loads the file with require(), which needs Node 20.19+ or 22.12+).
export const apps = [
  {
    name: 'whatsapp-family-bot',
    script: 'index.js',
    cwd: import.meta.dirname,
    autorestart: true,
    // After a crash, restart in 1s, then back off (up to 15s) if it keeps crashing.
    exp_backoff_restart_delay: 1000,
    // index.js exits with code 0 only on purpose (e.g. WhatsApp logged the
    // session out); restarting would just loop, so PM2 leaves it down.
    // (PM2 may still label it "waiting restart", but it does not restart.)
    stop_exit_codes: [0],
    max_memory_restart: '400M',
    time: true,
  },
];
