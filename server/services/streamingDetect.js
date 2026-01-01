import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Stream detection results to a socket as each step completes
 */
export async function streamDetection(socket, dirPath) {
  const emit = (step, status, data = {}) => {
    socket.emit('detect:step', { step, status, data, timestamp: Date.now() });
  };

  const result = {
    name: '',
    description: '',
    uiPort: null,
    apiPort: null,
    startCommands: [],
    pm2ProcessNames: [],
    pm2Status: null,
    type: 'unknown'
  };

  // Step 1: Validate path
  emit('validate', 'running', { message: 'Validating directory path...' });

  if (!existsSync(dirPath)) {
    emit('validate', 'error', { message: 'Directory does not exist' });
    socket.emit('detect:complete', { success: false, error: 'Directory does not exist' });
    return;
  }

  const stats = await stat(dirPath);
  if (!stats.isDirectory()) {
    emit('validate', 'error', { message: 'Path is not a directory' });
    socket.emit('detect:complete', { success: false, error: 'Path is not a directory' });
    return;
  }

  emit('validate', 'done', { message: 'Valid directory' });
  result.name = basename(dirPath);

  // Step 2: Read directory contents
  emit('files', 'running', { message: 'Scanning directory...' });
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = entries.map(e => e.name);
  emit('files', 'done', { message: `Found ${files.length} files`, files: files.slice(0, 20) });

  // Step 3: Read package.json
  emit('package', 'running', { message: 'Reading package.json...' });
  const pkgPath = join(dirPath, 'package.json');

  if (existsSync(pkgPath)) {
    const content = await readFile(pkgPath, 'utf-8').catch(() => null);
    if (content) {
      const pkg = JSON.parse(content);
      result.name = pkg.name || result.name;
      result.description = pkg.description || '';

      // Detect project type
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vite && deps.express) result.type = 'vite+express';
      else if (deps.vite || deps.react || deps.vue) result.type = 'vite';
      else if (deps.express || deps.fastify || deps.koa) result.type = 'single-node-server';
      else if (deps.next) result.type = 'nextjs';

      // Get start commands
      const scripts = pkg.scripts || {};
      if (scripts.dev) result.startCommands.push('npm run dev');
      if (scripts.start && !scripts.dev) result.startCommands.push('npm start');

      emit('package', 'done', {
        message: `Found: ${result.name}`,
        name: result.name,
        description: result.description,
        type: result.type,
        startCommands: result.startCommands
      });
    }
  } else {
    emit('package', 'done', { message: 'No package.json found' });
  }

  // Step 4: Check config files for ports
  emit('config', 'running', { message: 'Checking configuration files...' });
  const configFiles = [];

  // Check .env
  const envPath = join(dirPath, '.env');
  if (existsSync(envPath)) {
    const content = await readFile(envPath, 'utf-8').catch(() => '');
    const portMatch = content.match(/PORT\s*=\s*(\d+)/i);
    if (portMatch) result.apiPort = parseInt(portMatch[1]);
    const viteMatch = content.match(/VITE_PORT\s*=\s*(\d+)/i);
    if (viteMatch) result.uiPort = parseInt(viteMatch[1]);
    configFiles.push('.env');
  }

  // Check vite.config
  for (const viteConfig of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(dirPath, viteConfig);
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8').catch(() => '');
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) result.uiPort = parseInt(portMatch[1]);
      configFiles.push(viteConfig);
    }
  }

  // Check ecosystem.config.js/cjs for PM2 configuration
  for (const ecosystemFile of ['ecosystem.config.js', 'ecosystem.config.cjs']) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8').catch(() => '');
      if (content) {
        // Extract PORT from env_development or env_production
        const portMatch = content.match(/PORT\s*:\s*(\d+)/);
        if (portMatch && !result.apiPort) {
          result.apiPort = parseInt(portMatch[1]);
        }

        // Extract UI port from CLIENT_URL
        const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
        if (clientUrlMatch && !result.uiPort) {
          result.uiPort = parseInt(clientUrlMatch[1]);
        }

        // Extract PM2 process names
        const nameMatches = content.matchAll(/name\s*:\s*['"]([^'"]+)['"]/g);
        const ecosystemNames = [...nameMatches].map(m => m[1]);
        if (ecosystemNames.length > 0) {
          result.pm2ProcessNames = ecosystemNames;
        }

        configFiles.push(ecosystemFile);
      }
    }
  }

  emit('config', 'done', {
    message: configFiles.length ? `Found: ${configFiles.join(', ')}` : 'No config files found',
    uiPort: result.uiPort,
    apiPort: result.apiPort,
    pm2ProcessNames: result.pm2ProcessNames.length > 0 ? result.pm2ProcessNames : undefined,
    configFiles
  });

  // Step 5: Check PM2 status
  emit('pm2', 'running', { message: 'Checking PM2 processes...' });
  const { stdout } = await execAsync('pm2 jlist').catch(() => ({ stdout: '[]' }));
  const pm2Processes = JSON.parse(stdout);

  // Look for processes that might be this app
  const possibleNames = [
    result.name,
    result.name.toLowerCase(),
    result.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    `${result.name}-ui`,
    `${result.name}-api`
  ];

  const matchingProcesses = pm2Processes.filter(p =>
    possibleNames.some(name => p.name.includes(name) || name.includes(p.name))
  );

  if (matchingProcesses.length > 0) {
    result.pm2Status = matchingProcesses.map(p => ({
      name: p.name,
      status: p.pm2_env?.status,
      pid: p.pid
    }));
    // Use actual found PM2 process names
    result.pm2ProcessNames = matchingProcesses.map(p => p.name);
    emit('pm2', 'done', {
      message: `Found ${matchingProcesses.length} running process(es)`,
      pm2Status: result.pm2Status,
      pm2ProcessNames: result.pm2ProcessNames
    });
  } else {
    emit('pm2', 'done', { message: 'No matching PM2 processes found' });
    // Generate PM2 process names only if none found from ecosystem.config
    if (result.pm2ProcessNames.length === 0) {
      const baseName = result.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      if (result.type === 'vite+express') {
        result.pm2ProcessNames = [`${baseName}-ui`, `${baseName}-api`];
      } else {
        result.pm2ProcessNames = [baseName];
      }
    }
  }

  // Step 6: Read README.md for description (fast, no AI needed)
  if (!result.description) {
    emit('readme', 'running', { message: 'Reading README.md...' });
    let foundReadme = false;
    for (const readmeFile of ['README.md', 'readme.md', 'Readme.md']) {
      const readmePath = join(dirPath, readmeFile);
      if (existsSync(readmePath)) {
        const content = await readFile(readmePath, 'utf-8').catch(() => '');
        if (content) {
          // Extract first paragraph or heading as description
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
          if (lines.length > 0) {
            result.description = lines[0].trim().substring(0, 200);
          }
          emit('readme', 'done', { message: `Found: ${readmeFile}`, description: result.description });
          foundReadme = true;
          break;
        }
      }
    }
    if (!foundReadme) {
      emit('readme', 'done', { message: 'No README found' });
    }
  } else {
    emit('readme', 'skipped', { message: 'Description already found in package.json' });
  }

  // Complete
  socket.emit('detect:complete', {
    success: true,
    result
  });
}
