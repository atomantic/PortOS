/**
  * Which PROVIDER RECORDS front each model-taking reviewer's binary (#7339).
  *
  * A reviewer slug names a BINARY, not a record (`claude` is whatever `claude` on PATH resolves to, and PortOS ships several records per binary: `claude-code` headless / `claude-code-tui` PTY, `grok-cli` beside the Grok TUI). The PICKER offers the union of every matching record's catalog and the RETIRED-PIN AUDIT asks whether a stored `<reviewer>Model` pin appears in ANY of them; both must classify the same records or the picker offers a tier the audit calls retired (or vice versa), so the table lives HERE in a pure leaf the browser imports directly (`client/src/hooks/useReviewerModelOptions.js`). Matchers are in PREFERENCE ORDER: the option list and audit union EVERY match, while the picker's shown default takes the FIRST (a non-interactive reviewer reports the CLI record's default, not the TUI's); a predicate rather than a bare id where the app recognizes a provider by more than its shipped id (an `agy` configured by path). Deliberately NOT matched: **Bedrock/Vertex records** (`claude-code-bedrock` lists `us.anthropic.*` ids resolving only in that record's environment); **`opencode-<local-backend>` presets** (their ids resolve only under the `OPENCODE_CONFIG_CONTENT` a PortOS-spawned provider injects, while the reviewer runs bare `opencode` against the user's OWN config; the Zen CLI/TUI records ARE matched, their namespaced `opencode/*` ids being what `opencode models` prints and what the Harnesses page's refresh probes, see `server/services/harnesses.js#usesHarnessCatalog`); **`opencode-zen` itself** (the HTTP-API record whose bare ids like `claude-opus-5` `opencode -m` can't resolve). Pure leaf (`providerModels.js` + `providerTypes.js`, both browser-imported, and `kilo.js`). It does NOT import `reviewerConfig.js`: the rule that every MODEL_SELECTABLE_REVIEWERS slug has a row is a test (`reviewerProviderMatchers.test.js`), keeping this leaf out of the reviewer-argv vocabulary's closure.
 */

import {
  commandBasename,
  isAntigravityProvider,
  isCursorProvider,
  isKimiProvider,
} from './providerModels.js';
import { isGrokBuildCli, isProcessProvider } from './providerTypes.js';
import { isKiloProvider } from './kilo.js';
import { dedupeByKey } from './arrayUtils.js';

/** Reviewer slug → the provider-record predicates that front its binary, in preference order. */
export const REVIEWER_PROVIDER_MATCHERS = Object.freeze({
  claude: [(p) => p.id === 'claude-code', (p) => p.id === 'claude-code-tui'],
  codex: [(p) => p.id === 'codex', (p) => p.id === 'codex-tui'],
  antigravity: [isAntigravityProvider],
  // `grok` ships as BOTH a `cli` and a `tui` provider and the reviewer is spawned non-interactively, so the CLI record wins the default; the broad predicate follows for an install that kept only the TUI.
  grok: [(p) => p.id === 'grok-cli', isGrokBuildCli],
  cursor: [(p) => p.id === 'cursor-cli', isCursorProvider],
  pi: [(p) => p.id === 'pi-cli', (p) => isProcessProvider(p) && commandBasename(p.command) === 'pi'],
  // Kilo's shipped records front the user's OWN `/connect` credentials (no local-backend preset resolving only under an injected config, the OpenCode carve-out), so the broad predicate is safe.
  kilo: [(p) => p.id === 'kilo-cli', isKiloProvider],
  kimi: [(p) => p.id === 'kimi-cli', isKimiProvider],
  opencode: [(p) => p.id === 'opencode-zen-cli', (p) => p.id === 'opencode-zen-tui'],
  mtplx: [(p) => p.id === 'mtplx'],
  lmstudio: [(p) => p.id === 'lmstudio'],
  ollama: [(p) => p.id === 'ollama'],
});

/**
 * Every provider record fronting `reviewer`'s binary, in matcher-preference order (NOT `providers` order) so `[0]` is the record whose default a picker shows; de-duped by identity (`grok-cli` is also an `isGrokBuildCli`).
 * A reviewer with no row, or no matching record, yields `[]`, which callers must read as "nothing is known", never "nothing is offered".
 *
 * @param {string} reviewer
 * @param {Array<object>|null|undefined} providers
 * @returns {Array<object>}
 */
export function providersForReviewer(reviewer, providers) {
  const matchers = REVIEWER_PROVIDER_MATCHERS[reviewer];
  if (!matchers) return [];
  const matched = matchers.flatMap((match) => (providers || []).filter((p) => p && match(p)));
  // Keyed on the record itself, so identity de-dupes overlapping matchers and the FIRST match sets the preference order.
  return dedupeByKey(matched, (provider) => provider, (held) => held);
}

/**
 * The ids of those records: the audit's side, where a pin is judged against SEVERAL catalogs and is stale only when every one fails to list it.
 *
 * @param {string} reviewer
 * @param {Array<object>|null|undefined} providers
 * @returns {string[]}
 */
export const reviewerProviderIds = (reviewer, providers) =>
  providersForReviewer(reviewer, providers)
    .map((provider) => provider?.id)
    .filter((id) => typeof id === 'string' && id !== '');
