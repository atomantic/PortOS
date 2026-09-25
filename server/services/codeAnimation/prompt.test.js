import { describe, expect, it } from 'vitest';
import {
  buildCodeAnimationPrompt,
  extractAnimationHtml,
  resolveFrameSize,
  CODE_ANIMATION_AUDIO_GLOBAL,
  CODE_ANIMATION_MESSAGES,
} from './prompt.js';

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

  it('turns a character bible into rigging instructions, and omits them without one', () => {
    const withCast = buildCodeAnimationPrompt({
      concept: 'x',
      cast: 'Wick — a palm-sized paper lantern whose wire handle droops when sad',
      format,
    });
    expect(withCast).toContain('CHARACTERS — the design bible');
    expect(withCast).toContain('Wick — a palm-sized paper lantern whose wire handle droops when sad');
    expect(withCast).toContain('procedural face');
    expect(buildCodeAnimationPrompt({ concept: 'x', format })).not.toContain('CHARACTERS —');
  });

  it('holds every film to the direction bar and a pre-answer self-review', () => {
    const prompt = buildCodeAnimationPrompt({ concept: 'x', format });
    expect(prompt).toContain('DIRECTION — make it feel like a studio short');
    expect(prompt).toContain('virtual camera');
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
    expect(buildCodeAnimationPrompt({ concept: 'x', format })).toContain('The animation is silent');
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
