/**
 * Dev start script — cleanly (re)starts all PM2 processes.
 * Handles lingering processes, port conflicts, and fresh starts.
 *
 * Uses execFileSync (not execSync with string) to avoid cmd.exe on Windows,
 * which creates visible CMD windows even with windowsHide.
 */
import { execFileSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PM2 = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');
const ECO = 'ecosystem.config.cjs';

function pm2(...args) {
  execFileSync(process.execPath, [PM2, ...args], {
    stdio: 'inherit',
    windowsHide: true
  });
}

// Stop and delete existing PortOS processes (ignore errors if none exist)
try { pm2('stop', ECO); } catch {}
try { pm2('delete', ECO); } catch {}

// Brief pause for port release
await new Promise(r => setTimeout(r, 1500));

// Start fresh and tail logs
pm2('start', ECO);
spawn(process.execPath, [PM2, 'logs'], {
  stdio: 'inherit',
  windowsHide: true
});
