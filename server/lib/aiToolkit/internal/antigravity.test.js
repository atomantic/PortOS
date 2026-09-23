import { describe, it, expect } from 'vitest';
import { ANTIGRAVITY_CONFIGURED_DEFAULT, isAntigravityCommand, parseAntigravityModelList } from './antigravity.js';
// The toolkit SOURCE may not import out to server/lib (see ../AGENTS.md); a test
// may, and this is the only way to actually pin the duplication it documents.
import {
  isAntigravityCommand as upstreamIsAntigravityCommand,
  parseAntigravityModelList as upstreamParseAntigravityModelList,
} from '../../antigravity.js';

// Older agy builds print one bare id per line. Shape reproduced from the real
// binary: a blank line, the ids, and (on some builds) a status/banner line the
// filter has to reject.
const REAL_OUTPUT = `
gemini-3.1-pro-high
gemini-3.1-pro
claude-sonnet-4-6
gpt-5.2-codex

`;

// agy 2026-08 prints `<id>\t<Label>` instead. Transcribed verbatim from
// `agy models` stdout (the "Fetching available models…" banner goes to stderr,
// so it never reaches the parser). Parsing this shape as bare ids yields ZERO
// models, which is what broke the Image Gen agy model picker.
const TAB_LABELLED_OUTPUT = [
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n');

describe('parseAntigravityModelList', () => {
  // Success-path coverage for the parser extracted out of providerCatalogService.js. Without
  // it, `agy models` had no test that ever fed the filter real output — only a
  // spawn-failure case — so narrowing the character class or dropping the
  // sentinel filter would have kept the whole suite green.
  it('extracts bare ids and drops blank lines', () => {
    expect(parseAntigravityModelList(REAL_OUTPUT)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'gpt-5.2-codex',
    ]);
  });

  it('extracts the id column from the tab-labelled shape agy prints today', () => {
    expect(parseAntigravityModelList(TAB_LABELLED_OUTPUT)).toEqual([
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);
  });

  it('rejects prose rather than surrendering its first word as an id', () => {
    // The reason the label is anchored on a TAB and not "first whitespace
    // token": every one of these lines leads with a regex-valid word, and a
    // whitespace split would persist "Fetching"/"Available"/"Tip" as models.
    expect(parseAntigravityModelList([
      'Fetching available models...',
      'Available models',
      'Tip: use --model <id> to switch',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
    ].join('\n'))).toEqual(['gemini-3.6-flash-high']);
  });

  it('drops banner/status prose — anything that is not a bare id', () => {
    const out = parseAntigravityModelList('Available models:\ngemini-3.1-pro\nTip: use --model <id>\n');
    expect(out).toEqual(['gemini-3.1-pro']);
  });

  it('drops the configured-default sentinel so the caller can re-prepend it once', () => {
    // The caller does `[SENTINEL, ...new Set(listed)]`. If the filter let the
    // sentinel through, it would appear twice on any build that lists it.
    const out = parseAntigravityModelList(`${ANTIGRAVITY_CONFIGURED_DEFAULT}\ngemini-3.1-pro\n`);
    expect(out).toEqual(['gemini-3.1-pro']);
    expect(out).not.toContain(ANTIGRAVITY_CONFIGURED_DEFAULT);
  });

  it('handles CRLF line endings', () => {
    expect(parseAntigravityModelList('gemini-3.1-pro\r\nclaude-sonnet-4-6\r\n'))
      .toEqual(['gemini-3.1-pro', 'claude-sonnet-4-6']);
  });

  it('accepts the punctuation real ids use, and rejects ids with spaces', () => {
    expect(parseAntigravityModelList('gpt-5.2-codex\nqwen2.5:7b\nvendor/model\nnot an id\n'))
      .toEqual(['gpt-5.2-codex', 'qwen2.5:7b', 'vendor/model']);
  });

  it('returns an empty list for blank and non-string input', () => {
    // The caller turns empty into a THROW, so this must not invent entries.
    expect(parseAntigravityModelList('')).toEqual([]);
    expect(parseAntigravityModelList('\n\n')).toEqual([]);
    expect(parseAntigravityModelList(null)).toEqual([]);
    expect(parseAntigravityModelList(undefined)).toEqual([]);
  });
});

describe('vendored copy stays in sync with server/lib/antigravity.js', () => {
  it('agrees with upstream on every command-matching case', () => {
    const cases = [
      'agy', 'antigravity', '/opt/homebrew/bin/agy', 'C:\\Tools\\agy.exe', 'AGY',
      'agy.cmd', 'claude', 'cursor-agent', '',
    ];
    for (const c of cases) {
      expect(isAntigravityCommand(c), `disagreement on ${JSON.stringify(c)}`)
        .toBe(upstreamIsAntigravityCommand(c));
    }
  });

  it('agrees with upstream on every `agy models` output shape', () => {
    // Image Gen parses `agy models` through the upstream copy and the provider
    // catalog refresh through this one. A fix applied to only one of them is
    // exactly how the picker went empty while the catalog still worked.
    const cases = [
      REAL_OUTPUT,
      TAB_LABELLED_OUTPUT,
      'Available models:\ngemini-3.1-pro\nTip: use --model <id>\n',
      `${ANTIGRAVITY_CONFIGURED_DEFAULT}\ngemini-3.1-pro\n`,
      'gemini-3.1-pro\r\nclaude-sonnet-4-6\r\n',
      'gpt-5.2-codex\nqwen2.5:7b\nvendor/model\nnot an id\n',
      '',
    ];
    for (const c of cases) {
      expect(parseAntigravityModelList(c), `disagreement on ${JSON.stringify(c)}`)
        .toEqual(upstreamParseAntigravityModelList(c));
    }
  });
});
