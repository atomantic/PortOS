// Piper TTS backend — spawn-per-request CLI: text on stdin, WAV on stdout.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { expandPath } from './config.js';

const PIPER_TIMEOUT_MS = 30_000;

export const synthesizePiper = (text, cfg, signal) => {
  const voicePath = expandPath(cfg.piper.voicePath);
  if (!existsSync(voicePath)) {
    return Promise.reject(new Error(`piper voice missing: ${voicePath}`));
  }

  const rate = Math.max(0.25, Math.min(4, cfg.rate ?? 1.0));
  const lengthScale = String(1 / rate);
  const args = ['--model', voicePath, '--length_scale', lengthScale, '--output_file', '-'];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('piper', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let errBuf = '';
    let killed = false;

    const killTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`piper timed out after ${PIPER_TIMEOUT_MS}ms`));
    }, PIPER_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        child.kill('SIGTERM');
      }, { once: true });
    }

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { errBuf += c.toString(); });
    child.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (killed) return;
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${errBuf.slice(0, 400)}`));
      resolve({ wav: Buffer.concat(chunks), latencyMs: Date.now() - started });
    });

    child.stdin.end(text);
  });
};

import { readdir } from 'fs/promises';
import { dirname, basename, join } from 'path';

export const listPiperVoices = async (cfg) => {
  const dir = dirname(expandPath(cfg.piper.voicePath));
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.onnx'))
    .map((f) => ({ name: basename(f, '.onnx'), path: join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
};
