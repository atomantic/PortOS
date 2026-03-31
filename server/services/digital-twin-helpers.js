import { v4 as uuidv4 } from '../lib/uuid.js';
import { existsSync } from 'fs';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

export const DIGITAL_TWIN_DIR = PATHS.digitalTwin;

export function generateId() {
  return uuidv4();
}

export function now() {
  return new Date().toISOString();
}

export async function ensureSoulDir() {
  if (!existsSync(DIGITAL_TWIN_DIR)) {
    await ensureDir(DIGITAL_TWIN_DIR);
    console.log(`🧬 Created soul data directory: ${DIGITAL_TWIN_DIR}`);
  }
}

/**
 * Call any AI provider (API or CLI) with a prompt and return the response text.
 */
export async function callProviderAI(provider, model, prompt, { temperature = 0.3, max_tokens = 4000 } = {}) {
  const timeout = provider.timeout || 300000;

  if (provider.type === 'api') {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens
      })
    }).catch((err) => {
      clearTimeout(timer);
      return { ok: false, _fetchError: err.name === 'AbortError' ? 'AI request timed out' : err.message };
    });

    clearTimeout(timer);

    if (response._fetchError) {
      return { error: response._fetchError };
    }

    if (!response.ok) {
      return { error: `Provider API error: ${response.status}` };
    }

    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '' };
  }

  // CLI provider — pipe prompt via stdin to avoid arg length limits on large prompts
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const args = [...(provider.args || [])];
    let output = '';
    let resolved = false;

    const child = spawn(provider.command, args, {
      env: (() => { const e = { ...process.env, ...provider.envVars }; delete e.CLAUDECODE; return e; })(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    // Pipe prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({ error: 'AI request timed out' });
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        resolve({ text: output });
      } else {
        resolve({ error: `CLI exited with code ${code}: ${output.substring(0, 500)}` });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (resolved) return;
      resolved = true;
      resolve({ error: err.message });
    });
  });
}
