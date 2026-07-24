import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetCollection from './AssetCollection.jsx';
import { buildCollectionActions } from '../../lib/spriteCollectionActions.js';

// Role grouping + status badges + which cards get inline actions (#2931).
// The gating rules themselves are covered in spriteCollectionActions.test.js;
// this suite asserts the wiring — that the collection actually asks the
// resolvers per asset and renders/disables what they return.

const STRIP = 'grok/walk-east-abc12345/generated/example-walk-east-strip.png';
const asset = (path, over = {}) => ({ path, size: 2048, ...over });
const image = (path) => asset(path, { width: 96, height: 96, format: 'png' });

const ASSETS = [
  image('reference/example-walk-east-v1.png'),
  image('reference/example-walk-east-v2.png'),
  image(STRIP),
  asset('grok/walk-east-abc12345/generated/example-walk-east-manifest.json'),
];

const actionsFor = (over = {}, maps = {}) => buildCollectionActions({
  detail: {
    record: { id: 'example-walker', kind: 'character' },
    reference: { manifest: { anchors: [{ direction: 'east', status: 'locked' }] } },
    walk: {
      runs: [{ id: 'walk-east-abc12345', direction: 'east', status: 'candidate', stripPreview: { stripPath: STRIP } }],
      selection: { directions: {} },
      walkSet: null,
    },
    ...over,
  },
  generateWalk: vi.fn(),
  generateAnchor: vi.fn(),
  onRequestTrim: vi.fn(),
  ...maps,
});

const groupHeadings = () => screen.getAllByRole('heading', { level: 4 })
  .map((h) => h.textContent.replace(/\s+/g, ' ').trim());

describe('AssetCollection grouping', () => {
  it('groups by semantic role in the declared order, not by path segment', () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} />);
    // Pre-#2931 this was `reference` / `grok` (raw first path segments) — the
    // strip and its sidecar manifest sat in one undifferentiated bucket. The
    // manifest JSON is no longer surfaced as its own "Manifests" group —
    // behind-the-scenes metadata isn't a browsable asset card.
    expect(groupHeadings()).toEqual(['Reference set(2)', 'Strips(1)']);
    expect(screen.queryByRole('heading', { name: /Manifests/ })).toBeNull();
  });

  it('folds a runtime atlas sidecar manifest onto the atlas card as a View-manifest action', async () => {
    const user = userEvent.setup();
    render(
      <AssetCollection
        recordId="example-walker"
        assets={[
          image('runtime/v3/example-animation-atlas-v3.png'),
          asset('runtime/v3/example-animation-atlas-v3-manifest.json'),
        ]}
      />,
    );
    // Exactly one group (Atlases) — the manifest is not its own card.
    expect(groupHeadings()).toEqual(['Atlases(1)']);
    // The atlas card exposes a labeled manifest affordance; clicking it opens
    // the inspector on the sidecar JSON with its explanatory note.
    await user.click(screen.getByRole('button', { name: /View build manifest/ }));
    expect(await screen.findByText(/build manifest/i)).toBeTruthy();
  });

  it('badges each asset with its lifecycle status, including the cross-set supersede', () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} />);
    const referenceGroup = screen.getByRole('heading', { name: /Reference set/ }).parentElement;
    expect(within(referenceGroup).getByText('superseded')).toBeTruthy();
    expect(within(referenceGroup).getByText('approved')).toBeTruthy();
  });

  it('renders nothing but the inspector mount for an empty listing', () => {
    render(<AssetCollection recordId="example-walker" assets={[]} />);
    expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0);
  });

  it('keeps an unapproved run\'s strip badged `candidate` (#2938)', () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} />);
    const stripGroup = screen.getByRole('heading', { name: /Strips/ }).parentElement;
    expect(within(stripGroup).getByText('candidate')).toBeTruthy();
  });

  it('promotes an approved run\'s assets to `approved` from the walk selection (#2938)', () => {
    // The strip path is unchanged by approval — the pure classifier still reads
    // it as `candidate`; the approvedRunIds set is what promotes the badge.
    render(
      <AssetCollection
        recordId="example-walker"
        assets={ASSETS}
        approvedRunIds={new Set(['walk-east-abc12345'])}
      />,
    );
    const stripGroup = screen.getByRole('heading', { name: /Strips/ }).parentElement;
    expect(within(stripGroup).getByText('approved')).toBeTruthy();
    expect(within(stripGroup).queryByText('candidate')).toBeNull();
  });
});

describe('AssetCollection inline actions', () => {
  const stripCard = () => screen.getByTitle(STRIP).parentElement;

  it('puts Regenerate and Edit-in-Trimmer on a walk strip', () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} actions={actionsFor()} />);
    const card = stripCard();
    expect(within(card).getByRole('button', { name: /Regenerate/ })).toBeEnabled();
    expect(within(card).getByRole('button', { name: /Edit .* in Loop Trimmer/ })).toBeTruthy();
  });

  it('leaves non-actionable assets (a manifest, a locked reference) action-free', () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} actions={actionsFor()} />);
    expect(screen.getAllByRole('button', { name: /Regenerate/ })).toHaveLength(1);
  });

  it('renders no actions at all for a record with no workflow (props family)', () => {
    render(<AssetCollection recordId="example-props" assets={ASSETS} actions={null} />);
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });

  it('disables Regenerate while that direction render is in flight', () => {
    render(
      <AssetCollection recordId="example-walker" assets={ASSETS} actions={actionsFor({}, { walkPending: { east: 'job-1' } })} />,
    );
    expect(within(stripCard()).getByRole('button', { name: /Rendering/ })).toBeDisabled();
  });

  it('disables Regenerate once the walk set is finalized', () => {
    const actions = actionsFor({
      walk: {
        runs: [{ id: 'walk-east-abc12345', direction: 'east', status: 'approved', stripPreview: { stripPath: STRIP } }],
        selection: { directions: {} },
        walkSet: { frozen: true },
      },
    });
    render(<AssetCollection recordId="example-walker" assets={ASSETS} actions={actions} />);
    expect(within(stripCard()).getByRole('button', { name: /Regenerate/ })).toBeDisabled();
  });

  it('routes the trimmer request with the owning run id', async () => {
    const onRequestTrim = vi.fn();
    render(
      <AssetCollection
        recordId="example-walker"
        assets={ASSETS}
        actions={actionsFor({}, { onRequestTrim })}
      />,
    );
    await userEvent.click(within(stripCard()).getByRole('button', { name: /Edit .* in Loop Trimmer/ }));
    expect(onRequestTrim).toHaveBeenCalledWith('walk-east-abc12345');
  });

  it('opens the inspector from the card body, not from the action row', async () => {
    render(<AssetCollection recordId="example-walker" assets={ASSETS} actions={actionsFor()} />);
    await userEvent.click(screen.getByTitle(STRIP));
    expect(screen.getByText('Copy path')).toBeTruthy();
  });
});

describe('AssetCollection anchor correction note (#2964)', () => {
  const CANDIDATE = 'reference/candidates/walk-east-candidate-1.png';
  // An anchor re-roll is only offered for an UNLOCKED candidate.
  const unlockedEast = { reference: { manifest: { anchors: [{ direction: 'east', status: 'pending' }] } } };
  const candidateAssets = [image(CANDIDATE)];
  const candidateCard = () => screen.getByTitle(CANDIDATE).parentElement;

  it('shows a correction-note toggle only when the card can write the shared state', () => {
    // No onCorrectionChange → no affordance even though the re-roll is offered.
    render(
      <AssetCollection recordId="example-walker" assets={candidateAssets} actions={actionsFor(unlockedEast)} />,
    );
    expect(within(candidateCard()).queryByRole('button', { name: /correction note/i })).toBeNull();
  });

  it('binds the note to the shared per-direction corrections map and writes through it', async () => {
    const onCorrectionChange = vi.fn();
    render(
      <AssetCollection
        recordId="example-walker"
        assets={candidateAssets}
        actions={actionsFor(unlockedEast)}
        corrections={{ east: 'no pocket on the right sleeve' }}
        onCorrectionChange={onCorrectionChange}
      />,
    );
    const card = candidateCard();
    // An existing correction auto-opens the note and prefills the shared value.
    const textarea = within(card).getByLabelText(/Correction guidance for the east pose/i);
    expect(textarea).toHaveValue('no pocket on the right sleeve');
    // Typing routes an updater up to the page-owned state that merges by
    // direction key, preserving sibling directions' notes.
    await userEvent.type(textarea, '!');
    expect(onCorrectionChange).toHaveBeenCalled();
    const updater = onCorrectionChange.mock.calls[0][0];
    const merged = updater({ west: 'keep me' });
    expect(merged.west).toBe('keep me');
    expect(merged).toHaveProperty('east');
  });

  it('keeps the note collapsed by default when no correction exists yet', () => {
    render(
      <AssetCollection
        recordId="example-walker"
        assets={candidateAssets}
        actions={actionsFor(unlockedEast)}
        corrections={{}}
        onCorrectionChange={vi.fn()}
      />,
    );
    const card = candidateCard();
    expect(within(card).queryByLabelText(/Correction guidance/i)).toBeNull();
    expect(within(card).getByRole('button', { name: /Show correction note/i })).toBeTruthy();
  });
});
