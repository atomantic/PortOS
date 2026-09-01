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
    // childEnv (process.env + provider envVars, CLAUDECODE stripped, PWD pinned
    // — composed by the shared buildCliChildEnv) is built BEFORE the resolve so
    // PATH resolution sees the child's PATH, and is reused as the spawn env —
    // matching the working server/services/runner.js path.
    const childEnvIdx = RUNNER_SRC.indexOf('const childEnv = buildCliChildEnv(');
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

describe('cos-runner termination', () => {
  // Both halves of a kill now live in modules that can actually be imported:
  // killProcessTree (bufferedSpawn.js) decides what "kill" means for the
  // handle, and armForceKill (forceKill.js) owns the SIGTERM -> grace ->
  // SIGKILL escalation. bufferedSpawn.test.js and forceKill.test.js exercise
  // those for real; all this file pins is that index.js delegates to both
  // rather than hand-rolling either.
  it('kills only through the shared killProcessTree helper', () => {
    expect(RUNNER_SRC).toContain("import { prepareCliSpawn, killProcessTree } from '../lib/bufferedSpawn.js';");
    // A BARE `.kill()` is still fine — the sentinel watcher closes a finished
    // TUI session that way, and a bare kill is the one form node-pty accepts
    // on every platform. What must not reappear is a hand-rolled signal kill.
    expect(RUNNER_SRC).not.toContain(".process.kill('SIG");
  });

  it('escalates through the shared armForceKill on every terminate path', () => {
    expect(RUNNER_SRC).toContain("import { armForceKill as armForceKillShared } from './forceKill.js';");
    // /terminate and /terminate-all, plus the post-finalize tui:kill relay.
    expect(RUNNER_SRC.split('armForceKill(agentId, agent);')).toHaveLength(3);
    expect(RUNNER_SRC).toContain('armForceKill(agentId, agent, { dropState: agent.paused !== true })');
  });

  // A paused agent was stopped deliberately and its record is what a later
  // resume reads. The CLI close handler always had this guard; the TUI one did
  // not, and the node-pty kill fix is what made that path reachable on Windows
  // (before it, the kill threw and the PTY never exited at all).
  it('reports nothing when a paused TUI exits, instead of finalizing it failed', () => {
    const exitIdx = RUNNER_SRC.indexOf('tuiProcess.onExit(');
    expect(exitIdx, 'the TUI exit handler must exist').toBeGreaterThan(-1);
    const completedIdx = RUNNER_SRC.indexOf("emitToServer('agent:completed'", exitIdx);
    const handler = RUNNER_SRC.slice(exitIdx, completedIdx);
    expect(handler).toContain('current.paused === true');
    expect(handler).toContain('activeAgents.delete(agentId)');
  });
});

describe('cos-runner durable TUI ownership (#3202)', () => {
  it('checks the TUI executable against its child PATH before opening a PTY', () => {
    // node-pty otherwise turns a missing binary into exit 1 with no transcript,
    // which loses the real configuration error to a generic startup failure.
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\bfindCommandOnPath\b[^}]*\}\s*from\s*'\.\.\/lib\/processEnv\.js';/
    );
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\bcommandExists\b[^}]*\}\s*from\s*'\.\.\/lib\/commandExists\.js';/
    );
    const childEnvIdx = RUNNER_SRC.indexOf('const childEnv = buildCliChildEnv({ before: envVars, provider: providerAuth, cwd });');
    const resolveIdx = RUNNER_SRC.indexOf('const executable = findCommandOnPath(command, { env: childEnv, cwd });');
    const prepareProbeIdx = RUNNER_SRC.indexOf("const versionProbe = prepareCliSpawn(executable, ['--version'], childEnv);");
    const probeIdx = RUNNER_SRC.indexOf('const runnable = await commandExists(versionProbe.command, versionProbe.args, {');
    const spawnIdx = RUNNER_SRC.indexOf('pty.spawn(ptyCommand, ptyArgs');
    expect(resolveIdx, 'runner must resolve the command against childEnv').toBeGreaterThan(childEnvIdx);
    expect(prepareProbeIdx, 'runner must prepare a Windows-safe version probe').toBeGreaterThan(resolveIdx);
    expect(probeIdx, 'runner must capability-check the prepared command').toBeGreaterThan(prepareProbeIdx);
    expect(spawnIdx, 'runner must open the PTY after the executable probe').toBeGreaterThan(probeIdx);
    expect(RUNNER_SRC).toContain('const TUI_CAPABILITY_PROBE_TIMEOUT_MS = 15 * 1000;');
    expect(RUNNER_SRC).toMatch(/timeoutMs:\s*TUI_CAPABILITY_PROBE_TIMEOUT_MS/);
    expect(RUNNER_SRC).toContain('Command executable unavailable: ${basename(command)} is not on the CoS Runner PATH');
    expect(RUNNER_SRC).toContain('Command executable unavailable: ${basename(command)} did not pass the CoS Runner capability check');
    expect(RUNNER_SRC).toContain('const { command: ptyCommand, args: ptyArgs } = prepareCliSpawn(executable, args, childEnv);');
  });

  it('tracks TUI liveness from onExit bookkeeping rather than a pid probe', () => {
    // node-pty reports pid 0 for ConPTY on Windows, so getProcessStats(pid)
    // reads every runner-owned TUI as invalid/dead. GET /agents must use the
    // runner's own onExit flag, then tag the row so sweeps can tell a real
    // processActive from that pid-0 artifact.
    expect(RUNNER_SRC).toMatch(
      /import\s*\{[^}]*\brunnerAgentLivenessFields\b[^}]*\}\s*from\s*'\.\.\/lib\/runnerAgentLiveness\.js';/
    );
    expect(RUNNER_SRC).toMatch(/exited:\s*false/);
    expect(RUNNER_SRC).toMatch(/current\.exited\s*=\s*true/);
    const onExitIdx = RUNNER_SRC.indexOf('tuiProcess.onExit');
    const exitedIdx = RUNNER_SRC.indexOf('current.exited = true');
    expect(exitedIdx, 'onExit must stamp exited before deleting the handle').toBeGreaterThan(onExitIdx);
    const deleteIdx = RUNNER_SRC.indexOf('activeAgents.delete(agentId);', exitedIdx);
    expect(deleteIdx, 'onExit must drop the handle before awaiting completion I/O').toBeGreaterThan(exitedIdx);
    expect(deleteIdx).toBeLessThan(RUNNER_SRC.indexOf('await withState((state) => {', exitedIdx));
    expect(RUNNER_SRC).toMatch(/if\s*\(\s*agent\.exited\s*===\s*true\s*\)\s*continue;/);
    expect(RUNNER_SRC).toMatch(/runnerAgentLivenessFields\(agent,\s*stats\)/);
    expect(RUNNER_SRC).toMatch(/inspectAgentProcess\(agent\)/);
  });

  it('spawns the PTY through the shared Windows-safe CLI wrapper', () => {
    expect(RUNNER_SRC).toMatch(/app\.post\('\/spawn-tui'/);
    expect(RUNNER_SRC).toMatch(/prepareCliSpawn\(executable, args, childEnv\)/);
    expect(RUNNER_SRC).toMatch(/pty\.spawn\(ptyCommand,\s*ptyArgs/);
    expect(RUNNER_SRC).toMatch(/io\.emit\('tui:output'/);
    expect(RUNNER_SRC).toMatch(/parseSentinelPayload\(contents\)/);
    expect(RUNNER_SRC).toMatch(/emitToServer\('agent:completed'/);
  });

  it('includes a bounded terminal output tail with TUI exit telemetry', () => {
    // The live tui:output event can lose a race to an immediate process exit.
    // Its terminal companion must retain a diagnostic tail for the spawner's
    // raw-transcript failure analysis path.
    expect(RUNNER_SRC).toContain('const TUI_EXIT_OUTPUT_TAIL_CHARS = 16 * 1024;');
    expect(RUNNER_SRC).toMatch(/const outputTail = current\.outputBuffer\.slice\(-TUI_EXIT_OUTPUT_TAIL_CHARS\);/);
    expect(RUNNER_SRC).toMatch(/io\.emit\('tui:exit',[\s\S]{0,350}?\.\.\.\(outputTail \? \{ outputTail \} : \{\}\)/);
  });
});
