/**
 * In-tree AI toolkit (formerly the `portos-ai-toolkit` npm package).
 * Provides configurable AI provider, runner, and prompt services with
 * matching Express routes. See server/index.js for the wiring.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createProviderService } from './providers.js';
import { createRunnerService } from './runner.js';
import { createPromptsService } from './prompts.js';
import { createProviderStatusService } from './providerStatus.js';
import { createProvidersRoutes } from './routes/providers.js';
import { createRunsRoutes } from './routes/runs.js';
import { createPromptsRoutes } from './routes/prompts.js';
import { createProviderStatusRoutes } from './routes/providerStatus.js';
import * as errorDetection from './errorDetection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROVIDERS_SAMPLE = join(__dirname, 'defaults/providers.sample.json');

export * from './validation.js';
export * from './errorDetection.js';
export * from './constants.js';
export { createProviderService, createRunnerService, createPromptsService, createProviderStatusService };
export { createProvidersRoutes, createRunsRoutes, createPromptsRoutes, createProviderStatusRoutes };

export function createAIToolkit(config = {}) {
  const {
    dataDir = './data',
    providersFile = 'providers.json',
    statusFile = 'provider-status.json',
    runsDir = 'runs',
    promptsDir = 'prompts',
    screenshotsDir = './data/screenshots',
    sampleProvidersFile = null,
    io = null,
    asyncHandler = (fn) => fn,
    hooks = {},
    maxConcurrentRuns = 5,
    enableProviderStatus = true,
    defaultFallbackPriority = ['claude-code', 'codex', 'nvidia-kimi', 'lmstudio', 'ollama', 'antigravity-cli', 'gemini-cli']
  } = config;

  const providerService = createProviderService({
    dataDir,
    providersFile,
    sampleFile: sampleProvidersFile
  });

  let providerStatusService = null;
  if (enableProviderStatus) {
    providerStatusService = createProviderStatusService({
      dataDir,
      statusFile,
      defaultFallbackPriority,
      onStatusChange: (eventData) => {
        io?.emit('provider:status:changed', eventData);
      }
    });

    providerStatusService.init().catch(err => {
      console.error(`❌ Failed to initialize provider status: ${err.message}`);
    });
  }

  const runnerService = createRunnerService({
    dataDir,
    runsDir,
    screenshotsDir,
    providerService,
    providerStatusService,
    hooks: {
      ...hooks,
      onProviderError: (providerId, errorAnalysis, output) => {
        io?.emit('provider:error', { providerId, errorAnalysis });
        hooks.onProviderError?.(providerId, errorAnalysis, output);
      }
    },
    maxConcurrentRuns
  });

  const promptsService = createPromptsService({
    dataDir,
    promptsDir
  });

  promptsService.init().catch(err => {
    console.error(`❌ Failed to initialize prompts: ${err.message}`);
  });

  const providersRouter = createProvidersRoutes(providerService, { asyncHandler });
  const runsRouter = createRunsRoutes(runnerService, { asyncHandler, io });
  const promptsRouter = createPromptsRoutes(promptsService, { asyncHandler });

  let providerStatusRouter = null;
  if (providerStatusService) {
    providerStatusRouter = createProviderStatusRoutes(providerStatusService, { asyncHandler });
  }

  return {
    services: {
      providers: providerService,
      runner: runnerService,
      prompts: promptsService,
      providerStatus: providerStatusService,
      // Expose error detection so the PortOS runner override (and any
      // direct toolkit consumer) can call `services.errorDetection.analyzeError`
      // without separately importing the module. Without this, CLI runs that
      // exit non-zero silently skip error analysis and leave metadata.error
      // null.
      errorDetection
    },

    routes: {
      providers: providersRouter,
      runs: runsRouter,
      prompts: promptsRouter,
      providerStatus: providerStatusRouter
    },

    mountRoutes(app, basePath = '/api') {
      // Mount the more specific /providers/status BEFORE /providers so that
      // the providers router's GET /:id doesn't intercept "status" as an id.
      if (providerStatusRouter) {
        app.use(`${basePath}/providers/status`, providerStatusRouter);
      }
      app.use(`${basePath}/providers`, providersRouter);
      app.use(`${basePath}/runs`, runsRouter);
      app.use(`${basePath}/prompts`, promptsRouter);
    }
  };
}
