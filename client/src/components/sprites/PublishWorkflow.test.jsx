import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render, screen, act, fireEvent,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Coverage for the runtime-contract field group (#2992). The load-bearing
// behavior is the absent-vs-null merge: a populated contract SETS it, the
// Clear affordance sends explicit `null`, and saving with the contract
// untouched OMITS the key so the server inherits the stored contract.

vi.mock('../../services/apiSprites.js', () => ({
  compileSpriteAtlas: vi.fn(() => Promise.resolve({})),
  setSpritePublishBinding: vi.fn(() => Promise.resolve({})),
  publishSpriteAtlas: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../hooks/useSidebarApps.js', () => ({
  useSidebarApps: () => [{ id: 'app-1', name: 'Example App' }, { id: 'app-2', name: 'Other App' }],
}));

import PublishWorkflow from './PublishWorkflow';
import { setSpritePublishBinding } from '../../services/apiSprites.js';

const GEOMETRY = {
  columns: ['idle', 'frame-00', 'frame-01', 'frame-02', 'frame-03', 'frame-04',
    'frame-05', 'frame-06', 'frame-07', 'frame-08', 'frame-09', 'frame-10', 'frame-11'],
  cellSize: 96,
  walkFrameCount: 12,
};

const atlasWith = (extra = {}) => ({
  current: { version: 3, compiledAt: '2026-07-01T00:00:00.000Z', atlasPath: 'runtime/v3/a.png', geometry: GEOMETRY },
  publications: [],
  ...extra,
});

const renderWorkflow = (publishBinding, atlas = atlasWith()) => render(
  <MemoryRouter>
    <PublishWorkflow
      record={{ id: 'example-walker', publishBinding }}
      walk={{ walkSet: { imported: false } }}
      atlas={atlas}
      onChanged={vi.fn()}
    />
  </MemoryRouter>,
);

const savedContractBinding = {
  appId: 'app-1',
  atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
  codeBinding: null,
  runtimeContract: { walkFrameCount: 12, cellSize: 96, columnCount: 13 },
};

const lastBindingArg = () => setSpritePublishBinding.mock.calls.at(-1)[1];

describe('PublishWorkflow runtime contract', () => {
  beforeEach(() => setSpritePublishBinding.mockClear());

  it('SETS the contract from a populated field group', async () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Walk frames/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/Cell size/), { target: { value: '96' } });
    fireEvent.change(screen.getByLabelText(/Column count/), { target: { value: '13' } });

    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    expect(lastBindingArg().runtimeContract).toEqual({ walkFrameCount: 12, cellSize: 96, columnCount: 13 });
  });

  it('CLEARS the stored contract with an explicit null', async () => {
    renderWorkflow(savedContractBinding);

    await act(async () => { fireEvent.click(screen.getByText('Clear')); });
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    const binding = lastBindingArg();
    expect('runtimeContract' in binding).toBe(true);
    expect(binding.runtimeContract).toBeNull();
  });

  it('INHERITS the stored contract by OMITTING the key when untouched', async () => {
    renderWorkflow(savedContractBinding);

    // Make the binding dirty via an unrelated field so Save is enabled, but
    // leave the contract untouched.
    fireEvent.change(screen.getByLabelText(/Atlas destination/), { target: { value: 'assets/sprites/hero/renamed.png' } });
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    const binding = lastBindingArg();
    expect('runtimeContract' in binding).toBe(false);
  });

  it('SENDS the displayed contract explicitly when the bound app changes', async () => {
    renderWorkflow(savedContractBinding);

    // Re-pointing to a different app makes server inheritance (app-scoped) drop
    // the contract; since the fields still show it, the form must send it
    // explicitly rather than omit the key.
    fireEvent.change(screen.getByLabelText('Managed app'), { target: { value: 'app-2' } });
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    const binding = lastBindingArg();
    expect(binding.appId).toBe('app-2');
    expect(binding.runtimeContract).toEqual({ walkFrameCount: 12, cellSize: 96, columnCount: 13 });
  });

  it('lets an unbind proceed even while a saved contract is displayed', async () => {
    renderWorkflow(savedContractBinding);

    // Unbinding (app → "— none —") must not be blocked by the seeded, untouched
    // contract — the binding:null it sends clears the contract server-side.
    fireEvent.change(screen.getByLabelText('Managed app'), { target: { value: '' } });
    expect(screen.getByText('Save binding')).not.toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    expect(lastBindingArg()).toBeNull();
  });

  it('blocks a contract with no app/destination and explains why', () => {
    renderWorkflow(null, atlasWith());

    fireEvent.change(screen.getByLabelText(/Walk frames/), { target: { value: '12' } });

    expect(screen.getByText(/Bind an app and destination/)).toBeInTheDocument();
    expect(screen.getByText('Save binding')).toBeDisabled();
  });

  it('MATCHES the current atlas geometry into the fields', () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.click(screen.getByText('Match current atlas'));

    expect(screen.getByLabelText(/Walk frames/).value).toBe('12');
    expect(screen.getByLabelText(/Cell size/).value).toBe('96');
    expect(screen.getByLabelText(/Column count/).value).toBe('13');
  });

  it('rejects an out-of-range walk frame count and blocks the save', () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Walk frames/), { target: { value: '99' } });

    expect(screen.getByText(/Walk frame count must be/)).toBeInTheDocument();
    expect(screen.getByText('Save binding')).toBeDisabled();
  });
});
