import { writeFile } from 'fs/promises';
import { join } from 'path';

// Inline CORS middleware snippet for generated projects (no cors package dependency)
const CORS_SNIPPET = `app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});`;

export async function scaffoldExpress(repoPath, dirName, apiPort, addStep) {
  const pkg = {
    name: dirName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'node --watch index.js',
      start: 'node index.js'
    },
    dependencies: {
      express: '^4.21.2'
    }
  };
  await writeFile(join(repoPath, 'package.json'), JSON.stringify(pkg, null, 2));

  await writeFile(join(repoPath, 'index.js'), `import express from 'express';

const app = express();
const PORT = process.env.PORT || ${apiPort || 3000};

${CORS_SNIPPET}
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
