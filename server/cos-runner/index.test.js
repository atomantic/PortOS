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
      /import\s*\{\s*prepareCliSpawn\s*\}\s*from\s*'\.\.\/lib\/bufferedSpawn\.js';/
    );
  });

  it('resolves+wraps the agent CLI command before spawning it', () => {
    // The agent spawn (the /spawn handler) must feed its command/args through
    // prepareCliSpawn and spawn WHATEVER it returns — never the bare `command`.
    const call = RUNNER_SRC.match(
      /const\s*\{\s*command:\s*spawnCommand,\s*args:\s*finalSpawnArgs\s*\}\s*=\s*prepareCliSpawn\(\s*command,\s*spawnArgs,\s*childEnv\s*\)/
    );
    expect(call, 'agent spawn must call prepareCliSpawn(command, spawnArgs, childEnv)').not.toBeNull();
    // The resolved pair must be what spawn() actually receives.
    expect(RUNNER_SRC).toMatch(/spawn\(\s*spawnCommand,\s*finalSpawnArgs,/);
  });

  it('resolves the command against the child env (childEnv) so a provider PATH override is honored', () => {
    // childEnv (process.env + provider envVars, CLAUDECODE stripped) is built
    // BEFORE the resolve so PATH resolution sees the child's PATH, and is reused
    // as the spawn env — matching the working server/services/runner.js path.
    const childEnvIdx = RUNNER_SRC.indexOf('const childEnv = (() =>');
    const prepareIdx = RUNNER_SRC.indexOf('prepareCliSpawn(command, spawnArgs, childEnv)');
    expect(childEnvIdx, 'childEnv must be defined').toBeGreaterThan(-1);
    expect(prepareIdx, 'prepareCliSpawn must run against childEnv').toBeGreaterThan(-1);
    expect(childEnvIdx, 'childEnv must be built before the resolve').toBeLessThan(prepareIdx);
  });
});
