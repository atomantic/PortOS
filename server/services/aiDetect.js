import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { getActiveProvider, getProviderById } from './providers.js';
import { tryReadFile } from '../lib/fileUtils.js';
import { extractJson } from '../lib/jsonExtract.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { fenceBlock, UNTRUSTED_CONTENT_NOTICE } from '../lib/promptFencing.js';
import { validateCommand } from '../lib/commandSecurity.js';

const DEFAULT_AI_DETECT_TIMEOUT_MS = 60000;

// Per-section character caps for the untrusted repository text spliced into the
// detection prompt. Every section is capped: an oversized file must never
// dominate the context window and crowd out the instructions. The caps are
// applied at READ time (so an enormous file never reaches the prompt builder)
// and again by `fenceBlock` — the second pass is a backstop for any future
// caller that hands the builder a context it did not gather here.
const MAX_PACKAGE_JSON_CHARS = 4000;
const MAX_CONFIG_FILE_CHARS = 2000;
const MAX_ENV_LINES_CHARS = 500;
const MAX_README_CHARS = 1000;
const MAX_FILE_LIST_CHARS = 1000;
const MAX_DIR_NAME_CHARS = 200;

// PM2 process names become the identity of a spawned process; keep them to the
// same conservative shape PortOS itself uses for app process names.
const PM2_PROCESS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// `all` is pm2's reserved every-process target, not a name. Stored as this app's
// process name it would turn a scoped `pm2 stop <name>` into `pm2 stop all` and
// take down every app on the shared daemon — the exact target
// `PM2_ALL_TARGET_VERBS` blocks in commandSecurity.js.
const PM2_RESERVED_TARGETS = new Set(['all']);

const isUsablePm2ProcessName = (n) => (
  typeof n === 'string'
  && PM2_PROCESS_NAME_PATTERN.test(n)
  && !PM2_RESERVED_TARGETS.has(n.toLowerCase())
);

const DEFAULT_START_COMMAND = 'npm run dev';

// The scanned directory's name is operator-supplied rather than model output,
// but it still becomes a pm2 argv token when the model gives no usable name —
// so hold the fallback to the SAME predicate the model's answer must satisfy
// (a directory literally named `all` would otherwise reintroduce the reserved
// every-process target through the back door).
const fallbackProcessName = (dirName) => {
  const slug = dirName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64);
  return isUsablePm2ProcessName(slug) ? slug : 'app';
};

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
      // Cap at read time, like configFiles/readme below, so an enormous crafted
      // package.json never reaches the prompt builder at all.
      context.packageJson = content.substring(0, MAX_PACKAGE_JSON_CHARS);
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
        context.configFiles.push({ name: pattern, content: content.substring(0, MAX_CONFIG_FILE_CHARS) });
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
      context.readme = content.substring(0, MAX_README_CHARS);
      break;
    }
  }

  return context;
}

/**
 * Build prompt for AI analysis
 */
function buildAnalysisPrompt(context) {
  // Everything below that originates in the scanned repository is untrusted:
  // the operator may be pointing the detector at a cloned dependency or a repo
  // an agent checked out. It rides in fenced, capped blocks, under a standing
  // instruction that fenced content is data — because the answer's
  // `startCommands` is later handed to pm2 as a process command line.
  const sections = [
    fenceBlock('Directory', context.dirName, MAX_DIR_NAME_CHARS),
    fenceBlock('Files', context.files.slice(0, 50).join(', '), MAX_FILE_LIST_CHARS),
    fenceBlock('package.json', context.packageJson, MAX_PACKAGE_JSON_CHARS),
    ...context.configFiles.map(f => fenceBlock(f.name, f.content, MAX_CONFIG_FILE_CHARS)),
    ...context.envFiles.map(f => fenceBlock(`${f.name} (port lines)`, f.content, MAX_ENV_LINES_CHARS)),
    fenceBlock('README excerpt', context.readme, MAX_README_CHARS),
  ].filter(Boolean);

  return `Analyze this project and return JSON with the detected configuration.

${UNTRUSTED_CONTENT_NOTICE}

${sections.join('\n\n')}

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

// The model's answer is advisory, and its two executable-shaped fields come from
// a prompt that carried untrusted repository text. Filter rather than reject the
// whole detection: a partially-usable result beats none, and the same allowlist
// already gates PortOS's manual command runner.
function sanitizeStartCommands(value) {
  if (!Array.isArray(value)) return [DEFAULT_START_COMMAND];
  const kept = value.filter(c => typeof c === 'string' && validateCommand(c).valid);
  if (kept.length !== value.length) {
    console.warn(`🛡️ ai-detect dropped ${value.length - kept.length} of ${value.length} startCommands (not on the command allowlist)`);
  }
  return kept.length ? kept : [DEFAULT_START_COMMAND];
}

function sanitizePm2ProcessNames(value, fallbackName) {
  const fallback = [fallbackName];
  if (!Array.isArray(value)) return fallback;
  const kept = value.filter(isUsablePm2ProcessName);
  if (kept.length !== value.length) {
    console.warn(`🛡️ ai-detect dropped ${value.length - kept.length} of ${value.length} pm2ProcessNames (malformed or reserved process name)`);
  }
  return kept.length ? kept : fallback;
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
  // skipInnerFence: the prompt now wraps every repository section in a ```text
  // fence, so a prompt-echoing provider replays fences AHEAD of its answer.
  // extractJson's "first inner fence is the wrapper" heuristic would lock onto
  // the echoed Files/package.json block and never reach the real response — the
  // exact case its docblock says this option exists for. Balanced-block walking
  // plus the shape gate below still finds the answer.
  const { value } = extractJson(response, { shapePredicate: isDetectionShape, skipInnerFence: true });
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
      startCommands: sanitizeStartCommands(detected.startCommands),
      pm2ProcessNames: sanitizePm2ProcessNames(detected.pm2ProcessNames, fallbackProcessName(context.dirName)),
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
