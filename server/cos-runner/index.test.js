import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// index.js binds a socket server + `server.listen(PORT, HOST)` at module load,
// so it can't be imported into a unit test. These are source-inspection tests
// (the same convention as agentLifecycle.test.js) pinning the #2243 spawn fix:
// the runner must resolve+wrap a bare npm CLI shim before spawning, or a
// Windows `opencode`/`claude` .cmd shim fails with spawn ENOENT (errno -4058)
// → empty output → startup-failure.
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = readFileSync(join(__dirname, 'index.js'), 'utf-8');

describe('cos-runner spawn — Windows CLI shim resolve+wrap (#2243)', () => {
  it('imports prepareCliSpawn from the shared bufferedSpawn helper', () => {
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\bprepareCliSpawn\b[^}]*\}\s*from\s*'\.\.\/lib\/bufferedSpawn\.js';/
    );
  });

  it('resolves+wraps the agent CLI command before spawning it', () => {
    // The agent spawn (the /spawn handler) must feed its command/args through
    // prepareCliSpawn and spawn WHATEVER it returns — never the bare `command`.
    // deliveredArgs is spawnArgs after prepareCliPrompt (antigravity --print
    // value / grok Windows temp-file rewrite); every provider still resolves
    // through prepareCliSpawn before spawning.
    const call = RUNNER_SRC.match(
      /const\s*\{\s*command:\s*spawnCommand,\s*args:\s*finalSpawnArgs\s*\}\s*=\s*prepareCliSpawn\(\s*command,\s*deliveredArgs,\s*childEnv\s*\)/
    );
    expect(call, 'agent spawn must call prepareCliSpawn(command, deliveredArgs, childEnv)').not.toBeNull();
    // The resolved pair must be what spawn() actually receives.
    expect(RUNNER_SRC).toMatch(/spawn\(\s*spawnCommand,\s*finalSpawnArgs,/);
  });

  it('resolves the command against the child env (childEnv) so a provider PATH override is honored', () => {
    // childEnv (process.env + provider envVars, CLAUDECODE stripped) is built
    // BEFORE the resolve so PATH resolution sees the child's PATH, and is reused
    // as the spawn env — matching the working server/services/runner.js path.
    const childEnvIdx = RUNNER_SRC.indexOf('const childEnv = (() =>');
    const prepareIdx = RUNNER_SRC.indexOf('prepareCliSpawn(command, deliveredArgs, childEnv)');
    expect(childEnvIdx, 'childEnv must be defined').toBeGreaterThan(-1);
    expect(prepareIdx, 'prepareCliSpawn must run against childEnv').toBeGreaterThan(-1);
    expect(childEnvIdx, 'childEnv must be built before the resolve').toBeLessThan(prepareIdx);
  });
});

describe('cos-runner spawn — per-provider prompt delivery (antigravity --print value)', () => {
  it('imports prepareCliPrompt from the shared cliProviderArgs helper', () => {
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\bprepareCliPrompt\b[^}]*\}\s*from\s*'\.\.\/lib\/cliProviderArgs\.js';/
    );
  });

  it('runs the built argv through prepareCliPrompt before resolving the spawn', () => {
    // Antigravity (`agy`) takes the prompt as the --print VALUE and does NOT read
    // stdin; without this the prompt never reaches the model. prepareCliPrompt
    // rewrites the argv (and returns useStdin=false for agy) before the resolve.
    const prepareIdx = RUNNER_SRC.indexOf('prepareCliPrompt(command, spawnArgs, prompt)');
    const resolveIdx = RUNNER_SRC.indexOf('prepareCliSpawn(command, deliveredArgs, childEnv)');
    expect(prepareIdx, 'must call prepareCliPrompt(command, spawnArgs, prompt)').toBeGreaterThan(-1);
    expect(resolveIdx, 'must resolve the delivered argv').toBeGreaterThan(-1);
    expect(prepareIdx, 'prompt delivery runs before the spawn resolve').toBeLessThan(resolveIdx);
  });

  it('gates the stdin write on useStdin so an argv-delivered prompt is not also piped', () => {
    // For antigravity (--print value) / grok-on-Windows (temp file) useStdin is
    // false — writing the prompt to stdin too would be redundant/incorrect.
    expect(RUNNER_SRC).toMatch(/if\s*\(\s*useStdin\s*\)\s*claudeProcess\.stdin\.write\(prompt\)/);
  });
});

describe('cos-runner termination — Windows tree-kill for cmd.exe-wrapped shims (#2243)', () => {
  it('imports killProcessTree from the shared bufferedSpawn helper', () => {
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\bkillProcessTree\b[^}]*\}\s*from\s*'\.\.\/lib\/bufferedSpawn\.js';/
    );
  });

  it('terminates agent processes via killProcessTree, not a bare .kill(), so the wrapped child is not orphaned', () => {
    // Once an agent is spawned as `cmd.exe /c opencode.cmd …` on Windows, a
    // plain agent.process.kill() signals only cmd.exe and orphans the real CLI.
    // Every agent-process termination must route through killProcessTree.
    expect(RUNNER_SRC).toMatch(/killProcessTree\(agent\.process,\s*'SIGTERM'\)/);
    expect(RUNNER_SRC).toMatch(/killProcessTree\(agent\.process,\s*'SIGKILL'\)/);
    // Guard against a regression that reverts an agent-process kill to bare .kill().
    expect(RUNNER_SRC).not.toMatch(/agent\.process\.kill\(/);
    expect(RUNNER_SRC).not.toMatch(/current\.process\.kill\(/);
  });
});
