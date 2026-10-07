import { describe, expect, it } from 'vitest';
import {
  buildCodeAnimationPrompt,
  buildMusicVideoCodePrompt,
  buildMixedMediaDocumentPrompt,
  PACING_RULE,
  extractAnimationHtml,
  extractCodeSections,
  resolveFrameSize,
  CODE_ANIMATION_AUDIO_GLOBAL,
  CODE_ANIMATION_MESSAGES,
} from './prompt.js';
import { buildSongDocument } from '../musicVideo/codeTimeline.js';

const format = { durationSeconds: 20, aspectRatio: '16:9', resolution: '1080p', fps: 30 };

describe('buildCodeAnimationPrompt', () => {
  it('makes the universe style the art direction, refined by the per-film notes', () => {
    const prompt = buildCodeAnimationPrompt({
      concept: 'A lantern drifts over a sleeping city',
      styleNotes: 'slower camera, more fog',
      format,
      universe: {
        name: 'Example Universe',
        embrace: ['ink wash', 'muted indigo'],
        avoid: ['photorealism'],
        styleNotes: 'quiet and melancholic',
        styleReferences: [{ title: 'Night markets', prompt: 'paper lanterns, wet cobblestones' }],
      },
    });
    expect(prompt).toContain('The art style comes from the universe "Example Universe"');
    expect(prompt).toContain('Visual style to embrace: ink wash, muted indigo');
    expect(prompt).toContain('Visual style to avoid: photorealism');
    expect(prompt).toContain('Night markets: paper lanterns, wet cobblestones');
    expect(prompt).toContain('Refinements for this animation: slower camera, more fog');
    expect(prompt).not.toContain('No style was specified');
  });

  it('places one style grammar between the universe lines and the notes, with stated precedence, and is unchanged without one', () => {
    const input = {
      concept: 'x', styleNotes: 'slower camera', format,
      universe: { name: 'Example Universe', embrace: ['ink wash'], avoid: [], styleNotes: '', styleReferences: [] },
    };
    const plain = buildCodeAnimationPrompt(input);
    expect(plain).not.toContain('STYLE GRAMMAR');
    expect(buildCodeAnimationPrompt({ ...input, styleGrammarId: null })).toBe(plain);
    const prompt = buildCodeAnimationPrompt({ ...input, styleGrammarId: 'blueprint-draft' });
    expect(prompt.match(/STYLE GRAMMAR:/g)).toHaveLength(1);
    expect(prompt).toContain('Film style grammar: Blueprint draft');
    expect(prompt).toContain('the style grammar wins on rendering technique, motion stepping, camera moves and sound');
    const at = (text) => prompt.indexOf(text);
    expect(at('Visual style to embrace')).toBeLessThan(at('STYLE GRAMMAR:'));
    expect(at('STYLE GRAMMAR:')).toBeLessThan(at('Refinements for this animation'));
    expect(at('Refinements for this animation')).toBeLessThan(at('SOUND:'));
  });

  it('teaches the three renderer to import through the host import map, and leaves the other renderers untouched (#10464)', () => {
    const input = { concept: 'A lantern drifts over a sleeping city', format };
    const three = buildCodeAnimationPrompt({ ...input, renderer: 'three' });
    expect(three).toContain("import * as THREE from 'three'");
    expect(three).toContain('host serves three locally and adds the import map');
    expect(three).toContain('three/addons/postprocessing/');
    expect(three).toContain('about 2.0 by day');
    expect(three).toContain('PCFSoftShadowMap was removed');
    // The no-library rule gains exactly one exception, and only for three.
    expect(three).toContain('The ONE exception is the host-provided import map');
    for (const renderer of ['auto', 'canvas2d', 'webgl', 'svg']) {
      const prompt = buildCodeAnimationPrompt({ ...input, renderer });
      expect(prompt).not.toContain('import map');
      expect(prompt).toContain('no external scripts, stylesheets, fonts, images, or network requests of any kind; system fonts only. It must run');
    }
  });

  it('rejects an unknown style grammar id', () => {
    expect(() => buildCodeAnimationPrompt({ concept: 'x', format, styleGrammarId: 'no-such-style' })).toThrow(/Unknown film style grammar/);
  });

  it('turns a character bible into rigging instructions, and omits them without one', () => {
    const withCast = buildCodeAnimationPrompt({
      concept: 'x',
      cast: 'Wick — a palm-sized paper lantern whose wire handle droops when sad',
      format,
    });
    expect(withCast).toContain('CHARACTERS — the design bible');
    expect(withCast).toContain('Wick — a palm-sized paper lantern whose wire handle droops when sad');
    expect(buildCodeAnimationPrompt({ concept: 'x', format })).not.toContain('CHARACTERS —');
  });

  it('holds every film to the direction bar and a pre-answer self-review', () => {
    const prompt = buildCodeAnimationPrompt({ concept: 'x', format });
    expect(prompt).toContain('DIRECTION — make it feel like a studio short');
    expect(prompt).toContain('SELF-REVIEW before you answer');
    // The self-review follows the runtime contract, right before the output rule.
    expect(prompt.indexOf('SELF-REVIEW')).toBeGreaterThan(prompt.indexOf('RUNTIME CONTRACT'));
    expect(prompt.indexOf('SELF-REVIEW')).toBeLessThan(prompt.indexOf('OUTPUT:'));
  });

  it('lets the model choose a style only when nothing configures one', () => {
    expect(buildCodeAnimationPrompt({ concept: 'x', format })).toContain('No style was specified');
    const withBoard = buildCodeAnimationPrompt({
      concept: 'x',
      format,
      moodBoard: { name: 'Dusk', description: null, items: [{ kind: 'text', note: 'amber haze' }], droppedItems: 0 },
    });
    expect(withBoard).not.toContain('No style was specified');
    expect(withBoard).toContain('note: amber haze');
  });

  it('pins the host runtime contract at the resolved frame size', () => {
    const prompt = buildCodeAnimationPrompt({ concept: 'x', format: { ...format, aspectRatio: '9:16', resolution: '720p', fps: 24 } });
    expect(prompt).toContain('exactly 720×1280px');
    expect(prompt).toContain('window.renderFrame(t)');
    expect(prompt).toContain('canvas.captureStream(24)');
    for (const type of [CODE_ANIMATION_MESSAGES.ready, CODE_ANIMATION_MESSAGES.record, CODE_ANIMATION_MESSAGES.recorded, CODE_ANIMATION_MESSAGES.error]) {
      expect(prompt).toContain(type);
    }
  });

  it('drives the timeline from a supplied track, and composes one only on request', () => {
    const withTrack = buildCodeAnimationPrompt({
      concept: 'x',
      format,
      audio: { name: 'theme.mp3', durationSeconds: 31.5, notes: '120 BPM, drop at 0:16' },
    });
    expect(withTrack).toContain(`window.${CODE_ANIMATION_AUDIO_GLOBAL}`);
    expect(withTrack).toContain('"theme.mp3" (31.5s long)');
    expect(withTrack).toContain('120 BPM, drop at 0:16');
    expect(withTrack).toContain('MediaStreamAudioDestinationNode');

    const procedural = buildCodeAnimationPrompt({ concept: 'x', format, soundtrack: 'procedural' });
    expect(procedural).toContain('procedural soundtrack');
    expect(procedural).toContain('Silence is a beat');
    expect(procedural).toContain('MediaStreamAudioDestinationNode');
    const silent = buildCodeAnimationPrompt({ concept: 'x', format });
    expect(silent).toContain('The animation is silent');
    expect(silent).not.toContain('MediaStreamAudioDestinationNode');
  });

  it('gives CLI agents on-disk reference paths and keeps them out of a copied prompt', () => {
    const referenceImages = [{ label: 'hero.png', origin: 'upload', path: '/tmp/example/hero.png', note: 'the silhouette' }];
    const cli = buildCodeAnimationPrompt({ concept: 'x', format, referenceImages, delivery: 'cli' });
    expect(cli).toContain('1. hero.png (/tmp/example/hero.png) — the silhouette');
    expect(cli).toContain('Do not create or edit any files');
    const copy = buildCodeAnimationPrompt({ concept: 'x', format, referenceImages, delivery: 'copy' });
    expect(copy).toContain('attached alongside this prompt');
    expect(copy).not.toContain('/tmp/example/hero.png');
  });
});

describe('resolveFrameSize', () => {
  it('keeps the short side at the resolution and both sides even', () => {
    expect(resolveFrameSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(resolveFrameSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(resolveFrameSize('21:9', '720p')).toEqual({ width: 1680, height: 720 });
    expect(resolveFrameSize('4:5', '1080p')).toEqual({ width: 1080, height: 1350 });
  });
});

describe('extractAnimationHtml', () => {
  const doc = '<!DOCTYPE html>\n<html><body><canvas></canvas></body></html>';

  it.each([
    ['an html fence with commentary around it', `Here you go:\n\`\`\`html\n${doc}\n\`\`\`\nEnjoy!`],
    ['an unlabeled fence holding a document', `\`\`\`\n${doc}\n\`\`\``],
    ['a bare document', `Sure.\n${doc}\nThat is all.`],
  ])('reads %s', (_label, text) => {
    expect(extractAnimationHtml(text)).toBe(doc);
  });

  it('prefers the document fence over an earlier code snippet fence', () => {
    const text = `Setup:\n\`\`\`js\nconst x = 1;\n\`\`\`\n\`\`\`html\n${doc}\n\`\`\``;
    expect(extractAnimationHtml(text)).toBe(doc);
  });

  it('returns null when the response holds no document', () => {
    expect(extractAnimationHtml('I cannot do that.')).toBeNull();
    expect(extractAnimationHtml('')).toBeNull();
    expect(extractAnimationHtml(null)).toBeNull();
  });
});

describe('reference video rhythm', () => {
  // A failed scene-detection pass must not read as a measured "no cuts".
  it('says an unmeasured rhythm is unmeasured instead of reporting one continuous shot', () => {
    const video = (cuts) => buildCodeAnimationPrompt({ concept: 'x', format, referenceVideo: { label: 'Reference', durationSec: 12, cuts, note: '' } });
    expect(video(null)).toContain('its cut rhythm could not be measured');
    expect(video(null)).not.toContain('Measured rhythm');
    expect(video([])).toContain('Measured rhythm: One continuous 12.0s shot with no detected cuts.');
  });
});

// Exercise the production song adapter, not a prompt-only field nobody supplies.
describe('music-video craft and measured choreography', () => {
  const builders = [
    ['native Canvas', buildMusicVideoCodePrompt],
    ['document Canvas', input => buildMixedMediaDocumentPrompt({ ...input, renderer: 'canvas' })],
    ['document Three.js', input => buildMixedMediaDocumentPrompt({ ...input, renderer: 'three' })],
  ];
  const samples = Array.from({ length: 600 }, (_, index) => index / 600);
  const features = {
    envelopes: { fps: 20, rms: samples, low: samples, mid: samples, high: samples },
    onsets: { low: [0.75, 4.25], mid: [1.5], high: [2.75] }, truncatedAtSec: 30,
  };
  const project = {
    audioAnalysis: { durationSec: 32, beats: [0, 0.5, 1, 1.5, 4], downbeats: [0, 4], features,
      sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 32 }] },
    lyricCues: [{ id: 'line', text: 'Open slowly', startSec: 1, endSec: 3,
      words: [{ w: 'Open', startSec: 1.25, endSec: 2 }, { w: 'slowly', startSec: 2.25, endSec: 3 }] }],
  };
  const songSnapshot = prompt => JSON.parse(prompt.match(/^SONG[^\n]*\n([^\n]+)/m)[1]);

  it.each(builders)('gives %s the shared craft bar and bounded real feature/word anchors', (_label, build) => {
    const song = buildSongDocument(project);
    const prompt = build({ title: 'Example measured choreography', song, palette: {}, scenes: [] });
    expect(prompt).toContain('DIRECTION — make it feel like a studio short');
    expect(prompt).toContain(PACING_RULE);
    expect(prompt).toContain('SELF-REVIEW before you answer');
    expect(prompt).toContain('step through render(ctx, env)');
    expect(prompt).not.toContain('step through renderFrame');
    expect(prompt.indexOf('SELF-REVIEW')).toBeLessThan(prompt.indexOf('OUTPUT:'));
    expect(prompt).toContain('Follow the reviewed energy target and give each section a time-based action plan');
    expect(prompt).toContain('Repeated choruses');
    expect(prompt).toContain('does not require rapid cuts or constant motion');
    expect(prompt).toContain("Preserve the host's lyric pass as the authority");
    expect(prompt).toContain('never invent a kick, snare, drop, word timing or missing event');
    const snapshot = songSnapshot(prompt);
    expect(snapshot.beats).toEqual(project.audioAnalysis.beats);
    expect(snapshot.downbeats).toEqual(project.audioAnalysis.downbeats);
    expect(snapshot.lyrics[0].words[0]).toEqual({ text: 'Open', startSec: 1.25, endSec: 2 });
    expect(snapshot.features.onsets).toEqual(features.onsets);
    expect(snapshot.features.truncatedAtSec).toBe(30);
    expect(snapshot.features.envelopes).toMatchObject({ fps: 20, sampleStride: 3 });
    expect(snapshot.features.envelopes.low).toEqual(samples.filter((_, index) => index % 3 === 0));
    expect(snapshot.features.envelopes.low.length).toBeLessThanOrEqual(240);
    expect(song.features.envelopes.low).toEqual(samples); // runtime retains original sampling grid
  });

  it('teaches the Three.js author the host lens contract', () => {
    const prompt = buildMixedMediaDocumentPrompt({ title: 'Lens', song: buildSongDocument(project), palette: {}, scenes: [], renderer: 'three' });
    expect(prompt).toContain('ctx = { THREE, scene, camera, text, lens }');
    expect(prompt).toContain('ctx.lens.focus');
    expect(prompt).toContain('ctx.lens.bloomThreshold');
  });

  it('does not manufacture features for a legacy or malformed analysis', () => {
    for (const features of [null, { ...project.audioAnalysis.features, envelopes: { ...project.audioAnalysis.features.envelopes, low: [1.5] } }]) {
      const song = buildSongDocument({ ...project, audioAnalysis: { ...project.audioAnalysis, features } });
      for (const [, build] of builders) {
        const prompt = build({ song, palette: {}, scenes: [] });
        expect(songSnapshot(prompt).features).toBeNull();
        expect(prompt).toContain('audio feature data is unavailable');
      }
    }
  });
});

describe('extractCodeSections', () => {
  const fn = 'function render(ctx, env) { ctx.fillRect(0, 0, 1, 1); }';
  const valid = JSON.stringify({ sections: [{ id: 'beat-3', source: fn }] });
  it('parses a fenced answer and ignores sections without an id or source', () => {
    expect(extractCodeSections(`\`\`\`json\n${JSON.stringify({ sections: [{ id: 'a', source: fn }, { id: 'b' }] })}\n\`\`\``)).toEqual([{ id: 'a', source: fn }]);
  });
  it('recovers an answer with stray characters after the closing brackets', () => {
    expect(extractCodeSections(`\`\`\`json\n${valid}"}\n\`\`\``)).toEqual([{ id: 'beat-3', source: fn }]);
  });
  it('recovers an answer that left its last section object unclosed', () => {
    const unclosed = `{"sections":[{"id":"beat-3","source":${JSON.stringify(fn)}]}`;
    expect(extractCodeSections(`\`\`\`json\n${unclosed}\n\`\`\``)).toEqual([{ id: 'beat-3', source: fn }]);
  });
  it('recovers an unclosed last section followed by stray characters', () => {
    const both = `{"sections":[{"id":"beat-3","source":${JSON.stringify(fn)}]}"}`;
    expect(extractCodeSections(`\`\`\`json\n${both}\n\`\`\``)).toEqual([{ id: 'beat-3', source: fn }]);
  });
  it('returns nothing for text with no usable JSON', () => {
    expect(extractCodeSections('no json here')).toEqual([]);
    expect(extractCodeSections('```json\n{"sections": [ {"id": \n```')).toEqual([]);
  });
});
