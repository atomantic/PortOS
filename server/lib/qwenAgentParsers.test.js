import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './childProcess.js';
import {
  QWEN_AGENT_PARSERS,
  QWEN_AGENT_RUNTIMES,
  parserFlagsFor,
  qwenAgentParsersFor,
  vllmExtraArgs,
} from './qwenAgentParsers.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('QWEN_AGENT_PARSERS', () => {
  it('pins the measured vLLM spelling (qwen3_xml, never hermes)', () => {
    // docs/research/2026-08-21-qwen38-rtx3090-vllm.md: hermes parses nothing
    // because Qwen3.8 emits XML, and vLLM reports the failure as plain text.
    const flags = parserFlagsFor('vllm');
    expect(flags).toContain('qwen3_xml');
    expect(flags).not.toContain('qwen3_coder');
    expect(flags).not.toContain('hermes');
  });

  it('carries --enable-auto-tool-choice for vLLM, which 400s without it', () => {
    expect(parserFlagsFor('vllm')).toEqual([
      '--enable-auto-tool-choice',
      '--tool-call-parser',
      'qwen3_xml',
    ]);
  });

  it('pins the SGLang cookbook spellings (tool AND reasoning parser)', () => {
    expect(parserFlagsFor('sglang')).toEqual([
      '--tool-call-parser',
      'qwen3_coder',
      '--reasoning-parser',
      'qwen3',
    ]);
  });

  it('returns no flags for llama, whose server has no equivalent today', () => {
    expect(parserFlagsFor('llama')).toEqual([]);
  });

  it('throws on an unknown runtime rather than serving parser-less', () => {
    expect(() => parserFlagsFor('nope')).toThrow(/Unknown Qwen agent runtime 'nope'/);
    // The message has to name the alternatives — a bare throw sends the next
    // author back to grepping for the table.
    expect(() => qwenAgentParsersFor('nope')).toThrow(/vllm, sglang, llama/);
  });

  it('throws on prototype keys, not just absent ones', () => {
    expect(() => parserFlagsFor('toString')).toThrow(/Unknown Qwen agent runtime/);
    expect(() => parserFlagsFor('constructor')).toThrow(/Unknown Qwen agent runtime/);
  });

  it('declares every runtime with an explicit decision for both parsers', () => {
    expect(QWEN_AGENT_RUNTIMES).toEqual(['vllm', 'sglang', 'llama']);
    for (const [runtime, row] of Object.entries(QWEN_AGENT_PARSERS)) {
      // `null` is a positive "this runtime has no such flag" decision; the row
      // must never simply omit the key, which reads as an oversight.
      expect(Object.keys(row).sort(), `${runtime} row shape`).toEqual([
        'enableAutoToolChoice',
        'reasoningParser',
        'toolCallParser',
      ]);
      expect(typeof row.enableAutoToolChoice, `${runtime}.enableAutoToolChoice`).toBe('boolean');
    }
  });
});

describe('vllmExtraArgs', () => {
  it('is the string form of the vLLM argv fragment', () => {
    expect(vllmExtraArgs()).toBe('--enable-auto-tool-choice --tool-call-parser qwen3_xml');
    expect(vllmExtraArgs()).toBe(parserFlagsFor('vllm').join(' '));
  });

  it('matches the EXTRA_ARGS line documented in the 3090 feature doc', () => {
    // The doc's copy-paste snippet is the de-facto install instruction until
    // #4767 writes .env itself. If someone edits either side, this fails rather
    // than letting the doc and the table drift into two different spellings.
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'features', 'qwen38-rtx3090.md'), 'utf8');
    expect(doc).toContain(`EXTRA_ARGS=${vllmExtraArgs()}`);
  });
});

describe('qwen parser spellings live only in the table', () => {
  it('no other tracked source file hard-codes a qwen3 parser spelling', () => {
    // Acceptance criterion of #4778: the SGLang runtime (#4776) and the vLLM
    // guided install (#4767) must import this table instead of retyping the
    // string. Scoped to git-tracked JS so scratch files never flake it.
    const tracked = execFileSync('git', ['ls-files', '*.js', '*.jsx', '*.cjs', '*.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    const allowed = new Set(['server/lib/qwenAgentParsers.js', 'server/lib/qwenAgentParsers.test.js']);
    const offenders = tracked.filter((rel) => {
      if (allowed.has(rel)) return false;
      return /qwen3_xml|qwen3_coder/.test(readFileSync(join(REPO_ROOT, rel), 'utf8'));
    });
    expect(
      offenders,
      `These files hard-code a Qwen tool-call parser spelling — import parserFlagsFor() from server/lib/qwenAgentParsers.js instead: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
