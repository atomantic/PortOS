import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({ getProviders: vi.fn() }));
vi.mock('../../services/apiLocalLlm', () => ({ getVisionModels: vi.fn(), getToolUseModels: vi.fn() }));

import VisionProviderPicker from './VisionProviderPicker';
import { getProviders } from '../../services/api';
import { getVisionModels } from '../../services/apiLocalLlm';

// A local backend whose ONLY vision-capable model belongs to a family the
// client id regex predates — the `gemma4` gap, restaged with a placeholder id
// so it keeps testing the GAP rather than whichever families the regex has
// since learned. Regex-only, this picker renders empty.
const VLM_ID = 'muse-glimmer:30b';
const OLLAMA = {
  id: 'ollama',
  name: 'Ollama',
  type: 'api',
  enabled: true,
  endpoint: 'http://127.0.0.1:11434',
  defaultModel: 'qwen3.6:35b',
  models: ['qwen3.6:35b', VLM_ID, 'nomic-embed-text'],
};

// Cloud providers are never id-filtered — the regex is a local-name heuristic.
const CLOUD = {
  id: 'cloud-api',
  name: 'Cloud API',
  type: 'api',
  enabled: true,
  defaultModel: 'omni-1',
  models: ['omni-1', 'omni-1-mini'],
};

const modelSelect = () => screen.getByLabelText('Model');

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue({ providers: [OLLAMA] });
  getVisionModels.mockResolvedValue({ models: [] });
});

describe('VisionProviderPicker', () => {
  it('offers a VLM the client id regex does not recognize, once the server list lands', async () => {
    getVisionModels.mockResolvedValue({
      models: [{ id: VLM_ID, backend: 'ollama', providerId: 'ollama', vision: true }],
    });
    const onChange = vi.fn();
    render(<VisionProviderPicker onChange={onChange} />);

    // The auto-pick is lifted, so the caller's "Run" gate (`!!vision.model`) opens.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: 'ollama', model: VLM_ID, noVisionModel: false }),
    ));
    expect(modelSelect()).toHaveValue(VLM_ID);
    expect(within(modelSelect()).getByRole('option', { name: VLM_ID })).toBeInTheDocument();
    expect(screen.queryByText(/no vision-capable model installed/i)).not.toBeInTheDocument();
  });

  it('still blocks with an explanation when the backend really has no VLM', async () => {
    // The scan settles reporting nothing installed — regex-only is then the best
    // answer available, and it also finds nothing.
    render(<VisionProviderPicker onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/no vision-capable model installed/i)).toBeInTheDocument());
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('does not flash the blocker while the capability scan is still in flight', async () => {
    let settle;
    getVisionModels.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const onChange = vi.fn();
    render(<VisionProviderPicker onChange={onChange} />);

    // Providers have loaded and the regex found nothing — but "don't know yet"
    // must not render as "none installed".
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(screen.queryByText(/no vision-capable model installed/i)).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ noVisionModel: false, loading: true }),
    );

    settle({ models: [] });
    await waitFor(() => expect(screen.getByText(/no vision-capable model installed/i)).toBeInTheDocument());
  });

  it('leaves a cloud provider unfiltered while the scan is pending', async () => {
    getProviders.mockResolvedValue({ providers: [CLOUD] });
    getVisionModels.mockReturnValue(new Promise(() => {}));
    render(<VisionProviderPicker onChange={vi.fn()} />);

    // No local backend selected → nothing to wait for; the cloud list is final.
    await waitFor(() => expect(modelSelect()).toHaveValue('omni-1'));
    expect(screen.queryByText(/no vision-capable model installed/i)).not.toBeInTheDocument();
  });

  it('explains the empty case when no provider is configured at all', async () => {
    getProviders.mockResolvedValue({ providers: [] });
    render(<VisionProviderPicker onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/No API provider with a vision-capable model/i)).toBeInTheDocument());
  });
});
