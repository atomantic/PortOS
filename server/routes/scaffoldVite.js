import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from '../lib/childProcess.js';
import { atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { CORS_SNIPPET } from '../lib/scaffoldSnippets.js';

const CREATE_VITE_TIMEOUT_MS = 5 * 60 * 1000;

export async function scaffoldVite({ repoPath, dirName, parentDir, template, uiPort, apiPort, addStep }) {
  // Create using npm create vite
  // Security: Use spawn with array args instead of execAsync to prevent shell injection
  // Non-interactive (--yes, stdin closed) and bounded so an npx prompt or a
  // stalled registry can't hang the request; failure aborts before we touch
  // files that were never created.
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn('npm', ['create', '--yes', 'vite@latest', dirName, '--', '--template', 'react'], {
      cwd: parentDir,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CREATE_VITE_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stderr }));
    child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
  });

  if (code !== 0) {
    const detail = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`;
    addStep('Create Vite project', 'error', stderr || detail);
    throw new ServerError(`Failed to create Vite project: ${detail}`, { status: 500, code: 'SCAFFOLD_FAILED' });
  }
  addStep('Create Vite project', 'done');

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
    await ensureDir(serverDir);

    await writeFile(join(serverDir, 'index.js'), `import express from 'express';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3001};

${CORS_SNIPPET}
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
    const pkgContent = await readFile(pkgPath, 'utf-8');
    const pkg = safeJSONParse(pkgContent, { dependencies: {}, devDependencies: {}, scripts: {} });
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies.express = '^4.21.2';
    pkg.scripts['server'] = 'node server/index.js';
    pkg.scripts['dev:all'] = 'concurrently "npm run dev" "npm run server"';
    pkg.devDependencies = pkg.devDependencies || {};
    pkg.devDependencies.concurrently = '^8.2.2';
    await atomicWrite(pkgPath, pkg);

    addStep('Add Express server', 'done');
  }
}
