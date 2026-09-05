import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  updateCosConfig: vi.fn(),
}));
const localLlm = vi.hoisted(() => ({ getToolUseModels: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../../services/apiLocalLlm', () => localLlm);

import PersistentMindThinkingPresets from './PersistentMindThinkingPresets.jsx';

const PRESET = {
  id: 'deep-think', label: 'Deep think', providerId: 'example-cloud', model: 'example-large', effort: 'high',
};

// The Mind page re-derives this list from each `GET /api/cos/mind` response and
// re-renders on a 10s runtime poll and on every socket event — so the array
// identity changes while the editor is open, with identical CONTENTS. A host
// that rebuilds it on every render reproduces that faithfully.
const RefetchingHost = () => {
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setTick(tick + 1)}>Refresh</button>
      <PersistentMindThinkingPresets
        presets={[{ ...PRESET }]}
        editingPresetId="deep-think"
        onEditPreset={() => {}}
      />
    </div>
  );
};

describe('PersistentMindThinkingPresets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({
      activeProvider: 'example-cloud',
      providers: [{ id: 'example-cloud', name: 'Example Cloud', enabled: true, type: 'api', hasApiKey: true, models: ['example-large'] }],
    });
    api.updateCosConfig.mockResolvedValue({ success: true });
    localLlm.getToolUseModels.mockResolvedValue({ models: [] });
  });

  it('keeps an in-progress edit when the host re-derives an unchanged preset list', async () => {
    const user = userEvent.setup();
    render(<RefetchingHost />);

    await waitFor(() => expect(screen.getByDisplayValue('Deep think')).toBeTruthy());
    await user.clear(screen.getByLabelText('Preset name'));
    await user.type(screen.getByLabelText('Preset name'), 'Renamed while typing');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    // A refresh that changed nothing must not reset the field under the user.
    expect(screen.getByLabelText('Preset name').value).toBe('Renamed while typing');
  });

  it('reports a deep link to a preset that is no longer saved instead of editing another', async () => {
    render(
      <PersistentMindThinkingPresets
        presets={[PRESET]}
        editingPresetId="removed"
        onEditPreset={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('That preset is no longer saved.')).toBeTruthy());
    expect(screen.queryByDisplayValue('Deep think')).toBeNull();
  });
});
