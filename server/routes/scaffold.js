import { Router } from 'express';
import { writeFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir, platform } from 'os';
import { createApp, getReservedPorts } from '../services/apps.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { ensureDir } from '../lib/fileUtils.js';
import { scaffoldVite } from './scaffoldVite.js';
import { scaffoldExpress } from './scaffoldExpress.js';
import { scaffoldIOS } from './scaffoldIOS.js';
import { scaffoldXcode } from './scaffoldXcode.js';
import { toTargetName } from '../services/xcodeScripts.js';
import { scaffoldPortOS } from './scaffoldPortOS.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

// GET /api/scaffold/directories - Browse directories for directory picker
router.get('/directories', asyncHandler(async (req, res) => {
  const { path: dirPath } = req.query;

  // Default to parent of PortOS project if no path provided
  const defaultPath = resolve(join(__dirname, '../../..'));
  const targetPath = dirPath === '~' ? homedir() : dirPath ? resolve(dirPath) : defaultPath;

  // Validate path exists and is a directory
  if (!existsSync(targetPath)) {
    throw new ServerError('Directory does not exist', {
      status: 400,
      code: 'INVALID_PATH'
    });
  }

  const stats = await stat(targetPath);
  if (!stats.isDirectory()) {
    throw new ServerError('Path is not a directory', {
      status: 400,
      code: 'NOT_A_DIRECTORY'
    });
  }

  // Read directory contents
  const entries = await readdir(targetPath, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({
      name: entry.name,
      path: join(targetPath, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Get parent directory info
  const parentPath = dirname(targetPath);
  const canGoUp = parentPath !== targetPath; // Can't go above root

  // On Windows, include available drive letters so users can navigate between drives
  let drives = null;
  if (platform() === 'win32') {
    // Only check common drive letters (C-Z) to avoid slow floppy/network drives (A-B)
    drives = [];
    for (let i = 67; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drivePath = `${letter}:${sep}`;
      try { if (existsSync(drivePath)) drives.push(drivePath); } catch { /* skip inaccessible drives */ }
    }
  }

  res.json({
    currentPath: targetPath,
    parentPath: canGoUp ? parentPath : null,
    directories,
    ...(drives && { drives })
  });
}));

// GET /api/scaffold/templates - List available templates
router.get('/templates', asyncHandler(async (req, res) => {
  const templates = [
    {
      id: 'portos-stack',
      name: 'PortOS Stack',
      description: 'Express + React + Vite with Tailwind, PM2, AI providers, and GitHub Actions CI/CD',
      type: 'portos-stack',
      icon: 'layers',
      builtIn: true,
      features: ['Express.js API', 'React + Vite frontend', 'Tailwind CSS', 'PM2 ecosystem', 'AI Provider Integration', 'GitHub Actions CI/CD', 'Collapsible nav layout'],
      ports: { ui: true, api: true }
    },
    {
      id: 'vite-express',
      name: 'Vite + Express',
      description: 'Full-stack with React frontend and Express API',
      type: 'vite+express',
      icon: 'code',
      features: ['React + Vite', 'Express.js API', 'CORS configured'],
      ports: { ui: true, api: true }
    },
    {
      id: 'vite-react',
      name: 'Vite + React',
      description: 'React app with Vite bundler',
      type: 'vite',
      icon: 'globe',
      features: ['React 18', 'Vite bundler', 'Fast HMR'],
      ports: { ui: true, api: false }
    },
    {
      id: 'express-api',
      name: 'Express API',
      description: 'Node.js Express API server',
      type: 'single-node-server',
      icon: 'server',
      features: ['Express.js', 'CORS', 'Health endpoint'],
      ports: { ui: false, api: true }
    },
    {
      id: 'ios-native',
      name: 'iOS Native App',
      description: 'SwiftUI + XcodeGen with TestFlight deploy script',
      type: 'ios-native',
      icon: 'smartphone',
      features: ['SwiftUI', 'SwiftData', 'XcodeGen', 'TestFlight CI/CD', 'On-device processing'],
      ports: { ui: false, api: false }
    },
    {
      id: 'xcode-multiplatform',
      name: 'Xcode Multi-Platform',
      description: 'SwiftUI app for iOS + macOS + watchOS with deploy & screenshot scripts',
      type: 'xcode',
      icon: 'monitor-smartphone',
      features: ['SwiftUI', 'iOS + macOS + watchOS', 'XcodeGen', 'TestFlight Deploy', 'Screenshot Automation', 'UI Tests'],
      ports: { ui: false, api: false }
    }
  ];

  res.json(templates);
}));

// POST /api/scaffold/templates/create - User-friendly template creation
router.post('/templates/create', asyncHandler(async (req, res) => {
  const { templateId, name, targetPath } = req.body;

  if (!templateId || !name || !targetPath) {
    throw new ServerError('templateId, name, and targetPath are required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  // Map to scaffold endpoint format
  const scaffoldData = {
    name,
    template: templateId,
    parentDir: targetPath
  };

  // Reuse scaffold logic
  req.body = scaffoldData;
  // Forward to scaffold endpoint logic (call the same handler)
  return scaffoldApp(req, res);
}));

/**
 * Find the next available ports starting from USER_APP_PORT_START
 * Returns { apiPort, uiPort } for the next contiguous pair
 */
const USER_APP_PORT_START = 5570;
const USER_APP_PORT_END = 5599;

async function findNextAvailablePorts(needsApi, needsUi) {
  const reservedPorts = await getReservedPorts();
  const reserved = new Set(reservedPorts);

  let apiPort = null;
  let uiPort = null;

  for (let port = USER_APP_PORT_START; port <= USER_APP_PORT_END; port++) {
    if (reserved.has(port)) continue;

    if (needsApi && !apiPort) {
      apiPort = port;
      reserved.add(port);
    } else if (needsUi && !uiPort) {
      uiPort = port;
      reserved.add(port);
    }

    if ((!needsApi || apiPort) && (!needsUi || uiPort)) break;
  }

  return { apiPort, uiPort };
}

// Shared scaffold logic
async function scaffoldApp(req, res) {
  let {
    name,
    template,
    parentDir,
    uiPort,
    apiPort,
    createGitHubRepo = false,
    githubOrg = null
  } = req.body;

  // Validation
  if (!name || !template || !parentDir) {
    throw new ServerError('name, template, and parentDir are required', {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }

  // Auto-allocate ports if not provided
  const templateNeedsPorts = {
    'portos-stack': { api: true, ui: true },
    'vite-express': { api: true, ui: true },
    'vite-react': { api: false, ui: true },
    'express-api': { api: true, ui: false },
    'ios-native': { api: false, ui: false },
    'xcode-multiplatform': { api: false, ui: false }
  };

  const needs = templateNeedsPorts[template] || { api: false, ui: false };
  if ((needs.api && !apiPort) || (needs.ui && !uiPort)) {
    const allocated = await findNextAvailablePorts(needs.api && !apiPort, needs.ui && !uiPort);
    if (needs.api && !apiPort) apiPort = allocated.apiPort;
    if (needs.ui && !uiPort) uiPort = allocated.uiPort;
  }

  // Sanitize name for directory
  const dirName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const repoPath = join(parentDir, dirName);

  // Check parent exists
  if (!existsSync(parentDir)) {
    throw new ServerError('Parent directory does not exist', {
      status: 400,
      code: 'INVALID_PARENT'
    });
  }

  // Check target doesn't exist
  if (existsSync(repoPath)) {
    throw new ServerError('Directory already exists', {
      status: 400,
      code: 'DIR_EXISTS'
    });
  }

  const steps = [];
  const addStep = (name, status, error = null) => {
    steps.push({ name, status, error, timestamp: Date.now() });
  };

  // Create directory
  await ensureDir(repoPath);
  addStep('Create directory', 'done');

  // Generate project files based on template
  if (template === 'vite-react' || template === 'vite-express') {
    await scaffoldVite(repoPath, dirName, parentDir, template, uiPort, apiPort, addStep);
  } else if (template === 'express-api') {
    await scaffoldExpress(repoPath, dirName, apiPort, addStep);
  } else if (template === 'ios-native') {
    await scaffoldIOS(repoPath, name, dirName, addStep);
  } else if (template === 'xcode-multiplatform') {
    await scaffoldXcode(repoPath, name, dirName, addStep);
  } else if (template === 'portos-stack') {
    await scaffoldPortOS(repoPath, name, dirName, uiPort, apiPort, addStep);
  }

  // Create .env file
  const envContent = [
    uiPort && `VITE_PORT=${uiPort}`,
    apiPort && `PORT=${apiPort}`
  ].filter(Boolean).join('\n');

  if (envContent) {
    await writeFile(join(repoPath, '.env'), envContent + '\n');
    addStep('Create .env', 'done');
  }

  // Create PM2 ecosystem file with proper PORTS constant pattern
  let ecosystemContent;

  if (template === 'portos-stack') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort},    // Express API server
  UI: ${uiPort}       // Vite dev server (client)
};

module.exports = {
  PORTS, // Export for other configs to reference

  apps: [
    {
      name: '${dirName}-server',
      script: 'server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'development',
        PORT: PORTS.API,
        HOST: '0.0.0.0'
      },
      watch: false
    },
    {
      name: '${dirName}-ui',
      script: 'node_modules/.bin/vite',
      cwd: \`\${__dirname}/client\`,
      args: \`--host 0.0.0.0 --port \${PORTS.UI}\`,
      env: {
        NODE_ENV: 'development',
        VITE_PORT: PORTS.UI
      },
      watch: false
    }
  ]
};
`;
  } else if (template === 'vite-express') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort},    // Express API server
  UI: ${uiPort}       // Vite dev server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}-ui',
      script: 'npm',
      args: 'run dev',
      cwd: __dirname,
      env: {
        VITE_PORT: PORTS.UI
      }
    },
    {
      name: '${dirName}-api',
      script: 'server/index.js',
      cwd: __dirname,
      env: {
        PORT: PORTS.API
      }
    }
  ]
};
`;
  } else if (template === 'vite-react') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  UI: ${uiPort}       // Vite dev server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}',
      script: 'npm',
      args: 'run dev',
      cwd: __dirname,
      env: {
        VITE_PORT: PORTS.UI
      }
    }
  ]
};
`;
  } else if (template === 'express-api') {
    ecosystemContent = `// =============================================================================
// Port Configuration - All ports defined here as single source of truth
// =============================================================================
const PORTS = {
  API: ${apiPort}     // Express API server
};

module.exports = {
  PORTS,

  apps: [
    {
      name: '${dirName}',
      script: 'index.js',
      cwd: __dirname,
      env: {
        PORT: PORTS.API
      }
    }
  ]
};
`;
  }

  if (ecosystemContent) {
    await writeFile(join(repoPath, 'ecosystem.config.cjs'), ecosystemContent);
    addStep('Create PM2 config', 'done');
  }

  // Run npm install (skip for Xcode projects — no npm)
  if (template !== 'ios-native' && template !== 'xcode-multiplatform') {
    const installCmd = template === 'portos-stack' ? 'npm run install:all' : 'npm install';
    const { stderr: installErr } = await execAsync(installCmd, { cwd: repoPath, windowsHide: true })
      .catch(err => ({ stderr: err.message }));

    if (installErr && !installErr.includes('npm warn')) {
      addStep('npm install', 'error', installErr);
    } else {
      addStep('npm install', 'done');
    }
  }

  // Initialize git
  await execAsync('git init', { cwd: repoPath, windowsHide: true });

  // Create .gitignore
  let gitignoreContent;
  if (template === 'ios-native' || template === 'xcode-multiplatform') {
    gitignoreContent = `# Build output
build/
.build/
DerivedData/

# Environment files
.env

# Screenshots config (generated by take_screenshots.sh)
.screenshot_config.json

# OS files
.DS_Store

# IDE
*.swp
*.swo
xcuserdata/
*.xcworkspace
`;
  } else if (template === 'portos-stack') {
    gitignoreContent = `# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local
.env.*.local

# Logs
logs/
*.log
npm-debug.log*

# OS files
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
*.swo

# PM2
.pm2/
`;
  } else {
    gitignoreContent = 'node_modules\n.env\ndist\n';
  }

  await writeFile(join(repoPath, '.gitignore'), gitignoreContent);
  // Use spawn with shell:false to avoid shell injection
  const spawnGit = (args) => new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd: repoPath, shell: false, windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`)));
    proc.on('error', reject);
  });
  await spawnGit(['add', '-A']);
  await spawnGit(['commit', '-m', 'Initial commit']);
  addStep('Initialize git', 'done');

  // Create GitHub repo if requested
  if (createGitHubRepo) {
    // Security: Use spawn with array args to prevent shell injection from githubOrg/dirName
    const repoName = githubOrg ? `${githubOrg}/${dirName}` : dirName;
    const ghArgs = ['repo', 'create', repoName, '--source=.', '--push', '--private'];

    const { stderr: ghErr } = await new Promise((resolve) => {
      const child = spawn('gh', ghArgs, { cwd: repoPath, shell: false, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('close', () => resolve({ stderr }));
      child.on('error', (err) => resolve({ stderr: err.message }));
    });

    if (ghErr && !ghErr.includes('Created repository')) {
      addStep('Create GitHub repo', 'error', ghErr);
    } else {
      addStep('Create GitHub repo', 'done');
    }
  }

  // Register in PortOS
  const templateToType = {
    'portos-stack': 'portos-stack',
    'vite-react': 'vite',
    'vite-express': 'vite+express',
    'express-api': 'single-node-server',
    'ios-native': 'ios-native',
    'xcode-multiplatform': 'xcode'
  };

  let pm2Names;
  let startCmds;
  let buildCmd;

  if (template === 'portos-stack') {
    pm2Names = [`${dirName}-server`, `${dirName}-ui`];
    startCmds = ['npm run dev'];
  } else if (template === 'vite-express') {
    pm2Names = [`${dirName}-ui`, `${dirName}-api`];
    startCmds = ['npm run dev:all'];
  } else if (template === 'ios-native') {
    const tn = toTargetName(name);
    pm2Names = [];
    startCmds = [`open ${tn}.xcodeproj`];
    buildCmd = `xcodebuild build -project ${tn}.xcodeproj -scheme ${tn} -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO`;
  } else if (template === 'xcode-multiplatform') {
    const tn = toTargetName(name);
    pm2Names = [];
    startCmds = [`open ${tn}.xcodeproj`];
    buildCmd = `xcodebuild build -project ${tn}.xcodeproj -scheme ${tn} -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO`;
  } else {
    pm2Names = [dirName];
    startCmds = ['npm run dev'];
  }

  const app = await createApp({
    name,
    repoPath,
    type: templateToType[template] || 'unknown',
    uiPort: uiPort || null,
    apiPort: apiPort || null,
    buildCommand: buildCmd,
    startCommands: startCmds,
    pm2ProcessNames: pm2Names,
    envFile: '.env'
  });

  addStep('Register in PortOS', 'done');

  res.json({
    success: true,
    app,
    repoPath,
    steps
  });
}

// POST /api/scaffold - Create a new app from template
router.post('/', asyncHandler(scaffoldApp));

export default router;
