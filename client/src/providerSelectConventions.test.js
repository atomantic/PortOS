// @vitest-environment node

/**
 * Repo-wide guard (#7566): an AI provider is picked through the shared
 * preset-first `ProviderModelSelector` (`components/ProviderModelSelector.jsx`),
 * never through a hand-rolled `<select>` that maps over a provider list.
 *
 * The shared selector is what gives every surface the same contract at once:
 * enabled presets grouped by harness, the "Custom combination…" compose flow
 * (composite ids, "Save as preset"), a saved value that is unavailable staying
 * visible with its reason instead of being auto-replaced, hardware and
 * caller-mode policies, and the harness-keyed effort ladder. A bespoke select
 * gets none of that, and the next capability added to the selector skips it
 * silently — which is exactly how ~30 copies accumulated before this guard.
 *
 * The rule is structural: a `<select …>…</select>` block whose body maps over
 * an identifier that names providers (`providers.map(`, `providerOptions.map(`,
 * `enabledProviders.map(`, …) fails this suite unless the file is allowlisted.
 *
 * ## Allowlist
 *
 * - `src/components/ProviderModelSelector.jsx` — it IS the shared implementation.
 * - `src/components/sprites/AnimationProviderPicker.jsx` — sprite ANIMATION
 *   backends (`{ id, label, ready }`), not AI provider records; the name
 *   collides with the detector, the concept does not.
 * - The legacy sites below still carry a bespoke select and are migrated
 *   one PR at a time (#7585). The allowlist is
 *   SHRINK-ONLY: a migrated file must be removed from it (the third test
 *   fails on a stale entry), and no new file may be added.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass. A select whose options come from a
 * pre-mapped array (`{options}` built elsewhere) or a `.map` over an
 * identifier that does not name providers slips through; comments are
 * stripped so prose mentioning a select does not trip it. Closing those
 * gaps means moving to an AST pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedJsxFiles } from './test/trackedFiles.js';
import { stripComments } from './test/stripComments.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHARED_SELECTOR = 'src/components/ProviderModelSelector.jsx';
const NOT_AI_PROVIDERS = ['src/components/sprites/AnimationProviderPicker.jsx'];
/** Legacy bespoke selects awaiting migration — shrink-only, never grow. */
const LEGACY_BESPOKE = [
  'src/components/brain/tabs/ConfigTab.jsx',
  'src/components/cos/TaskAddForm.jsx',
  'src/components/creative-director/CreativeDirectorModelsDrawer.jsx',
  'src/components/quotaBurn/StepSettings.jsx',
  'src/components/settings/AiAssignmentsTab.jsx',
];
const ALLOWED = [SHARED_SELECTOR, ...NOT_AI_PROVIDERS, ...LEGACY_BESPOKE];

const SELECT_BLOCK = /<select\b[\s\S]*?<\/select>/g;
const PROVIDER_MAP = /\b(\w*[pP]roviders?\w*)\.map\(/;

/**
 * The provider-list identifiers each bespoke `<select>` in `src` maps over,
 * one entry per offending block (`[]` when the file is clean).
 */
export function findBespokeProviderSelects(src) {
  return [...stripComments(src).matchAll(SELECT_BLOCK)]
    .map((block) => PROVIDER_MAP.exec(block[0])?.[1])
    .filter(Boolean);
}

describe('AI provider pickers go through ProviderModelSelector', () => {
  const files = trackedJsxFiles(CLIENT_ROOT).filter((file) => !file.endsWith('.test.jsx'));

  it('has no bespoke provider <select> outside the shared selector and its allowlist', () => {
    // A broken `git ls-files` would otherwise make this guard pass by scanning nothing.
    expect(files.length).toBeGreaterThan(100);
    const violations = [];
    for (const file of files) {
      if (ALLOWED.includes(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      for (const id of findBespokeProviderSelects(src)) violations.push(`${file}: <select> mapping ${id}`);
    }
    expect(
      violations,
      'These files render an AI provider picker as a bespoke <select>. Render '
      + '`ProviderModelSelector` (components/ProviderModelSelector.jsx) instead — pass '
      + 'the provider list, the selected id, `emptyProviderOption` for the "default" '
      + 'row, and `availableModels`/`onModelChange` when a model is picked too. It '
      + 'gives the surface the harness-grouped preset list, the compose flow, the '
      + 'unavailable-pin rendering, and the effort ladder for free.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: if the detector stops recognizing the shape, the scan
  // above goes vacuously green.
  it('flags a select mapping any provider-named list and ignores other selects', () => {
    expect(findBespokeProviderSelects('<select>{providers.map((p) => <option key={p.id}>{p.name}</option>)}</select>')).toEqual(['providers']);
    expect(findBespokeProviderSelects('<select value={x}>\n<option value="">Auto</option>\n{enabledProviders.map((p) => null)}\n</select>')).toEqual(['enabledProviders']);
    expect(findBespokeProviderSelects('<select>{providerOptions.map((p) => null)}</select>')).toEqual(['providerOptions']);
    expect(findBespokeProviderSelects('<select>{apps.map((a) => null)}</select>')).toEqual([]);
    // The list mapped OUTSIDE a select (a card grid) is not a picker.
    expect(findBespokeProviderSelects('<ul>{providers.map((p) => <li>{p.name}</li>)}</ul>')).toEqual([]);
    // A comment naming the pattern is not a select.
    expect(findBespokeProviderSelects('{/* <select>{providers.map(...)}</select> */}\n<div />')).toEqual([]);
  });

  // The allowlist must keep naming files that exist and still carry the
  // shape — a migrated file left on it would be silent dead config, and the
  // list is meant to shrink to nothing.
  it('allowlists only files that exist and still render a bespoke provider select', () => {
    for (const file of ALLOWED) {
      expect(files, `${file} is allowlisted but not a tracked .jsx file`).toContain(file);
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      expect(findBespokeProviderSelects(src).length, `${file} no longer needs its allowlist entry — remove it`).toBeGreaterThan(0);
    }
  });
});
