// Piper TTS backend — spawn-per-request CLI: text on stdin, WAV on stdout.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { expandPath, piperVoiceTildePath, voiceHome } from './config.js';
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
    // Prepend piperLib onto existing DYLD_/LD_LIBRARY_PATH so users who rely
    // on other libraries (MKL, Metal plugins, locally-built deps) don't have
    // their paths clobbered. Piper's dylibs win first-match without erasing
    // the caller's environment.
    const env = { ...process.env };
    if (existsSync(piperLib)) {
      env.DYLD_LIBRARY_PATH = process.env.DYLD_LIBRARY_PATH
        ? `${piperLib}${delimiter}${process.env.DYLD_LIBRARY_PATH}`
        : piperLib;
      env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
        ? `${piperLib}${delimiter}${process.env.LD_LIBRARY_PATH}`
        : piperLib;
    }
    const child = spawn(piperBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const chunks = [];
    let errBuf = '';
    let killed = false;
    let settled = false;

    const settle = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn(arg);
    };
    const doResolve = settle(resolve);
    const doReject = settle(reject);

    const killTimer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      doReject(new Error(`piper timed out after ${PIPER_TIMEOUT_MS}ms`));
    }, PIPER_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        return doReject(new Error('piper synthesis aborted'));
      }
      signal.addEventListener('abort', () => {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        doReject(new Error('piper synthesis aborted'));
      }, { once: true });
    }

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { errBuf += c.toString(); });
    child.on('error', (err) => { doReject(err); });
    child.on('close', (code) => {
      if (killed) return doReject(new Error('piper synthesis aborted'));
      if (code !== 0) return doReject(new Error(`piper exited ${code}: ${errBuf.slice(0, 400)}`));
      doResolve({ wav: Buffer.concat(chunks), latencyMs: Date.now() - started });
    });

    child.stdin.end(text);
  });
};

// Return the curated catalog, annotated with `downloaded` plus both tilde
// and resolved paths. Storing `path` in tilde form keeps voice.tts.piper.voicePath
// portable across machines/users (the rest of the voice config uses `~/` too),
// while `resolvedPath` is available for UI display or diagnostics.
export const listPiperVoices = async () => PIPER_VOICES.map((v) => {
  const tildePath = piperVoiceTildePath(v.id);
  const resolvedPath = voicePathFor(v.id);
  return {
    name: v.id,
    path: tildePath,
    resolvedPath,
    downloaded: existsSync(resolvedPath),
    gender: v.gender,
    accent: v.accent,
    note: v.note,
    sizeMB: v.sizeMB,
    speakerId: v.speakerId,
  };
});
