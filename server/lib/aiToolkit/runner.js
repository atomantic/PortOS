import { mkdir, readFile, readdir, rm } from 'fs/promises';
import { atomicWrite } from './internal/atomicWrite.js';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { analyzeError, analyzeHttpError, ERROR_CATEGORIES } from './errorDetection.js';
import { ensureProviderReady as ensureOllamaProviderReady } from '../../services/ollamaManager.js';

export function createRunnerService(config = {}) {
  const {
    dataDir = './data',
    runsDir = 'runs',
    screenshotsDir = './data/screenshots',
    providerService,
    providerStatusService = null,
    hooks = {},
    maxConcurrentRuns: _maxConcurrentRuns = 5
  } = config;

  const RUNS_PATH = join(dataDir, runsDir);
  const activeRuns = new Map();

  async function ensureRunsDir() {
    if (!existsSync(RUNS_PATH)) {
      await mkdir(RUNS_PATH, { recursive: true });
    }
  }

  function getMimeType(filepath) {
    const ext = extname(filepath).toLowerCase();
    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/png';
  }

  async function loadImageAsBase64(imagePath) {
    const fullPath = imagePath.startsWith('/') ? imagePath : join(screenshotsDir, imagePath);

    if (!existsSync(fullPath)) {
      throw new Error(`Image not found: ${fullPath}`);
    }

    const buffer = await readFile(fullPath);
    const mimeType = getMimeType(fullPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  function safeJsonParse(str, fallback = {}) {
    if (typeof str !== 'string' || !str.trim()) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(str);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function handleProviderError(providerId, errorAnalysis, output) {
    hooks.onProviderError?.(providerId, errorAnalysis, output);

    if (providerStatusService) {
      if (errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT && errorAnalysis.requiresFallback) {
        await providerStatusService.markUsageLimit(providerId, {
          message: errorAnalysis.message,
          waitTime: errorAnalysis.waitTime
        }).catch(err => {
          console.error(`❌ Failed to mark provider usage limit: ${err.message}`);
        });
      } else if (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT) {
        await providerStatusService.markRateLimited(providerId).catch(err => {
          console.error(`❌ Failed to mark provider rate limited: ${err.message}`);
        });
      }
    }
  }

  return {
    async createRun(options) {
      const {
        providerId,
        model,
        prompt,
        workspacePath = process.cwd(),
        workspaceName = 'default',
        timeout,
        source = 'devtools',
        fallbackProviderId = null
      } = options;

      if (!providerService) {
        throw new Error('Provider service not configured');
      }

      let effectiveProviderId = providerId;
      let usedFallback = false;

      if (providerStatusService && !providerStatusService.isAvailable(providerId)) {
        const allProviders = await providerService.getAllProviders();
        const providersMap = {};
        for (const p of allProviders.providers) {
          providersMap[p.id] = p;
        }

        const fallback = providerStatusService.getFallbackProvider(
          providerId,
          providersMap,
          fallbackProviderId
        );

        if (fallback) {
          effectiveProviderId = fallback.provider.id;
          usedFallback = true;
          console.log(`⚡ Using fallback provider: ${fallback.provider.name} (source: ${fallback.source})`);
        } else {
          const timeUntilRecovery = providerStatusService.getTimeUntilRecovery(providerId);
          throw new Error(
            `Provider ${providerId} is unavailable (${providerStatusService.getStatus(providerId).reason}) ` +
            `and no fallback is available. Recovery in: ${timeUntilRecovery || 'unknown'}`
          );
        }
      }

      const provider = await providerService.getProviderById(effectiveProviderId);
      if (!provider) {
        throw new Error('Provider not found');
      }

      if (!provider.enabled) {
        throw new Error('Provider is disabled');
      }

      await ensureRunsDir();

      const runId = randomUUID();
      const runDir = join(RUNS_PATH, runId);
      await mkdir(runDir);

      const metadata = {
        id: runId,
        type: 'ai',
        providerId: effectiveProviderId,
        providerName: provider.name,
        originalProviderId: usedFallback ? providerId : null,
        usedFallback,
        model: model || provider.defaultModel,
        workspacePath,
        workspaceName,
        source,
        prompt: prompt.substring(0, 500),
        startTime: new Date().toISOString(),
        endTime: null,
        duration: null,
        exitCode: null,
        success: null,
        error: null,
        errorCategory: null,
        errorAnalysis: null,
        outputSize: 0
      };

      await atomicWrite(join(runDir, 'metadata.json'), metadata);
      await atomicWrite(join(runDir, 'prompt.txt'), prompt);
      await atomicWrite(join(runDir, 'output.txt'), '');

      hooks.onRunCreated?.(metadata);
      console.log(`🤖 AI run [${source}]: ${provider.name}/${metadata.model}`);

      const effectiveTimeout = timeout || provider.timeout;

      return { runId, runDir, provider, metadata, timeout: effectiveTimeout };
    },

    async executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout) {
      const runDir = join(RUNS_PATH, runId);
      const outputPath = join(runDir, 'output.txt');
      const metadataPath = join(runDir, 'metadata.json');

      const startTime = Date.now();
      let output = '';

      // Pass the prompt via stdin (not argv) and run without a shell so that
      // user-configurable `provider.command` cannot inject extra commands via
      // shell metacharacters, and so the full prompt isn't visible in
      // process listings as a single command-line argument.
      const args = [...(provider.args || [])];
      console.log(`🚀 Executing CLI: ${provider.command} ${args.join(' ')} (${prompt.length} chars via stdin)`);

      const childProcess = spawn(provider.command, args, {
        cwd: workspacePath,
        env: { ...process.env, ...provider.envVars },
        windowsHide: true
      });
      if (childProcess.stdin) {
        childProcess.stdin.write(prompt);
        childProcess.stdin.end();
      }

      activeRuns.set(runId, childProcess);
      hooks.onRunStarted?.({ runId, provider: provider.name, model: provider.defaultModel });

      const timeoutHandle = setTimeout(() => {
        if (childProcess && !childProcess.killed) {
          console.log(`⏱️ Run ${runId} timed out after ${timeout}ms`);
          childProcess.kill('SIGTERM');
        }
      }, timeout);

      childProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        onData?.(text);
      });

      childProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        output += text;
        onData?.(text);
      });

      childProcess.on('close', async (code) => {
        clearTimeout(timeoutHandle);
        activeRuns.delete(runId);

        await atomicWrite(outputPath, output);

        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.exitCode = code;
        metadata.success = code === 0;
        metadata.outputSize = Buffer.byteLength(output);

        if (!metadata.success) {
          const errorAnalysis = analyzeError(output, code);
          metadata.error = errorAnalysis.message || `Process exited with code ${code}`;
          metadata.errorCategory = errorAnalysis.category;
          metadata.errorAnalysis = errorAnalysis;

          if (errorAnalysis.hasError &&
              (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
               errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
            await handleProviderError(provider.id, errorAnalysis, output);
          }
        }

        await atomicWrite(metadataPath, metadata);

        if (metadata.success) {
          hooks.onRunCompleted?.(metadata, output);
        } else {
          hooks.onRunFailed?.(metadata, metadata.error, output);
        }

        onComplete?.(metadata);
      });

      return runId;
    },

    async executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete) {
      const runDir = join(RUNS_PATH, runId);
      const outputPath = join(runDir, 'output.txt');
      const metadataPath = join(runDir, 'metadata.json');

      const startTime = Date.now();
      let output = '';

      const headers = {
        'Content-Type': 'application/json'
      };
      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const controller = new AbortController();
      activeRuns.set(runId, controller);

      hooks.onRunStarted?.({ runId, provider: provider.name, model });

      let messageContent;
      if (screenshots && screenshots.length > 0) {
        console.log(`📸 Loading ${screenshots.length} screenshots for vision API`);
        const contentParts = [];

        for (const screenshotPath of screenshots) {
          const imageDataUrl = await loadImageAsBase64(screenshotPath).catch(err => {
            console.error(`❌ Failed to load screenshot ${screenshotPath}: ${err.message}`);
            return null;
          });
          if (imageDataUrl) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: imageDataUrl }
            });
          }
        }

        contentParts.push({ type: 'text', text: prompt });
        messageContent = contentParts;
      } else {
        messageContent = prompt;
      }

      const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
      const response = ready.success
        ? await fetch(`${provider.endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              model: model || provider.defaultModel,
              messages: [{ role: 'user', content: messageContent }],
              stream: true
            })
          }).catch(err => ({ ok: false, error: err.message, status: 0 }))
        : { ok: false, error: `Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`, status: 0 };

      if (!response.ok) {
        activeRuns.delete(runId);
        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.success = false;

        let responseBody = response.error || '';
        if (response.text) {
          responseBody = await response.text().catch(() => response.error || '');
        }

        const errorAnalysis = analyzeHttpError({
          status: response.status || 0,
          statusText: response.statusText || '',
          body: responseBody
        });

        metadata.error = errorAnalysis.message || `API error: ${response.status}`;
        metadata.errorCategory = errorAnalysis.category;
        metadata.errorAnalysis = errorAnalysis;

        if (errorAnalysis.hasError &&
            (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
             errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
          await handleProviderError(provider.id, errorAnalysis, responseBody);
        }

        await atomicWrite(metadataPath, metadata);

        hooks.onRunFailed?.(metadata, metadata.error, '');
        onComplete?.(metadata);
        return runId;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let reasoning = '';

      const processStream = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === '✅' || data === '[DONE]') continue;

            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;

            if (delta?.content) {
              const text = delta.content;
              output += text;
              onData?.({ text });
            }

            if (delta?.reasoning) {
              reasoning += delta.reasoning;
            }
          }
        }

        // Capture the fallback decision BEFORE mutating `output` — otherwise
        // the metadata check below (`!output.trim() && reasoning.trim()`) is
        // always false on the reasoning-only path because `output` was just
        // overwritten with the reasoning text.
        const usedReasoningAsFallback = !output.trim() && reasoning.trim().length > 0;
        if (usedReasoningAsFallback) {
          console.log(`🧠 Reasoning model detected - using reasoning as output (${reasoning.length} chars)`);
          output = reasoning;
          onData?.({ text: reasoning, isReasoning: true });
        }

        await atomicWrite(outputPath, output);
        activeRuns.delete(runId);

        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.exitCode = 0;
        metadata.success = true;
        metadata.outputSize = Buffer.byteLength(output);
        metadata.hadReasoning = reasoning.length > 0;
        metadata.usedReasoningAsFallback = usedReasoningAsFallback;
        await atomicWrite(metadataPath, metadata);

        hooks.onRunCompleted?.(metadata, output);
        onComplete?.(metadata);
      };

      processStream().catch(async (err) => {
        activeRuns.delete(runId);

        if (output) {
          await atomicWrite(outputPath, output).catch(() => {});
        }

        const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
        metadata.endTime = new Date().toISOString();
        metadata.duration = Date.now() - startTime;
        metadata.success = false;

        const errorAnalysis = analyzeError(err.message);
        metadata.error = errorAnalysis.message || err.message;
        metadata.errorCategory = errorAnalysis.category;
        metadata.errorAnalysis = errorAnalysis;
        metadata.outputSize = Buffer.byteLength(output);

        if (errorAnalysis.hasError &&
            (errorAnalysis.category === ERROR_CATEGORIES.RATE_LIMIT ||
             errorAnalysis.category === ERROR_CATEGORIES.USAGE_LIMIT)) {
          await handleProviderError(provider.id, errorAnalysis, output);
        }

        await atomicWrite(metadataPath, metadata);

        hooks.onRunFailed?.(metadata, metadata.error, output);
        onComplete?.(metadata);
      });

      return runId;
    },

    async stopRun(runId) {
      const active = activeRuns.get(runId);
      if (!active) return false;

      if (active.kill) {
        active.kill('SIGTERM');
      } else if (active.abort) {
        active.abort();
      }

      activeRuns.delete(runId);
      return true;
    },

    async getRun(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      const metadata = safeJsonParse(await readFile(join(runDir, 'metadata.json'), 'utf-8').catch(() => '{}'));
      return metadata;
    },

    async getRunOutput(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      return readFile(join(runDir, 'output.txt'), 'utf-8');
    },

    async getRunPrompt(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return null;

      return readFile(join(runDir, 'prompt.txt'), 'utf-8');
    },

    async listRuns(limit = 50, offset = 0, source = 'all') {
      await ensureRunsDir();

      const entries = await readdir(RUNS_PATH, { withFileTypes: true });
      const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);

      const runs = [];
      for (const runId of runIds) {
        const metadataPath = join(RUNS_PATH, runId, 'metadata.json');
        if (existsSync(metadataPath)) {
          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          if (metadata.id) runs.push(metadata);
        }
      }

      let filteredRuns = runs;
      if (source !== 'all') {
        filteredRuns = runs.filter(run => {
          const runSource = run.source || 'devtools';
          return runSource === source;
        });
      }

      filteredRuns.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

      return {
        total: filteredRuns.length,
        runs: filteredRuns.slice(offset, offset + limit)
      };
    },

    async deleteRun(runId) {
      const runDir = join(RUNS_PATH, runId);
      if (!existsSync(runDir)) return false;

      await rm(runDir, { recursive: true });
      return true;
    },

    async deleteFailedRuns() {
      await ensureRunsDir();

      const entries = await readdir(RUNS_PATH, { withFileTypes: true });
      const runIds = entries.filter(e => e.isDirectory()).map(e => e.name);

      let deletedCount = 0;
      for (const runId of runIds) {
        const metadataPath = join(RUNS_PATH, runId, 'metadata.json');
        if (existsSync(metadataPath)) {
          const metadata = safeJsonParse(await readFile(metadataPath, 'utf-8').catch(() => '{}'));
          if (metadata.success === false) {
            await rm(join(RUNS_PATH, runId), { recursive: true });
            deletedCount++;
          }
        }
      }

      return deletedCount;
    },

    async isRunActive(runId) {
      return activeRuns.has(runId);
    }
  };
}
