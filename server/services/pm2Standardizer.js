import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getActiveProvider, getProviderById } from './providers.js';
import { spawn } from 'child_process';

const execAsync = promisify(exec);

/**
 * Gather all config files for standardization analysis
 */
async function gatherConfigContext(dirPath) {
  const context = {
    dirName: basename(dirPath),
    hasGit: existsSync(join(dirPath, '.git')),
    packageJson: null,
    ecosystemConfig: null,
    ecosystemPath: null,
    envFiles: [],
    viteConfigs: [],
    otherConfigs: [],
    structure: { hasClient: false, hasServer: false, hasPackages: false }
  };

  // Check directory structure
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  context.structure.hasClient = dirs.includes('client') || dirs.includes('web') || dirs.includes('frontend');
  context.structure.hasServer = dirs.includes('server') || dirs.includes('api') || dirs.includes('backend');
  context.structure.hasPackages = dirs.includes('packages');

  // Read package.json
  const pkgPath = join(dirPath, 'package.json');
  if (existsSync(pkgPath)) {
    context.packageJson = await readFile(pkgPath, 'utf-8').catch(() => null);
  }

  // Read ecosystem.config
  for (const name of ['ecosystem.config.cjs', 'ecosystem.config.js']) {
    const path = join(dirPath, name);
    if (existsSync(path)) {
      context.ecosystemConfig = await readFile(path, 'utf-8').catch(() => null);
      context.ecosystemPath = name;
      break;
    }
  }

  // Read .env files
  for (const name of ['.env', '.env.local', '.env.development']) {
    const path = join(dirPath, name);
    if (existsSync(path)) {
      const content = await readFile(path, 'utf-8').catch(() => '');
      context.envFiles.push({ name, path, content });
    }
  }

  // Read vite configs (root and subdirs)
  const vitePaths = [
    ['vite.config.js', dirPath],
    ['vite.config.ts', dirPath],
    ['client/vite.config.js', join(dirPath, 'client')],
    ['client/vite.config.ts', join(dirPath, 'client')],
    ['packages/web/vite.config.js', join(dirPath, 'packages/web')],
    ['packages/web/vite.config.ts', join(dirPath, 'packages/web')]
  ];

  for (const [relPath, fullDir] of vitePaths) {
    const fullPath = join(dirPath, relPath);
    if (existsSync(fullPath)) {
      const content = await readFile(fullPath, 'utf-8').catch(() => '');
      context.viteConfigs.push({ name: relPath, path: fullPath, content });
    }
  }

  return context;
}

/**
 * Build LLM prompt for PM2 standardization analysis
 */
function buildStandardizationPrompt(context) {
  return `# PM2 Standardization Analysis

You are analyzing a Node.js application to generate a standardized PM2 ecosystem configuration.

## Project: ${context.dirName}

## Directory Structure
- Has client/web directory: ${context.structure.hasClient}
- Has server/api directory: ${context.structure.hasServer}
- Has packages/ directory: ${context.structure.hasPackages}

## Current Files

${context.packageJson ? `### package.json
\`\`\`json
${context.packageJson}
\`\`\`` : 'No package.json found'}

${context.ecosystemConfig ? `### ${context.ecosystemPath}
\`\`\`javascript
${context.ecosystemConfig}
\`\`\`` : 'No ecosystem.config found'}

${context.envFiles.length > 0 ? `### Environment Files
${context.envFiles.map(f => `#### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}` : ''}

${context.viteConfigs.length > 0 ? `### Vite Configs
${context.viteConfigs.map(f => `#### ${f.name}\n\`\`\`javascript\n${f.content}\n\`\`\``).join('\n\n')}` : ''}

## PM2 Standard Requirements

1. **All ports MUST be in ecosystem.config.cjs env blocks** - Never in .env or vite.config
2. **Use CommonJS format** (.cjs extension) for PM2 compatibility
3. **Process naming**: lowercase-hyphenated (e.g., "myapp-server", "myapp-client")
4. **Server processes**: Enable watch for live-reload on dist/ or src/
5. **Vite processes**: Use \`npx vite --host --port XXXX\` in args, disable watch (Vite has HMR)
6. **Set cwd** for each process pointing to its directory
7. **Include NODE_ENV** in all env blocks

## Output Format

Return ONLY valid JSON (no markdown wrapper, no explanation) with this structure:
{
  "processes": [
    {
      "name": "string - process name",
      "cwd": "string - relative path like ./server or ./packages/web",
      "script": "string - entry point or npx",
      "args": "string or null - for vite: 'vite --host --port XXXX'",
      "watch": "array of paths to watch or false",
      "watchDelay": 1000,
      "ignoreWatch": ["node_modules", "data", "*.log"],
      "env": {
        "NODE_ENV": "development",
        "PORT": "number - the port this process uses"
      }
    }
  ],
  "strayPorts": [
    {
      "file": "string - relative file path",
      "variable": "string - variable name like PORT",
      "value": "number - the port value",
      "line": "number - line number",
      "action": "remove or keep"
    }
  ],
  "reasoning": "Brief explanation of your analysis"
}

Rules:
- Generate ecosystem.config.cjs content for ALL processes needed
- If existing ecosystem.config exists, preserve working configurations but add missing ports to env
- Mark PORT/VITE_PORT in .env files with action: "remove" (will be moved to ecosystem)
- Mark port in vite.config with action: "remove" (will use --port arg instead)
- If no ports are detected, use sensible defaults (3000 for frontend, 3001 for backend)`;
}

/**
 * Execute LLM analysis using CLI provider
 */
async function executeCliAnalysis(provider, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = [...(provider.args || []), prompt];
    let output = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

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
        settle(resolve, output);
      } else {
        settle(reject, new Error(`CLI exited with code ${code}`));
      }
    });

    child.on('error', (err) => settle(reject, err));

    const timeoutMs = provider.timeout || 180000;
    const timer = setTimeout(() => {
      console.log(`⏰ CLI analysis timed out after ${timeoutMs / 1000}s for: ${provider.command}`);
      child.kill();
      settle(reject, new Error(`Standardization analysis timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

/**
 * Execute LLM analysis using API provider
 */
async function executeApiAnalysis(provider, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const timeoutMs = provider.timeout || 180000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    })
  }).finally(() => clearTimeout(timer));

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Parse LLM response to extract JSON
 */
function parseAnalysisResponse(response) {
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
 * Generate ecosystem.config.cjs content from processes
 */
function generateEcosystemContent(processes, appName) {
  const apps = processes.map(proc => {
    const config = {
      name: proc.name,
      cwd: proc.cwd,
      script: proc.script
    };

    if (proc.args) {
      config.args = proc.args;
    }

    if (proc.watch && proc.watch !== false) {
      config.watch = proc.watch;
      config.watch_delay = proc.watchDelay || 1000;
      config.ignore_watch = proc.ignoreWatch || ['node_modules', 'data', '*.log'];
    } else {
      config.watch = false;
    }

    config.env = proc.env || { NODE_ENV: 'development' };

    return config;
  });

  // Generate formatted JavaScript
  const configStr = JSON.stringify({ apps }, null, 2)
    .replace(/"([^"]+)":/g, '$1:')  // Remove quotes from keys
    .replace(/"/g, "'");             // Use single quotes for strings

  return `// PM2 Ecosystem Configuration
// Generated by PortOS PM2 Standardizer

module.exports = ${configStr};
`;
}

/**
 * Create git backup before modifications
 */
export async function createGitBackup(repoPath) {
  // Check if git repo
  if (!existsSync(join(repoPath, '.git'))) {
    return { success: false, reason: 'Not a git repository' };
  }

  const timestamp = Date.now();
  const branch = `portos-backup-${timestamp}`;

  // Check for uncommitted changes
  const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
  const hasChanges = status.trim().length > 0;

  if (hasChanges) {
    // Stash changes
    await execAsync('git stash push -m "PortOS standardization backup"', { cwd: repoPath })
      .catch(() => null); // Ignore if nothing to stash
  }

  // Create backup branch
  await execAsync(`git branch ${branch}`, { cwd: repoPath });

  if (hasChanges) {
    // Pop stash
    await execAsync('git stash pop', { cwd: repoPath }).catch(() => null);
  }

  return { success: true, branch, hadChanges: hasChanges };
}

/**
 * Analyze app and generate standardization plan
 */
export async function analyzeApp(repoPath, providerId = null) {
  if (!existsSync(repoPath)) {
    return { success: false, error: 'Directory does not exist' };
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
  const context = await gatherConfigContext(repoPath);
  const prompt = buildStandardizationPrompt(context);

  // Execute analysis
  const startTime = Date.now();
  console.log(`🤖 Running ${provider.type} analysis via ${provider.name} (timeout: ${(provider.timeout || 180000) / 1000}s)`);

  let response;
  if (provider.type === 'cli') {
    response = await executeCliAnalysis(provider, prompt, repoPath);
  } else if (provider.type === 'api') {
    response = await executeApiAnalysis(provider, prompt);
  } else {
    return { success: false, error: 'Unknown provider type' };
  }

  console.log(`✅ Analysis response received in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Parse response
  const analysis = parseAnalysisResponse(response);

  // Generate ecosystem content
  const ecosystemContent = generateEcosystemContent(analysis.processes, context.dirName);

  return {
    success: true,
    provider: provider.name,
    repoPath,
    currentState: {
      hasEcosystem: !!context.ecosystemConfig,
      ecosystemPath: context.ecosystemPath,
      hasGit: context.hasGit,
      envFiles: context.envFiles.map(f => f.name),
      viteConfigs: context.viteConfigs.map(f => f.name)
    },
    proposedChanges: {
      createEcosystem: !context.ecosystemConfig,
      ecosystemContent,
      processes: analysis.processes,
      strayPorts: analysis.strayPorts || []
    },
    llmAnalysis: {
      providerId: provider.id,
      reasoning: analysis.reasoning || 'Analysis complete'
    }
  };
}

/**
 * Apply standardization changes to the repository
 */
export async function applyStandardization(repoPath, plan) {
  const results = {
    success: true,
    backupBranch: null,
    filesModified: [],
    errors: []
  };

  // Create git backup first
  if (plan.currentState.hasGit) {
    const backup = await createGitBackup(repoPath);
    if (backup.success) {
      results.backupBranch = backup.branch;
      console.log(`📦 Created backup branch: ${backup.branch}`);
    } else {
      console.log(`⚠️ Could not create backup: ${backup.reason}`);
    }
  }

  // Write ecosystem.config.cjs
  const ecosystemPath = join(repoPath, 'ecosystem.config.cjs');
  await writeFile(ecosystemPath, plan.proposedChanges.ecosystemContent, 'utf-8');
  results.filesModified.push('ecosystem.config.cjs');
  console.log(`✅ Written ecosystem.config.cjs`);

  // Remove old ecosystem.config.js if we're creating .cjs
  const oldEcosystemJs = join(repoPath, 'ecosystem.config.js');
  if (existsSync(oldEcosystemJs) && plan.proposedChanges.createEcosystem) {
    const { unlink } = await import('fs/promises');
    await unlink(oldEcosystemJs).catch(() => null);
    results.filesModified.push('ecosystem.config.js (removed)');
  }

  // Process stray ports - remove from .env files
  for (const stray of plan.proposedChanges.strayPorts || []) {
    if (stray.action !== 'remove') continue;

    const filePath = join(repoPath, stray.file);
    if (!existsSync(filePath)) continue;

    const content = await readFile(filePath, 'utf-8').catch(() => null);
    if (!content) continue;

    // Remove the port line from .env files
    if (stray.file.includes('.env')) {
      const lines = content.split('\n');
      const filtered = lines.filter(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) return true;
        return !new RegExp(`^${stray.variable}\\s*=`).test(trimmed);
      });

      if (filtered.length !== lines.length) {
        await writeFile(filePath, filtered.join('\n'), 'utf-8');
        results.filesModified.push(`${stray.file} (removed ${stray.variable})`);
        console.log(`✅ Removed ${stray.variable} from ${stray.file}`);
      }
    }

    // Remove port from vite.config (more complex - comment it out)
    if (stray.file.includes('vite.config')) {
      const modified = content.replace(
        /(\s*port\s*:\s*\d+\s*,?)/g,
        '/* $1 */ // Moved to PM2 ecosystem.config.cjs'
      );

      if (modified !== content) {
        await writeFile(filePath, modified, 'utf-8');
        results.filesModified.push(`${stray.file} (commented out port)`);
        console.log(`✅ Commented out port in ${stray.file}`);
      }
    }
  }

  return results;
}

/**
 * Get the standard PM2 template for reference
 */
export function getStandardTemplate() {
  return `// PM2 Ecosystem Configuration Template
// All ports should be defined here, not in .env or vite.config

module.exports = {
  apps: [
    {
      name: 'myapp-server',
      cwd: './server',
      script: 'dist/index.js',
      watch: ['dist'],
      watch_delay: 1000,
      ignore_watch: ['node_modules', 'data', '*.log'],
      env: {
        NODE_ENV: 'development',
        PORT: 3001
      }
    },
    {
      name: 'myapp-client',
      cwd: './client',
      script: 'npx',
      args: 'vite --host --port 3000',
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      }
    }
  ]
};
`;
}
