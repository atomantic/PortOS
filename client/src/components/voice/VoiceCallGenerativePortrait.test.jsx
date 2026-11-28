import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const idleStreams = [];
vi.mock('../../services/apiVoiceAvatar', () => ({
  streamVoiceAvatar: vi.fn(() => new Promise(() => {})),
  // Each idle request stays open until aborted, like a long neural idle chunk.
  streamVoiceAvatarIdle: vi.fn(({ stage, signal, onFrame }) => new Promise((resolve) => {
    idleStreams.push({ stage, signal, onFrame });
    signal.addEventListener('abort', resolve, { once: true });
  })),
}));
vi.mock('../../services/voiceClient', () => ({ bindVoiceOutputVisualizer: () => () => {} }));
vi.mock('../MediaImage', () => ({ default: () => null }));

import VoiceCallGenerativePortrait from './VoiceCallGenerativePortrait';
import { streamVoiceAvatarIdle } from '../../services/apiVoiceAvatar';

const drawImage = vi.fn();
const originals = {};

beforeEach(() => {
  idleStreams.length = 0;
  drawImage.mockClear();
  streamVoiceAvatarIdle.mockClear();
  originals.getContext = HTMLCanvasElement.prototype.getContext;
  originals.Image = globalThis.Image;
  HTMLCanvasElement.prototype.getContext = () => ({ drawImage });
  globalThis.Image = class { decode() { return Promise.resolve(); } };
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originals.getContext;
  globalThis.Image = originals.Image;
});

describe('VoiceCallGenerativePortrait', () => {
  it('stops neural idle while thinking, loops recent frames, and resumes after', async () => {
    const { rerender } = render(<VoiceCallGenerativePortrait running stage="listening" />);
    await waitFor(() => expect(idleStreams).toHaveLength(1));
    const listening = idleStreams[0];
    expect(listening.stage).toBe('listening');
    for (const jpeg of ['a', 'b', 'c']) listening.onFrame({ jpeg });
    await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(3));

    rerender(<VoiceCallGenerativePortrait running stage="thinking" />);
    // The open idle request is cancelled so the worker stops rendering, and no new one starts.
    expect(listening.signal.aborted).toBe(true);
    // The canvas keeps moving by replaying the frames it already painted.
    await waitFor(() => expect(drawImage.mock.calls.length).toBeGreaterThan(6));
    expect(streamVoiceAvatarIdle).toHaveBeenCalledTimes(1);

    rerender(<VoiceCallGenerativePortrait running stage="idle" />);
    await waitFor(() => expect(idleStreams).toHaveLength(2));
    expect(idleStreams[1].stage).toBe('idle');
  });

  it('treats a model load like thinking and never requests idle frames during it', async () => {
    render(<VoiceCallGenerativePortrait running stage="loading" />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(streamVoiceAvatarIdle).not.toHaveBeenCalled();
  });
});
