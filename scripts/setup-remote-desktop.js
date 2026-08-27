#!/usr/bin/env node

import { createConnection } from 'node:net';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const portValue = Number.parseInt(process.env.PORTOS_VNC_PORT ?? '5900', 10);
const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535 ? portValue : 5900;

const probe = () => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  let settled = false;
  const finish = (reachable) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(1000);
  socket.once('connect', () => finish(true));
  socket.once('timeout', () => finish(false));
  socket.once('error', () => finish(false));
});

if (await probe()) {
  console.log(`✅ A VNC server is reachable on 127.0.0.1:${port}. PortOS remote desktop is ready.`);
  process.exit(0);
}

console.log(`🖥️  No VNC server is reachable on 127.0.0.1:${port}.`);
if (platform() === 'darwin') {
  console.log('   In System Settings → General → Sharing, enable Remote Management.');
  console.log('   Open its Info panel, enable “VNC viewers may control screen with password,” and choose a unique VNC password.');
  console.log('   Do not reuse your macOS login password or PortOS instance password.');
  if (process.stdin.isTTY && process.stdout.isTTY) {
    spawnSync('open', ['x-apple.systempreferences:com.apple.Sharing-Settings.extension'], { stdio: 'ignore' });
    console.log('   System Settings has been opened. Re-run this command after saving the setting.');
  }
} else {
  console.log(`   Install and start a VNC server bound to loopback port ${port}.`);
  console.log('   Set PORTOS_VNC_PORT if your local server uses a different port, then restart PortOS.');
}
process.exitCode = 1;
