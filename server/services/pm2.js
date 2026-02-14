import pm2 from 'pm2';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

/**
 * Connect to PM2 daemon and run an action
 */
function connectAndRun(action) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        return reject(err);
      }
      action(pm2)
        .then((result) => {
          pm2.disconnect();
          resolve(result);
        })
        .catch((err) => {
          pm2.disconnect();
          reject(err);
        });
    });
  });
}

/**
 * Start an app with PM2
 * @param {string} name PM2 process name
 * @param {object} options Start options
 */
export async function startApp(name, options = {}) {
  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      const startOptions = {
        name,
        script: options.script || 'npm',
        args: options.args || 'run dev',
        cwd: options.cwd,
        env: options.env || {},
        watch: false,
        autorestart: true
      };

      pm2.start(startOptions, (err, proc) => {
        if (err) return reject(err);
        resolve({ success: true, process: proc });
      });
    });
  });
}

/**
 * Stop an app
 * @param {string} name PM2 process name
 */
export async function stopApp(name) {
  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.stop(name, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
}

/**
 * Restart an app
 * @param {string} name PM2 process name
 */
export async function restartApp(name) {
  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.restart(name, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
}

/**
 * Delete an app from PM2
 * @param {string} name PM2 process name
 */
export async function deleteApp(name) {
  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.delete(name, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
}

/**
 * Get status of a specific process using CLI (avoids connection deadlocks)
 * @param {string} name PM2 process name
 */
export async function getAppStatus(name) {
  return new Promise((resolve) => {
    const child = spawn('pm2', ['jlist'], { shell: false });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      const processes = JSON.parse(stdout || '[]');
      const proc = processes.find(p => p.name === name);

      if (!proc) {
        return resolve({
          name,
          status: 'not_found',
          pm2_env: null
        });
      }

      resolve({
        name: proc.name,
        status: proc.pm2_env?.status || 'unknown',
        pid: proc.pid,
        pm_id: proc.pm_id,
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
        restarts: proc.pm2_env?.restart_time || 0,
        createdAt: proc.pm2_env?.created_at || null
      });
    });

    child.on('error', () => {
      resolve({ name, status: 'error', pm2_env: null });
    });
  });
}

/**
 * List all PM2 processes using CLI (avoids connection deadlocks)
 */
export async function listProcesses() {
  return new Promise((resolve) => {
    const child = spawn('pm2', ['jlist'], { shell: false });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      // pm2 jlist may output ANSI codes and warnings before JSON
      // Look for '[{' (array with objects) or '[]' (empty array) to avoid matching ANSI codes like [31m
      let jsonStart = stdout.indexOf('[{');
      if (jsonStart < 0) {
        const emptyMatch = stdout.match(/\[\](?![0-9])/);
        jsonStart = emptyMatch ? stdout.indexOf(emptyMatch[0]) : -1;
      }
      const pm2Json = jsonStart >= 0 ? stdout.slice(jsonStart) : '[]';
      const list = JSON.parse(pm2Json);
      const processes = list.map(proc => ({
        name: proc.name,
        status: proc.pm2_env?.status || 'unknown',
        pid: proc.pid,
        pm_id: proc.pm_id,
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
        restarts: proc.pm2_env?.restart_time || 0
      }));
      resolve(processes);
    });

    child.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Get logs for a process using pm2 CLI (more reliable for log retrieval)
 * @param {string} name PM2 process name
 * @param {number} lines Number of lines to retrieve
 */
export async function getLogs(name, lines = 100) {
  return new Promise((resolve, reject) => {
    const args = ['logs', name, '--lines', String(lines), '--nostream', '--raw'];
    const child = spawn('pm2', args, { shell: false });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        return reject(new Error(stderr));
      }
      resolve(stdout);
    });

    child.on('error', reject);
  });
}

/**
 * Start an app using a specific command in cwd
 * @param {string} name PM2 process name
 * @param {string} cwd Working directory
 * @param {string} command Command to run (e.g., "npm run dev")
 */
export async function startWithCommand(name, cwd, command) {
  const [script, ...args] = command.split(' ');

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.start({
        name,
        script,
        args: args.join(' '),
        cwd,
        watch: false,
        autorestart: true,
        max_memory_restart: '500M'
      }, (err, proc) => {
        if (err) return reject(err);
        resolve({ success: true, process: proc });
      });
    });
  });
}

/**
 * Start app(s) using ecosystem.config.cjs/js file
 * This properly uses all env vars, scripts, args defined in the config
 * @param {string} cwd Working directory containing ecosystem config
 * @param {string[]} processNames Optional: specific processes to start (--only flag)
 */
export async function startFromEcosystem(cwd, processNames = []) {
  return new Promise((resolve, reject) => {
    const ecosystemFile = ['ecosystem.config.cjs', 'ecosystem.config.js']
      .find(f => existsSync(`${cwd}/${f}`));

    if (!ecosystemFile) {
      return reject(new Error('No ecosystem.config.cjs or ecosystem.config.js found'));
    }

    const args = ['start', ecosystemFile];
    if (processNames.length > 0) {
      args.push('--only', processNames.join(','));
    }

    // Strip PortOS env vars so child ecosystem configs don't inherit them
    // e.g., process.env.PORT || 4420 would resolve to PortOS's 5554 otherwise
    const cleanEnv = { ...process.env };
    delete cleanEnv.PORT;
    delete cleanEnv.HOST;

    const child = spawn('pm2', args, { cwd, shell: false, env: cleanEnv });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `pm2 start exited with code ${code}`));
      }
      resolve({ success: true, output: stdout });
    });

    child.on('error', reject);
  });
}
