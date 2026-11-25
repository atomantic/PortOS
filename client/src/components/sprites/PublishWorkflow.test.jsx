import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render, screen, act, fireEvent,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';

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
import { compileSpriteAtlas, publishSpriteAtlas, setSpritePublishBinding } from '../../services/apiSprites.js';

const GEOMETRY = {
  columns: ['idle', 'frame-00', 'frame-01', 'frame-02', 'frame-03', 'frame-04',
    'frame-05', 'frame-06', 'frame-07', 'frame-08', 'frame-09', 'frame-10', 'frame-11'],
  cellSize: 96,
  walkFrameCount: 12,
};

const WALK_DEFINITION = {
  id: 'walk',
  label: 'Walk cycle',
  minFrameCount: 6,
  maxFrameCount: 16,
  defaultFrameCount: 12,
  contractFrameCountField: 'walkFrameCount',
  standaloneContract: true,
};
const SCANNER_DEFINITION = {
  id: 'scanner',
  label: 'Scanner action',
  minFrameCount: 2,
  maxFrameCount: 8,
  defaultFrameCount: 4,
  contractFrameCountField: 'scannerFrameCount',
  standaloneContract: false,
};
const AMBIENT_DEFINITION = {
  id: 'ambient',
  label: 'Ambient loop',
  minFrameCount: 2,
  maxFrameCount: 6,
  defaultFrameCount: 3,
  contractFrameCountField: 'ambientFrameCount',
  standaloneContract: true,
};
const JETPACK_DEFINITION = {
  id: 'jetpack',
  label: 'Jetpack burst',
  minFrameCount: 3,
  maxFrameCount: 7,
  defaultFrameCount: 5,
  contractFrameCountField: 'jetpackFrameCount',
  standaloneContract: false,
};

const atlasWith = (extra = {}) => ({
  current: { version: 3, compiledAt: '2026-07-01T00:00:00.000Z', atlasPath: 'runtime/v3/a.png', geometry: GEOMETRY },
  publications: [],
  ...extra,
});

const renderWorkflow = (
  publishBinding,
  atlas = atlasWith(),
  props = {},
) => render(
  <MemoryRouter>
    <PublishWorkflow
      record={{ id: 'example-walker', publishBinding }}
      walk={{ walkSet: { imported: false } }}
      tracks={{}}
      trackDefinitions={[WALK_DEFINITION, SCANNER_DEFINITION]}
      atlas={atlas}
      onChanged={vi.fn()}
      {...props}
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

it('shows every occupied path and requires a fresh confirmation for a changed review', async () => {
  const paths = ['atlas.png', 'atlas.layout.json', 'portrait.png', 'idle.png', 'idle.presentation.json'];
  const occupied = (paths, revision) => ({
    code: 'PUBLISH_OUTPUTS_OCCUPIED', context: { appLabel: 'Example App', paths, revision },
  });
  publishSpriteAtlas.mockRejectedValueOnce(occupied(paths, 'a'.repeat(64)))
    .mockRejectedValueOnce(occupied(['new-atlas.png'], 'b'.repeat(64)))
    .mockResolvedValueOnce({ published: true, publication: { version: 3 } });
  renderWorkflow(savedContractBinding);
  fireEvent.click(screen.getByRole('button', { name: 'Publish to app' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
  expect(publishSpriteAtlas).toHaveBeenLastCalledWith('example-walker', {}, { silent: true });
  expect(screen.getByText(/Overwrite these files in Example App/)).toBeInTheDocument();
  for (const path of paths) expect(screen.getByText(path)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })); });
  expect(publishSpriteAtlas).toHaveBeenCalledTimes(2);
  expect(publishSpriteAtlas).toHaveBeenLastCalledWith('example-walker', { acknowledgeOverwrite: 'a'.repeat(64) }, { silent: true });
  expect(screen.getByText(/The binding or files changed/)).toBeInTheDocument();
  expect(screen.getByText('new-atlas.png')).toBeInTheDocument();
  expect(screen.queryByText('portrait.png')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })); });
  expect(publishSpriteAtlas).toHaveBeenLastCalledWith('example-walker', { acknowledgeOverwrite: 'b'.repeat(64) }, { silent: true });
  expect(screen.queryByRole('button', { name: 'Overwrite' })).toBeNull();
});

describe('PublishWorkflow runtime contract', () => {
  beforeEach(() => {
    compileSpriteAtlas.mockClear();
    setSpritePublishBinding.mockClear();
  });

  it('compiles a 2x atlas from the runtime cell size without changing sprite proportions', async () => {
    renderWorkflow(savedContractBinding);

    fireEvent.change(screen.getByLabelText(/Cell size/), { target: { value: '192' } });
    await act(async () => { fireEvent.click(screen.getByText('Recompile atlas')); });

    expect(compileSpriteAtlas).toHaveBeenCalledWith(
      'example-walker',
      {
        geometry: {
          cellSize: 192,
          pivot: [96, 176],
          targetMaxHeight: 148,
          targetMaxWidth: 172,
        },
      },
      { silent: true },
    );
  });

  it('saves the player-facing picker animation destination', async () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Picker idle strip/), {
      target: { value: 'assets/presentation/hero-idle.png' },
    });
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    expect(lastBindingArg().presentationIdleDestPath)
      .toBe('assets/presentation/hero-idle.png');
  });

  it('SETS the contract from a populated field group', async () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Walk cycle frames/), { target: { value: '12' } });
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

    fireEvent.change(screen.getByLabelText(/Walk cycle frames/), { target: { value: '12' } });

    expect(screen.getByText(/Bind an app and destination/)).toBeInTheDocument();
    expect(screen.getByText('Save binding')).toBeDisabled();
  });

  it('requires a track frame count when a scanner contract is entered on its own', () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Scanner action frames/), { target: { value: '4' } });

    expect(screen.getByText(/Walk cycle frame count is required/)).toBeInTheDocument();
    expect(screen.getByText('Save binding')).toBeDisabled();
  });

  it('MATCHES the current atlas geometry into the fields', () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.click(screen.getByText('Match current atlas'));

    expect(screen.getByLabelText(/Walk cycle frames/).value).toBe('12');
    expect(screen.getByLabelText(/Cell size/).value).toBe('96');
    expect(screen.getByLabelText(/Column count/).value).toBe('13');
  });

  it('carries the scanner span into a runtime contract when the atlas has one', async () => {
    const scannerAtlas = atlasWith({
      current: {
        version: 3,
        compiledAt: '2026-07-01T00:00:00.000Z',
        atlasPath: 'runtime/v3/a.png',
        geometry: {
          ...GEOMETRY,
          scannerFrameCount: 4,
          tracks: { scanner: { start: 13, count: 4, rows: 8 } },
        },
      },
    });
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null }, scannerAtlas);

    fireEvent.click(screen.getByText('Match current atlas'));
    expect(screen.getByLabelText(/Scanner action frames/).value).toBe('4');
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });

    expect(lastBindingArg().runtimeContract).toEqual({
      walkFrameCount: 12, scannerFrameCount: 4, cellSize: 96, columnCount: 13,
    });
  });

  it('uses ambientFrameCount for an ambient-only atlas instead of inventing walk frames', async () => {
    const ambientAtlas = atlasWith({
      current: {
        version: 3,
        compiledAt: '2026-07-01T00:00:00.000Z',
        atlasPath: 'runtime/v3/a.png',
        geometry: {
          columns: ['idle', 'ambient-00', 'ambient-01', 'ambient-02'],
          tracks: { idle: { start: 0, count: 1, rows: 1 }, ambient: { start: 1, count: 3, rows: 1 } },
          cellSize: 96,
          walkFrameCount: null,
          ambientFrameCount: 3,
        },
      },
    });
    render(
      <MemoryRouter>
        <PublishWorkflow
          record={{ id: 'example-tree', publishBinding: { appId: 'app-1', atlasDestPath: 'assets/tree.png', codeBinding: null } }}
          tracks={{ ambient: { definition: AMBIENT_DEFINITION, set: {} } }}
          trackDefinitions={[AMBIENT_DEFINITION]}
          atlas={ambientAtlas}
          onChanged={vi.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Match current atlas'));
    expect(screen.queryByLabelText(/Walk cycle frames/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Ambient loop frames/).value).toBe('3');
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });
    expect(lastBindingArg().runtimeContract).toEqual({ ambientFrameCount: 3, cellSize: 96, columnCount: 4 });
  });

  it('rejects an out-of-range walk frame count and blocks the save', () => {
    renderWorkflow({ appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null });

    fireEvent.change(screen.getByLabelText(/Walk cycle frames/), { target: { value: '99' } });

    expect(screen.getByText(/Walk cycle frame count must be/)).toBeInTheDocument();
    expect(screen.getByText('Save binding')).toBeDisabled();
  });

  it('renders, range-checks, fills, and saves a user-defined track from its definition', async () => {
    const jetpackAtlas = atlasWith({
      current: {
        version: 3,
        compiledAt: '2026-07-01T00:00:00.000Z',
        atlasPath: 'runtime/v3/a.png',
        geometry: {
          ...GEOMETRY,
          tracks: {
            walk: { start: 1, count: 12, rows: 8 },
            jetpack: { start: 13, count: 5, rows: 8 },
          },
        },
      },
    });
    renderWorkflow(
      { appId: 'app-1', atlasDestPath: 'assets/hero.png', codeBinding: null },
      jetpackAtlas,
      { trackDefinitions: [WALK_DEFINITION, JETPACK_DEFINITION] },
    );

    expect(screen.getByLabelText(/Jetpack burst frames/)).toHaveAttribute('min', '3');
    expect(screen.getByLabelText(/Jetpack burst frames/)).toHaveAttribute('max', '7');
    fireEvent.change(screen.getByLabelText(/Walk cycle frames/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(/Jetpack burst frames/), { target: { value: '8' } });
    expect(screen.getByText(/Jetpack burst frame count must be a whole number 3–7/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Match current atlas'));
    expect(screen.getByLabelText(/Jetpack burst frames/).value).toBe('5');
    await act(async () => { fireEvent.click(screen.getByText('Save binding')); });
    expect(lastBindingArg().runtimeContract).toEqual({
      walkFrameCount: 12,
      jetpackFrameCount: 5,
      cellSize: 96,
      columnCount: 13,
    });
  });

  it('derives the required primary-track gate and mismatch summary from definitions', () => {
    const glimmer = {
      ...JETPACK_DEFINITION,
      id: 'glimmer',
      label: 'Glimmer loop',
      contractFrameCountField: 'glimmerFrameCount',
      standaloneContract: true,
    };
    const pulse = {
      ...JETPACK_DEFINITION,
      id: 'pulse',
      label: 'Pulse action',
      contractFrameCountField: 'pulseFrameCount',
    };
    renderWorkflow(
      {
        appId: 'app-1',
        atlasDestPath: 'assets/glimmer.png',
        codeBinding: null,
        runtimeContract: { glimmerFrameCount: 5, pulseFrameCount: 4 },
      },
      atlasWith({
        current: {
          version: 3,
          compiledAt: '2026-07-01T00:00:00.000Z',
          atlasPath: 'runtime/v3/a.png',
          geometry: {
            columns: ['idle', 'glimmer-00', 'glimmer-01', 'glimmer-02', 'glimmer-03', 'glimmer-04'],
            tracks: {
              glimmer: { start: 1, count: 5, rows: 1 },
              pulse: { start: 6, count: 3, rows: 1 },
            },
            cellSize: 96,
          },
        },
      }),
      {
        walk: null,
        tracks: {
          glimmer: { definition: glimmer, set: {} },
          pulse: { definition: pulse, set: {} },
        },
        trackDefinitions: [glimmer, pulse],
      },
    );

    expect(screen.getByText(/contract expects 4 pulse action frames, atlas has 3/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Glimmer loop frames/), { target: { value: '' } });
    expect(screen.getByText(/Glimmer loop frame count is required/)).toBeInTheDocument();
  });
});
