import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFalH3MaxPrompt, FAL_H3_MAX_FREE_URL, openFalH3MaxFreeTool,
} from './falVideoHandoff.js';

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: toastMocks }));

describe('fal H3 Max free-tool handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  it('preserves the shot and appends a non-empty avoid list', () => {
    expect(buildFalH3MaxPrompt('  One continuous tracking shot.  ', ' cuts, logos '))
      .toBe('One continuous tracking shot.\n\nAvoid: cuts, logos');
    expect(buildFalH3MaxPrompt('A quiet room.', '  ')).toBe('A quiet room.');
  });

  it('opens the free tool and copies the prepared prompt', async () => {
    expect(openFalH3MaxFreeTool({ prompt: 'The door opens.', negativePrompt: 'cuts' })).toBe(true);
    expect(globalThis.open).toHaveBeenCalledWith(FAL_H3_MAX_FREE_URL, '_blank', 'noopener,noreferrer');
    await vi.waitFor(() => expect(globalThis.navigator.clipboard.writeText)
      .toHaveBeenCalledWith('The door opens.\n\nAvoid: cuts'));
  });

  it('does nothing when no prompt is ready', () => {
    expect(openFalH3MaxFreeTool({ prompt: '  ' })).toBe(false);
    expect(globalThis.open).not.toHaveBeenCalled();
  });

  it('returns the prepared prompt to the caller when automatic copying fails', async () => {
    const onCopyFailure = vi.fn();
    globalThis.navigator.clipboard.writeText.mockRejectedValueOnce(new Error('blocked'));

    openFalH3MaxFreeTool({
      prompt: 'The door opens.', negativePrompt: 'cuts', onCopyFailure,
    });

    await vi.waitFor(() => expect(onCopyFailure)
      .toHaveBeenCalledWith('The door opens.\n\nAvoid: cuts'));
  });
});
