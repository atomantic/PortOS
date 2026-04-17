// Piper TTS backend — spawn-per-request CLI: text on stdin, WAV on stdout.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { expandPath, voiceHome } from './config.js';
import { PIPER_VOICES, findPiperVoice } from './piper-voices.js';

const PIPER_TIMEOUT_MS = 30_000;
const VOICES_DIR = join(voiceHome(), 'voices');
const PIPER_BIN = join(voiceHome(), 'piper', 'piper');

const voicePathFor = (id) => join(VOICES_DIR, `${id}.onnx`);

export const synthesizePiper = (text, cfg, signal) => {
  const voiceId = cfg.piper.voice;
  const voicePath = expandPath(cfg.piper.voicePath || voicePathFor(voiceId));
  if (!existsSync(voicePath)) {
    return Promise.reject(new Error(`piper voice missing: ${voicePath}`));
  }

  const rate = Math.max(0.25, Math.min(4, cfg.rate ?? 1.0));
  const lengthScale = String(1 / rate);
  const args = ['--model', voicePath, '--length_scale', lengthScale, '--output_file', '-'];

  // Multi-speaker voices (VCTK) need a speaker index. Prefer the per-session
  // override from config, fall back to the catalog default.
  const catalog = findPiperVoice(voiceId);
  const speakerId = cfg.piper.speakerId ?? catalog?.speakerId;
  if (speakerId != null) args.push('--speaker', String(speakerId));

  const started = Date.now();

  return new Promise((resolve, reject) => {
    const piperBin = existsSync(PIPER_BIN) ? PIPER_BIN : 'piper';
    const piperLib = join(voiceHome(), 'piper', 'lib');
    const env = existsSync(piperLib)
      ? { ...process.env, DYLD_LIBRARY_PATH: piperLib, LD_LIBRARY_PATH: piperLib }
      : process.env;
    const child = spawn(piperBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
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

// Return the curated catalog, annotated with `downloaded` + resolved `path`.
// The UI shows every entry; missing ones are fetched on save via reconcile.
export const listPiperVoices = async () => PIPER_VOICES.map((v) => {
  const path = voicePathFor(v.id);
  return {
    name: v.id,
    path,
    downloaded: existsSync(path),
    gender: v.gender,
    accent: v.accent,
    note: v.note,
    sizeMB: v.sizeMB,
    speakerId: v.speakerId,
  };
});
