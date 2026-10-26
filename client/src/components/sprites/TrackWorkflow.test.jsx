import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The one review/approve surface for every non-walk animation track (#3136).
 *
 * Replaces `ScannerWorkflow.test.jsx` and the loop half of
 * `AmbientWorkflow.test.jsx`, which asserted the same behaviors twice against two
 * components. Everything here runs table-driven over BOTH shipped track shapes —
 * directional (8 facing cards) and non-directional (1 row) — because the property
 * under test is that the component reads the server's `definition` rather than
 * branching on a track id. Two separate suites could pass while the component
 * secretly special-cased one of them.
 *
 * The definitions below mirror the registry rows the server sends verbatim; the
 * `jetpack` case is a track no client build has ever heard of, which is the real
 * acceptance criterion for the epic.
 */

vi.mock('../../services/apiSprites.js', () => ({
  approveSpriteTrack: vi.fn(() => Promise.resolve({})),
}));

import TrackWorkflow from './TrackWorkflow.jsx';
import { approveSpriteTrack } from '../../services/apiSprites.js';

const record = { id: 'example-walker' };
const reference = { manifest: {
  mainReference: { locked: true, path: 'reference/main.png' },
  anchors: [{ direction: 'east', status: 'locked', path: 'reference/east.png' }],
} };

const SCANNER_DEF = {
  id: 'scanner', label: 'Scanner action', directional: true, sourceReference: 'anchor',
  defaultFrameCount: 4, defaultFps: 6,
};
const AMBIENT_DEF = {
  id: 'ambient', label: 'Ambient loop', directional: false, sourceReference: 'main',
  defaultFrameCount: 3, defaultFps: 4,
};

const renderTrack = (definition, state = {}, props = {}) => render(
  <TrackWorkflow
    record={record}
    reference={reference}
    state={{ definition, runs: [], selection: { directions: {} }, set: null, ...state }}
    onGenerate={vi.fn()}
    onChanged={vi.fn()}
    {...props}
  />,
);

// `facing` is the card the assertions target: a directional track's cards are the
// eight facings, a non-directional one's single card is row 0.
const TRACKS = [
  { definition: SCANNER_DEF, facing: 'east', cardLabel: 'east', cardCount: 8 },
  { definition: AMBIENT_DEF, facing: 'south', cardLabel: 'Ambient loop row 0', cardCount: 1 },
];

describe.each(TRACKS)('TrackWorkflow renders the $definition.id track from its definition', (track) => {
  const { definition, facing, cardLabel } = track;
  const { directional } = definition;
  const candidateRun = {
    id: `${definition.id}-${facing}-12345678`,
    direction: facing,
    status: 'candidate',
    stripPreview: { stripPath: `runs/${definition.id}-${facing}-12345678/generated/strip.png`, stripSha256: 'abc' },
  };

  it('labels itself and its geometry from the registry row, not from component copy', () => {
    renderTrack(definition);
    expect(screen.getByText(definition.label)).toBeInTheDocument();
    // The frame/fps summary and the approval denominator both come from the row,
    // so they can't drift from what the server clamps.
    expect(screen.getByText(
      new RegExp(`0/${track.cardCount} approved · ${definition.defaultFrameCount}f @ ${definition.defaultFps}fps`),
    )).toBeInTheDocument();
  });

  it('renders one card per facing the row declares', () => {
    renderTrack(definition);
    expect(screen.getAllByRole('button', { name: 'Generate' })).toHaveLength(track.cardCount);
  });

  it('exposes the user-triggered generation path, naming the track it is for', () => {
    const onGenerate = vi.fn();
    renderTrack(definition, {}, { onGenerate });
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    // The track id rides along, which is what lets ONE page handler serve every
    // track — including one added after this build shipped. So do the two things
    // that need the definition: the request facing (omitted for a single-row
    // track, whose row the server derives) and the correction-note key.
    expect(onGenerate).toHaveBeenCalledWith(definition.id, {
      direction: directional ? 'south' : undefined,
      correctionKey: `${definition.id}:south`,
    });
  });

  it('reviews a packaged candidate strip', () => {
    renderTrack(definition, { runs: [candidateRun] });
    expect(screen.getByRole('img', { name: new RegExp(`${cardLabel} ${definition.label} preview`, 'i') })).toBeInTheDocument();
  });

  it('approves the reviewed candidate through the generic endpoint', async () => {
    renderTrack(definition, { runs: [candidateRun] });
    fireEvent.click(screen.getByRole('button', { name: `Approve ${definition.label} ${cardLabel}` }));
    await waitFor(() => expect(approveSpriteTrack).toHaveBeenCalledWith(
      'example-walker', definition.id, { direction: facing, runId: candidateRun.id }, { silent: true },
    ));
  });

  it('writes a correction through to the shared map under a track-namespaced key (#3134)', () => {
    const onCorrectionChange = vi.fn();
    renderTrack(definition, {}, { corrections: {}, onCorrectionChange });
    const cards = screen.getAllByRole('button', { name: /Show correction note for/i });
    fireEvent.click(cards[0]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'the motion never returns to the start pose' } });
    // A still-image ANCHOR note for the same facing must survive untouched — the
    // whole reason keys are namespaced per surface rather than per direction.
    const merged = onCorrectionChange.mock.calls[0][0]({ south: 'anchor note' });
    expect(merged.south).toBe('anchor note');
    expect(merged).toHaveProperty(`${definition.id}:south`);
  });

  it('omits the correction affordance when the page supplies no writer', () => {
    renderTrack(definition);
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('hides every action once the track\'s set is finalized', () => {
    renderTrack(definition, { set: { status: 'final' } }, { corrections: {}, onCorrectionChange: vi.fn() });
    expect(screen.getByText(/finalized/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('stays hidden until the identity reference is locked', () => {
    // Before a lock the Generate would always 409 server-side, so offering it
    // would be a button that cannot work.
    const { container } = render(
      <TrackWorkflow
        record={record}
        reference={{ manifest: { mainReference: { locked: false } } }}
        state={{ definition, runs: [], selection: null, set: null }}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe.each(TRACKS)('render-lane picker on the $definition.id track (#4876)', ({ definition }) => {
  const PROVIDERS = [
    { id: 'grok', label: 'Grok (cloud)', ready: true, reason: null },
    { id: 'local', label: 'Local (MiniMax H3)', ready: true, reason: null },
  ];

  it('offers the picker and reports the chosen lane', () => {
    const onProviderChange = vi.fn();
    renderTrack(definition, {}, { providers: PROVIDERS, provider: 'grok', onProviderChange });
    fireEvent.change(screen.getByLabelText(/Render on/), { target: { value: 'local' } });
    expect(onProviderChange).toHaveBeenCalledWith('local');
  });

  it('shows no picker when the page never learned about a second lane', () => {
    renderTrack(definition);
    expect(screen.queryByLabelText(/Render on/)).toBeNull();
  });

  it('names the SELECTED lane in the caption instead of hardcoding Grok', () => {
    // The caption read "directly requested Grok render" unconditionally, which
    // became a lie the moment a local render was picked.
    renderTrack(definition, {}, { providers: PROVIDERS, provider: 'local', onProviderChange: vi.fn() });
    expect(screen.getByText(/directly requested local render/)).toBeInTheDocument();
    renderTrack(definition, {}, { providers: PROVIDERS, provider: 'grok', onProviderChange: vi.fn() });
    expect(screen.getAllByText(/directly requested Grok render/).length).toBeGreaterThan(0);
  });
});

describe('a track this client build has never heard of (#3136)', () => {
  // The acceptance criterion for the epic: a user-defined track renders with no
  // client change at all, because every track-specific string and count is read
  // from the definition the server sent.
  const JETPACK = {
    id: 'jetpack', label: 'Jetpack burst', directional: true, sourceReference: 'anchor',
    defaultFrameCount: 5, defaultFps: 8,
  };

  it('renders, generates, and approves with nothing hardcoded for it', async () => {
    const onGenerate = vi.fn();
    render(
      <TrackWorkflow
        record={record}
        reference={reference}
        state={{
          definition: JETPACK,
          runs: [{ id: 'jetpack-east-12345678', direction: 'east', status: 'candidate' }],
          selection: { directions: {} },
          set: null,
        }}
        onGenerate={onGenerate}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('Jetpack burst')).toBeInTheDocument();
    expect(screen.getByText(/0\/8 approved · 5f @ 8fps/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate' })[0]);
    expect(onGenerate).toHaveBeenCalledWith('jetpack', {
      direction: 'south', correctionKey: 'jetpack:south',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve Jetpack burst east' }));
    await waitFor(() => expect(approveSpriteTrack).toHaveBeenCalledWith(
      'example-walker', 'jetpack', { direction: 'east', runId: 'jetpack-east-12345678' }, { silent: true },
    ));
  });

  it('renders nothing at all without a definition', () => {
    // A state payload with no row is unrenderable — better blank than a section
    // titled "undefined" with buttons that can't resolve a track.
    const { container } = render(
      <TrackWorkflow
        record={record}
        reference={reference}
        state={{ runs: [], selection: null, set: null }}
        onGenerate={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('local endpoint conditioning', () => {
  const providers = [{ id: 'local', ready: true, returnToIdleAnchorSupported: true }];
  it('keeps loop choices per track and facing across reload and submits both inputs', () => {
    const onGenerate = vi.fn();
    const view = renderTrack(SCANNER_DEF, {}, { provider: 'local', providers, onGenerate });
    const east = screen.getByRole('checkbox', { name: 'Return to idle anchor east' });
    expect(east).not.toBeChecked();
    fireEvent.click(east);
    expect(screen.getByAltText('east last conditioning anchor')).toBeInTheDocument();
    const eastCard = east.closest('article');
    fireEvent.click(eastCard.querySelector('button'));
    expect(onGenerate).toHaveBeenCalledWith('scanner', {
      direction: 'east', correctionKey: 'scanner:east', returnToIdleAnchor: true,
    });
    expect(screen.getByRole('checkbox', { name: 'Return to idle anchor west' })).not.toBeChecked();
    view.unmount();
    const reloaded = renderTrack(SCANNER_DEF, {}, { provider: 'local', providers });
    expect(screen.getByRole('checkbox', { name: 'Return to idle anchor east' })).toBeChecked();
    reloaded.unmount();
    renderTrack(AMBIENT_DEF, {}, { provider: 'local', providers });
    expect(screen.getByRole('checkbox', { name: 'Return to idle anchor south' })).not.toBeChecked();
  });

  it('restores the selected mode from a saved run and blocks unsupported admission', () => {
    renderTrack(AMBIENT_DEF, {
      runs: [{ id: 'ambient-run', direction: 'south', returnToIdleAnchor: true }],
    }, { provider: 'local', providers: [{ id: 'local', ready: true, returnToIdleAnchorSupported: false }] });
    const checkbox = screen.getByRole('checkbox', { name: 'Return to idle anchor south' });
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    fireEvent.click(checkbox);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});
