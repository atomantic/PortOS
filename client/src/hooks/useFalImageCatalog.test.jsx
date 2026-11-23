import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../services/apiCore.js', () => ({ request: vi.fn() }));
import { request } from '../services/apiCore.js';
import FalModelSelect from '../components/imageGen/FalModelSelect.jsx';
import { FAL_FEATURED_IMAGE_MODEL_IDS } from '../lib/imageGenBackends';

describe('fal.ai image model picker', () => {
  it('leads with the featured endpoints and appends a listed model', async () => {
    request.mockResolvedValue({
      models: [
        { id: 'fal-ai/nano-banana-pro', label: 'LIVE NAME', category: 'text-to-image' },
        { id: 'fal-ai/flux/schnell', label: 'FLUX Schnell', category: 'text-to-image' },
      ],
      stale: false,
      bundled: false,
    });
    render(<FalModelSelect id="fal-model" ariaLabel="fal.ai model" value="" onChange={() => {}} />);
    const select = screen.getByLabelText('fal.ai model');
    await waitFor(() => expect([...select.options].some((option) => option.value === 'fal-ai/flux/schnell')).toBe(true));
    const featured = [...select.querySelectorAll('optgroup[label="Featured"] option')].map((option) => option.value);
    expect(featured).toEqual([...FAL_FEATURED_IMAGE_MODEL_IDS]);
    expect([...select.options].find((option) => option.value === 'fal-ai/nano-banana-pro').textContent).toContain('$0.15/image');
    expect([...select.options].find((option) => option.value === 'fal-ai/nano-banana-pro').textContent).not.toContain('LIVE NAME');
    const all = [...select.querySelectorAll('optgroup[label="All image models"] option')].map((option) => option.value);
    expect(all).toContain('fal-ai/flux/schnell');
    expect(all).not.toContain(FAL_FEATURED_IMAGE_MODEL_IDS[0]);
  });
});
