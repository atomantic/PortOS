import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'fs/promises';
// Mock fs/promises so the fixture-driven tests below control exactly what
// `readFile` returns, independent of the vendored slashdo submodule's live
// content — so assertions can't drift with a slashdo version bump. Defaults to
// delegating to the real implementation.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn((...args) => actual.readFile(...args)),
  };
});
import { loadSlashdoLib, loadSlashdoFile } from './slashdoLoader.js';

// Regression guard for the CoS review-loop bug: PortOS inlines slashdo lib
// markdown into headless CoS-agent prompts WITHOUT going through slashdo's
// own per-environment installer, so it must resolve the `<!-- if:teams -->`
// conditionals itself. Leaving both branches in shipped a self-contradictory
// reviewer spec (in-process Agent tool AND `claude -p`) to a codex agent,
// which then improvised its own `claude` invocation via a dozen probe calls.
describe('slashdo loaders (loadSlashdoFile / loadSlashdoLib)', () => {
  // Driven from controlled fixtures via the mocked `readFile`, NOT the vendored
  // submodule's live content — so the assertions can't drift with a slashdo
  // version bump. Each test resets `readFile` to clean real-delegation first: a
  // `mockRejectedValueOnce` leaked from an earlier suite would otherwise null out
  // a load and fail here (the flake that reddened CI), and the reset also lets
  // `mockResolvedValueOnce` feed a fixture as the next read.
  let realReadFile;
  beforeEach(async () => {
    realReadFile = (await vi.importActual('fs/promises')).readFile;
    vi.mocked(fsPromises.readFile).mockReset();
    vi.mocked(fsPromises.readFile).mockImplementation((...args) => realReadFile(...args));
  });

  it('loadSlashdoLib resolves if:teams to the else branch by default and the if branch under teams:true', async () => {
    const fixture = 'A<!-- if:teams -->IF<!-- else -->ELSE<!-- /if:teams -->B';
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(fixture);
    expect(await loadSlashdoLib('cond-fixture-else')).toBe('AELSEB');
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(fixture);
    expect(await loadSlashdoLib('cond-fixture-if', { teams: true })).toBe('AIFB');
  });

  it('loadSlashdoLib leaves a non-teams conditional block untouched', async () => {
    const fixture = 'A<!-- if:other -->X<!-- /if:other -->B';
    vi.mocked(fsPromises.readFile).mockResolvedValueOnce(fixture);
    expect(await loadSlashdoLib('cond-fixture-other')).toBe(fixture);
  });

  it('loadSlashdoLib returns null for a lib file that does not exist', async () => {
    expect(await loadSlashdoLib('no-such-lib-file-xyz')).toBeNull();
  });

  it('loadSlashdoFile inlines includes with $-tokens verbatim and resolves conditionals', async () => {
    // A shell-heavy lib whose `$&` / `$`-backtick tokens must survive a
    // String.replace (a bare-string replacement would interpret them and splice
    // pre-match content in, corrupting the text and ballooning the output).
    const libBody = 'run claude -p "$LOCAL_PROMPT" $& $`tail';
    const cmdBody = 'HEAD\n!`cat ~/.claude/lib/some-lib.md`\n<!-- if:teams -->TEAMS<!-- else -->SUB<!-- /if:teams -->\nTAIL';
    vi.mocked(fsPromises.readFile)
      .mockResolvedValueOnce(cmdBody)   // the command file
      .mockResolvedValueOnce(libBody);  // the included lib
    const body = await loadSlashdoFile('cmd-fixture-dollar');
    expect(body).toContain('claude -p "$LOCAL_PROMPT" $& $`tail'); // $-tokens verbatim, no blowup
    expect(body).toContain('SUB');                                 // else branch kept
    expect(body).not.toContain('TEAMS');                           // if branch stripped
    expect(body).not.toMatch(/<!--\s*(if:|else|\/if:)/);           // markers gone
  });
});
