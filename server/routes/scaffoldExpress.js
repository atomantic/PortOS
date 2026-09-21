import { writeFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../lib/fileUtils.js';
import { CORS_SNIPPET } from '../lib/scaffoldSnippets.js';

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
  await atomicWrite(join(repoPath, 'package.json'), pkg);

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
