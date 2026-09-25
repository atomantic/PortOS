/**
 * Code-rendered music: the Music Designer's "Code" engine.
 *
 *   writeMusicCode()       musical description → Strudel or Tone.js code the LLM
 *                          wrote (fence-stripped and size-checked; nothing runs here).
 *   saveCodeTakeToTrack()  a WAV the browser recorded from that code → the
 *                          shared music library, appended to the track's render
 *                          history as an `engine: 'code'` take.
 *
 * The code is arbitrary JavaScript, so the server never executes it. The
 * browser runs it inside a sandboxed, network-blocked iframe
 * (client/src/components/music/strudelFrame.js) and records the take there.
 *
 * Nothing here runs on its own: every call is driven by an explicit button
 * press in the same request (AI Provider Usage Policy: no cold bootstrap).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { trimTo } from '../lib/textUtils.js';
import { wavDurationMs, writeWavAudioFile } from '../lib/wavAudioFile.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from './promptRunner.js';
import * as tracks from './tracks/index.js';

const CODE_ENGINE = 'code';
// Strudel was the first language; Tone.js is the second (client/src/components/music/strudelFrame.js
// mounts a frame document per language, same postMessage protocol for both).
export const MUSIC_CODE_LANGUAGES = Object.freeze(['strudel', 'tonejs']);
// Longest code the designer accepts, from the LLM or back from the editor.
export const MUSIC_CODE_MAX = 20000;

const MAX_DESCRIPTION = 8000;
const MAX_LYRICS = 20000;
const MAX_GUIDANCE = 4000;

const section = (label, body) => (body ? `\n\n${label}:\n${body}` : '');

/** The Strudel writing contract sent to the LLM. */
function buildStrudelPrompt({ description, lyrics, guidance, current }) {
  return `You are a composer who writes music as Strudel code (the JavaScript port of TidalCycles, strudel.cc). The code runs in a browser with the @strudel/web bundle and is the whole piece: there is no audio model and no DAW.${
    section('MUSIC TO WRITE', trimTo(description, MAX_DESCRIPTION) || '(none given)')
  }${
    section('LYRICS / THEME (mood only; nothing is sung, so instruments carry the melody)', trimTo(lyrics, MAX_LYRICS))
  }${
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE))
  }${
    current ? section('CURRENT CODE (revise it per the request above; keep what works, change what is asked)', current) : ''
  }

Return ONLY the Strudel code: no prose and no markdown fence. It is evaluated exactly like the strudel.cc REPL:
- Set the tempo first with setcps(BPM / 60 / 4), e.g. setcps(0.5) for 120 BPM in 4/4.
- End with ONE pattern expression, usually stack(...) with one layer per part (lead, bass, harmony, drums).
- Double-quoted strings are mini-notation: "c3 e3 g3" steps, "~" rests, "[a b]" subdivides a step, "<a b c>" picks one per cycle, "a*4" repeats, "a!2" duplicates, "a@3" lengthens.
- Pitch: note("c3 eb3 g3") or n("0 2 4 <5 7>").scale("C4:minor"). Chords: note("<[c3,eb3,g3] [ab2,c3,eb3]>").
- Sounds: ONLY these built-in synths exist: "sine", "triangle", "square", "sawtooth", "supersaw", "pulse", the noises "white", "pink", "brown", "crackle", and the synth kick "sbd". Pick one with .s("sawtooth"). NO samples are loaded, so s("bd"), s("hh"), s("piano"), and samples(...) fail. Never load or fetch anything.
- Drums from synths: kick s("sbd*4"); snare s("~ pink ~ pink").decay(.12).sustain(0); hats s("white*8").decay(.04).sustain(0).gain(.35).
- Shape sounds with .lpf(), .hpf(), .attack(), .decay(), .sustain(), .release(), .gain(), .pan(), .room(), .delay(), .vowel(); slow or vary with .slow(), .fast(), .every(4, x => x.rev()), .sometimes(...).
- Keep master levels sensible (layer gains around 0.3-0.8).

Compose real music: a memorable melody, a bassline that moves, harmony, and percussion that grooves unless the description asks otherwise. Stay in key, and use "<...>" alternation over several cycles so the piece develops instead of looping one bar.`;
}

/** The Tone.js writing contract sent to the LLM. */
function buildTonejsPrompt({ description, lyrics, guidance, current }) {
  return `You are a composer who writes music as plain JavaScript against the Tone.js library (tonejs.github.io/), running against the global \`Tone\`. The code IS the whole piece: there is no audio model and no DAW, and it runs once per play.${
    section('MUSIC TO WRITE', trimTo(description, MAX_DESCRIPTION) || '(none given)')
  }${
    section('LYRICS / THEME (mood only; nothing is sung, so instruments carry the melody)', trimTo(lyrics, MAX_LYRICS))
  }${
    section('ADDITIONAL GUIDANCE FROM THE USER', trimTo(guidance, MAX_GUIDANCE))
  }${
    current ? section('CURRENT CODE (revise it per the request above; keep what works, change what is asked)', current) : ''
  }

Return ONLY the JavaScript: no prose and no markdown fence. Rules for the code:
- The host has already unlocked audio and reset the transport before your code runs; do not call Tone.start().
- Build the graph, schedule the music (Tone.Transport.schedule, Tone.Transport.scheduleRepeat, or a Tone.Part/Tone.Sequence), then call Tone.Transport.start() as the LAST statement so playback actually begins.
- Only these built-in instruments exist, all playable with no external files: Tone.Synth, Tone.AMSynth, Tone.FMSynth, Tone.MonoSynth, Tone.DuoSynth, Tone.PluckSynth, Tone.MembraneSynth (kick/toms), Tone.MetalSynth (hats/cymbals), Tone.NoiseSynth (noise/snare), and Tone.PolySynth(Tone.Synth) (or another synth) for chords. NEVER use Tone.Player, Tone.GrainPlayer, Tone.Sampler, Tone.UserMedia, or any URL/buffer/sample loading — there is no network access and no sample files, so they always fail.
- Shape and route sound with the built-in effects: Tone.Filter, Tone.EQ3, Tone.Distortion, Tone.Chorus, Tone.FeedbackDelay, Tone.Reverb, Tone.Compressor, Tone.Gain, Tone.Panner. Chain with .connect() or .chain(), and end every audible chain with .toDestination().
- Note names are strings like "C3", "Eb4", "G#2"; durations are Tone.js notation like "8n", "4n.", "16t". Use Tone.Time/Tone.Frequency helpers as needed.
- Set the tempo with Tone.Transport.bpm.value = BPM before scheduling.
- Keep levels sensible: set instrument/gain .volume around -12 to -6 dB per layer so a full mix doesn't clip.
- Wrap the whole body in a try/catch only if you need to recover from an error yourself; otherwise let errors propagate so they can be reported.

Compose real music: a memorable melody, a bassline that moves, harmony, and percussion that grooves unless the description asks otherwise. Stay in key, and vary the pattern over multiple bars (with scheduleRepeat callbacks or a Part with several events) so the piece develops instead of looping one bar forever.`;
}

const PROMPT_BUILDERS = { strudel: buildStrudelPrompt, tonejs: buildTonejsPrompt };

// A reply usually arrives bare, but a fenced block (with or without prose
// around it) is common. Take the first fence's body when there is one.
const FENCE_RE = /```[^\n`]*\n([\s\S]*?)\n?```/;
function extractCode(text) {
  const raw = typeof text === 'string' ? text : '';
  const fenced = raw.match(FENCE_RE);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Ask the chosen provider to write the piece as code. `current` (the code in
 * the editor) turns the call into a revision of it.
 */
export async function writeMusicCode({ description, lyrics, guidance, current, language = 'strudel', providerId, model, effort } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, { message: 'No AI provider available to write the music code', code: 'NO_PROVIDER' });

  const buildPrompt = PROMPT_BUILDERS[language] || buildStrudelPrompt;
  const run = await runPromptThroughProvider({
    provider,
    model: selectedModel ?? undefined,
    effort,
    prompt: buildPrompt({ description, lyrics, guidance, current: trimTo(current, MUSIC_CODE_MAX) }),
    source: 'music-code',
  });

  const code = extractCode(run.text);
  if (!code) {
    throw new ServerError('The AI returned no code. Try rerunning or picking a stronger model.', { status: 502, code: 'MUSIC_CODE_EMPTY' });
  }
  if (code.length > MUSIC_CODE_MAX) {
    throw new ServerError(`The AI returned more than ${MUSIC_CODE_MAX} characters of code. Try rerunning or asking for a shorter piece.`, {
      status: 502, code: 'MUSIC_CODE_TOO_LONG',
    });
  }
  const ranModel = run.model ?? selectedModel ?? null;
  console.log(`🎹 Wrote ${language} music code via ${provider.id}/${ranModel || 'default'} (${code.length} chars)`);
  return { language, code, llm: { provider: run.provider?.id || provider.id, model: ranModel } };
}

/**
 * Land a browser-recorded WAV (a Buffer) in the shared music library and make
 * it the track's active take.
 */
export async function saveCodeTakeToTrack({ trackId, wav, prompt, title }) {
  const durationMs = wavDurationMs(wav);
  if (!durationMs) {
    throw new ServerError('The take must be a PCM WAV file', { status: 400, code: 'MUSIC_CODE_TAKE_NOT_WAV' });
  }
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });

  const filename = await writeWavAudioFile(wav, PATHS.music, `music-${randomUUID()}`);
  const durationSec = Math.max(1, Math.round(durationMs / 1000));
  const updated = await tracks.appendActiveTake(trackId, {
    audioFilename: filename, prompt: prompt || track.prompt, engine: CODE_ENGINE, durationSec,
  }, title ? { title } : {});
  if (!updated) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🎹 Saved code-rendered take (${durationSec}s)`);
  return { track: updated, filename, durationSec };
}
