import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The Adapt-LLM picker fetches prompts + providers on mount; this suite only
// cares about the World style row, so stub it out.
vi.mock('./StagePromptModelPicker', () => ({
  default: () => null,
}));

import StoryboardConfigTab from './StoryboardConfigTab';
import { STYLE_ID, WR_IMAGE_DEFAULTS } from '../../lib/wrImageDefaults';

const baseProps = {
  imageCfg: WR_IMAGE_DEFAULTS,
  models: [],
  availableBackends: [],
  onCfgChange: () => {},
  stylePresets: [{ id: 'noir', label: 'Noir', category: 'Film', prompt: 'high contrast noir', negativePrompt: '' }],
  imageStyle: { presetId: 'noir', prompt: 'high contrast noir', negativePrompt: '' },
  onStyleChange: () => {},
  onOpenImageGenSettings: () => {},
};

describe('StoryboardConfigTab', () => {
  afterEach(() => {
    cleanup();
  });

  // The world-style Clear button used to be bare 9px text with no padding — a
  // ~10x22px tap target on a phone (#3565). Assert the utility tokens rather
  // than computed geometry; jsdom applies no Tailwind.
  it('a11y: the world-style Clear button meets the 44px touch-target floor', () => {
    render(<StoryboardConfigTab {...baseProps} />);

    const clearBtn = screen.getByRole('button', { name: 'Clear' });
    expect(clearBtn.className).toContain('min-h-[44px]');
    expect(clearBtn.className).toContain('min-w-[44px]');
  });

  it('hides the Clear button when no world style is set', () => {
    render(<StoryboardConfigTab {...baseProps} imageStyle={{ presetId: STYLE_ID.NONE, prompt: '', negativePrompt: '' }} />);

    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});
