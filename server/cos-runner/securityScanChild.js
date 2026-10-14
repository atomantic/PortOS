import { spawn } from '../lib/childProcess.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';

// The runner first persists this supervisor's identity, then releases exactly
// one launch over its private IPC channel. A crash before that cannot start a
// provider call. A crash afterwards closes IPC and kills our own process group.
// The scanner receives ordinary inherited stdio, never the control channel.
const killOwnedGroup = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(1); }
};
process.once('disconnect', killOwnedGroup);
const launch = ({ command, args, cwd }) => {
  const child = spawn(command, args, { cwd, env: withSpawnCwdEnv(process.env, cwd || process.cwd()), stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', () => process.exit(1));
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1));
  });
};
process.once('message', async message => {
  if (!message.prepare) return launch(message);
  try {
    const { prepareSecurityScanSnapshot } = await import('./securityScanSnapshot.js');
    const snapshot = await prepareSecurityScanSnapshot(message.prepare);
    process.once('message', launch);
    process.send({ snapshot }, err => { if (err) killOwnedGroup(); });
  } catch (err) {
    // The runner owns public evidence; never forward Git stderr or local paths.
    process.send({ snapshotError: { code: 'snapshot-unavailable', preflight: err.preflight } }, err => { if (err) killOwnedGroup(); });
  }
});
