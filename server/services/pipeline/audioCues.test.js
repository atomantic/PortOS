import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the LLM driver so deriveAudioCues never hits a provider.
const runStagedLLMMock = vi.fn();
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: (...a) => runStagedLLMMock(...a),
}));

const {
  deriveAudioCues,
  preserveRenderedCues,
  ERR_NO_SOURCE,
  ERR_EMPTY_RESULT,
  __testing,
} = await import('./audioCues.js');

describe('audioCues — pure internals', () => {
  describe('episodeBeatText', () => {
    it('prefers idea.output (beats) over idea.input (synopsis)', () => {
      const issue = { stages: { idea: { output: 'BEATS', input: 'SYNOPSIS' } } };
      expect(__testing.episodeBeatText(issue)).toBe('BEATS');
    });
    it('falls back to idea.input when output is empty', () => {
      const issue = { stages: { idea: { output: '   ', input: 'SYNOPSIS' } } };
      expect(__testing.episodeBeatText(issue)).toBe('SYNOPSIS');
    });
    it('returns empty string when neither is present', () => {
      expect(__testing.episodeBeatText({ stages: { idea: {} } })).toBe('');
      expect(__testing.episodeBeatText({})).toBe('');
    });
  });

  describe('renderScenesForPrompt', () => {
    it('returns the no-scenes placeholder for an empty list', () => {
      expect(__testing.renderScenesForPrompt([])).toMatch(/no storyboard scenes/i);
      expect(__testing.renderScenesForPrompt(null)).toMatch(/no storyboard scenes/i);
    });
    it('numbers scenes and prefers heading + summary', () => {
      const out = __testing.renderScenesForPrompt([
        { heading: 'The kitchen', summary: 'Jean waits.' },
        { heading: 'The roof' },
      ]);
      expect(out).toContain('1. The kitchen — Jean waits.');
      expect(out).toContain('2. The roof');
    });
  });

  describe('sanitizeDerivedCue', () => {
    it('drops a cue with no prompt', () => {
      expect(__testing.sanitizeDerivedCue({ label: 'x' }, 0, 'musicgen')).toBeNull();
    });
    it('builds an un-rendered, un-placed cue with sequential id + default engine', () => {
      const cue = __testing.sanitizeDerivedCue({ label: 'Act I', prompt: 'pads' }, 0, 'audioldm2');
      expect(cue).toMatchObject({
        id: 'cue-001', label: 'Act I', prompt: 'pads', engine: 'audioldm2',
        startSec: null, endSec: null, trackFilename: null, durationSec: null, gain: null,
      });
    });
    it('honors a per-cue engine hint over the default', () => {
      const cue = __testing.sanitizeDerivedCue({ prompt: 'p', engine: 'suno' }, 3, 'musicgen');
      expect(cue.engine).toBe('suno');
      expect(cue.id).toBe('cue-004');
    });
    it('defaults the label when absent', () => {
      const cue = __testing.sanitizeDerivedCue({ prompt: 'p' }, 1, 'musicgen');
      expect(cue.label).toBe('Cue 2');
    });
  });
});

describe('preserveRenderedCues', () => {
  it('returns fresh cues unchanged when there is no prior rendered audio', () => {
    const fresh = [{ id: 'cue-001', label: 'A', trackFilename: null }];
    expect(preserveRenderedCues(fresh, [])).toEqual(fresh);
    expect(preserveRenderedCues(fresh, [{ label: 'A', trackFilename: null }])).toEqual(fresh);
  });
  it('carries a rendered track forward onto the matching fresh label (case-insensitive)', () => {
    const fresh = [
      { id: 'cue-001', label: 'Act I', prompt: 'new prompt', trackFilename: null, durationSec: null },
      { id: 'cue-002', label: 'Climax', trackFilename: null, durationSec: null },
    ];
    const prior = [{ label: 'act i', trackFilename: 'music-gen-x.wav', durationSec: 42 }];
    const merged = preserveRenderedCues(fresh, prior);
    expect(merged[0].trackFilename).toBe('music-gen-x.wav');
    expect(merged[0].durationSec).toBe(42);
    // The fresh prompt is kept — only the render artifacts carry over.
    expect(merged[0].prompt).toBe('new prompt');
    // A label with no prior match stays un-rendered.
    expect(merged[1].trackFilename).toBeNull();
  });
});

describe('deriveAudioCues', () => {
  beforeEach(() => runStagedLLMMock.mockReset());

  const issueWithBeats = {
    number: 3, title: 'Ep',
    stages: { idea: { output: 'Act 1 setup. Act 2 climax.' }, storyboards: { scenes: [{ heading: 'A' }] } },
  };

  it('throws PIPELINE_AUDIO_CUES_NO_SOURCE when the episode has no beats', async () => {
    await expect(deriveAudioCues({ stages: { idea: {} } })).rejects.toMatchObject({ code: ERR_NO_SOURCE, status: 400 });
    expect(runStagedLLMMock).not.toHaveBeenCalled();
  });

  it('runs the cue-planner stage and returns sanitized cues with the default engine', async () => {
    runStagedLLMMock.mockResolvedValue({
      content: { cues: [
        { label: 'Act I', prompt: 'warm pads' },
        { label: 'Climax', prompt: 'tense strings' },
      ] },
      runId: 'r1', providerId: 'p', model: 'm',
    });
    const { cues, runId } = await deriveAudioCues(issueWithBeats, { defaultEngine: 'audioldm2' });
    expect(runStagedLLMMock).toHaveBeenCalledWith('pipeline-audio-cues', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ id: 'cue-001', label: 'Act I', prompt: 'warm pads', engine: 'audioldm2', startSec: null, trackFilename: null });
    expect(cues[1].id).toBe('cue-002');
    expect(runId).toBe('r1');
  });

  it('drops prompt-less cues and re-indexes ids sequentially', async () => {
    runStagedLLMMock.mockResolvedValue({
      content: { cues: [
        { label: 'A', prompt: 'p1' },
        { label: 'B' },          // dropped — no prompt
        { label: 'C', prompt: 'p3' },
      ] },
    });
    const { cues } = await deriveAudioCues(issueWithBeats, { defaultEngine: 'musicgen' });
    expect(cues.map((c) => c.id)).toEqual(['cue-001', 'cue-002']);
    expect(cues.map((c) => c.label)).toEqual(['A', 'C']);
  });

  it('throws PIPELINE_AUDIO_CUES_EMPTY when no usable cues come back', async () => {
    runStagedLLMMock.mockResolvedValue({ content: { cues: [{ label: 'no prompt' }] } });
    await expect(deriveAudioCues(issueWithBeats)).rejects.toMatchObject({ code: ERR_EMPTY_RESULT });
  });
});
