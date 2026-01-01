import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getActiveProvider, getProviderById } from './providers.js';
import { spawn } from 'child_process';

const execAsync = promisify(exec);

/**
 * Stream detection results to a socket as each step completes
 */
export async function streamDetection(socket, dirPath, providerId = null) {
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
  let pkg = null;

  if (existsSync(pkgPath)) {
    const content = await readFile(pkgPath, 'utf-8').catch(() => null);
    if (content) {
      pkg = JSON.parse(content);
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

  emit('config', 'done', {
    message: configFiles.length ? `Found: ${configFiles.join(', ')}` : 'No config files found',
    uiPort: result.uiPort,
    apiPort: result.apiPort,
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
    emit('pm2', 'done', {
      message: `Found ${matchingProcesses.length} running process(es)`,
      pm2Status: result.pm2Status
    });
  } else {
    emit('pm2', 'done', { message: 'No matching PM2 processes found' });
  }

  // Generate PM2 process names
  const baseName = result.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  if (result.type === 'vite+express') {
    result.pm2ProcessNames = [`${baseName}-ui`, `${baseName}-api`];
  } else {
    result.pm2ProcessNames = [baseName];
  }

  // Step 6: AI-powered analysis (if provider available)
  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (provider?.enabled) {
    emit('ai', 'running', { message: `Analyzing with ${provider.name}...` });

    const aiResult = await runAiAnalysis(dirPath, provider, { pkg, files }).catch(err => {
      console.log(`⚠️ AI analysis failed: ${err.message}`);
      return null;
    });

    if (aiResult) {
      // Merge AI results (AI takes precedence for name/description)
      if (aiResult.name) result.name = aiResult.name;
      if (aiResult.description) result.description = aiResult.description;
      if (aiResult.uiPort && !result.uiPort) result.uiPort = aiResult.uiPort;
      if (aiResult.apiPort && !result.apiPort) result.apiPort = aiResult.apiPort;
      if (aiResult.startCommands?.length) result.startCommands = aiResult.startCommands;
      if (aiResult.pm2ProcessNames?.length) result.pm2ProcessNames = aiResult.pm2ProcessNames;

      emit('ai', 'done', {
        message: 'AI analysis complete',
        name: result.name,
        description: result.description
      });
    } else {
      emit('ai', 'skipped', { message: 'AI analysis unavailable' });
    }
  } else {
    emit('ai', 'skipped', { message: 'No AI provider configured' });
  }

  // Complete
  socket.emit('detect:complete', {
    success: true,
    result,
    provider: provider?.name || null
  });
}

/**
 * Run AI analysis on project
 */
async function runAiAnalysis(dirPath, provider, context) {
  const prompt = buildPrompt(dirPath, context);

  let response;
  if (provider.type === 'cli') {
    response = await executeCliPrompt(provider, prompt, dirPath);
  } else if (provider.type === 'api') {
    response = await executeApiPrompt(provider, prompt);
  } else {
    throw new Error('Unknown provider type');
  }

  return parseResponse(response);
}

function buildPrompt(dirPath, { pkg, files }) {
  return `Analyze this project and return JSON configuration.

Directory: ${basename(dirPath)}
Files: ${files.slice(0, 30).join(', ')}
${pkg ? `package.json name: ${pkg.name}, scripts: ${Object.keys(pkg.scripts || {}).join(', ')}` : 'No package.json'}

Return ONLY valid JSON:
{
  "name": "Human readable app name",
  "description": "One sentence description",
  "uiPort": null or number,
  "apiPort": null or number,
  "startCommands": ["npm run dev"],
  "pm2ProcessNames": ["app-name"]
}`;
}

async function executeCliPrompt(provider, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = [...(provider.args || []), prompt];
    let output = '';
    const child = spawn(provider.command, args, { cwd, env: process.env, shell: false });
    child.stdout.on('data', d => output += d.toString());
    child.stderr.on('data', d => output += d.toString());
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Exit ${code}`)));
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, provider.timeout || 60000);
  });
}

async function executeApiPrompt(provider, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseResponse(response) {
  let str = response.trim();
  const match = str.match(/```(?:json)?\s*([\s\S]*?)```/) || str.match(/\{[\s\S]*\}/);
  if (match) str = match[1] || match[0];
  return JSON.parse(str);
}
