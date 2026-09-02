import { describe, expect, it } from 'vitest';

import {
  generateVllmApiKey,
  isWsl2Engine,
  mergeEnvFileContents,
  parseEnvContents,
  upsertEnvLine,
  vllmEnvDefaults,
  VLLM_API_KEY_VAR,
} from './vllmQwenProvision.js';
import { vllmExtraArgs } from './qwenAgentParsers.js';

const defaults = (wsl2 = false) => vllmEnvDefaults({ apiKey: 'generated-key', wsl2 });

describe('generateVllmApiKey', () => {
  it('mints a fresh 24-byte hex token each call', () => {
    const a = generateVllmApiKey();
    const b = generateVllmApiKey();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).not.toBe(a);
  });
});

describe('isWsl2Engine', () => {
  it('counts win32 — Docker Desktop\'s engine IS a WSL2 VM', () => {
    // The feature doc's shell snippet tests /proc/version, which a native-Win32
    // PortOS cannot read at all. Trusting only that test is what would omit the
    // two mandatory WSL2 variables on exactly the host that needs them, and the
    // symptom is a quiet compose crash-loop rather than an error.
    expect(isWsl2Engine({ platform: 'win32', procVersion: null })).toBe(true);
  });

  it('matches a WSL2 distro by its own /proc/version', () => {
    expect(isWsl2Engine({ platform: 'linux', procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2' })).toBe(true);
  });

  it('is false on native Linux and on darwin', () => {
    expect(isWsl2Engine({ platform: 'linux', procVersion: 'Linux version 6.8.0-generic' })).toBe(false);
    expect(isWsl2Engine({ platform: 'linux', procVersion: null })).toBe(false);
    expect(isWsl2Engine({ platform: 'darwin', procVersion: null })).toBe(false);
  });
});

describe('vllmEnvDefaults', () => {
  it('always carries the tool-parser line, which is the setting agents die without', () => {
    const keys = Object.fromEntries(defaults());
    // Asserted against the owning table, so a corrected spelling there reaches
    // the guided install without a second edit here.
    expect(keys.EXTRA_ARGS).toBe(vllmExtraArgs());
    expect(keys.EXTRA_ARGS).toContain('--tool-call-parser');
    expect(keys.SPEC).toBe('dflash2');
    expect(keys.PREFIX_CACHE).toBe('1');
    expect(keys[VLLM_API_KEY_VAR]).toBe('generated-key');
  });

  it('adds the WSL2 pair only for a WSL2 engine', () => {
    expect(Object.fromEntries(defaults(false))).not.toHaveProperty('VLLM_WSL2_ENABLE_PIN_MEMORY');
    expect(Object.fromEntries(defaults(true))).toMatchObject({
      VLLM_WSL2_ENABLE_PIN_MEMORY: '1',
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:False',
    });
  });
});

describe('parseEnvContents', () => {
  it('reads plain, quoted, and whitespace-padded assignments', () => {
    const found = parseEnvContents('  A=1\nB="two"\nC=\'three\'\n');
    expect(Object.fromEntries(found)).toEqual({ A: '1', B: 'two', C: 'three' });
  });

  it('treats a present-but-empty value as SET and a commented-out key as absent', () => {
    // The distinction the whole module turns on: `EXTRA_ARGS=` is a decision the
    // operator made, `# EXTRA_ARGS=…` is a line that is not in effect.
    const found = parseEnvContents('EXTRA_ARGS=\n# SPEC=dflash2\n');
    expect(found.has('EXTRA_ARGS')).toBe(true);
    expect(found.get('EXTRA_ARGS')).toBe('');
    expect(found.has('SPEC')).toBe(false);
  });

  it('ignores blank lines and lines with no key', () => {
    expect([...parseEnvContents('\n\n=orphan\nnot-an-assignment\n').keys()]).toEqual([]);
  });
});

describe('mergeEnvFileContents', () => {
  it('appends only the missing keys and reports both sides by name', () => {
    const result = mergeEnvFileContents('SPEC=custom\n', defaults());
    expect(result.kept).toEqual(['SPEC']);
    expect(result.added).toEqual([VLLM_API_KEY_VAR, 'PREFIX_CACHE', 'EXTRA_ARGS']);
    expect(result.contents.startsWith('SPEC=custom\n')).toBe(true);
    expect(result.contents.match(/^SPEC=/gm)).toHaveLength(1);
  });

  it('never overwrites an operator value — and reports THEIRS as effective', () => {
    // The caller propagates `effective`, so a project that already had a key
    // keeps serving on it and the providers are pointed at that one.
    const result = mergeEnvFileContents('VLLM_API_KEY=operator-chosen\nGPU_UTIL=0.93\n', defaults());
    expect(result.effective[VLLM_API_KEY_VAR]).toBe('operator-chosen');
    expect(result.contents).toContain('GPU_UTIL=0.93');
    expect(result.contents.match(/^VLLM_API_KEY=/gm)).toHaveLength(1);
  });

  it('writes every default into an absent file', () => {
    const result = mergeEnvFileContents('', defaults(true));
    expect(result.kept).toEqual([]);
    expect(result.added).toHaveLength(6);
    expect(result.contents).toBe([
      'VLLM_API_KEY=generated-key',
      'SPEC=dflash2',
      'PREFIX_CACHE=1',
      `EXTRA_ARGS=${vllmExtraArgs()}`,
      'VLLM_WSL2_ENABLE_PIN_MEMORY=1',
      'PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False',
      '',
    ].join('\n'));
  });

  it('does not splice onto a file that lacks a trailing newline', () => {
    const result = mergeEnvFileContents('GPU_UTIL=0.93', [['SPEC', 'dflash2']]);
    expect(result.contents).toBe('GPU_UTIL=0.93\nSPEC=dflash2\n');
  });

  it('returns the file untouched when nothing is missing', () => {
    const existing = 'VLLM_API_KEY=k\nSPEC=s\nPREFIX_CACHE=0\nEXTRA_ARGS=--whatever\n';
    const result = mergeEnvFileContents(existing, defaults());
    expect(result.contents).toBe(existing);
    expect(result.added).toEqual([]);
  });
});

describe('upsertEnvLine', () => {
  it('replaces the line a key already declares, leaving the rest byte for byte', () => {
    const existing = 'PGPASSWORD=portos\nVLLM_QWEN_PROJECT_DIR=/srv/old\nGPU_UTIL=0.93\n';
    expect(upsertEnvLine(existing, 'VLLM_QWEN_PROJECT_DIR', '/srv/new'))
      .toBe('PGPASSWORD=portos\nVLLM_QWEN_PROJECT_DIR=/srv/new\nGPU_UTIL=0.93\n');
  });

  it('appends a key the file does not mention, without splicing onto its last line', () => {
    expect(upsertEnvLine('PGPASSWORD=portos', 'VLLM_QWEN_PROJECT_DIR', '/srv/qwen'))
      .toBe('PGPASSWORD=portos\nVLLM_QWEN_PROJECT_DIR=/srv/qwen\n');
    expect(upsertEnvLine('', 'SPEC', 'dflash2')).toBe('SPEC=dflash2\n');
  });

  it('writes a value containing a $-pattern literally', () => {
    // A string replacement would expand `$&` into the matched line and `$\`` into
    // everything before it, corrupting the file and every key around it.
    const written = upsertEnvLine('A=1\nSECRET=old\nB=2\n', 'SECRET', 'p$&w$`d');
    expect(written).toBe('A=1\nSECRET=p$&w$`d\nB=2\n');
    expect(parseEnvContents(written).get('SECRET')).toBe('p$&w$`d');
  });
});
