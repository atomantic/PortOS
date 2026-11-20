/**
 * Rule: Pick AI providers through `ProviderModelSelector` (`components/ProviderModelSelector.jsx`), never a hand-rolled `<select>` mapping over a provider list.
 * Fix: Replace the bespoke `<select>` with `ProviderModelSelector`.
 * What this guard cannot see:
 *   - A `<select>` whose options come from a pre-mapped array (`{options}`) or a `.map` over an identifier that does not name providers.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedJsxFiles } from '../../trackedFiles.js';
import { stripComments } from '../../stripComments.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

const SHARED_SELECTOR = 'src/components/ProviderModelSelector.jsx';
const NOT_AI_PROVIDERS = ['src/components/sprites/AnimationProviderPicker.jsx'];
// Filters cannot compose execution presets or fetch unrelated provider configuration.
const READ_ONLY_FILTERS = ['src/components/models/ModelComparison.jsx'];
const ALLOWED = [SHARED_SELECTOR, ...NOT_AI_PROVIDERS, ...READ_ONLY_FILTERS];

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
      const src = readText(join(CLIENT_ROOT, file));
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
  // list stays minimal.
  it('allowlists only files that exist and still render a bespoke provider select', () => {
    for (const file of ALLOWED) {
      expect(files, `${file} is allowlisted but not a tracked .jsx file`).toContain(file);
      const src = readText(join(CLIENT_ROOT, file));
      expect(findBespokeProviderSelects(src).length, `${file} no longer needs its allowlist entry — remove it`).toBeGreaterThan(0);
    }
  });
});
