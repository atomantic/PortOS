// Soft ceiling on concurrent user-spawned interactive shells. Each session is a
// single idle PTY (a few MB, one OS process), and the deployment is single-user
// on a private network — so this is a sanity bound against runaway tab-spamming,
// not a resource/abuse defense. External views (TUI runs) don't count.
// Pure leaf: services/shell.js imports node-pty, so the browser cannot import it.
export const MAX_TOTAL_SESSIONS = 20;
