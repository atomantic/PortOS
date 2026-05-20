import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getActiveProvider, getProviderById } from './providers.js';
import { tryReadFile } from '../lib/fileUtils.js';
import { extractJson } from '../lib/jsonExtract.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';

const DEFAULT_AI_DETECT_TIMEOUT_MS = 60000;

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
    const content = await tryReadFile(pkgPath);
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
      const content = await tryReadFile(configPath);
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

// Match the detection-response JSON, not the package.json the prompt echoes
// back. Prompt-echoing CLI/TUI providers (Codex, Claude Code) replay the input
// before the real answer; without a shape gate, extractJson would lock onto
// the echoed `{ "name": "...", "scripts": {...} }` block and return defaults.
const isDetectionShape = (v) => (
  v && typeof v === 'object' && !Array.isArray(v)
  && ('hasFrontend' in v || 'hasBackend' in v || 'uiPort' in v || 'apiPort' in v || 'pm2ProcessNames' in v || 'startCommands' in v)
);

function parseAiResponse(response) {
  const { value } = extractJson(response, { shapePredicate: isDetectionShape });
  if (!isDetectionShape(value)) throw new Error('Failed to parse AI detection response');
  return value;
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

  // cwd: dirPath so any spawned CLI/TUI runs against the analyzed repo, not PortOS's own cwd.
  const { text: response } = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'ai-app-detect',
    timeout: provider.timeout || DEFAULT_AI_DETECT_TIMEOUT_MS,
    cwd: dirPath,
  });

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
