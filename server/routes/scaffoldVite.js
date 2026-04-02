import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { ensureDir } from '../lib/fileUtils.js';
import { safeJSONParse } from '../lib/fileUtils.js';

// Inline CORS middleware snippet for generated projects (no cors package dependency)
const CORS_SNIPPET = `app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});`;

export async function scaffoldVite(repoPath, dirName, parentDir, template, uiPort, apiPort, addStep) {
  // Create using npm create vite
  // Security: Use spawn with array args instead of execAsync to prevent shell injection
  const { stderr } = await new Promise((resolve) => {
    const child = spawn('npm', ['create', 'vite@latest', dirName, '--', '--template', 'react'], {
      cwd: parentDir,
      shell: process.platform === 'win32',
      windowsHide: true
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
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    addStep('Add Express server', 'done');
  }
}
