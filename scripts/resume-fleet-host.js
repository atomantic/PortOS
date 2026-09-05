// Invoked by the dedicated host's Windows login task; never generates tokens.
import { join } from 'node:path';
import { PATHS } from '../server/lib/fileUtils.js';
import { readPortosEnvValue } from '../server/lib/portosEnv.js';
import { commandOutput } from '../server/lib/commandExists.js';
import { runStreamingCommand } from '../server/lib/streamingSpawn.js';
import { inspectVllmQwenProject } from '../server/lib/vllmQwenProject.js';
import { ensureFleetDockerIntegration } from '../server/services/fleetLlmDocker.js';
import { PORTS } from '../server/lib/ports.js';

if (readPortosEnvValue('PORTOS_FLEET_LLM_ENABLED') === '1') {
  const restored = await runStreamingCommand(process.execPath, [join(PATHS.root, 'node_modules/pm2/bin/pm2'), 'resurrect'], undefined, { timeoutMs: 60000 });
  if (!restored.success) throw new Error('Could not restore PortOS processes.');
  let dockerReady = false;
  for (let attempt = 0; attempt < 60 && !dockerReady; attempt++) {
    dockerReady = Boolean(await commandOutput('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 3000 }));
    if (!dockerReady) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!dockerReady) throw new Error('Docker did not start. Open the model host setup guide.');
  const project = await inspectVllmQwenProject();
  await ensureFleetDockerIntegration(project);
  const started = await runStreamingCommand('docker', ['compose', '-f', project.composeFile, '-f', join(project.dir, 'compose.portos-host.yaml'), '--profile', 'single', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'single'], undefined, { cwd: project.dir, env: { PORT: String(PORTS.VLLM_QWEN) }, timeoutMs: 60000 });
  if (!started.success) throw new Error('Could not restore the prepared Qwen container. Open the model host setup guide.');
}
