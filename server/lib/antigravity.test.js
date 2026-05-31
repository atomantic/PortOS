import { describe, it, expect } from 'vitest';
import {
  ANTIGRAVITY_CLI_ID,
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  isAntigravityCommand,
  isAntigravityCliProvider,
  ensureAntigravityPrintArgs,
  ensureAntigravityTuiArgs,
  stripAntigravityUnsupportedArgs,
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
  it('injects --print and --dangerously-skip-permissions for empty args', () => {
    expect(ensureAntigravityPrintArgs([])).toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('strips legacy Gemini flags then injects print/skip-permissions', () => {
    expect(ensureAntigravityPrintArgs(['--yolo', '-m', 'gemini-2.5-pro', '--output-format', 'text']))
      .toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('does not duplicate --print when already present (incl. -p / --prompt)', () => {
    expect(ensureAntigravityPrintArgs(['--print'])).toEqual(['--print', '--dangerously-skip-permissions']);
    expect(ensureAntigravityPrintArgs(['-p'])).toEqual(['-p', '--dangerously-skip-permissions']);
    expect(ensureAntigravityPrintArgs(['--prompt'])).toEqual(['--prompt', '--dangerously-skip-permissions']);
  });

  it('does not add --dangerously-skip-permissions when --sandbox is present', () => {
    expect(ensureAntigravityPrintArgs(['--sandbox'])).toEqual(['--print', '--sandbox']);
  });

  it('does not duplicate --dangerously-skip-permissions', () => {
    expect(ensureAntigravityPrintArgs(['--dangerously-skip-permissions']))
      .toEqual(['--print', '--dangerously-skip-permissions']);
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
