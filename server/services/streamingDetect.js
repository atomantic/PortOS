import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Parse ecosystem.config.js/cjs to extract all processes with their ports
 * Uses regex parsing since we can't safely execute arbitrary JS
 */
export function parseEcosystemConfig(content) {
  const processes = [];

  // Extract top-level port constants (e.g., const CDP_PORT = 5549)
  const portConstants = {};
  const constMatches = content.matchAll(/(?:const|let|var)\s+(\w*PORT\w*)\s*=\s*(\d+)/g);
  for (const match of constMatches) {
    portConstants[match[1]] = parseInt(match[2]);
  }

  // Match each app block: { name: '...', ... }
  // This regex captures app objects including nested braces
  const appBlockRegex = /\{\s*name\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  let lastIndex = 0;

  while ((match = appBlockRegex.exec(content)) !== null) {
    const processName = match[1];
    const startPos = match.index;

    // Find the end of this app block by counting braces
    let braceCount = 0;
    let endPos = startPos;
    let inString = false;
    let stringChar = null;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = startPos; i < content.length; i++) {
      const char = content[i];
      const nextChar = i < content.length - 1 ? content[i + 1] : '';
      const prevChar = i > 0 ? content[i - 1] : '';

      // Handle line comments (// ...)
      if (!inString && !inBlockComment && char === '/' && nextChar === '/') {
        inLineComment = true;
        continue;
      }
      if (inLineComment && char === '\n') {
        inLineComment = false;
        continue;
      }

      // Handle block comments (/* ... */)
      if (!inString && !inLineComment && char === '/' && nextChar === '*') {
        inBlockComment = true;
        continue;
      }
      if (inBlockComment && char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++; // Skip the closing /
        continue;
      }

      // Skip if in any comment
      if (inLineComment || inBlockComment) continue;

      // Track string boundaries
      if ((char === '"' || char === "'") && prevChar !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
          stringChar = null;
        }
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endPos = i;
            break;
          }
        }
      }
    }

    const appBlock = content.substring(startPos, endPos + 1);

    // Extract ports - first try the PortOS standard 'ports' object
    let ports = {};

    // Look for ports: { label: port, ... } object (PortOS standard)
    const portsObjMatch = appBlock.match(/\bports\s*:\s*\{([^}]+)\}/);
    if (portsObjMatch) {
      const portsContent = portsObjMatch[1];
      const portEntries = portsContent.matchAll(/(\w+)\s*:\s*(\d+)/g);
      for (const entry of portEntries) {
        ports[entry[1]] = parseInt(entry[2]);
      }
    }

    // Fall back to legacy parsing if no ports object found
    if (Object.keys(ports).length === 0) {
      // Extract PORT from env
      const portMatch = appBlock.match(/(?:env|env_development|env_production)\s*:\s*\{[^}]*\bPORT\s*:\s*(\d+)/);
      if (portMatch) {
        ports.api = parseInt(portMatch[1]);
      }

      // Extract CDP_PORT (Chrome DevTools Protocol port for browser processes)
      const cdpPortMatch = appBlock.match(/(?:env|env_development|env_production)\s*:\s*\{[^}]*CDP_PORT\s*:\s*(\d+)/);
      if (cdpPortMatch) {
        ports.cdp = parseInt(cdpPortMatch[1]);
      } else {
        // Check for variable reference (CDP_PORT: CDP_PORT)
        const cdpVarMatch = appBlock.match(/CDP_PORT\s*:\s*(\w+)/);
        if (cdpVarMatch && portConstants[cdpVarMatch[1]]) {
          ports.cdp = portConstants[cdpVarMatch[1]];
        }
      }

      // Also check for --port in args
      if (Object.keys(ports).length === 0) {
        const argsPortMatch = appBlock.match(/args\s*:\s*['"][^'"]*--port\s+(\d+)/);
        if (argsPortMatch) {
          ports.ui = parseInt(argsPortMatch[1]);
        }
      }

      // Check for port: XXXX directly (some configs use this)
      if (Object.keys(ports).length === 0) {
        const directPortMatch = appBlock.match(/\bport\s*:\s*(\d+)/);
        if (directPortMatch) {
          ports.api = parseInt(directPortMatch[1]);
        }
      }
    }

    // Primary port is the first one found (for backwards compatibility)
    const portValues = Object.values(ports);
    const port = portValues.length > 0 ? portValues[0] : null;

    // Extract cwd for processes that might have external config files
    let cwd = null;
    const cwdMatch = appBlock.match(/cwd\s*:\s*['"]([^'"]+)['"]/);
    if (cwdMatch) {
      cwd = cwdMatch[1];
    }

    // Check if this process uses vite (need to check vite.config in cwd)
    const usesVite = /\bvite\b/i.test(appBlock);

    processes.push({ name: processName, port, ports, cwd, usesVite });
    lastIndex = endPos;
  }

  return processes;
}

/**
 * Extract port from vite.config.js/ts content
 */
function extractVitePort(content) {
  const portMatch = content.match(/port\s*:\s*(\d+)/);
  return portMatch ? parseInt(portMatch[1]) : null;
}

/**
 * Parse ecosystem config from a directory path (non-streaming, for refresh)
 * Also checks vite.config files in subdirectories for processes that use Vite
 */
export async function parseEcosystemFromPath(dirPath) {
  for (const ecosystemFile of ['ecosystem.config.js', 'ecosystem.config.cjs']) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8');
      const processes = parseEcosystemConfig(content);

      // For processes that use vite and don't have a port, check their cwd for vite.config
      for (const proc of processes) {
        if (proc.usesVite && !proc.port && proc.cwd) {
          const cwdPath = join(dirPath, proc.cwd);
          for (const viteConfig of ['vite.config.ts', 'vite.config.js']) {
            const viteConfigPath = join(cwdPath, viteConfig);
            if (existsSync(viteConfigPath)) {
              const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
              const port = extractVitePort(viteContent);
              if (port) {
                proc.port = port;
                break;
              }
            }
          }
        }
        // Clean up internal properties before returning
        delete proc.cwd;
        delete proc.usesVite;
      }

      return processes;
    }
  }
  return [];
}

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
    processes: [],
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
        // Parse all processes with their ports using the dedicated parser
        const parsedProcesses = parseEcosystemConfig(content);
        if (parsedProcesses.length > 0) {
          // For processes that use vite and don't have a port, check their cwd for vite.config
          for (const proc of parsedProcesses) {
            if (proc.usesVite && !proc.port && proc.cwd) {
              const cwdPath = join(dirPath, proc.cwd);
              for (const viteConfig of ['vite.config.ts', 'vite.config.js']) {
                const viteConfigPath = join(cwdPath, viteConfig);
                if (existsSync(viteConfigPath)) {
                  const viteContent = await readFile(viteConfigPath, 'utf-8').catch(() => '');
                  const port = extractVitePort(viteContent);
                  if (port) {
                    proc.port = port;
                    break;
                  }
                }
              }
            }
            // Clean up internal properties
            delete proc.cwd;
            delete proc.usesVite;
          }

          result.processes = parsedProcesses;
          result.pm2ProcessNames = parsedProcesses.map(p => p.name);

          // Set apiPort from first process with a port (usually the main server)
          const processWithPort = parsedProcesses.find(p => p.port);
          if (processWithPort && !result.apiPort) {
            result.apiPort = processWithPort.port;
          }
        }

        // Extract UI port from CLIENT_URL (still needed as it's not in process configs)
        const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
        if (clientUrlMatch && !result.uiPort) {
          result.uiPort = parseInt(clientUrlMatch[1]);
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
    processes: result.processes.length > 0 ? result.processes : undefined,
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
