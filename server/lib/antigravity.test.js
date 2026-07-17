import { describe, it, expect } from 'vitest';
import {
  ANTIGRAVITY_CLI_ID,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  isAntigravityCommand,
  isAntigravityCliProvider,
  ensureAntigravityPrintArgs,
  ensureAntigravityTuiArgs,
  stripAntigravityUnsupportedArgs,
  prepareAntigravityPrompt,
} from './antigravity.js';

describe('antigravity command/provider predicates', () => {
  it('isAntigravityCommand matches agy and the antigravity alias', () => {
    expect(isAntigravityCommand('agy')).toBe(true);
    expect(isAntigravityCommand('antigravity')).toBe(true);
    expect(isAntigravityCommand('gemini')).toBe(false);
    expect(isAntigravityCommand(undefined)).toBe(false);
  });

  it('isAntigravityCliProvider matches by id OR command', () => {
    expect(isAntigravityCliProvider({ id: ANTIGRAVITY_CLI_ID })).toBe(true);
    expect(isAntigravityCliProvider({ command: 'agy' })).toBe(true);
    expect(isAntigravityCliProvider({ id: 'gemini-cli', command: 'gemini' })).toBe(false);
    expect(isAntigravityCliProvider(null)).toBe(false);
  });
});

describe('stripAntigravityUnsupportedArgs', () => {
  it('drops --yolo', () => {
    expect(stripAntigravityUnsupportedArgs(['--yolo'])).toEqual([]);
  });

  it('drops the space-separated model/output-format flag AND its value', () => {
    expect(stripAntigravityUnsupportedArgs(['-m', 'gemini-2.5-pro'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['--model', 'x', 'keep'])).toEqual(['keep']);
    expect(stripAntigravityUnsupportedArgs(['--output-format', 'text'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['-o', 'json'])).toEqual([]);
  });

  it('drops the equals-form model/output-format flag', () => {
    expect(stripAntigravityUnsupportedArgs(['--model=x'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['-m=x'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['--output-format=text'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['-o=json'])).toEqual([]);
  });

  it('preserves unrelated flags', () => {
    expect(stripAntigravityUnsupportedArgs(['--print', '--foo', 'bar'])).toEqual(['--print', '--foo', 'bar']);
  });

  it('handles a dangling space-form flag at the end without throwing', () => {
    expect(stripAntigravityUnsupportedArgs(['keep', '-m'])).toEqual(['keep']);
  });
});

describe('ensureAntigravityPrintArgs', () => {
  // agy takes the prompt as the VALUE of --print (it does NOT read stdin), so
  // --print must be the FINAL token and --dangerously-skip-permissions must come
  // BEFORE it — otherwise agy consumes the flag as the prompt text. That was the
  // shipped bug: the model received "--dangerously-skip-permissions" as its task.
  it('puts --print LAST with --dangerously-skip-permissions before it', () => {
    expect(ensureAntigravityPrintArgs([])).toEqual(['--dangerously-skip-permissions', '--print']);
  });

  it('never leaves a flag AFTER --print (regression: flag-swallowing)', () => {
    const args = ensureAntigravityPrintArgs([]);
    expect(args[args.length - 1]).toBe('--print');
    expect(args).not.toContain('--print --dangerously-skip-permissions');
  });

  it('strips legacy Gemini flags then emits skip-permissions + trailing --print', () => {
    expect(ensureAntigravityPrintArgs(['--yolo', '-m', 'gemini-2.5-pro', '--output-format', 'text']))
      .toEqual(['--dangerously-skip-permissions', '--print']);
  });

  it('normalizes any pre-baked print flag (--print / -p / --prompt) to a single trailing --print', () => {
    expect(ensureAntigravityPrintArgs(['--print'])).toEqual(['--dangerously-skip-permissions', '--print']);
    expect(ensureAntigravityPrintArgs(['-p'])).toEqual(['--dangerously-skip-permissions', '--print']);
    expect(ensureAntigravityPrintArgs(['--prompt'])).toEqual(['--dangerously-skip-permissions', '--print']);
  });

  it('does not add --dangerously-skip-permissions when --sandbox is present', () => {
    expect(ensureAntigravityPrintArgs(['--sandbox'])).toEqual(['--sandbox', '--print']);
  });

  it('does not duplicate --dangerously-skip-permissions', () => {
    expect(ensureAntigravityPrintArgs(['--dangerously-skip-permissions']))
      .toEqual(['--dangerously-skip-permissions', '--print']);
  });
});

describe('prepareAntigravityPrompt', () => {
  it('splices the prompt in as the VALUE of the trailing --print (no stdin)', () => {
    const built = ensureAntigravityPrintArgs([]);
    const { args, useStdin } = prepareAntigravityPrompt(built, 'do the creative work');
    expect(args).toEqual(['--dangerously-skip-permissions', '--print', 'do the creative work']);
    expect(useStdin).toBe(false);
  });

  it('keeps --dangerously-skip-permissions as a real flag, not the prompt', () => {
    const built = ensureAntigravityPrintArgs([]);
    const { args } = prepareAntigravityPrompt(built, 'PROMPT');
    // the flag stays before --print; only PROMPT follows --print
    expect(args.indexOf('--dangerously-skip-permissions')).toBeLessThan(args.indexOf('--print'));
    expect(args[args.indexOf('--print') + 1]).toBe('PROMPT');
  });

  it('appends --print + prompt when no print flag is present', () => {
    const { args, useStdin } = prepareAntigravityPrompt(['--sandbox'], 'hi');
    expect(args).toEqual(['--sandbox', '--print', 'hi']);
    expect(useStdin).toBe(false);
  });

  it('returns a callable no-op cleanup', () => {
    const { cleanup } = prepareAntigravityPrompt(['--print'], 'x');
    expect(() => cleanup()).not.toThrow();
  });
});

describe('ensureAntigravityTuiArgs', () => {
  it('strips legacy flags and adds --dangerously-skip-permissions (no --print)', () => {
    expect(ensureAntigravityTuiArgs(['--yolo', '--model', 'gemini-2.5-pro']))
      .toEqual(['--dangerously-skip-permissions']);
  });

  it('respects an existing --sandbox', () => {
    expect(ensureAntigravityTuiArgs(['--sandbox'])).toEqual(['--sandbox']);
  });
});

describe('ANTIGRAVITY_CONFIGURED_DEFAULT', () => {
  it('matches the cross-module sentinel value', () => {
    expect(ANTIGRAVITY_CONFIGURED_DEFAULT).toBe('antigravity-configured-default');
  });
});
