/**
 * Build the CoS task payload for the "Investigate & fix" action on a failing
 * DOM-selector test (Comms → Sync → DOM Selectors, `/messages/sync`).
 *
 * Build the CoS task payload behind the DOM-selector-test "Investigate & fix" action (Comms →
 * Sync): `buildSelectorTestFailureTask({ provider, status, results, error })` → `{
 * description, prompt }` naming the provider, the `testSelectors()` status, the per-selector match
 * counts, and the relevant source files. Fed to the generic `QueueInvestigationButton`
 * (`components/ui/QueueInvestigationButton.jsx`), the same queueing primitive `installFailureTask.js`
 * uses.
 *
 * Pure: no React, no network. The caller hands the result straight to
 * `QueueInvestigationButton`.
 */

const STATUS_PROSE = {
  'no-browser': 'PortOS could not open or find a browser tab for this provider in the CDP browser — portos-browser may not be running.',
  'auth-required': 'The open browser tab is on a login/redirect page, so the selectors could not be evaluated against the real inbox — the account may need to sign in again.',
  'no-selectors': 'No selectors are configured for this provider.',
  partial: 'At least one configured selector matched zero elements on the live page — the provider likely changed its DOM structure.',
};

function formatResults(results) {
  const entries = Object.entries(results || {});
  if (entries.length === 0) return '(no selectors were evaluated)';
  return entries
    .map(([name, r]) => `- ${name}: \`${r?.selector}\` -> ${r?.matches ?? 0} match${r?.matches === 1 ? '' : 'es'}`)
    .join('\n');
}

/**
 * @param {object} input
 * @param {string} input.provider - 'outlook' | 'teams'
 * @param {string} input.status - the `testSelectors()` status ('no-browser' | 'auth-required' | 'no-selectors' | 'partial' | 'error')
 * @param {object} [input.results] - per-selector `{ selector, matches }` from the test response.
 * @param {string} [input.error] - the test response's `error`, when present.
 * @returns {{ description: string, prompt: string }} ready for `QueueInvestigationButton`.
 */
export function buildSelectorTestFailureTask({ provider, status, results, error } = {}) {
  const name = provider === 'teams' ? 'Teams' : 'Outlook';
  const description = `Fix failing DOM selector test for ${name} message sync`;
  const prose = STATUS_PROSE[status] || 'The selector test did not report success.';

  const sections = [
    `The DOM Selectors test for ${name} (Comms → Sync at /messages/sync) is failing. Investigate the root cause and fix it.`,
    '',
    `Provider: ${name}`,
    `Test status: ${status || '(unknown)'}`,
    prose,
  ];
  if (error) sections.push(`Error: ${error}`);
  sections.push(
    '',
    'Per-selector results from the last test run:',
    formatResults(results),
    '',
    'Relevant code: server/services/messagePlaywrightSync.js (testSelectors, buildExtractionScript), '
      + 'server/lib/messageSelectorDefaults.js (MESSAGE_SELECTOR_DEFAULTS), '
      + 'server/services/browserService.js (findOrOpenPage, isAuthPage, evaluateOnPage), '
      + 'client/src/components/messages/SyncTab.jsx (the DOM Selectors panel).',
    '',
    'Reproduce against the portos-browser CDP instance (Dev Tools → Browser at /browser), find why the configured '
      + 'selector(s) in data/messages/selectors.json (falling back to MESSAGE_SELECTOR_DEFAULTS) no longer match '
      + 'the live page DOM — the provider may have changed its markup or a custom override may be stale — and '
      + 'fix the selector(s) or extraction logic so the test reports "ok".',
  );

  return { description, prompt: sections.join('\n') };
}
