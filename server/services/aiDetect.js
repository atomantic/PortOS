import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getActiveProvider, getProviderById } from './providers.js';
import { spawn } from 'child_process';

/**
 * Gather project context for AI analysis
 */
async function gatherProjectContext(dirPath) {
  const context = {
    dirName: basename(dirPath),
    files: [],
    packageJson: null,
    envFiles: [],
    configFiles: []
  };

  // Get directory listing
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  context.files = entries.map(e => e.name);

  // Read package.json
  const pkgPath = join(dirPath, 'package.json');
  if (existsSync(pkgPath)) {
    const content = await readFile(pkgPath, 'utf-8').catch(() => null);
    if (content) {
      context.packageJson = content;
    }
  }

  // Check for common config files
  const configPatterns = [
    'vite.config.js', 'vite.config.ts',
    'next.config.js', 'next.config.mjs',
    'webpack.config.js',
    'ecosystem.config.cjs', 'ecosystem.config.js',
    'tsconfig.json',
    'Dockerfile', 'docker-compose.yml'
  ];

  for (const pattern of configPatterns) {
    const configPath = join(dirPath, pattern);
    if (existsSync(configPath)) {
      const content = await readFile(configPath, 'utf-8').catch(() => null);
      if (content) {
        context.configFiles.push({ name: pattern, content: content.substring(0, 2000) });
      }
    }
  }

  // Check for .env files
  const envPatterns = ['.env', '.env.local', '.env.development'];
  for (const pattern of envPatterns) {
    const envPath = join(dirPath, pattern);
    if (existsSync(envPath)) {
      const content = await readFile(envPath, 'utf-8').catch(() => '');
      // Extract port-related lines only (don't expose secrets)
      const portLines = content.split('\n')
        .filter(line => /port/i.test(line) && !line.startsWith('#'))
        .join('\n');
      if (portLines) {
        context.envFiles.push({ name: pattern, content: portLines });
      }
    }
  }

  // Check for README
  for (const readme of ['README.md', 'readme.md', 'README']) {
    const readmePath = join(dirPath, readme);
    if (existsSync(readmePath)) {
      const content = await readFile(readmePath, 'utf-8').catch(() => '');
      context.readme = content.substring(0, 3000);
      break;
    }
  }

  return context;
}

/**
 * Build prompt for AI analysis
 */
function buildAnalysisPrompt(context) {
  return `Analyze this project and return JSON with the detected configuration.

Directory: ${context.dirName}
Files: ${context.files.slice(0, 50).join(', ')}

${context.packageJson ? `package.json:\n${context.packageJson}\n` : ''}
${context.configFiles.map(f => `${f.name}:\n${f.content}`).join('\n\n')}
${context.envFiles.map(f => `${f.name}:\n${f.content}`).join('\n')}
${context.readme ? `README excerpt:\n${context.readme.substring(0, 1000)}` : ''}

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "name": "Human readable app name",
  "description": "One sentence description",
  "uiPort": null or number (frontend/dev server port),
  "apiPort": null or number (backend/API port),
  "startCommands": ["array of npm scripts to start the app"],
  "pm2ProcessNames": ["suggested PM2 process names"],
  "hasFrontend": true/false,
  "hasBackend": true/false
}

Rules:
- name: Use package.json name or derive from directory, make it human readable
- Look for ports in vite.config, .env files, or package.json scripts
- For startCommands, prefer "npm run dev" patterns
- For pm2ProcessNames, use lowercase hyphenated names like "app-name-ui", "app-name-api"
- If the app has both frontend and backend, suggest separate PM2 processes`;
}

/**
 * Execute AI detection using CLI provider
 */
async function executeCliDetection(provider, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = [...(provider.args || []), prompt];
    let output = '';

    const child = spawn(provider.command, args, {
      cwd,
      env: process.env,
      shell: false
    });

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`CLI exited with code ${code}`));
      }
    });

    child.on('error', reject);

    // Timeout after provider timeout or 60s
    setTimeout(() => {
      child.kill();
      reject(new Error('Detection timed out'));
    }, provider.timeout || 60000);
  });
}

/**
 * Execute AI detection using API provider
 */
async function executeApiDetection(provider, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Parse AI response to extract JSON
 */
function parseAiResponse(response) {
  // Try to extract JSON from response
  let jsonStr = response.trim();

  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Try to find JSON object
  const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    jsonStr = objectMatch[0];
  }

  return JSON.parse(jsonStr);
}

/**
 * Auto-detect app configuration using AI
 */
export async function detectAppWithAi(dirPath, providerId = null) {
  // Validate directory
  if (!existsSync(dirPath)) {
    return { success: false, error: 'Directory does not exist' };
  }

  const stats = await stat(dirPath);
  if (!stats.isDirectory()) {
    return { success: false, error: 'Path is not a directory' };
  }

  // Get provider
  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();

  if (!provider) {
    return { success: false, error: 'No AI provider configured' };
  }

  if (!provider.enabled) {
    return { success: false, error: 'AI provider is disabled' };
  }

  // Gather context
  const context = await gatherProjectContext(dirPath);
  const prompt = buildAnalysisPrompt(context);

  // Execute detection
  let response;
  if (provider.type === 'cli') {
    response = await executeCliDetection(provider, prompt, dirPath)
      .catch(err => { throw new Error(`CLI detection failed: ${err.message}`); });
  } else if (provider.type === 'api') {
    response = await executeApiDetection(provider, prompt)
      .catch(err => { throw new Error(`API detection failed: ${err.message}`); });
  } else {
    return { success: false, error: 'Unknown provider type' };
  }

  // Parse response
  const detected = parseAiResponse(response);

  return {
    success: true,
    provider: provider.name,
    detected: {
      name: detected.name || context.dirName,
      description: detected.description || '',
      uiPort: detected.uiPort || null,
      apiPort: detected.apiPort || null,
      startCommands: detected.startCommands || ['npm run dev'],
      pm2ProcessNames: detected.pm2ProcessNames || [context.dirName.toLowerCase().replace(/[^a-z0-9]/g, '-')],
      hasFrontend: detected.hasFrontend !== false,
      hasBackend: detected.hasBackend !== false
    },
    context: {
      hasPackageJson: !!context.packageJson,
      hasReadme: !!context.readme,
      configFiles: context.configFiles.map(f => f.name)
    }
  };
}
