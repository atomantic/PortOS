/**
 * Build the CoS task payload for the "Investigate & fix" action on a failing
 * DOM-selector test (Settings > Messages > Sync tab > DOM Selectors).
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
    `The DOM Selectors test for ${name} (Settings > Messages > Sync tab) is failing. Investigate the root cause and fix it.`,
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
      + 'server/services/browserService.js (findOrOpenPage, isAuthPage, evaluateOnPage), '
      + 'client/src/components/messages/SyncTab.jsx (the DOM Selectors panel).',
    '',
    'Reproduce against the portos-browser CDP instance (Settings > Browser), find why the configured '
      + 'selector(s) no longer match the live page DOM — the provider may have changed its markup, or the '
      + 'selector may not be the one the real scraper actually reads (the Outlook extraction script currently '
      + "hardcodes its own selectors rather than reading messageRow from data/messages/selectors.json) — and "
      + 'fix the selector(s) or the code that reads them so the test reports "ok".',
  );

  return { description, prompt: sections.join('\n') };
}
