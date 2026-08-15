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
    it('adds nothing to an empty argv — non-interactive mode is implicit in --prompt (#4139)', () => {
      expect(ensureKimiHeadlessArgs([])).toEqual([]);
    });
    it('passes user args through untouched when no model is pinned', () => {
      expect(ensureKimiHeadlessArgs(['--output-format', 'stream-json']))
        .toEqual(['--output-format', 'stream-json']);
    });
    it('injects --model only for a real (non-null) model id', () => {
      expect(ensureKimiHeadlessArgs([], 'kimi-k2')).toEqual(['--model', 'kimi-k2']);
      expect(ensureKimiHeadlessArgs([], null)).toEqual([]);
      expect(ensureKimiHeadlessArgs([], '')).toEqual([]);
    });
    it('does not duplicate a user-baked model flag', () => {
      expect(ensureKimiHeadlessArgs(['--model', 'mine'], 'other')).toEqual(['--model', 'mine']);
      expect(ensureKimiHeadlessArgs(['-m', 'mine'], 'other')).toEqual(['-m', 'mine']);
    });
    // Regression guard for #4139: a live kimi v0.32.0 exits at argv parsing on any
    // of these — `--print`/`--afk` are not options at all, and `--yolo`/`-y`/`--auto`
    // are refused alongside `--prompt` ("Cannot combine --prompt with --yolo.").
    it('never injects a flag the headless binary rejects', () => {
      const forbidden = ['--print', '--afk', '--yolo', '-y', '--auto'];
      for (const args of [[], ['--model', 'mine'], ['-p'], ['--prompt', 'x']]) {
        for (const model of [null, undefined, '', 'kimi-k2']) {
          const out = ensureKimiHeadlessArgs(args, model);
          for (const flag of forbidden) {
            expect(out.filter((a) => a === flag)).toEqual(args.filter((a) => a === flag));
          }
        }
      }
    });
  });

  describe('ensureKimiTuiArgs', () => {
    it('adds --yolo when no approval posture is pinned', () => {
      expect(ensureKimiTuiArgs([])).toEqual(['--yolo']);
    });
    it('is idempotent when --yolo is already present (seeded default)', () => {
      expect(ensureKimiTuiArgs(['--yolo'])).toEqual(['--yolo']);
    });
    it('respects a user-pinned -y short posture', () => {
      expect(ensureKimiTuiArgs(['-y'])).toEqual(['-y']);
    });
    it('still adds --yolo alongside a stale --afk (not a real kimi flag, #4139)', () => {
      expect(ensureKimiTuiArgs(['--afk'])).toEqual(['--afk', '--yolo']);
    });
  });

  describe('prepareKimiPrompt', () => {
    it('appends the prompt as the --prompt value, useStdin false', () => {
      const { args, useStdin, cleanup } = prepareKimiPrompt([], 'do the thing');
      expect(args).toEqual(['--prompt', 'do the thing']);
      expect(useStdin).toBe(false);
      expect(typeof cleanup).toBe('function');
    });
    it('appends after unrelated user args', () => {
      const { args } = prepareKimiPrompt(['--model', 'kimi-k2'], 'do the thing');
      expect(args).toEqual(['--model', 'kimi-k2', '--prompt', 'do the thing']);
    });
    it('splices the value after a user-baked prompt flag', () => {
      const { args } = prepareKimiPrompt(['--prompt'], 'task');
      expect(args).toEqual(['--prompt', 'task']);
    });
    it('splices after the short -p flag', () => {
      const { args } = prepareKimiPrompt(['-p'], 'task');
      expect(args).toEqual(['-p', 'task']);
    });
    it('coerces a non-string prompt to empty', () => {
      const { args } = prepareKimiPrompt([], undefined);
      expect(args).toEqual(['--prompt', '']);
    });
    it('REPLACES a user-baked separated prompt value instead of leaving it a stray positional (#2815)', () => {
      // ['--prompt','old'] must NOT become ['--prompt','task','old'] — the trailing
      // 'old' would reach kimi as a second, positional prompt.
      const { args } = prepareKimiPrompt(['--prompt', 'old'], 'task');
      expect(args).toEqual(['--prompt', 'task']);
    });
    it('replaces a baked -p short-flag value', () => {
      const { args } = prepareKimiPrompt(['-p', 'old', '--model', 'kimi-k2'], 'task');
      expect(args).toEqual(['-p', 'task', '--model', 'kimi-k2']);
    });
    it('replaces the value of a joined --prompt=old form (#2815)', () => {
      const { args } = prepareKimiPrompt(['--prompt=old'], 'task');
      expect(args).toEqual(['--prompt=task']);
    });
    it('replaces a joined -p=old short form', () => {
      const { args } = prepareKimiPrompt(['-p=old'], 'task');
      expect(args).toEqual(['-p=task']);
    });
    it('inserts a value after a trailing bare flag followed by another flag', () => {
      // --prompt is immediately followed by another flag, so it has no value yet;
      // insert (not replace) so the following flag is preserved.
      const { args } = prepareKimiPrompt(['--prompt', '--model'], 'task');
      expect(args).toEqual(['--prompt', 'task', '--model']);
    });
    it('uses the LAST prompt flag when more than one is baked in', () => {
      const { args } = prepareKimiPrompt(['--prompt', 'a', '-p', 'b'], 'task');
      expect(args).toEqual(['--prompt', 'a', '-p', 'task']);
    });
  });

  // The full headless argv as a spawn site assembles it, spelled out end to end
  // so a regression can't hide behind two individually-plausible halves (#4139).
  describe('headless argv, end to end', () => {
    const headlessArgv = (baseArgs, model, prompt) =>
      prepareKimiPrompt(ensureKimiHeadlessArgs(baseArgs, model), prompt).args;

    it('is just the prompt pair for the shipped (empty) provider args', () => {
      expect(headlessArgv([], null, 'summarize the diff')).toEqual(['--prompt', 'summarize the diff']);
    });
    it('carries a pinned model ahead of the prompt pair', () => {
      expect(headlessArgv([], 'kimi-k2', 'summarize the diff'))
        .toEqual(['--model', 'kimi-k2', '--prompt', 'summarize the diff']);
    });
    it('drops nothing a user pinned themselves', () => {
      expect(headlessArgv(['--output-format', 'stream-json'], null, 'go'))
        .toEqual(['--output-format', 'stream-json', '--prompt', 'go']);
    });
  });
});
