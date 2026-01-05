import { Router } from 'express';
import { mkdir, writeFile, readdir, copyFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createApp } from '../services/apps.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '../../templates');

const router = Router();

// GET /api/templates - List available templates
router.get('/templates', asyncHandler(async (req, res) => {
  const templates = [
    {
      id: 'portos-stack',
      name: 'PortOS Stack',
      description: 'Express + React + Vite with Tailwind, PM2, and GitHub Actions CI/CD',
      type: 'portos-stack',
      icon: 'layers',
      builtIn: true,
      features: ['Express.js API', 'React + Vite frontend', 'Tailwind CSS', 'PM2 ecosystem', 'GitHub Actions CI/CD', 'Collapsible nav layout'],
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
    }
  ];

  res.json(templates);
}));

// POST /api/templates/create - User-friendly template creation
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

  // For portos-stack, we need to handle it specially (not implemented yet)
  if (templateId === 'portos-stack') {
    throw new ServerError('PortOS Stack template scaffolding is not yet implemented. Please use vite-express for a similar full-stack setup.', {
      status: 501,
      code: 'NOT_IMPLEMENTED'
    });
  }

  // Reuse scaffold logic
  req.body = scaffoldData;
  // Forward to scaffold endpoint logic (call the same handler)
  return scaffoldApp(req, res);
}));

// Shared scaffold logic
async function scaffoldApp(req, res) {
  const {
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
  await mkdir(repoPath, { recursive: true });
  addStep('Create directory', 'done');

  // Generate project files based on template
  if (template === 'vite-react' || template === 'vite-express') {
    // Create using npm create vite
    const { stderr } = await execAsync(
      `npm create vite@latest ${dirName} -- --template react`,
      { cwd: parentDir }
    ).catch(err => ({ stderr: err.message }));

    if (stderr && !stderr.includes('npm warn')) {
      addStep('Create Vite project', 'error', stderr);
    } else {
      addStep('Create Vite project', 'done');
    }

    // Update vite.config.js with port
    if (uiPort) {
      const viteConfigPath = join(repoPath, 'vite.config.js');
      if (existsSync(viteConfigPath)) {
        let config = await readFile(viteConfigPath, 'utf-8');
        config = config.replace(
          'plugins: [react()]',
          `plugins: [react()],\n  server: {\n    host: '0.0.0.0',\n    port: ${uiPort}\n  }`
        );
        await writeFile(viteConfigPath, config);
      }
    }

    // Add Express server if vite-express template
    if (template === 'vite-express') {
      const serverDir = join(repoPath, 'server');
      await mkdir(serverDir, { recursive: true });

      await writeFile(join(serverDir, 'index.js'), `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3001};

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`Server running on port \${PORT}\`);
});
`);

      // Update package.json to add express and server script
      const pkgPath = join(repoPath, 'package.json');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies.express = '^4.21.2';
      pkg.dependencies.cors = '^2.8.5';
      pkg.scripts['server'] = 'node server/index.js';
      pkg.scripts['dev:all'] = 'concurrently "npm run dev" "npm run server"';
      pkg.devDependencies = pkg.devDependencies || {};
      pkg.devDependencies.concurrently = '^8.2.2';
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

      addStep('Add Express server', 'done');
    }
  } else if (template === 'express-api') {
    // Create Express-only project
    const pkg = {
      name: dirName,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'node --watch index.js',
        start: 'node index.js'
      },
      dependencies: {
        express: '^4.21.2',
        cors: '^2.8.5'
      }
    };
    await writeFile(join(repoPath, 'package.json'), JSON.stringify(pkg, null, 2));

    await writeFile(join(repoPath, 'index.js'), `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3000};

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`API server running on port \${PORT}\`);
});
`);

    addStep('Create Express project', 'done');
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

  // Create PM2 ecosystem file
  const pm2Config = {
    apps: []
  };

  if (template === 'vite-express') {
    pm2Config.apps.push(
      {
        name: `${dirName}-ui`,
        script: 'npm',
        args: 'run dev',
        cwd: repoPath
      },
      {
        name: `${dirName}-api`,
        script: 'server/index.js',
        cwd: repoPath
      }
    );
  } else if (template === 'vite-react') {
    pm2Config.apps.push({
      name: dirName,
      script: 'npm',
      args: 'run dev',
      cwd: repoPath
    });
  } else {
    pm2Config.apps.push({
      name: dirName,
      script: 'index.js',
      cwd: repoPath
    });
  }

  await writeFile(
    join(repoPath, 'ecosystem.config.cjs'),
    `module.exports = ${JSON.stringify(pm2Config, null, 2)};\n`
  );
  addStep('Create PM2 config', 'done');

  // Run npm install
  const { stderr: installErr } = await execAsync('npm install', { cwd: repoPath })
    .catch(err => ({ stderr: err.message }));

  if (installErr && !installErr.includes('npm warn')) {
    addStep('npm install', 'error', installErr);
  } else {
    addStep('npm install', 'done');
  }

  // Initialize git
  await execAsync('git init', { cwd: repoPath });
  await writeFile(join(repoPath, '.gitignore'), 'node_modules\n.env\ndist\n');
  await execAsync('git add -A', { cwd: repoPath });
  await execAsync('git commit -m "Initial commit"', { cwd: repoPath });
  addStep('Initialize git', 'done');

  // Create GitHub repo if requested
  if (createGitHubRepo) {
    const ghArgs = githubOrg
      ? `repo create ${githubOrg}/${dirName} --source=. --push --private`
      : `repo create ${dirName} --source=. --push --private`;

    const { stderr: ghErr } = await execAsync(`gh ${ghArgs}`, { cwd: repoPath })
      .catch(err => ({ stderr: err.message }));

    if (ghErr && !ghErr.includes('Created repository')) {
      addStep('Create GitHub repo', 'error', ghErr);
    } else {
      addStep('Create GitHub repo', 'done');
    }
  }

  // Register in PortOS
  const templateToType = {
    'vite-react': 'vite',
    'vite-express': 'vite+express',
    'express-api': 'single-node-server'
  };

  const pm2Names = template === 'vite-express'
    ? [`${dirName}-ui`, `${dirName}-api`]
    : [dirName];

  const startCmds = template === 'vite-express'
    ? ['npm run dev', 'npm run server']
    : template === 'express-api'
      ? ['npm run dev']
      : ['npm run dev'];

  const app = await createApp({
    name,
    repoPath,
    type: templateToType[template] || 'unknown',
    uiPort: uiPort || null,
    apiPort: apiPort || null,
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
