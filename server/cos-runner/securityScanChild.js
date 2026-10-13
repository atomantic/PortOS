import { spawn } from '../lib/childProcess.js';

// The runner first persists this supervisor's identity, then releases exactly
// one launch over its private IPC channel. A crash before that cannot start a
// provider call. A crash afterwards closes IPC and kills our own process group.
// The scanner receives ordinary inherited stdio, never the control channel.
const killOwnedGroup = () => {
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch { process.exit(1); }
};
process.once('disconnect', killOwnedGroup);
process.once('message', ({ command, args }) => {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', () => process.exit(1));
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1));
  });
});
