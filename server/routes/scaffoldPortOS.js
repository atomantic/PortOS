import { writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, ensureDirs } from '../lib/fileUtils.js';

// Inline CORS middleware snippet for generated projects (no cors package dependency)
const CORS_SNIPPET = `app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});`;

export async function scaffoldPortOS(repoPath, name, dirName, uiPort, apiPort, addStep) {
  const clientDir = join(repoPath, 'client');
  const serverDir = join(repoPath, 'server');
  const workflowsDir = join(repoPath, '.github/workflows');

  await ensureDirs([clientDir, serverDir, workflowsDir]);

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
    name: `${dirName}-ui`,
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
      'portos-ai-toolkit': '^0.1.0',
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
  await ensureDir(clientSrcDir);

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
import { Menu, X, Home, Brain, Info } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import AIProviders from './pages/AIProviders';

function HomePage() {
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
      <p className="text-gray-400">Express + React + Vite + Tailwind + AI Provider Integration</p>
    </div>
  );
}

export default function App() {
  const [navOpen, setNavOpen] = useState(true);
  const location = useLocation();

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
        <div className="flex flex-col gap-1 p-2">
          <Link to="/" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Home size={18} />
            {navOpen && <span>Home</span>}
          </Link>
          <Link to="/providers" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/providers' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Brain size={18} />
            {navOpen && <span>AI Providers</span>}
          </Link>
          <Link to="/about" className={\`flex items-center gap-2 p-2 rounded hover:bg-app-border \${location.pathname === '/about' ? 'bg-app-accent/20 text-app-accent' : ''}\`}>
            <Info size={18} />
            {navOpen && <span>About</span>}
          </Link>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/providers" element={<AIProviders />} />
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

  // === Client pages ===
  const pagesDir = join(clientSrcDir, 'pages');
  await ensureDir(pagesDir);

  // AIProviders page - uses shared component from ai-toolkit
  await writeFile(join(pagesDir, 'AIProviders.jsx'), `import { AIProviders } from 'portos-ai-toolkit/client';
import toast from 'react-hot-toast';

export default function AIProvidersPage() {
  return <AIProviders onError={toast.error} colorPrefix="app" />;
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
      'express': '^4.21.2',
      'portos-ai-toolkit': '^0.1.0',
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
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createAIToolkit } from 'portos-ai-toolkit/server';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || ${apiPort || 3001};

${CORS_SNIPPET}
app.use(express.json());

// Initialize AI Toolkit with routes for providers, runs, and prompts
const aiToolkit = createAIToolkit({
  dataDir: './data',
  io
});
aiToolkit.mountRoutes(app);

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

  // === Default Data (providers, etc.) ===
  const dataDir = join(repoPath, 'data');
  await ensureDir(dataDir);

  const defaultProviders = {
    activeProvider: 'claude-code',
    providers: {
      'claude-code': {
        id: 'claude-code',
        name: 'Claude Code CLI',
        type: 'cli',
        command: 'claude',
        args: ['--print'],
        models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'],
        defaultModel: 'claude-sonnet-4-5-20250929',
        lightModel: 'claude-haiku-4-5-20251001',
        mediumModel: 'claude-sonnet-4-5-20250929',
        heavyModel: 'claude-opus-4-5-20251101',
        timeout: 300000,
        enabled: true,
        envVars: {}
      },
      'codex': {
        id: 'codex',
        name: 'Codex CLI',
        type: 'cli',
        command: 'codex',
        args: [],
        models: ['gpt-5', 'gpt-5-codex'],
        defaultModel: 'gpt-5-codex',
        lightModel: 'gpt-5',
        mediumModel: 'gpt-5-codex',
        heavyModel: 'gpt-5-codex',
        timeout: 300000,
        enabled: true,
        envVars: {}
      },
      'lm-studio': {
        id: 'lm-studio',
        name: 'LM Studio (Local)',
        type: 'api',
        endpoint: 'http://localhost:1234/v1',
        apiKey: 'lm-studio',
        models: [],
        defaultModel: null,
        timeout: 300000,
        enabled: false,
        envVars: {}
      },
      'ollama': {
        id: 'ollama',
        name: 'Ollama (Local)',
        type: 'api',
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        models: [],
        defaultModel: null,
        timeout: 300000,
        enabled: false,
        envVars: {}
      }
    }
  };
  await writeFile(join(dataDir, 'providers.json'), JSON.stringify(defaultProviders, null, 2));
  addStep('Create default data', 'done');

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
- **index.js**: Express server with Socket.IO and AI toolkit integration

### Client (\`client/src/\`)
- **App.jsx**: Main component with routing and collapsible nav
- **main.jsx**: React entry point

### AI Provider Integration

This project includes \`portos-ai-toolkit\` for AI provider management. The server exposes:
- \`GET/POST /api/providers\` - Manage AI providers (CLI or API-based)
- \`GET/POST /api/runs\` - Execute and track AI runs
- \`GET/POST /api/prompts\` - Manage prompt templates

Provider data is stored in \`./data/providers.json\`.

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
- **AI**: portos-ai-toolkit for provider management
- **PM2**: Process management
- **CI/CD**: GitHub Actions

## API Endpoints

- \`GET /api/health\` - Health check
- \`GET/POST /api/providers\` - AI provider management
- \`GET/POST /api/runs\` - AI execution runs
- \`GET/POST /api/prompts\` - Prompt templates

## Scripts

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start both client and server |
| \`npm run build\` | Build client for production |
| \`npm test\` | Run server tests |
`);

  addStep('Create documentation', 'done');
}
