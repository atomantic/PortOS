import { describe, it, expect } from 'vitest';
import {
  CURSOR_COMMAND,
  isCursorCommand,
  ensureCursorHeadlessArgs,
  ensureCursorTuiArgs,
} from './cursor.js';

describe('isCursorCommand', () => {
  it('matches the bare binary, a path to it, and a Windows .exe', () => {
    expect(isCursorCommand('cursor-agent')).toBe(true);
    expect(isCursorCommand('/Users/x/.local/bin/cursor-agent')).toBe(true);
    expect(isCursorCommand('C:\\tools\\cursor-agent.exe')).toBe(true);
    expect(isCursorCommand('CURSOR-AGENT')).toBe(true);
  });

  it('does NOT match a bare `cursor` — that is the GUI editor launcher', () => {
    expect(isCursorCommand('cursor')).toBe(false);
    expect(isCursorCommand('/usr/local/bin/cursor')).toBe(false);
  });

  it('is false for other CLIs and for empty/nullish input', () => {
    expect(isCursorCommand('claude')).toBe(false);
    expect(isCursorCommand('')).toBe(false);
    expect(isCursorCommand(null)).toBe(false);
    expect(isCursorCommand(undefined)).toBe(false);
  });
});

describe('ensureCursorHeadlessArgs', () => {
  it('injects print mode, the trust/approval posture, and the model', () => {
    expect(ensureCursorHeadlessArgs([], 'auto')).toEqual(['--print', '--force', '--model', 'auto']);
  });

  it('omits --model when no model is given (cursor falls back to its own default)', () => {
    expect(ensureCursorHeadlessArgs([], null)).toEqual(['--print', '--force']);
    expect(ensureCursorHeadlessArgs([], '')).toEqual(['--print', '--force']);
  });

  it('folds a pinned effort into --model instead of emitting an --effort flag', () => {
    // cursor-agent has no --effort; passing one exits non-zero.
    expect(ensureCursorHeadlessArgs([], 'gpt-5', 'max'))
      .toEqual(['--print', '--force', '--model', 'gpt-5[effort=max]']);
    expect(ensureCursorHeadlessArgs([], 'claude-opus-4-7[thinking=true]', 'high'))
      .toEqual(['--print', '--force', '--model', 'claude-opus-4-7[thinking=true,effort=high]']);
    expect(ensureCursorHeadlessArgs([], 'gpt-5', 'max')).not.toContain('--effort');
  });

  it('drops an effort with no model to attach it to', () => {
    expect(ensureCursorHeadlessArgs([], null, 'max')).toEqual(['--print', '--force']);
  });

  it('does not duplicate print mode pinned in either form', () => {
    expect(ensureCursorHeadlessArgs(['--print'], null)).toEqual(['--print', '--force']);
    expect(ensureCursorHeadlessArgs(['-p'], null)).toEqual(['-p', '--force']);
  });

  // Only a flag covering BOTH gates (trust + approval) means we owe nothing.
  it('adds nothing when the pinned flag already covers both gates', () => {
    for (const flag of ['--force', '-f', '--yolo']) {
      expect(ensureCursorHeadlessArgs(['--print', flag], null)).toEqual(['--print', flag]);
    }
  });

  // `--trust` clears trust but grants NO approval — the run would reach the first
  // tool call and stall there until the provider timeout expires.
  it('adds --force for approval when the user pinned only --trust', () => {
    expect(ensureCursorHeadlessArgs(['--print', '--trust'], null)).toEqual(['--print', '--trust', '--force']);
  });

  // `--auto-review` is an approval posture that does NOT clear trust — without a
  // trust flag cursor prints "Workspace Trust Required" and exits doing no work.
  // The pinned posture must be preserved, so we add the narrow `--trust`, not `--force`.
  it('adds --trust (not --force) when the user pinned only --auto-review', () => {
    expect(ensureCursorHeadlessArgs(['--print', '--auto-review'], null))
      .toEqual(['--print', '--auto-review', '--trust']);
  });

  it('respects a joined posture flag (--force=true style)', () => {
    expect(ensureCursorHeadlessArgs(['--print', '--force=true'], null)).toEqual(['--print', '--force=true']);
  });

  it('respects a user-baked model flag rather than emitting a second one', () => {
    expect(ensureCursorHeadlessArgs(['--print', '--force', '--model', 'mine'], 'auto'))
      .toEqual(['--print', '--force', '--model', 'mine']);
    expect(ensureCursorHeadlessArgs(['--print', '--force', '--model=mine'], 'auto'))
      .toEqual(['--print', '--force', '--model=mine']);
  });

  it('does not mutate the caller-supplied args array', () => {
    const base = ['--print'];
    ensureCursorHeadlessArgs(base, 'auto');
    expect(base).toEqual(['--print']);
  });

  it('is idempotent', () => {
    const once = ensureCursorHeadlessArgs([], 'auto');
    expect(ensureCursorHeadlessArgs(once, 'auto')).toEqual(once);
  });
});

describe('ensureCursorTuiArgs', () => {
  it('injects --force so the PTY session clears trust and auto-approves tools', () => {
    expect(ensureCursorTuiArgs([])).toEqual(['--force']);
  });

  it('adds nothing when the pinned flag already covers both gates', () => {
    for (const flag of ['--force', '-f', '--yolo']) {
      expect(ensureCursorTuiArgs([flag])).toEqual([flag]);
    }
  });

  it('adds --force for approval when the user pinned only --trust', () => {
    expect(ensureCursorTuiArgs(['--trust'])).toEqual(['--trust', '--force']);
  });

  it('adds --trust for the trust gate when the user pinned only --auto-review', () => {
    expect(ensureCursorTuiArgs(['--auto-review'])).toEqual(['--auto-review', '--trust']);
  });

  it('does not mutate the caller-supplied args array and is idempotent', () => {
    const base = [];
    const once = ensureCursorTuiArgs(base);
    expect(base).toEqual([]);
    expect(ensureCursorTuiArgs(once)).toEqual(once);
  });
});

describe('CURSOR_COMMAND', () => {
  // Consumed by inferTuiCommand + the CLI spawn fallback, so a rename here has
  // to stay in step with the seeds' `command` field.
  it('is the agent binary the shipped providers name', () => {
    expect(CURSOR_COMMAND).toBe('cursor-agent');
    expect(isCursorCommand(CURSOR_COMMAND)).toBe(true);
  });
});
