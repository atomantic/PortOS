import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  updatePostConfig: vi.fn(),
  getMemoryItems: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import PracticePlan from './PracticePlan';
import { POST_TOPICS } from './constants';
import { updatePostConfig, getMemoryItems } from '../../../services/api';
import toast from '../../ui/Toast';

const drillTypesForModule = (module) => [...new Set(
  POST_TOPICS.filter(topic => topic.module === module).flatMap(topic => topic.drillTypes)
)].sort();

// A config shaped like what the server actually hands the client: DEFAULT_CONFIG
// deep-merged over whatever is saved. Deliberately carries NO `topics` key, so
// every test starts from the legacy "absent = enabled" baseline.
const baseConfig = (overrides = {}) => ({
  mentalMath: {
    enabled: true,
    drillTypes: {
      'doubling-chain': { enabled: true },
      'serial-subtraction': { enabled: true },
      multiplication: { enabled: true },
      powers: { enabled: true },
      estimation: { enabled: true },
    },
  },
  llmDrills: {
    enabled: true,
    drillTypes: {
      'pun-wordplay': { enabled: true },
      'word-association': { enabled: true },
      'wit-comeback': { enabled: true },
      'what-if': { enabled: true },
    },
  },
  cognitive: { enabled: true, drillTypes: { 'n-back': { enabled: true } } },
  memory: { enabled: true, drillTypes: { 'memory-sequence': { enabled: true } } },
  morse: { enabled: true },
  // No sessionModules → legacy/absent → every module composes.
  ...overrides,
});

const MEMORY_ITEMS = [
  { id: 'elements-song', title: 'The Elements' },
  { id: 'raven', title: 'The Raven' },
];

// Settle the mount-time memory-items fetch inside act() so the strict act()
// guard in src/test/setup.js doesn't fail the test on a post-mount state update.
async function renderPlan(config = baseConfig(), props = {}) {
  const result = render(<PracticePlan config={config} onSaved={() => {}} onBack={() => {}} {...props} />);
  await act(async () => {});
  return result;
}

const summary = () => screen.getByTestId('plan-summary');

beforeEach(() => {
  vi.clearAllMocks();
  getMemoryItems.mockResolvedValue(MEMORY_ITEMS);
  updatePostConfig.mockResolvedValue({});
});

describe('PracticePlan summary (issue #3252)', () => {
  it('lists every enabled session topic with its drills', async () => {
    await renderPlan();
    const box = summary();
    expect(within(box).getByText('Mental Math')).toBeInTheDocument();
    expect(within(box).getByText('Wordplay')).toBeInTheDocument();
    expect(within(box).getByText('Verbal Agility')).toBeInTheDocument();
    expect(within(box).getByText('Imagination')).toBeInTheDocument();
    expect(within(box).getByText(/Pun & Wordplay/)).toBeInTheDocument();
  });

  it('drops a topic from the summary as soon as it is toggled off — before saving', async () => {
    await renderPlan();
    expect(within(summary()).getByText('Verbal Agility')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Verbal Agility', { selector: 'input' }));

    await waitFor(() => {
      expect(within(summary()).queryByText('Verbal Agility')).not.toBeInTheDocument();
    });
    // Its sibling llm-drills topic is untouched — that's the granularity the
    // coarse sessionModules filter could never express.
    expect(within(summary()).getByText('Wordplay')).toBeInTheDocument();
    expect(updatePostConfig).not.toHaveBeenCalled();
  });

  it('leaves only wordplay when every other session topic is switched off', async () => {
    await renderPlan();
    for (const label of ['Mental Math', 'Verbal Agility', 'Imagination', 'Cognitive']) {
      fireEvent.click(screen.getByLabelText(label, { selector: 'input' }));
    }
    await waitFor(() => {
      expect(within(summary()).getByText('Wordplay')).toBeInTheDocument();
    });
    for (const label of ['Mental Math', 'Verbal Agility', 'Imagination', 'Cognitive']) {
      expect(within(summary()).queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('explains an empty plan instead of rendering a blank summary', async () => {
    await renderPlan(baseConfig({ sessionModules: [] }));
    expect(within(summary()).getByText(/Nothing right now/)).toBeInTheDocument();
  });

  it('counts the memory items still in the rotation', async () => {
    await renderPlan();
    await waitFor(() => expect(getMemoryItems).toHaveBeenCalled());
    await waitFor(() => {
      expect(within(summary()).getByText(/2 of 2 memorized texts/)).toBeInTheDocument();
    });
  });
});

describe('PracticePlan per-item memory control', () => {
  it('lists memory items under the expanded Memory topic and drops a disabled one from the count', async () => {
    await renderPlan();
    await waitFor(() => expect(getMemoryItems).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Expand Memory'));
    const itemToggle = await screen.findByLabelText('The Elements', { selector: 'input' });
    expect(itemToggle).toBeChecked();

    fireEvent.click(itemToggle);
    await waitFor(() => {
      expect(within(summary()).getByText(/1 of 2 memorized texts/)).toBeInTheDocument();
    });
  });

  it('greys out (and never silently re-enables) sub-toggles when the parent topic is off', async () => {
    await renderPlan();
    await waitFor(() => expect(getMemoryItems).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Expand Memory'));
    await screen.findByLabelText('The Raven', { selector: 'input' });

    fireEvent.click(screen.getByLabelText('Memory', { selector: 'input' }));

    await waitFor(() => {
      expect(screen.getByLabelText('The Raven', { selector: 'input' })).toBeDisabled();
    });
    expect(screen.getByLabelText('The Raven', { selector: 'input' })).not.toBeChecked();
  });
});

describe('PracticePlan save', () => {
  it('persists topics, per-item memory flags and the morse toggle in one patch', async () => {
    const onSaved = vi.fn();
    updatePostConfig.mockResolvedValue({ ok: true });
    await renderPlan(baseConfig(), { onSaved });
    await waitFor(() => expect(getMemoryItems).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Morse', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Imagination', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Expand Memory'));
    fireEvent.click(await screen.findByLabelText('The Elements', { selector: 'input' }));

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    const [patch, options] = updatePostConfig.mock.calls[0];
    expect(patch.topics.imagination).toEqual({ enabled: false });
    expect(patch.morse).toEqual({ enabled: false });
    expect(patch.memory.items['elements-song']).toEqual({ enabled: false });
    // The component owns its own error toast, so the helper must stay silent.
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ok: true }));
    expect(toast.success).toHaveBeenCalled();
  });

  it('sends a COMPLETE drill-type map per module — the config schema records are exhaustive', async () => {
    await renderPlan();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    const [patch] = updatePostConfig.mock.calls[0];
    expect(Object.keys(patch.llmDrills.drillTypes).sort()).toEqual(drillTypesForModule('llm-drills'));
    expect(Object.keys(patch.mentalMath.drillTypes).sort()).toEqual(drillTypesForModule('mental-math'));
    expect(Object.keys(patch.cognitive.drillTypes).sort()).toEqual(drillTypesForModule('cognitive'));
    expect(Object.keys(patch.memory.drillTypes).sort()).toEqual(drillTypesForModule('memory'));
    // A drill type absent from the saved config is persisted as disabled — the
    // launcher already ignored it, so seeding must not silently switch it on.
    expect(patch.llmDrills.drillTypes['bridge-word']).toEqual({ enabled: false });
    expect(patch.llmDrills.drillTypes['pun-wordplay']).toEqual({ enabled: true });
  });

  it('surfaces its own error toast when the save fails', async () => {
    updatePostConfig.mockRejectedValue(new Error('nope'));
    await renderPlan();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// Memory and Morse each have a module-level `enabled` flag on the server as well
// as a topic entry, and this surface exposes ONE control that writes both. If the
// control only read the topic entry, a config carrying the module flag off with no
// topic entry would render ON and the next Save would switch it back on.
describe('PracticePlan two-flags-one-control seeding (issue #3252)', () => {
  it('renders Morse OFF when only the module flag is off', async () => {
    await renderPlan(baseConfig({ morse: { enabled: false } }));
    expect(screen.getByLabelText('Morse', { selector: 'input' })).not.toBeChecked();
  });

  it('renders Memory OFF when only the module flag is off', async () => {
    await renderPlan(baseConfig({ memory: { enabled: false, drillTypes: {} } }));
    expect(screen.getByLabelText('Memory', { selector: 'input' })).not.toBeChecked();
  });

  it('does not silently re-enable a module-flag-off topic on an unrelated save', async () => {
    await renderPlan(baseConfig({ morse: { enabled: false } }));
    // Touch a completely different topic, then save.
    fireEvent.click(screen.getByLabelText('Wordplay', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    const [patch] = updatePostConfig.mock.calls[0];
    expect(patch.morse).toEqual({ enabled: false });
    expect(patch.topics.morse).toEqual({ enabled: false });
  });

  it('writes BOTH the topic entry and the module flag so the server gates agree', async () => {
    await renderPlan();
    fireEvent.click(screen.getByLabelText('Memory', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(updatePostConfig).toHaveBeenCalled());
    const [patch] = updatePostConfig.mock.calls[0];
    expect(patch.topics.memory).toEqual({ enabled: false });
    expect(patch.memory.enabled).toBe(false);
  });
});
