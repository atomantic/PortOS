import { describe, it, expect } from 'vitest';
import {
  KIMI_CLI_ID,
  KIMI_TUI_ID,
  isKimiCommand,
  isKimiCliProvider,
  isKimiTuiProvider,
  ensureKimiHeadlessArgs,
  ensureKimiTuiArgs,
  prepareKimiPrompt,
} from './kimi.js';

describe('kimi.js', () => {
  describe('isKimiCommand', () => {
    it('matches the bare binary, a path, and a Windows .exe', () => {
      expect(isKimiCommand('kimi')).toBe(true);
      expect(isKimiCommand('/opt/homebrew/bin/kimi')).toBe(true);
      expect(isKimiCommand('C:\\tools\\Kimi.exe')).toBe(true);
    });
    it('rejects other binaries and empty input', () => {
      expect(isKimiCommand('grok')).toBe(false);
      expect(isKimiCommand('claude')).toBe(false);
      expect(isKimiCommand('')).toBe(false);
      expect(isKimiCommand(null)).toBe(false);
      expect(isKimiCommand(undefined)).toBe(false);
    });
  });

  describe('provider predicates', () => {
    it('detects the CLI provider by id or type+command', () => {
      expect(isKimiCliProvider({ id: KIMI_CLI_ID })).toBe(true);
      expect(isKimiCliProvider({ type: 'cli', command: '/usr/local/bin/kimi' })).toBe(true);
      expect(isKimiCliProvider({ type: 'tui', command: 'kimi' })).toBe(false);
      expect(isKimiCliProvider({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(false);
    });
    it('detects the TUI provider by id or type+command', () => {
      expect(isKimiTuiProvider({ id: KIMI_TUI_ID })).toBe(true);
      expect(isKimiTuiProvider({ type: 'tui', command: 'kimi' })).toBe(true);
      expect(isKimiTuiProvider({ type: 'cli', command: 'kimi' })).toBe(false);
    });
  });

  describe('ensureKimiHeadlessArgs', () => {
    it('adds --print when absent', () => {
      expect(ensureKimiHeadlessArgs([])).toEqual(['--print']);
    });
    it('does not double-add --print when already present (seeded default)', () => {
      expect(ensureKimiHeadlessArgs(['--print'])).toEqual(['--print']);
    });
    it('injects --model only for a real (non-null) model id', () => {
      expect(ensureKimiHeadlessArgs(['--print'], 'kimi-k2')).toEqual(['--print', '--model', 'kimi-k2']);
      expect(ensureKimiHeadlessArgs(['--print'], null)).toEqual(['--print']);
      expect(ensureKimiHeadlessArgs(['--print'], '')).toEqual(['--print']);
    });
    it('does not duplicate a user-baked model flag', () => {
      expect(ensureKimiHeadlessArgs(['--print', '--model', 'mine'], 'other')).toEqual(['--print', '--model', 'mine']);
      expect(ensureKimiHeadlessArgs(['-m', 'mine'], 'other')).toEqual(['-m', 'mine', '--print']);
    });
  });

  describe('ensureKimiTuiArgs', () => {
    it('adds --yolo when no approval posture is pinned', () => {
      expect(ensureKimiTuiArgs([])).toEqual(['--yolo']);
    });
    it('is idempotent when --yolo is already present (seeded default)', () => {
      expect(ensureKimiTuiArgs(['--yolo'])).toEqual(['--yolo']);
    });
    it('respects a user-pinned approval posture (-y / --afk)', () => {
      expect(ensureKimiTuiArgs(['-y'])).toEqual(['-y']);
      expect(ensureKimiTuiArgs(['--afk'])).toEqual(['--afk']);
    });
  });

  describe('prepareKimiPrompt', () => {
    it('appends the prompt as the --prompt value, useStdin false', () => {
      const { args, useStdin, cleanup } = prepareKimiPrompt(['--print'], 'do the thing');
      expect(args).toEqual(['--print', '--prompt', 'do the thing']);
      expect(useStdin).toBe(false);
      expect(typeof cleanup).toBe('function');
    });
    it('splices the value after a user-baked prompt flag', () => {
      const { args } = prepareKimiPrompt(['--print', '--prompt'], 'task');
      expect(args).toEqual(['--print', '--prompt', 'task']);
    });
    it('splices after the short -p flag', () => {
      const { args } = prepareKimiPrompt(['-p'], 'task');
      expect(args).toEqual(['-p', 'task']);
    });
    it('coerces a non-string prompt to empty', () => {
      const { args } = prepareKimiPrompt(['--print'], undefined);
      expect(args).toEqual(['--print', '--prompt', '']);
    });
  });
});
