/**
 * The agent programs PortOS drives, as the browser needs to name them.
 *
 * Browser MIRROR of `PROVIDER_HARNESSES` in `server/lib/providerHarnesses.js`
 * — the browser cannot import server code, so the id→label table is duplicated
 * and `server/lib/providerHarnesses.parity.test.js` reads this file as TEXT to
 * pin the two together.
 *
 * Only `id → label` is mirrored, and deliberately so. The server registry's
 * other columns are all decided server-side and arrive on the wire already
 * resolved: `matches` classifies a provider RECORD (the browser is handed a
 * `harnessId`), `modes` is already reflected by the routes a binding actually
 * owns, and `protocol` is a transport decision no picker makes. Mirroring them
 * would create three more things to drift for no rendered difference.
 */

/** id → display label. MIRROR of the server registry; keep in lockstep. */
export const PROVIDER_HARNESS_LABELS = Object.freeze({
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor Agent',
  grok: 'Grok',
  kimi: 'Kimi Code',
  pi: 'Pi',
});

/**
 * What to call a binding's harness.
 *
 * `null` is the DIRECT API case and has a name of its own — it is a real
 * binding with a real route, not a missing value. An id this build does not
 * know is shown verbatim rather than hidden: an unmapped harness stays a
 * visible legacy route, which is exactly what the graph promises.
 */
export const harnessLabel = (harnessId) => {
  if (harnessId === null || harnessId === undefined) return 'Direct API';
  return PROVIDER_HARNESS_LABELS[harnessId] || harnessId;
};
