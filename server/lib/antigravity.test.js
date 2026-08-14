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

  it('isAntigravityCommand recognizes a path- or .exe-configured agy (prompt-delivery parity with buildCliArgs)', () => {
    // A provider whose command is an absolute path or Windows .exe must still be
    // detected, or prepareCliPrompt falls through to stdin and loses the prompt
    // while the trailing --print marker (added by id) is left dangling.
    expect(isAntigravityCommand('/opt/homebrew/bin/agy')).toBe(true);
    expect(isAntigravityCommand('C:\\tools\\agy.exe')).toBe(true);
    expect(isAntigravityCommand('agy.exe')).toBe(true);
    expect(isAntigravityCommand('/usr/local/bin/antigravity')).toBe(true);
    expect(isAntigravityCommand('/usr/local/bin/claude')).toBe(false);
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

  it('drops the space-separated legacy-Gemini flag AND its value', () => {
    expect(stripAntigravityUnsupportedArgs(['-m', 'gemini-2.5-pro'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['--output-format', 'text'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['-o', 'json'])).toEqual([]);
  });

  it('drops the equals-form legacy-Gemini flag', () => {
    expect(stripAntigravityUnsupportedArgs(['-m=x'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['--output-format=text'])).toEqual([]);
    expect(stripAntigravityUnsupportedArgs(['-o=json'])).toEqual([]);
  });

  // agy grew a per-session `--model` flag, so a long-form pin is a real user
  // selection to keep — only the legacy `-m` spelling it never accepted goes.
  it('preserves a long-form --model pin (both spellings)', () => {
    expect(stripAntigravityUnsupportedArgs(['--model', 'x', 'keep'])).toEqual(['--model', 'x', 'keep']);
    expect(stripAntigravityUnsupportedArgs(['--model=x'])).toEqual(['--model=x']);
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

  // Per-run model/effort must land BEFORE the trailing --print marker, or agy
  // would consume `--model` as the prompt text.
  it('injects the per-run model and effort ahead of the trailing --print', () => {
    expect(ensureAntigravityPrintArgs([], { model: 'claude-sonnet-4-6', effort: 'medium' }))
      .toEqual(['--model', 'claude-sonnet-4-6', '--effort', 'medium', '--dangerously-skip-permissions', '--print']);
  });

  it('omits --model for the configured-default sentinel (agy keeps its own default)', () => {
    expect(ensureAntigravityPrintArgs([], { model: 'antigravity-configured-default' }))
      .toEqual(['--dangerously-skip-permissions', '--print']);
  });

  it('clamps an out-of-range effort to agy\'s top level', () => {
    expect(ensureAntigravityPrintArgs([], { effort: 'max' }))
      .toEqual(['--effort', 'high', '--dangerously-skip-permissions', '--print']);
  });

  it('drops a dangling --model rather than emitting it twice', () => {
    // The suffixed id splits into base + `--effort` (equivalent invocation).
    expect(ensureAntigravityPrintArgs(['--model'], { model: 'gemini-3.1-pro-low' }))
      .toEqual(['--model', 'gemini-3.1-pro', '--effort', 'low', '--dangerously-skip-permissions', '--print']);
  });

  // This is the path every production caller uses (buildCliArgs,
  // buildCliSpawnConfig, askService), so the "user-baked pin wins" contract is
  // pinned here rather than only on the TUI normalizer.
  it('lets a user-baked --model pin win over the per-run model (both spellings)', () => {
    expect(ensureAntigravityPrintArgs(['--model', 'claude-sonnet-4-6'], { model: 'gemini-3.1-pro-high' }))
      .toEqual(['--model', 'claude-sonnet-4-6', '--dangerously-skip-permissions', '--print']);
    expect(ensureAntigravityPrintArgs(['--model=claude-sonnet-4-6'], { model: 'gemini-3.1-pro-high' }))
      .toEqual(['--model=claude-sonnet-4-6', '--dangerously-skip-permissions', '--print']);
  });

  it('lets a user-baked --effort pin win over the per-run effort', () => {
    expect(ensureAntigravityPrintArgs(['--effort', 'low'], { effort: 'high' }))
      .toEqual(['--effort', 'low', '--dangerously-skip-permissions', '--print']);
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

  // #4110: runCliProviderPrompt concatenates a call's extraArgs onto
  // buildCliArgs' output, which for agy already ends in the bare `--print`
  // marker (cliProviderRun.js). Splicing
  // the prompt in after the flag's *current* position would leave the extraArgs
  // trailing the prompt as stray positionals; the pair must be re-anchored.
  it('re-anchors --print + prompt at the END when extraArgs trail the marker', () => {
    const built = ensureAntigravityPrintArgs([]);
    const extraArgs = ['--include-directories', '/srv/example'];
    const { args } = prepareAntigravityPrompt([...built, ...extraArgs], 'PROMPT');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--include-directories',
      '/srv/example',
      '--print',
      'PROMPT',
    ]);
    // the pair is final, and every extraArg precedes it
    expect(args.slice(-2)).toEqual(['--print', 'PROMPT']);
    for (const extra of extraArgs) {
      expect(args.indexOf(extra)).toBeLessThan(args.indexOf('--print'));
    }
    // exactly one print flag survives the move
    expect(args.filter((a) => a === '--print')).toHaveLength(1);
  });

  it('leaves the empty-extraArgs shape unchanged (no duplicate or moved flag)', () => {
    const built = ensureAntigravityPrintArgs([]);
    const { args } = prepareAntigravityPrompt([...built], 'PROMPT');
    expect(args).toEqual(['--dangerously-skip-permissions', '--print', 'PROMPT']);
  });

  it('preserves the print flag spelling when relocating it', () => {
    const { args } = prepareAntigravityPrompt(['-p', '--verbose'], 'PROMPT');
    expect(args).toEqual(['--verbose', '-p', 'PROMPT']);
  });

  // extraArgs are concatenated on AFTER ensureAntigravityPrintArgs has stripped
  // baked print flags, so they can smuggle a second one in. A leftover flag
  // would make agy read the token after IT as the prompt.
  it('lifts EVERY print flag, not just the last, and the last spelling wins', () => {
    const { args } = prepareAntigravityPrompt(['--print', '--verbose', '-p'], 'PROMPT');
    expect(args).toEqual(['--verbose', '-p', 'PROMPT']);
    expect(args.filter((a) => a === '--print')).toHaveLength(0);
  });
});

describe('ensureAntigravityTuiArgs', () => {
  it('strips legacy flags and adds --dangerously-skip-permissions (no --print)', () => {
    expect(ensureAntigravityTuiArgs(['--yolo', '-m', 'gemini-2.5-pro']))
      .toEqual(['--dangerously-skip-permissions']);
  });

  it('respects an existing --sandbox', () => {
    expect(ensureAntigravityTuiArgs(['--sandbox'])).toEqual(['--sandbox']);
  });

  // The TUI path injects model/effort downstream (agentTuiSpawning), so this
  // normalizer only preserves a real pin and drops a dangling one — otherwise
  // that later append would emit a second --model.
  it('preserves a user-baked --model pin', () => {
    expect(ensureAntigravityTuiArgs(['--model', 'claude-sonnet-4-6']))
      .toEqual(['--model', 'claude-sonnet-4-6', '--dangerously-skip-permissions']);
  });

  it('drops a dangling --model so the downstream append cannot double it', () => {
    expect(ensureAntigravityTuiArgs(['--model'])).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('ANTIGRAVITY_CONFIGURED_DEFAULT', () => {
  it('matches the cross-module sentinel value', () => {
    expect(ANTIGRAVITY_CONFIGURED_DEFAULT).toBe('antigravity-configured-default');
  });
});
