import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../services/apiPrompts', () => ({
  getPrompt: vi.fn(),
  savePrompt: vi.fn(),
}));

vi.mock('../../services/apiProviders', () => ({
  getProviders: vi.fn(),
}));

vi.mock('../ui/Toast');

import StagePromptModelPicker from './StagePromptModelPicker';
import { getPrompt } from '../../services/apiPrompts';
import { getProviders } from '../../services/apiProviders';

describe('StagePromptModelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('a11y: Tier and Specific mode toggle buttons meet the 44px touch-target floor', async () => {
    getPrompt.mockResolvedValue({ provider: null, model: 'default', timeout: null });
    getProviders.mockResolvedValue({
      activeProvider: 'openai',
      providers: [
        { id: 'openai', enabled: true, defaultModel: 'gpt-4o', models: ['gpt-4o'] },
      ],
    });

    render(<StagePromptModelPicker stageName="adapt" label="Adapt Stage" />);

    const tierBtn = await screen.findByRole('button', { name: 'Tier' });
    const specificBtn = await screen.findByRole('button', { name: 'Specific' });

    expect(tierBtn.className).toContain('min-h-[44px]');
    expect(tierBtn.className).toContain('min-w-[44px]');
    expect(tierBtn.className).toContain('flex');
    expect(tierBtn.className).toContain('items-center');
    expect(tierBtn.className).toContain('justify-center');

    expect(specificBtn.className).toContain('min-h-[44px]');
    expect(specificBtn.className).toContain('min-w-[44px]');
    expect(specificBtn.className).toContain('flex');
    expect(specificBtn.className).toContain('items-center');
    expect(specificBtn.className).toContain('justify-center');
  });
});
