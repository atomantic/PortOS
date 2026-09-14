/**
 * Which PROVIDER RECORDS front each model-taking reviewer's binary (#7339).
 *
 * A reviewer slug names a BINARY, not a provider record — `claude` is whatever
 * `claude` on PATH resolves to, and PortOS ships more than one record per
 * binary (`claude-code` for the headless CLI, `claude-code-tui` for the PTY;
 * `grok-cli` beside the Grok TUI). Two questions need that mapping and used to
 * have only a client-side answer (`useReviewerModelOptions.js`):
 *
 *  - the PICKER, which offers the union of every matching record's catalog,
 *    because any record fronting that binary lists ids the binary accepts;
 *  - the RETIRED-PIN AUDIT, which asks whether a stored `<reviewer>Model` pin
 *    still appears in ANY of them.
 *
 * Both must classify the same records or they disagree about the same pin: the
 * picker would offer a tier the audit calls retired, or the audit would flag a
 * pin the picker just handed the user. So the table lives HERE, in a pure leaf
 * the browser imports directly — one table, no mirror to drift.
 *
 * Matchers are listed in PREFERENCE ORDER, and the two reductions over each
 * list answer different questions: the option list and the audit union EVERY
 * match, while the picker's shown default takes the FIRST — so a reviewer
 * spawned non-interactively reports the CLI record's default rather than the
 * TUI's. A predicate rather than a bare id wherever the app already recognizes
 * a provider by more than its shipped id (an `agy` configured by path), so this
 * classifies the same records the rest of PortOS does.
 *
 * What is deliberately NOT matched matters as much as what is:
 * - **No Bedrock/Vertex record.** `claude-code-bedrock` lists `us.anthropic.*`
 *   ids that resolve only under that record's own environment.
 * - **No `opencode-<local-backend>` preset.** Those enumerate ids that resolve
 *   only under the `OPENCODE_CONFIG_CONTENT` a PortOS-spawned provider injects,
 *   and the reviewer runs a bare `opencode` against the user's OWN config. The
 *   Zen CLI/TUI records are the exception and ARE matched: their ids are the
 *   namespaced `opencode/*` spellings that bare `opencode models` prints, and
 *   the Harnesses page's model refresh fills them from exactly that probe (see
 *   `server/services/harnesses.js#usesHarnessCatalog`), so they are the live
 *   catalog for the account the reviewer will bill.
 * - **Not `opencode-zen` itself.** That is the HTTP-API record; its bare ids
 *   (`claude-opus-5`) are Zen's API model names, which `opencode -m` cannot
 *   resolve.
 *
 * Pure leaf (`providerModels.js` + `providerTypes.js`, both already browser-
 * imported) so `client/src/hooks/useReviewerModelOptions.js` takes it verbatim.
 * Deliberately does NOT import `reviewerConfig.js`: the coverage rule — every
 * MODEL_SELECTABLE_REVIEWERS slug has a row — is a test
 * (`reviewerProviderMatchers.test.js`), not a runtime dependency, which keeps
 * this leaf out of the reviewer-argv vocabulary's closure.
 */

import {
  commandBasename,
  isAntigravityProvider,
  isCursorProvider,
  isKimiProvider,
} from './providerModels.js';
import { isGrokBuildCli, isProcessProvider } from './providerTypes.js';

/** Reviewer slug → the provider-record predicates that front its binary, in preference order. */
export const REVIEWER_PROVIDER_MATCHERS = Object.freeze({
  claude: [(p) => p.id === 'claude-code', (p) => p.id === 'claude-code-tui'],
  codex: [(p) => p.id === 'codex', (p) => p.id === 'codex-tui'],
  antigravity: [isAntigravityProvider],
  // `grok` names one binary that ships as BOTH a `cli` and a `tui` provider, and
  // the reviewer is spawned non-interactively, so the CLI's record wins the
  // default — the broad predicate follows it for an install that only kept the TUI.
  grok: [(p) => p.id === 'grok-cli', isGrokBuildCli],
  cursor: [(p) => p.id === 'cursor-cli', isCursorProvider],
  pi: [(p) => p.id === 'pi-cli', (p) => isProcessProvider(p) && commandBasename(p.command) === 'pi'],
  kimi: [(p) => p.id === 'kimi-cli', isKimiProvider],
  opencode: [(p) => p.id === 'opencode-zen-cli', (p) => p.id === 'opencode-zen-tui'],
  mtplx: [(p) => p.id === 'mtplx'],
  lmstudio: [(p) => p.id === 'lmstudio'],
  ollama: [(p) => p.id === 'ollama'],
});

/**
 * Every provider record fronting `reviewer`'s binary, in matcher-preference
 * order (NOT the order they appear in `providers`) so `[0]` is the record whose
 * default a picker shows. De-duped by identity: two matchers commonly overlap —
 * `grok-cli` is also an `isGrokBuildCli`.
 *
 * A reviewer with no row, or one no record matches, yields `[]` — which every
 * caller must read as "nothing is known", never as "nothing is offered".
 *
 * @param {string} reviewer
 * @param {Array<object>|null|undefined} providers
 * @returns {Array<object>}
 */
export function providersForReviewer(reviewer, providers) {
  const matchers = REVIEWER_PROVIDER_MATCHERS[reviewer];
  if (!matchers) return [];
  const matched = [];
  for (const match of matchers) {
    for (const provider of providers || []) {
      if (provider && match(provider) && !matched.includes(provider)) matched.push(provider);
    }
  }
  return matched;
}

/**
 * The ids of those records — the audit's side of the question, where a pin is
 * judged against SEVERAL candidate catalogs and is stale only when every one of
 * them fails to list it.
 *
 * @param {string} reviewer
 * @param {Array<object>|null|undefined} providers
 * @returns {string[]}
 */
export const reviewerProviderIds = (reviewer, providers) =>
  providersForReviewer(reviewer, providers)
    .map((provider) => provider?.id)
    .filter((id) => typeof id === 'string' && id !== '');
