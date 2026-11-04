import { spawn } from './childProcess.js';

/**
 * Start a GUI program detached. A spawn only proves the binary ran: a GUI app with
 * no display (e.g. Blender on a headless host) exits at once, so a quick exit within `graceMs` is
 * a failure carrying its last stderr line. After that PortOS lets it go.
 */
export function launchDetached(executable, args, { graceMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timer = null;
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const said = stderr.trim().split('\n').filter(Boolean).at(-1);
      reject(new Error(`it closed right after starting (${signal || `exit ${code}`})${said ? `: ${said}` : ''}`));
    });
    child.once('spawn', () => {
      timer = setTimeout(() => {
        child.removeAllListeners('exit');
        child.stderr.destroy();
        child.unref();
        resolve();
      }, graceMs);
    });
  });
}
