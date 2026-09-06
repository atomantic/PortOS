import http from 'node:http';
import { commandOutput } from '../lib/commandExists.js';

// Docker Desktop's local settings API. No TCP management port is exposed.
function desktopRequest(path, body, pipe = 'dockerBackendApiServer') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: `\\\\.\\pipe\\${pipe}`, path, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 45000 }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Docker Desktop settings API is unavailable.'));
        Promise.resolve().then(() => text ? JSON.parse(text) : null).then(resolve, reject);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Docker Desktop settings request timed out.')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function ensureFleetDockerIntegration(project, { emit = () => {} } = {}) {
  if (process.platform !== 'win32') return;
  const distro = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\/i.exec(project.dir)?.[1];
  if (!distro) return;
  // Wake the distro before Docker launches its agent: early systemd startup
  // can otherwise time out Docker's first whoami command (WSL #14541).
  await commandOutput('wsl.exe', ['-d', distro, '-e', 'true'], { timeoutMs: 45000 });
  const ready = () => commandOutput('wsl.exe', ['-d', distro, '-e', 'docker', 'version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  if (await ready()) return;
  emit('Enabling Docker access to the WSL model files…');
  const settings = await desktopRequest('/app/settings');
  const integration = settings?.wslIntegration;
  if (!Array.isArray(integration?.distros)) throw new Error('Enable this model distro in Docker Desktop → Settings → Resources → WSL integration, then retry.');
  if (!integration.distros.includes(distro)) {
    await desktopRequest('/app/settings', { wslIntegration: { ...integration, distros: [...integration.distros, distro] } });
  }
  if (await ready()) return;
  const error = await desktopRequest('/error', undefined, 'errorReporter').catch(() => null);
  if (error?.actions?.includes('Restart the WSL integration')) {
    emit('Retrying Docker WSL integration now that the distro is awake…');
    await desktopRequest('/action', { action: 'Restart the WSL integration' }, 'errorReporter');
  }
  // The Desktop action returns before its proxy has bound the socket.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Docker WSL integration is not ready. In Docker Desktop, restart the WSL integration, then retry host setup.');
}
