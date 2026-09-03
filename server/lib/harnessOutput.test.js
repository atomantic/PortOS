import { describe, it, expect } from 'vitest';
import {
  compareHarnessVersions,
  MAX_MODELS,
  parseHarnessModels,
  parseHarnessVersion,
} from './harnessOutput.js';

// Real banners, one per shipped harness — every vendor spells it differently
// and the parser has to survive all of them without a per-vendor branch.
describe('parseHarnessVersion', () => {
  it.each([
    ['1.18.27', '1.18.27'],                                  // opencode
    ['2.1.259 (Claude Code)', '2.1.259'],                     // claude
    ['codex-cli 0.151.0', '0.151.0'],                         // codex
    ['1.1.25', '1.1.25'],                                     // agy
    ['grok 1.0.13 (5e9a58528b76) [stable]', '1.0.13'],        // grok — hash must not win
    ['0.32.0', '0.32.0'],                                     // kimi
    ['2.0.0-beta.3', '2.0.0-beta.3'],                         // prerelease suffix kept
  ])('reads %j as %j', (banner, expected) => {
    expect(parseHarnessVersion(banner)).toBe(expected);
  });

  // `null` is NOT-KNOWN. Collapsing it to '0.0.0' would make every unparseable
  // banner read as "out of date" against any published version.
  it.each([null, undefined, '', 'no version here', '2026'])('returns null for %j', (input) => {
    expect(parseHarnessVersion(input)).toBeNull();
  });
});

describe('compareHarnessVersions', () => {
  it('orders numerically, not lexically', () => {
    // The whole point: '1.18.27' < '1.9.0' as strings, and > as versions.
    expect(compareHarnessVersions('1.18.27', '1.9.0')).toBe(1);
    expect(compareHarnessVersions('1.18.27', '1.19.0')).toBe(-1);
    expect(compareHarnessVersions('1.18.27', '1.18.27')).toBe(0);
  });

  // Prerelease precedence comes from `compareSemver`: someone on a beta with
  // the final published IS behind, and should see the update badge.
  it('orders a prerelease below its release', () => {
    expect(compareHarnessVersions('2.0.0-beta.3', '2.0.0')).toBe(-1);
    expect(compareHarnessVersions('2.0.0-beta.3', '2.0.0-beta.10')).toBe(-1);
  });

  it('ignores build metadata', () => {
    expect(compareHarnessVersions('2.0.0+abc', '2.0.0')).toBe(0);
  });

  // Both sides must be a version this module would have pulled out of a banner
  // in the first place — a two-segment string is not one, and answering an
  // ordering for it would be inventing the third segment.
  it('refuses a version it would not have parsed from a banner', () => {
    expect(compareHarnessVersions('2.1', '2.1.0')).toBeNull();
  });

  // An unparseable side must not decide "out of date" — the caller renders the
  // update badge only on a definite -1.
  it.each([[null, '1.0.0'], ['1.0.0', null], ['nightly', '1.0.0'], [undefined, undefined]])(
    'returns null when a side is unparseable (%j, %j)',
    (a, b) => expect(compareHarnessVersions(a, b)).toBeNull(),
  );
});

describe('parseHarnessModels', () => {
  it('keeps the OpenCode namespace, which is what --model takes', () => {
    const stdout = 'opencode/big-pickle\nopencode/mimo-v2.5-free\nopencode/nemotron-3-ultra-free\n';
    expect(parseHarnessModels('opencode', stdout)).toEqual([
      'opencode/big-pickle',
      'opencode/mimo-v2.5-free',
      'opencode/nemotron-3-ultra-free',
    ]);
  });

  it('takes the id column of Antigravity TAB rows and drops its preamble', () => {
    const stdout = [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      '',
    ].join('\n');
    expect(parseHarnessModels('agy', stdout)).toEqual([
      'gemini-3.8-flash-high',
      'claude-opus-4-6-thinking',
    ]);
  });

  // Delegated to `parseAntigravityModelList`, which is what makes these two
  // work: a fresh reading of today's TAB-separated output would have required a
  // tab and reported an older build's catalog as empty — surfacing as "sign in
  // to Antigravity", the wrong diagnosis for a signed-in CLI.
  it('still reads an older agy build\'s bare-id rows', () => {
    expect(parseHarnessModels('agy', 'gemini-3.8-flash-high\nclaude-opus-4-6-thinking\n'))
      .toEqual(['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']);
  });

  it('drops the agy configured-default sentinel, which is not a model', () => {
    expect(parseHarnessModels('agy', 'antigravity-configured-default\ngemini-3.8-flash-high\n'))
      .toEqual(['gemini-3.8-flash-high']);
  });

  it('reads the Cursor catalog through the parser the provider card already uses', () => {
    const stdout = ['Available models:', '  auto - Auto', '  gpt-5.1 - GPT-5.1', ''].join('\n');
    expect(parseHarnessModels('cursor-agent', stdout)).toEqual(['auto', 'gpt-5.1']);
  });

  it('takes only Grok bullet rows, not its "Default model:" line', () => {
    const stdout = [
      'You are logged in with example.invalid.',
      '',
      'Default model: grok-4.6',
      '',
      'Available models:',
      '  * grok-4.6 (default)',
      '  - grok-4.5',
    ].join('\n');
    // A naive line parser reads `Default model: grok-4.6` as a model and would
    // write `model:` (or the banner) into every provider's picker.
    expect(parseHarnessModels('grok', stdout)).toEqual(['grok-4.6', 'grok-4.5']);
  });

  it('de-duplicates while preserving the vendor order', () => {
    expect(parseHarnessModels('opencode', 'a/one\na/two\na/one\n')).toEqual(['a/one', 'a/two']);
  });

  it('caps a runaway catalog', () => {
    const stdout = Array.from({ length: MAX_MODELS + 50 }, (_, i) => `x/model-${i}`).join('\n');
    expect(parseHarnessModels('opencode', stdout)).toHaveLength(MAX_MODELS);
  });

  it('returns [] for a harness with no parser and for non-string output', () => {
    expect(parseHarnessModels('claude', 'claude-opus-5')).toEqual([]);
    expect(parseHarnessModels('opencode', null)).toEqual([]);
  });
});
