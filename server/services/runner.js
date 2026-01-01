import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { getProviderById } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const RUNS_DIR = join(DATA_DIR, 'runs');

// Track active runs for cancellation
const activeRuns = new Map();

async function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) {
    await mkdir(RUNS_DIR, { recursive: true });
  }
}

export async function createRun(options) {
  const {
    providerId,
    model,
    prompt,
    workspacePath,
    workspaceName
  } = options;

  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new Error('Provider not found');
  }

  if (!provider.enabled) {
    throw new Error('Provider is disabled');
  }

  await ensureRunsDir();

  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);
  await mkdir(runDir);

  const metadata = {
    id: runId,
    type: 'ai',
    providerId,
    providerName: provider.name,
    model: model || provider.defaultModel,
    workspacePath,
    workspaceName,
    prompt: prompt.substring(0, 500), // Store truncated prompt in metadata
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    exitCode: null,
    success: null,
    error: null,
    outputSize: 0
  };

  await writeFile(join(runDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(join(runDir, 'prompt.txt'), prompt);
  await writeFile(join(runDir, 'output.txt'), '');

  return { runId, runDir, provider, metadata };
}

export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete) {
  const runDir = join(RUNS_DIR, runId);
  const outputPath = join(runDir, 'output.txt');
  const metadataPath = join(runDir, 'metadata.json');

  // Build command args
  const args = [...(provider.args || [])];

  // For claude CLI, the prompt goes at the end
  if (provider.command === 'claude') {
    args.push(prompt);
  } else {
    // For other CLIs, try stdin or args
    args.push(prompt);
  }

  const startTime = Date.now();
  let output = '';

  const child = spawn(provider.command, args, {
    cwd: workspacePath || process.cwd(),
    env: { ...process.env, ...provider.envVars },
    shell: false
  });

  activeRuns.set(runId, child);

  const appendOutput = async (data) => {
    const text = data.toString();
    output += text;
    await writeFile(outputPath, output);
    onData?.(text);
  };

  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  child.on('close', async (code) => {
    activeRuns.delete(runId);

    const endTime = Date.now();
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));

    metadata.endTime = new Date().toISOString();
    metadata.duration = endTime - startTime;
    metadata.exitCode = code;
    metadata.success = code === 0;
    metadata.outputSize = Buffer.byteLength(output);

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  });

  child.on('error', async (err) => {
    activeRuns.delete(runId);

    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    metadata.error = err.message;

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  });

  // Set timeout
  if (provider.timeout) {
    setTimeout(() => {
      if (activeRuns.has(runId)) {
        child.kill('SIGTERM');
      }
    }, provider.timeout);
  }

  return runId;
}

export async function executeApiRun(runId, provider, model, prompt, workspacePath, onData, onComplete) {
  const runDir = join(RUNS_DIR, runId);
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

  const response = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: model || provider.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  }).catch(err => ({ ok: false, error: err.message }));

  if (!response.ok) {
    activeRuns.delete(runId);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    metadata.error = response.error || `API error: ${response.status}`;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
    return runId;
  }

  // Handle streaming response
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const processStream = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        const parsed = JSON.parse(data).catch?.(() => null);
        if (parsed?.choices?.[0]?.delta?.content) {
          const text = parsed.choices[0].delta.content;
          output += text;
          onData?.(text);
        }
      }
    }

    await writeFile(outputPath, output);
    activeRuns.delete(runId);

    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.exitCode = 0;
    metadata.success = true;
    metadata.outputSize = Buffer.byteLength(output);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  };

  processStream().catch(async (err) => {
    activeRuns.delete(runId);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
    metadata.endTime = new Date().toISOString();
    metadata.duration = Date.now() - startTime;
    metadata.success = false;
    metadata.error = err.message;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    onComplete?.(metadata);
  });

  return runId;
}

export async function stopRun(runId) {
  const active = activeRuns.get(runId);
  if (!active) {
    return false;
  }

  if (active.kill) {
    // It's a child process
    active.kill('SIGTERM');
  } else if (active.abort) {
    // It's an AbortController
    active.abort();
  }

  activeRuns.delete(runId);
  return true;
}

export async function getRun(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  const metadata = JSON.parse(await readFile(join(runDir, 'metadata.json'), 'utf-8'));
  return metadata;
}

export async function getRunOutput(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  return readFile(join(runDir, 'output.txt'), 'utf-8');
}

export async function getRunPrompt(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return null;
  }

  return readFile(join(runDir, 'prompt.txt'), 'utf-8');
}

export async function listRuns(limit = 50, offset = 0) {
  await ensureRunsDir();

  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  const runIds = entries
    .filter(e => e.isDirectory())
    .map(e => e.name);

  // Load all metadata and sort by start time
  const runs = [];
  for (const runId of runIds) {
    const metadataPath = join(RUNS_DIR, runId, 'metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
      runs.push(metadata);
    }
  }

  runs.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  return {
    total: runs.length,
    runs: runs.slice(offset, offset + limit)
  };
}

export async function deleteRun(runId) {
  const runDir = join(RUNS_DIR, runId);
  if (!existsSync(runDir)) {
    return false;
  }

  await rm(runDir, { recursive: true });
  return true;
}

export function isRunActive(runId) {
  return activeRuns.has(runId);
}
