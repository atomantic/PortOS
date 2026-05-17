/**
 * Pipeline audio helpers — voice ID namespace + thin wrappers around the
 * existing voice-agent TTS (`server/services/voice/tts.js`) for pipeline
 * artifacts that need to land on disk instead of streaming over Socket.IO.
 *
 * Provider strategy: **always-available local OSS first.** Kokoro and Piper
 * ship in-process via ONNX/transformers.js — every install can render voice
 * lines without network or API keys. Premium providers (ElevenLabs, etc.)
 * add as sibling engines via `server/services/voice/tts.js`'s engine
 * dispatch; the pipeline doesn't care which one rendered the bytes.
 *
 * Voice ID namespace: `engine:voiceName` — `kokoro:af_heart`,
 * `piper:en_GB-northern_english_male`. A bare voice name without the
 * `engine:` prefix is interpreted as the active engine's voice.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { synthesize, listVoices, VALID_ENGINES } from '../voice/tts.js';
import { ServerError } from '../../lib/errorHandler.js';

const VOICE_ID_RE = /^([a-z][a-z0-9-]*):(.+)$/i;

/**
 * Split a voice id into `{ engine, voice }`. Returns `{ engine: null, voice: id }`
 * when no engine prefix is present so the caller can fall back to the active
 * engine — same shape as the legacy single-engine code path.
 */
export function parseVoiceId(voiceId) {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return { engine: null, voice: null };
  const trimmed = voiceId.trim();
  const m = trimmed.match(VOICE_ID_RE);
  if (!m) return { engine: null, voice: trimmed };
  const engine = m[1].toLowerCase();
  if (!VALID_ENGINES.has(engine)) return { engine: null, voice: trimmed };
  return { engine, voice: m[2] };
}

/**
 * List every voice exposed by every supported engine, namespaced with
 * `engine:voiceName` so the character voice picker can present a single
 * flat list across providers. Failures from one engine never block the
 * others — a missing Piper binary, for instance, just drops piper voices
 * from the list.
 */
export async function listAllVoices() {
  const engines = [...VALID_ENGINES];
  const results = await Promise.all(engines.map(async (engine) => {
    try {
      const { voices } = await listVoices(engine);
      return voices.map((v) => ({
        id: `${engine}:${v.name}`,
        engine,
        voice: v.name,
        label: v.label || v.name,
        // Carry through any metadata the engine surfaces (gender, language,
        // accent, etc.) without locking the shape — the UI renders what's
        // present.
        ...v,
      }));
    } catch (err) {
      console.warn(`⚠️ listAllVoices: ${engine} unavailable — ${err?.message || err}`);
      return [];
    }
  }));
  return results.flat();
}

/**
 * Synthesize text to a WAV file under PATHS.audio and return the saved
 * filename. The route layer + the audio stage line records correlate by
 * filename, same convention as the image pipeline.
 *
 * `voiceId` may be the namespaced form (`kokoro:af_heart`) or a bare voice
 * name (interpreted against the active engine). Empty / falsy `voiceId`
 * uses the configured default voice.
 */
/**
 * Walk an issue's already-extracted storyboard scenes and emit a flat
 * `lines[]` ready to write onto `stages.audio.lines`. The scene extractor
 * already parsed dialogue into `{ character, line }` per scene, so we don't
 * re-parse markdown here — we just flatten + bind each speaker to a canon
 * character (by name, case-insensitive) so the per-line render can resolve
 * a voice id.
 *
 * Lines without a matching canon character still get persisted (the user
 * may want narrator / un-named-character lines synthesized via the project
 * default voice); `characterId` stays null in that case.
 */
/**
 * Voice resolution for a single VO line. Priority:
 *   1. `explicit`             (per-request body override)
 *   2. `line.voiceIdOverride` (per-line override saved on the issue)
 *   3. `character.voiceId`    (canon character binding by line.characterId)
 *   4. `null`                 (caller falls through to the configured default voice)
 *
 * `canon` is `{ characters }` — typically loaded from the linked universe
 * via `getSeriesCanon(series)`. Pure function — no I/O — so the route,
 * a future "render all" flow, and unit tests all use the same priority.
 */
export function resolveVoiceForLine(line, canon, { explicit } = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (line?.voiceIdOverride) return line.voiceIdOverride;
  if (line?.characterId) {
    const char = (canon?.characters || []).find((c) => c?.id === line.characterId);
    if (char?.voiceId) return char.voiceId;
  }
  return null;
}

/**
 * Strip parenthetical performance hints from a screenplay speaker label so
 * character matching works on the bare name. Handles trailing single
 * (`JEAN (O.S.)`), stacked trailing (`JEAN (O.S.)(angry)`), and leading
 * (`(O.S.) JEAN`) parens — all three appear in real teleplays.
 */
function stripSpeakerParens(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^\s*\([^)]*\)\s*/, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();
}

export function extractDialogueLines(issue, canon, { preserveFrom = [] } = {}) {
  const scenes = Array.isArray(issue?.stages?.storyboards?.scenes)
    ? issue.stages.storyboards.scenes
    : [];
  // First-registration wins so duplicate character names / aliased collisions
  // resolve deterministically. Last-writer-wins on a Map would silently flip
  // a binding when a later character shares a name.
  const charactersByKey = new Map();
  const rememberKey = (key, c) => {
    if (key && !charactersByKey.has(key)) charactersByKey.set(key, c);
  };
  for (const c of (canon?.characters || [])) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    rememberKey(name.toLowerCase(), c);
    if (Array.isArray(c.aliases)) {
      for (const alias of c.aliases) {
        if (typeof alias === 'string' && alias.trim()) rememberKey(alias.trim().toLowerCase(), c);
      }
    }
  }

  // Build a (speakerKey + text) → prior line index so re-extraction can carry
  // forward rendered audio for lines that haven't changed. The match is
  // intentionally strict — any edit to text or character invalidates the
  // existing render.
  const preservedByKey = new Map();
  if (Array.isArray(preserveFrom)) {
    for (const prev of preserveFrom) {
      if (!prev || typeof prev !== 'object') continue;
      if (!prev.audioFilename && !prev.audioJobId) continue;
      const key = `${(prev.characterName || '').toLowerCase()}|${prev.text || ''}`;
      if (!preservedByKey.has(key)) preservedByKey.set(key, prev);
    }
  }

  const lines = [];
  let preservedCount = 0;
  let lineNumber = 1;
  for (let sIdx = 0; sIdx < scenes.length; sIdx += 1) {
    const scene = scenes[sIdx];
    const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
    for (let dIdx = 0; dIdx < dialogue.length; dIdx += 1) {
      const d = dialogue[dIdx];
      const text = typeof d?.line === 'string' ? d.line.trim() : '';
      if (!text) continue;
      const rawSpeaker = typeof d?.character === 'string' ? d.character.trim() : '';
      const bareSpeaker = stripSpeakerParens(rawSpeaker);
      const match = bareSpeaker ? charactersByKey.get(bareSpeaker.toLowerCase()) : null;
      const preserveKey = `${rawSpeaker.toLowerCase()}|${text}`;
      const carryover = preservedByKey.get(preserveKey);
      if (carryover) preservedCount += 1;
      lines.push({
        id: `line-${String(lineNumber).padStart(3, '0')}`,
        characterId: match?.id || null,
        characterName: rawSpeaker || null,
        text,
        voiceIdOverride: carryover?.voiceIdOverride || null,
        audioJobId: carryover?.audioJobId || null,
        audioFilename: carryover?.audioFilename || null,
      });
      lineNumber += 1;
    }
  }
  return { lines, preservedCount };
}

export async function synthesizeToFile({ text, voiceId, signal } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new ServerError('text is required', { status: 400, code: 'PIPELINE_AUDIO_EMPTY_TEXT' });
  }
  const { engine, voice } = parseVoiceId(voiceId);
  const opts = { signal };
  if (engine) opts.engine = engine;
  if (voice) opts.voice = voice;

  const { wav, latencyMs, engine: usedEngine } = await synthesize(trimmed, opts);
  await ensureDir(PATHS.audio);
  // UUID filename keeps two simultaneous renders from colliding; the line's
  // audioJobId-or-audioFilename binding lives in stages.audio.lines[].
  const filename = `vo-${randomUUID()}.wav`;
  await writeFile(join(PATHS.audio, filename), wav);
  return { filename, latencyMs, engine: usedEngine, voiceId: voice ? `${usedEngine}:${voice}` : null };
}
