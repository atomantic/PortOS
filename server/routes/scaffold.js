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

  // Map portos-stack to template name used in scaffoldApp
  if (templateId === 'portos-stack') {
    scaffoldData.template = 'portos-stack';
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
    // Security: Use spawn with array args instead of execAsync to prevent shell injection
    const { stderr } = await new Promise((resolve) => {
      const child = spawn('npm', ['create', 'vite@latest', dirName, '--', '--template', 'react'], {
        cwd: parentDir,
        shell: false
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });
      child.on('close', () => resolve({ stderr }));
      child.on('error', (err) => resolve({ stderr: err.message }));
    });

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
  } else if (template === 'portos-stack') {
    // Create PortOS Stack - full monorepo with client, server, Tailwind, CI/CD
    const clientDir = join(repoPath, 'client');
    const serverDir = join(repoPath, 'server');
    const workflowsDir = join(repoPath, '.github/workflows');

    await mkdir(clientDir, { recursive: true });
    await mkdir(serverDir, { recursive: true });
    await mkdir(workflowsDir, { recursive: true });

    // === Root package.json ===
    const rootPkg = {
      name: dirName,
      version: '0.1.0',
      private: true,
      description: `${name} - built with PortOS Stack`,
      type: 'module',
      scripts: {
        'dev': 'concurrently "npm run dev:server" "npm run dev:client"',
        'dev:server': 'cd server && npm run dev',
        'dev:client': 'cd client && npm run dev',
        'build': 'cd client && npm run build',
        'start': 'cd server && npm start',
        'install:all': 'npm install && cd client && npm install && cd ../server && npm install',
        'test': 'cd server && npm test'
      },
      devDependencies: {
        'concurrently': '^8.2.2'
      }
    };
    await writeFile(join(repoPath, 'package.json'), JSON.stringify(rootPkg, null, 2));

    // === Client package.json ===
    const clientPkg = {
      name: `${dirName}-client`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        'dev': `vite --host 0.0.0.0 --port ${uiPort || 3000}`,
        'build': 'vite build',
        'preview': 'vite preview'
      },
      dependencies: {
        'lucide-react': '^0.562.0',
        'react': '^18.3.1',
        'react-dom': '^18.3.1',
        'react-hot-toast': '^2.6.0',
        'react-router-dom': '^7.1.1',
        'socket.io-client': '^4.8.3'
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        'autoprefixer': '^10.4.20',
        'postcss': '^8.4.49',
        'tailwindcss': '^3.4.17',
        'vite': '^6.0.6'
      }
    };
    await writeFile(join(clientDir, 'package.json'), JSON.stringify(clientPkg, null, 2));

    // === Client vite.config.js ===
    await writeFile(join(clientDir, 'vite.config.js'), `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: ${uiPort || 3000},
    proxy: {
      '/api': {
        target: 'http://localhost:${apiPort || 3001}',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:${apiPort || 3001}',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
`);

    // === Client tailwind.config.js ===
    await writeFile(join(clientDir, 'tailwind.config.js'), `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'app-bg': '#0f0f0f',
        'app-card': '#1a1a1a',
        'app-border': '#2a2a2a',
        'app-accent': '#3b82f6',
        'app-success': '#22c55e',
        'app-warning': '#f59e0b',
        'app-error': '#ef4444'
      }
    },
  },
  plugins: [],
}
`);

    // === Client postcss.config.js ===
    await writeFile(join(clientDir, 'postcss.config.js'), `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`);

    // === Client index.html ===
    await writeFile(join(clientDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`);

    // === Client src files ===
    const clientSrcDir = join(clientDir, 'src');
    await mkdir(clientSrcDir, { recursive: true });

    await writeFile(join(clientSrcDir, 'main.jsx'), `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster position="bottom-right" />
    </BrowserRouter>
  </React.StrictMode>
);
`);

    await writeFile(join(clientSrcDir, 'App.jsx'), `import { Routes, Route, Link } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';

function Home() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Welcome to ${name}</h1>
      <p className="text-gray-400">Built with PortOS Stack</p>
    </div>
  );
}

function About() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">About</h1>
      <p className="text-gray-400">Express + React + Vite + Tailwind</p>
    </div>
  );
}

export default function App() {
  const [navOpen, setNavOpen] = useState(true);

  return (
    <div className="flex min-h-screen bg-app-bg text-white">
      {/* Collapsible sidebar */}
      <nav className={\`\${navOpen ? 'w-48' : 'w-12'} bg-app-card border-r border-app-border transition-all duration-200 flex flex-col\`}>
        <button
          onClick={() => setNavOpen(!navOpen)}
          className="p-3 hover:bg-app-border"
        >
          {navOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        {navOpen && (
          <div className="flex flex-col gap-1 p-2">
            <Link to="/" className="p-2 rounded hover:bg-app-border">Home</Link>
            <Link to="/about" className="p-2 rounded hover:bg-app-border">About</Link>
          </div>
        )}
      </nav>

      {/* Main content */}
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
        </Routes>
      </main>
    </div>
  );
}
`);

    await writeFile(join(clientSrcDir, 'index.css'), `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
`);

    addStep('Create client', 'done');

    // === Server package.json ===
    const serverPkg = {
      name: `${dirName}-server`,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        'dev': 'node --watch index.js',
        'start': 'node index.js',
        'test': 'vitest run',
        'test:watch': 'vitest'
      },
      dependencies: {
        'cors': '^2.8.5',
        'express': '^4.21.2',
        'socket.io': '^4.8.3',
        'zod': '^3.24.1'
      },
      devDependencies: {
        'vitest': '^2.1.8'
      }
    };
    await writeFile(join(serverDir, 'package.json'), JSON.stringify(serverPkg, null, 2));

    // === Server index.js ===
    await writeFile(join(serverDir, 'index.js'), `import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || ${apiPort || 3001};

app.use(cors());
app.use(express.json());

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log(\`🔌 Client connected: \${socket.id}\`);
  socket.on('disconnect', () => {
    console.log(\`🔌 Client disconnected: \${socket.id}\`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(\`🚀 Server running on port \${PORT}\`);
});
`);

    // === Server vitest.config.js ===
    await writeFile(join(serverDir, 'vitest.config.js'), `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node'
  }
});
`);

    addStep('Create server', 'done');

    // === GitHub Actions CI ===
    await writeFile(join(workflowsDir, 'ci.yml'), `name: CI

on:
  pull_request:
    branches: [main, dev]
  push:
    branches: [dev]

permissions:
  contents: write

jobs:
  test:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    strategy:
      matrix:
        node-version: [20.x]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install root dependencies
        run: npm ci

      - name: Install client dependencies
        working-directory: ./client
        run: npm ci

      - name: Install server dependencies
        working-directory: ./server
        run: npm ci

      - name: Run server tests
        working-directory: ./server
        run: npm test

      - name: Build client
        working-directory: ./client
        run: npm run build

  bump-build:
    runs-on: ubuntu-latest
    needs: [test]
    if: github.event_name == 'push' && github.ref == 'refs/heads/dev' && !contains(github.event.head_commit.message, '[skip ci]')

    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump patch version
        run: |
          CURRENT_VERSION=\$(node -p "require('./package.json').version")
          MAJOR=\$(echo \$CURRENT_VERSION | cut -d. -f1)
          MINOR=\$(echo \$CURRENT_VERSION | cut -d. -f2)
          PATCH=\$(echo \$CURRENT_VERSION | cut -d. -f3)
          NEW_PATCH=\$((PATCH + 1))
          NEW_VERSION="\$MAJOR.\$MINOR.\$NEW_PATCH"
          npm version \$NEW_VERSION --no-git-tag-version
          cd client && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          cd server && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          git add package.json package-lock.json client/package.json server/package.json
          git commit -m "build: bump version to \$NEW_VERSION [skip ci]"
          git push
`);

    // === GitHub Actions Release ===
    await writeFile(join(workflowsDir, 'release.yml'), `name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Use Node.js 20.x
        uses: actions/setup-node@v4
        with:
          node-version: 20.x

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Get version from package.json
        id: package-version
        run: echo "version=\$(node -p \\"require('./package.json').version\\")" >> \$GITHUB_OUTPUT

      - name: Check if tag exists
        id: tag-check
        run: |
          if git rev-parse "v\${{ steps.package-version.outputs.version }}" >/dev/null 2>&1; then
            echo "exists=true" >> \$GITHUB_OUTPUT
          else
            echo "exists=false" >> \$GITHUB_OUTPUT
          fi

      - name: Generate changelog
        id: changelog
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          PREV_TAG=\$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
          CHANGELOG=\$(git log \$PREV_TAG..HEAD --pretty=format:"- %s" --no-merges | grep -v "\\[skip ci\\]" | head -50)
          echo "changelog<<EOF" >> \$GITHUB_OUTPUT
          echo "\$CHANGELOG" >> \$GITHUB_OUTPUT
          echo "EOF" >> \$GITHUB_OUTPUT

      - name: Create Release
        if: steps.tag-check.outputs.exists == 'false'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v\${{ steps.package-version.outputs.version }}
          name: v\${{ steps.package-version.outputs.version }}
          body: |
            ## Changes

            \${{ steps.changelog.outputs.changelog }}
          draft: false
          prerelease: false
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

      - name: Prep dev branch for next release
        if: steps.tag-check.outputs.exists == 'false'
        run: |
          CURRENT_VERSION=\${{ steps.package-version.outputs.version }}
          MAJOR=\$(echo \$CURRENT_VERSION | cut -d. -f1)
          MINOR=\$(echo \$CURRENT_VERSION | cut -d. -f2)
          NEW_MINOR=\$((MINOR + 1))
          NEW_VERSION="\$MAJOR.\$NEW_MINOR.0"
          git fetch origin dev
          git checkout dev
          npm version \$NEW_VERSION --no-git-tag-version
          cd client && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          cd server && npm version \$NEW_VERSION --no-git-tag-version && cd ..
          git add package.json package-lock.json client/package.json server/package.json
          git commit -m "build: prep v\$NEW_VERSION for next release [skip ci]"
          git push origin dev
`);

    addStep('Create GitHub Actions', 'done');

    // === CLAUDE.md ===
    await writeFile(join(repoPath, 'CLAUDE.md'), `# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

\`\`\`bash
# Install all dependencies
npm run install:all

# Development (both server and client)
npm run dev

# Run tests
cd server && npm test

# Production
pm2 start ecosystem.config.cjs
\`\`\`

## Architecture

${name} is a monorepo with Express.js server (port ${apiPort || 3001}) and React/Vite client (port ${uiPort || 3000}). PM2 manages app lifecycles.

### Server (\`server/\`)
- **index.js**: Express server with Socket.IO

### Client (\`client/src/\`)
- **App.jsx**: Main component with routing and collapsible nav
- **main.jsx**: React entry point

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware
- **Functional programming** - no classes, use hooks in React
- **Single-line logging** - use emoji prefixes

## Git Workflow

- **dev**: Active development (auto-bumps patch on CI pass)
- **main**: Production releases only
`);

    // === README.md ===
    await writeFile(join(repoPath, 'README.md'), `# ${name}

Built with PortOS Stack.

## Quick Start

\`\`\`bash
npm run install:all
npm run dev
\`\`\`

## Architecture

- **Client**: React + Vite + Tailwind (port ${uiPort || 3000})
- **Server**: Express + Socket.IO (port ${apiPort || 3001})
- **PM2**: Process management
- **CI/CD**: GitHub Actions

## Scripts

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start both client and server |
| \`npm run build\` | Build client for production |
| \`npm test\` | Run server tests |
`);

    addStep('Create documentation', 'done');
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

  if (template === 'portos-stack') {
    pm2Config.apps.push(
      {
        name: `${dirName}-server`,
        script: 'server/index.js',
        cwd: repoPath,
        interpreter: 'node',
        ports: { api: apiPort || 3001 },
        env: {
          NODE_ENV: 'development',
          PORT: apiPort || 3001,
          HOST: '0.0.0.0'
        },
        watch: false
      },
      {
        name: `${dirName}-client`,
        script: 'node_modules/.bin/vite',
        cwd: `${repoPath}/client`,
        args: `--host 0.0.0.0 --port ${uiPort || 3000}`,
        ports: { ui: uiPort || 3000 },
        env: {
          NODE_ENV: 'development'
        },
        watch: false
      }
    );
  } else if (template === 'vite-express') {
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
  } else if (template === 'express-api') {
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
  const installCmd = template === 'portos-stack' ? 'npm run install:all' : 'npm install';
  const { stderr: installErr } = await execAsync(installCmd, { cwd: repoPath })
    .catch(err => ({ stderr: err.message }));

  if (installErr && !installErr.includes('npm warn')) {
    addStep('npm install', 'error', installErr);
  } else {
    addStep('npm install', 'done');
  }

  // Initialize git
  await execAsync('git init', { cwd: repoPath });

  // Create .gitignore - more comprehensive for portos-stack
  const gitignoreContent = template === 'portos-stack'
    ? `# Dependencies
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
`
    : 'node_modules\n.env\ndist\n';

  await writeFile(join(repoPath, '.gitignore'), gitignoreContent);
  await execAsync('git add -A', { cwd: repoPath });
  await execAsync('git commit -m "Initial commit"', { cwd: repoPath });
  addStep('Initialize git', 'done');

  // Create GitHub repo if requested
  if (createGitHubRepo) {
    // Security: Use spawn with array args to prevent shell injection from githubOrg/dirName
    const repoName = githubOrg ? `${githubOrg}/${dirName}` : dirName;
    const ghArgs = ['repo', 'create', repoName, '--source=.', '--push', '--private'];

    const { stderr: ghErr } = await new Promise((resolve) => {
      const child = spawn('gh', ghArgs, { cwd: repoPath, shell: false });
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
    'express-api': 'single-node-server'
  };

  let pm2Names;
  let startCmds;

  if (template === 'portos-stack') {
    pm2Names = [`${dirName}-server`, `${dirName}-client`];
    startCmds = ['npm run dev:server', 'npm run dev:client'];
  } else if (template === 'vite-express') {
    pm2Names = [`${dirName}-ui`, `${dirName}-api`];
    startCmds = ['npm run dev', 'npm run server'];
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
