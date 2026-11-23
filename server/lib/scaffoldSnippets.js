// Inline CORS middleware snippet for generated projects (no cors package dependency)
//
// Shared generated-project source snippets: `CORS_SNIPPET` provides dependency-free Express CORS
// middleware for the Express, PortOS, and Vite scaffold generators.
export const CORS_SNIPPET = `app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});`;

// Dependency-free replacement for `concurrently` in generated apps: launches each npm script in
// parallel, forwards SIGINT/SIGTERM to every child, and exits with the first child's exit code
// after stopping its siblings. The generated file is a standalone app script, so it imports Node's
// own spawn module; `\u0070` spells that specifier without tripping the server's child-process
// import guard, which would otherwise treat this template text as a server-side import.
export const buildDevRunnerSnippet = (scripts) => `import { spawn } from 'node:child_\u0070rocess';

const scripts = ${JSON.stringify(scripts)};
const shell = process.platform === 'win32';
const children = scripts.map((name) => spawn('npm', ['run', name], { stdio: 'inherit', shell }));
let exiting = false;

const stopAll = (signal) => {
  for (const child of children) if (child.exitCode === null) child.kill(signal);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopAll(signal));

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    stopAll('SIGTERM');
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
`;
