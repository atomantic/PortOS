import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execPm2 } from './pm2.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { detectAppIcon } from './appIconDetect.js';

/** App types that do not use PM2 for process management */
export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);

/** Check if an app type uses PM2 for process management */
export const usesPm2 = (type) => !NON_PM2_TYPES.has(type);

/**
 * Find the index of the `}` that matches the `{` at `openBraceIdx`, ignoring
 * braces inside strings and comments. Returns -1 if no match.
 */
function findMatchingBrace(content, openBraceIdx) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBraceIdx; i < content.length; i++) {
    const char = content[i];
    const nextChar = i < content.length - 1 ? content[i + 1] : '';
    const prevChar = i > 0 ? content[i - 1] : '';

    if (!inString && !inBlockComment && char === '/' && nextChar === '/') { inLineComment = true; continue; }
    if (inLineComment && char === '\n') { inLineComment = false; continue; }
    if (!inString && !inLineComment && char === '/' && nextChar === '*') { inBlockComment = true; continue; }
    if (inBlockComment && char === '*' && nextChar === '/') { inBlockComment = false; i++; continue; }
    if (inLineComment || inBlockComment) continue;

    if ((char === '"' || char === "'") && prevChar !== '\\') {
      if (!inString) { inString = true; stringChar = char; }
      else if (char === stringChar) { inString = false; stringChar = null; }
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Parse ecosystem.config.js/cjs to extract all processes with their ports
 * Uses regex parsing since we can't safely execute arbitrary JS
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export function parseEcosystemConfig(content) {
  const processes = [];
  let pm2Home = null;

  // Extract PM2_HOME constant if defined (e.g., const PM2_HOME = `${require("os").homedir()}/.pm2-grace`)
  // First try template literals (backticks) which can contain nested quotes
  const templateMatch = content.match(/(?:const|let|var)\s+PM2_HOME\s*=\s*`([^`]+)`/);
  if (templateMatch) {
    let homePath = templateMatch[1];
    // Replace common template expressions
    homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.homedir\(\)\}/g, homedir());
    homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.userInfo\(\)\.username\}/g, process.env.USER || 'user');
    homePath = homePath.replace(/\$\{process\.env\.HOME\}/g, homedir());
    pm2Home = homePath;
  } else {
    // Try regular string literals
    const stringMatch = content.match(/(?:const|let|var)\s+PM2_HOME\s*=\s*['"]([^'"]+)['"]/);
    if (stringMatch) {
      pm2Home = stringMatch[1];
    } else {
      // Check for PM2_HOME in env blocks
      const envPm2HomeMatch = content.match(/PM2_HOME\s*:\s*PM2_HOME/);
      if (envPm2HomeMatch) {
        // PM2_HOME is used but defined as a variable - try template literal first
        const varTemplateMatch = content.match(/PM2_HOME\s*=\s*`([^`]+)`/);
        if (varTemplateMatch) {
          let homePath = varTemplateMatch[1];
          homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.homedir\(\)\}/g, homedir());
          homePath = homePath.replace(/\$\{require\(['"]os['"]\)\.userInfo\(\)\.username\}/g, process.env.USER || 'user');
          pm2Home = homePath;
        }
      }
    }
  }

  // Extract top-level port constants (e.g., const CDP_PORT = 5549)
  const portConstants = {};
  const constMatches = content.matchAll(/(?:const|let|var)\s+(\w*PORT\w*)\s*=\s*(\d+)/g);
  for (const match of constMatches) {
    portConstants[match[1]] = parseInt(match[2], 10);
  }

  // Extract PORTS object - handles both flat and nested structures
  // Flat: const PORTS = { WEB: 5550, API: 5551 }
  // Nested: const PORTS = { server: { api: 5555 }, client: { ui: 5554 } }
  const portsObjStart = content.match(/(?:const|let|var)\s+PORTS\s*=\s*\{/);
  if (portsObjStart) {
    const startIdx = portsObjStart.index + portsObjStart[0].length - 1;
    let braceCount = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }
    }
    const portsBlock = content.substring(startIdx, endIdx + 1);

    // Parse flat entries: KEY: 5550
    const flatEntries = portsBlock.matchAll(/(\w+)\s*:\s*(\d+)/g);
    for (const entry of flatEntries) {
      portConstants[`PORTS.${entry[1]}`] = parseInt(entry[2], 10);
    }

    // Parse nested entries: key: { subkey: 5550 }
    const nestedMatches = portsBlock.matchAll(/(\w+)\s*:\s*\{([^}]+)\}/g);
    for (const nestedMatch of nestedMatches) {
      const parentKey = nestedMatch[1];
      const nestedContent = nestedMatch[2];
      const nestedPorts = {};
      const subEntries = nestedContent.matchAll(/(\w+)\s*:\s*(\d+)/g);
      for (const subEntry of subEntries) {
        const port = parseInt(subEntry[2], 10);
        portConstants[`PORTS.${parentKey}.${subEntry[1]}`] = port;
        nestedPorts[subEntry[1]] = port;
      }
      // Also store the whole nested object for `ports: PORTS.server` references
      portConstants[`PORTS.${parentKey}`] = nestedPorts;
    }
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

    // Look for ports: { label: port, ... } object with literal values
    const portsObjMatch = appBlock.match(/\bports\s*:\s*\{([^}]+)\}/);
    if (portsObjMatch) {
      const portsContent = portsObjMatch[1];
      const portEntries = portsContent.matchAll(/(\w+)\s*:\s*(\d+)/g);
      for (const entry of portEntries) {
        ports[entry[1]] = parseInt(entry[2], 10);
      }
    }

    // Look for ports: VARIABLE reference (e.g., ports: PORTS.server)
    if (Object.keys(ports).length === 0) {
      const portsVarMatch = appBlock.match(/\bports\s*:\s*([\w.]+)/);
      if (portsVarMatch) {
        const varRef = portsVarMatch[1];
        const resolved = portConstants[varRef];
        if (resolved && typeof resolved === 'object') {
          ports = { ...resolved };
        }
      }
    }

    // Fall back to legacy parsing if no ports object found
    if (Object.keys(ports).length === 0) {
      // Helper to resolve port value from literal, variable reference, or expression
      // Handles: 4420, PORTS.API, process.env.PORT || 4420, Number(...) || 4420
      const resolvePortValue = (value) => {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
        // Expression with || fallback: "process.env.PORT || 4420"
        const fallbackMatch = trimmed.match(/\|\|\s*['"]?(\d+)['"]?\s*$/);
        if (fallbackMatch) return parseInt(fallbackMatch[1], 10);
        // PORTS.XXX or constant reference
        if (portConstants[trimmed]) return portConstants[trimmed];
        return null;
      };

      // Collect every `<NAME>_PORT` env-var first, label after — so CDP_PORT
      // can influence the smart label chosen for PORT regardless of source order.
      // The `_PORT` suffix requirement avoids matching identifiers like REPORT.
      // Brace-counting (not `[^}]*`) so env values with nested objects/ternaries
      // don't truncate the scan at the first inner `}`.
      const envPorts = {};
      const envHeaderRegex = /(?:env|env_development|env_production)\s*:\s*\{/g;
      let envHeaderMatch;
      while ((envHeaderMatch = envHeaderRegex.exec(appBlock)) !== null) {
        const openIdx = envHeaderMatch.index + envHeaderMatch[0].length - 1;
        const closeIdx = findMatchingBrace(appBlock, openIdx);
        if (closeIdx < 0) continue;
        const envContent = appBlock.substring(openIdx + 1, closeIdx);
        const portKeyRegex = /\b(PORT|[A-Z][A-Z0-9_]*_PORT)\b\s*:\s*([^,}\n]+)/g;
        let m;
        while ((m = portKeyRegex.exec(envContent)) !== null) {
          const key = m[1];
          if (envPorts[key] !== undefined) continue;
          const resolved = resolvePortValue(m[2]);
          if (resolved) envPorts[key] = resolved;
        }
      }

      const isUiProcess = /[-_](ui|client)$/i.test(processName);
      const isBrowserProcess = /[-_]browser$/i.test(processName);

      if (envPorts.CDP_PORT !== undefined) ports.cdp = envPorts.CDP_PORT;
      if (envPorts.PORT !== undefined) {
        if (isUiProcess) {
          ports.ui = envPorts.PORT;
        } else if (isBrowserProcess && ports.cdp !== undefined) {
          // Browser processes pair CDP_PORT (DevTools) with PORT (health endpoint).
          ports.health = envPorts.PORT;
        } else {
          ports.api = envPorts.PORT;
        }
      }
      if (envPorts.VITE_PORT !== undefined) ports.ui = envPorts.VITE_PORT;

      // FOO_BAR_PORT → fooBar, capturing app-specific labels (coinbaseIpc, etc.).
      for (const [key, value] of Object.entries(envPorts)) {
        if (key === 'PORT' || key === 'VITE_PORT' || key === 'CDP_PORT') continue;
        const stem = key.replace(/_?PORT$/, '');
        if (!stem) continue;
        const label = stem.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
        if (ports[label] === undefined) ports[label] = value;
      }

      // Also check for --port in args
      if (Object.keys(ports).length === 0) {
        const argsPortMatch = appBlock.match(/args\s*:\s*['"][^'"]*--port\s+(\d+)/);
        if (argsPortMatch) {
          ports.ui = parseInt(argsPortMatch[1], 10);
        }
      }

      // Check for port: XXXX directly (some configs use this)
      if (Object.keys(ports).length === 0) {
        const directPortMatch = appBlock.match(/\bport\s*:\s*(\d+)/);
        if (directPortMatch) {
          ports.api = parseInt(directPortMatch[1], 10);
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
    // Match explicit "vite" command OR VITE_PORT in env config
    const usesVite = /\bvite\b/i.test(appBlock) || /VITE_PORT/i.test(appBlock);

    processes.push({ name: processName, port, ports, cwd, usesVite });
    lastIndex = endPos;
  }

  // Post-process: when an app has both an API process and Vite dev processes,
  // relabel Vite ports from 'ui' to 'devUi' since the prod UI is served by the API.
  const hasApiProcess = processes.some(p => p.ports?.api);
  if (hasApiProcess) {
    for (const proc of processes) {
      if (proc.usesVite && proc.ports?.ui && !proc.ports?.devUi) {
        proc.ports.devUi = proc.ports.ui;
        delete proc.ports.ui;
        // Update primary port reference
        const portValues = Object.values(proc.ports);
        proc.port = portValues.length > 0 ? portValues[0] : null;
      }
    }
  }

  return { processes, pm2Home };
}

/**
 * Extract port from vite.config.js/ts content
 */
function extractVitePort(content) {
  const portMatch = content.match(/port\s*:\s*(\d+)/);
  return portMatch ? parseInt(portMatch[1], 10) : null;
}

/**
 * Parse ecosystem config from a directory path (non-streaming, for refresh)
 * Also checks vite.config files in subdirectories for processes that use Vite
 * @returns {{ processes: Array, pm2Home: string|null }}
 */
export async function parseEcosystemFromPath(dirPath) {
  for (const ecosystemFile of ['ecosystem.config.js', 'ecosystem.config.cjs']) {
    const ecosystemPath = join(dirPath, ecosystemFile);
    if (existsSync(ecosystemPath)) {
      const content = await readFile(ecosystemPath, 'utf-8');
      const { processes, pm2Home } = parseEcosystemConfig(content);

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

      return { processes, pm2Home };
    }
  }
  return { processes: [], pm2Home: null };
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
    devUiPort: null,
    apiPort: null,
    buildCommand: null,
    startCommands: [],
    pm2ProcessNames: [],
    pm2Status: null,
    processes: [],
    pm2Home: null,
    type: 'unknown',
    appIconPath: null
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

  // Detect Swift/Xcode projects from directory contents
  const hasXcodeproj = files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  const hasProjectYml = files.includes('project.yml');
  const hasPackageSwift = files.includes('Package.swift');

  if (hasXcodeproj || hasProjectYml || hasPackageSwift) {
    // Parse project.yml for XcodeGen projects
    if (hasProjectYml) {
      const ymlContent = await readFile(join(dirPath, 'project.yml'), 'utf-8').catch(() => '');
      const nameMatch = ymlContent.match(/^name:\s*(.+)$/m);
      if (nameMatch) result.name = nameMatch[1].trim();

      // Detect platform from targets
      const platformMatch = ymlContent.match(/platform:\s*\[?([^\]\n]+)/);
      if (platformMatch) {
        const platforms = platformMatch[1].toLowerCase();
        if (platforms.includes('ios') && platforms.includes('macos')) {
          result.type = 'xcode';
        } else if (platforms.includes('ios')) {
          result.type = 'ios-native';
        } else if (platforms.includes('macos')) {
          result.type = 'macos-native';
        } else {
          result.type = 'xcode';
        }
      } else {
        result.type = 'xcode';
      }

      // Extract build command
      result.buildCommand = 'xcodebuild -scheme ' + result.name + ' build';
    } else if (hasPackageSwift) {
      result.type = 'swift';
      result.buildCommand = 'swift build';
    } else {
      // .xcodeproj without project.yml
      const xcodeprojDir = files.find(f => f.endsWith('.xcodeproj'));
      const schemeName = xcodeprojDir?.replace('.xcodeproj', '') || result.name;
      result.type = 'xcode';
      result.buildCommand = 'xcodebuild -scheme ' + schemeName + ' build';
    }

    result.startCommands = [];
    result.pm2ProcessNames = [];
    result.editorCommand = process.platform === 'darwin' ? 'xed .' : 'code .';
  }

  // Step 3: Read package.json
  emit('package', 'running', { message: 'Reading package.json...' });
  const pkgPath = join(dirPath, 'package.json');

  if (existsSync(pkgPath)) {
    const content = await readFile(pkgPath, 'utf-8').catch(() => null);
    if (content) {
      const pkg = safeJSONParse(content, null);
      if (!pkg) {
        emit('package', 'error', { message: 'Invalid package.json format' });
      } else {
        result.name = pkg.name || result.name;
        result.description = pkg.description || '';

        // Detect project type
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vite && deps.express) result.type = 'vite+express';
        else if (deps.vite || deps.react || deps.vue) result.type = 'vite';
        else if (deps.express || deps.fastify || deps.koa) result.type = 'single-node-server';
        else if (deps.next) result.type = 'nextjs';

        // Get start commands and build command
        const scripts = pkg.scripts || {};
        if (scripts.dev) result.startCommands.push('npm run dev');
        if (scripts.start && !scripts.dev) result.startCommands.push('npm start');
        if (scripts.build) result.buildCommand = 'npm run build';

        emit('package', 'done', {
          message: `Found: ${result.name}`,
          name: result.name,
          description: result.description,
          type: result.type,
          startCommands: result.startCommands
        });
      }
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
    if (portMatch) result.apiPort = parseInt(portMatch[1], 10);
    const viteMatch = content.match(/VITE_PORT\s*=\s*(\d+)/i);
    if (viteMatch) result.devUiPort = parseInt(viteMatch[1], 10);
    configFiles.push('.env');
  }

  // Check vite.config
  for (const viteConfig of ['vite.config.js', 'vite.config.ts']) {
    const configPath = join(dirPath, viteConfig);
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8').catch(() => '');
      const portMatch = content.match(/port\s*:\s*(\d+)/);
      if (portMatch) result.devUiPort = parseInt(portMatch[1], 10);
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
        const { processes: parsedProcesses, pm2Home } = parseEcosystemConfig(content);
        if (pm2Home) {
          result.pm2Home = pm2Home;
        }
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

          // Derive ports from parsed processes
          const apiProc = parsedProcesses.find(p => p.ports?.api);
          if (apiProc && !result.apiPort) {
            result.apiPort = apiProc.ports.api;
          }
          const uiProc = parsedProcesses.find(p => p.ports?.ui);
          if (uiProc && !result.uiPort) {
            result.uiPort = uiProc.ports.ui;
          }
          const devUiProc = parsedProcesses.find(p => p.ports?.devUi);
          if (devUiProc && !result.devUiPort) {
            result.devUiPort = devUiProc.ports.devUi;
          }
          // When app has API + Vite dev but no dedicated UI port,
          // the prod UI is served by the API server
          if (!result.uiPort && result.apiPort && result.devUiPort) {
            result.uiPort = result.apiPort;
          }
        }

        // Extract UI port from CLIENT_URL (still needed as it's not in process configs)
        const clientUrlMatch = content.match(/CLIENT_URL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
        if (clientUrlMatch && !result.uiPort) {
          result.uiPort = parseInt(clientUrlMatch[1], 10);
        }

        configFiles.push(ecosystemFile);
      }
    }
  }

  // When config-file heuristics found a Vite dev port but no dedicated uiPort,
  // derive uiPort: API serves prod UI if present, otherwise devUiPort is the only UI
  if (!result.uiPort && result.devUiPort) {
    result.uiPort = result.apiPort ?? result.devUiPort;
  }

  emit('config', 'done', {
    message: configFiles.length ? `Found: ${configFiles.join(', ')}` : 'No config files found',
    uiPort: result.uiPort,
    devUiPort: result.devUiPort,
    apiPort: result.apiPort,
    pm2ProcessNames: result.pm2ProcessNames.length > 0 ? result.pm2ProcessNames : undefined,
    processes: result.processes.length > 0 ? result.processes : undefined,
    configFiles
  });

  // Step 5: Check PM2 status (skip for non-PM2 app types)
  if (!usesPm2(result.type)) {
    emit('pm2', 'skipped', { message: `Not applicable for ${result.type} apps` });
  } else {
    emit('pm2', 'running', { message: 'Checking PM2 processes...' });
    // Use custom PM2_HOME if detected from ecosystem config
    const pm2Env = result.pm2Home ? { ...process.env, PM2_HOME: result.pm2Home } : undefined;
    const { stdout } = await execPm2(['jlist'], pm2Env ? { env: pm2Env } : {}).catch(() => ({ stdout: '[]' }));
    // pm2 jlist may output ANSI codes and warnings before JSON
    let jsonStart = stdout.indexOf('[{');
    if (jsonStart < 0) {
      const emptyMatch = stdout.match(/\[\](?![0-9])/);
      jsonStart = emptyMatch ? stdout.indexOf(emptyMatch[0]) : -1;
    }
    const pm2Json = jsonStart >= 0 ? stdout.slice(jsonStart) : '[]';
    const pm2Processes = safeJSONParse(pm2Json, []);

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

  // Step 7: Detect app icon
  emit('icon', 'running', { message: 'Looking for app icon...' });
  const detectedIcon = await detectAppIcon(dirPath, result.type);
  if (detectedIcon) {
    result.appIconPath = detectedIcon;
    emit('icon', 'done', { message: `Found: ${basename(detectedIcon)}`, appIconPath: detectedIcon });
  } else {
    emit('icon', 'done', { message: 'No app icon found' });
  }

  // Complete
  socket.emit('detect:complete', {
    success: true,
    result
  });
}
