#!/usr/bin/env node

/**
 * Build a disposable, synthetic PortOS data root for README screenshots.
 *
 * This intentionally never reads the install's `data/` directory. It copies
 * only the checked-in `data.reference/` starter tree into a caller-supplied
 * empty directory, then overlays fake records that make the public UI pages
 * useful to inspect without exposing a real install.
 *
 * Usage:
 *   node scripts/seed-readme-demo-data.mjs --root /tmp/portos-readme-demo
 */

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const referenceRoot = join(repoRoot, 'data.reference');

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const demoRoot = rootIndex >= 0 ? args[rootIndex + 1] : null;

if (!demoRoot || demoRoot.startsWith('--')) {
  console.error('Usage: node scripts/seed-readme-demo-data.mjs --root <empty-demo-root>');
  process.exit(1);
}

const targetRoot = resolve(demoRoot);
const existingEntries = existsSync(targetRoot) ? readdirSync(targetRoot) : [];
if (existingEntries.length > 0) {
  throw new Error(`Refusing to seed non-empty directory: ${targetRoot}`);
}

mkdirSync(targetRoot, { recursive: true });
const dataRoot = join(targetRoot, 'data');
cpSync(referenceRoot, dataRoot, { recursive: true });

const writeJson = (relativePath, value) => {
  const filePath = join(dataRoot, relativePath);
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

// The task store resolves configured files relative to PATHS.root. Keep these
// paths relative to the checkout so PORTOS_DATA_ROOT still points at the
// disposable root when the server runs from this repository.
const userTasksFile = relative(repoRoot, join(dataRoot, 'TASKS.md'));
const cosTasksFile = relative(repoRoot, join(dataRoot, 'COS-TASKS.md'));

writeJson('apps.json', {
  apps: {
    'portos-default': {
      id: 'portos-default',
      name: 'PortOS',
      description: 'Synthetic workspace used for screenshots and documentation.',
      repoPath: '<demo-root>/portos',
      type: 'express',
      uiPort: 5655,
      apiPort: 5655,
      pm2ProcessNames: ['portos-demo-server'],
      icon: 'portos',
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-18T09:00:00.000Z',
    },
    'atlas-notes': {
      id: 'atlas-notes',
      name: 'Atlas Notes',
      description: 'A small local-first notes workspace.',
      repoPath: '<demo-root>/atlas-notes',
      type: 'static',
      uiPort: 4173,
      icon: 'book-open',
      createdAt: '2026-07-12T09:00:00.000Z',
      updatedAt: '2026-08-17T16:30:00.000Z',
    },
    'signal-lab': {
      id: 'signal-lab',
      name: 'Signal Lab',
      description: 'Synthetic data visualization sandbox.',
      repoPath: '<demo-root>/signal-lab',
      type: 'python',
      icon: 'activity',
      createdAt: '2026-06-20T09:00:00.000Z',
      updatedAt: '2026-08-16T11:15:00.000Z',
    },
    'orbit-mobile': {
      id: 'orbit-mobile',
      name: 'Orbit Mobile',
      description: 'A sample Swift project for the app catalog.',
      repoPath: '<demo-root>/orbit-mobile',
      type: 'ios-native',
      icon: 'smartphone',
      createdAt: '2026-05-03T09:00:00.000Z',
      updatedAt: '2026-08-15T13:45:00.000Z',
    },
  },
});

writeJson('providers.json', {
  activeProvider: 'atlas-cli',
  providers: {
    'atlas-cli': {
      id: 'atlas-cli',
      name: 'Atlas CLI',
      type: 'cli',
      command: 'atlas',
      args: ['--print'],
      models: ['atlas-small', 'atlas-medium', 'atlas-large'],
      defaultModel: 'atlas-medium',
      lightModel: 'atlas-small',
      mediumModel: 'atlas-medium',
      heavyModel: 'atlas-large',
      timeout: 300000,
      enabled: true,
      envVars: {},
    },
    'nova-tui': {
      id: 'nova-tui',
      name: 'Nova TUI',
      type: 'tui',
      command: 'nova',
      args: [],
      models: ['nova-coder', 'nova-reasoner'],
      defaultModel: 'nova-coder',
      lightModel: 'nova-coder',
      mediumModel: 'nova-coder',
      heavyModel: 'nova-reasoner',
      timeout: 300000,
      enabled: true,
      envVars: {},
    },
    'local-studio': {
      id: 'local-studio',
      name: 'Local Studio',
      type: 'api',
      endpoint: 'http://127.0.0.1:9999/v1',
      apiKey: '',
      models: ['local-vision', 'local-text'],
      defaultModel: 'local-text',
      lightModel: 'local-text',
      mediumModel: 'local-text',
      heavyModel: 'local-vision',
      timeout: 120000,
      enabled: false,
      envVars: {},
      secretEnvVars: [],
    },
    'demo-router': {
      id: 'demo-router',
      name: 'Demo Router',
      type: 'api',
      endpoint: 'https://example.com/v1',
      apiKey: '',
      models: ['demo-auto'],
      defaultModel: 'demo-auto',
      lightModel: 'demo-auto',
      mediumModel: 'demo-auto',
      heavyModel: 'demo-auto',
      timeout: 120000,
      enabled: false,
      envVars: {},
      secretEnvVars: [],
    },
  },
});

// Durable user config lives in its own file (#6182); state.json holds only the
// runtime records.
writeJson('cos/config.json', {
  userTasksFile,
  cosTasksFile,
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  maxTotalProcesses: 50,
  autoStart: false,
  alwaysOn: false,
  selfImprovementEnabled: true,
  dynamicAvatar: true,
  avatarStyle: 'svg',
});

writeJson('cos/state.json', {
  running: false,
  paused: false,
  stats: {
    tasksCompleted: 18,
    totalRuntime: 8940000,
    agentsSpawned: 24,
    lastEvaluation: '2026-08-18T15:30:00.000Z',
    lastHealthCheck: '2026-08-18T15:29:00.000Z',
    healthIssues: [],
  },
  agents: {
    'demo-agent-01': {
      id: 'demo-agent-01',
      taskId: 'task-demo-ship',
      status: 'completed',
      startedAt: '2026-08-18T14:42:00.000Z',
      completedAt: '2026-08-18T14:55:00.000Z',
      metadata: {
        taskType: 'user',
        provider: 'atlas-cli',
        model: 'atlas-medium',
        app: 'atlas-notes',
        description: 'Polish the notes search experience',
      },
      result: { success: true, summary: 'Completed synthetic demo task.' },
      output: [],
    },
    'demo-agent-02': {
      id: 'demo-agent-02',
      taskId: 'sys-demo-audit',
      status: 'completed',
      startedAt: '2026-08-18T13:10:00.000Z',
      completedAt: '2026-08-18T13:23:00.000Z',
      metadata: {
        taskType: 'internal',
        provider: 'nova-tui',
        model: 'nova-coder',
        app: 'portos-default',
        description: 'Review the synthetic dashboard fixture',
      },
      result: { success: true, summary: 'Completed synthetic audit task.' },
      output: [],
    },
  },
});

writeJson('settings.json', {
  timezone: 'UTC',
  theme: 'classic-midnight',
  voice: { enabled: false, trigger: 'push-to-talk', hotkey: 'Space' },
});

writeFileSync(join(dataRoot, 'TASKS.md'), `# Tasks

## Pending
- [ ] #task-demo-ship | HIGH | Polish the notes search experience
  - app: atlas-notes
  - provider: atlas-cli
  - model: atlas-medium
- [ ] #task-demo-design | MEDIUM | Sketch the next dashboard widget
  - app: portos-default

## In Progress
- [~] #task-demo-docs | MEDIUM | Refresh the public setup guide
  - app: portos-default

## Blocked
- [!] #task-demo-assets | HIGH | Prepare the sample media collection
  - blocker: Waiting for a synthetic asset pack

## Completed
- [x] #task-demo-tests | LOW | Add smoke coverage for the demo routes
  - completed: 2026-08-18T12:30:00.000Z
`);

writeFileSync(join(dataRoot, 'COS-TASKS.md'), `# Tasks

## Pending
- [ ] #sys-demo-audit | HIGH | AUTO | Review the synthetic dashboard fixture
  - app: portos-default

## In Progress
- [~] #sys-demo-metrics | MEDIUM | APPROVAL | Compare the demo theme contrast
  - app: portos-default

## Completed
- [x] #sys-demo-archive | LOW | AUTO | Archive the previous demo run
  - completed: 2026-08-18T11:00:00.000Z
`);

console.log(`✅ Seeded synthetic README demo data at ${targetRoot}`);
