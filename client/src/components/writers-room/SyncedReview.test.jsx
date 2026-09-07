import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the API so the component renders a deterministic synced-review payload.
const getWritersRoomSyncedReview = vi.fn();
const proposeAugment = vi.fn();
const applyAugment = vi.fn();
vi.mock('../../services/apiWritersRoom', () => ({
  getWritersRoomSyncedReview: (...args) => getWritersRoomSyncedReview(...args),
  proposeWritersRoomCharacterAugmentation: (...args) => proposeAugment(...args),
  applyWritersRoomCharacterAugmentation: (...args) => applyAugment(...args),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toastMock }));

import SyncedReview from './SyncedReview';

function payload(overrides = {}) {
  return {
    workId: 'wr-work-1',
    title: 'Test',
    draftVersionId: 'wr-draft-1',
    activeContentHash: 'h',
    prose: {
      segments: [
        { id: 'seg-001', kind: 'chapter', heading: 'Opening', start: 0, end: 10, wordCount: 5, text: 'The hero wakes.', scriptSceneIds: ['scene-01'], media: [] },
        { id: 'seg-002', kind: 'chapter', heading: 'Battle', start: 10, end: 20, wordCount: 5, text: 'Swords clash.', scriptSceneIds: [], media: [] },
      ],
    },
    script: {
      available: true, status: 'succeeded', stale: false, analysisId: 'script',
      providerId: 'openai', model: 'gpt-x', completedAt: '2026-01-01T00:00:00Z', error: null,
      title: 'T', logline: 'L',
      scenes: [
        { id: 'scene-01', heading: 'Opening Scene', slugline: 'INT. ROOM', summary: 'wakes', characters: [], sourceSegmentIds: ['seg-001'], proseSegmentIds: ['seg-001'], media: null },
      ],
    },
    media: { items: [] },
    ...overrides,
  };
}

beforeEach(() => {
  getWritersRoomSyncedReview.mockReset();
  proposeAugment.mockReset();
  applyAugment.mockReset();
  toastMock.error.mockReset();
  toastMock.success.mockReset();
});

const work = { id: 'wr-work-1', title: 'Test' };

describe('SyncedReview', () => {
  it('renders the three panes from the assembled payload', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    // unique body text identifies each prose segment card
    expect(await screen.findByText('The hero wakes.')).toBeTruthy();
    expect(screen.getByText('Swords clash.')).toBeTruthy();
    expect(screen.getByText('Opening Scene')).toBeTruthy();
    // pane toggles in the toolbar
    expect(screen.getByTitle('Toggle Prose pane')).toBeTruthy();
    expect(screen.getByTitle('Toggle Script pane')).toBeTruthy();
    expect(screen.getByTitle('Toggle Media pane')).toBeTruthy();
  });

  it('selecting a prose segment activates the cross-link (Clear link appears)', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText('The hero wakes.'));
    expect(await screen.findByText(/Clear link/)).toBeTruthy();
    // clicking again clears the selection
    fireEvent.click(screen.getByText('The hero wakes.'));
    await waitFor(() => expect(screen.queryByText(/Clear link/)).toBeNull());
  });

  it('renders the anchor card of a cross-link stronger than the cards it links to', async () => {
    // seg-001 ↔ scene-01 ↔ one rendered media item, so every pane has both an
    // anchor candidate and a merely-linked card (#3586).
    const base = payload();
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      prose: {
        segments: [
          { ...base.prose.segments[0], media: [{ sceneId: 'scene-01', ref: 'a.png' }] },
          base.prose.segments[1],
        ],
      },
      script: { ...base.script, scenes: [{ ...base.script.scenes[0], media: { ref: 'a.png' } }] },
      media: {
        items: [{
          sceneId: 'scene-01', ref: 'a.png', sceneHeading: 'Opening Scene', orphan: false,
          proseSegmentIds: ['seg-001'], prompt: 'a room', generatedAt: '2026-01-01T00:00:00Z',
        }],
      },
    }));
    const { container } = render(<SyncedReview work={work} />);
    await screen.findByText('The hero wakes.');

    const card = (pane, syncId) => container.querySelector(`[data-pane="${pane}"] [data-sync-id="${syncId}"]`);
    const isSelected = (el) => /\bring-port-accent\b/.test(el.className);
    const isLinked = (el) => /border-port-accent\/50/.test(el.className);

    // Selecting prose: its own card is the anchor; the script/media cards it
    // maps to get the weaker "linked" treatment.
    fireEvent.click(screen.getByText('The hero wakes.'));
    await waitFor(() => expect(isSelected(card('prose', 'seg-001'))).toBe(true));
    expect(isLinked(card('prose', 'seg-001'))).toBe(false);
    expect(isSelected(card('script', 'scene-01'))).toBe(false);
    expect(isLinked(card('script', 'scene-01'))).toBe(true);
    expect(isSelected(card('media', 'scene-01'))).toBe(false);
    expect(isLinked(card('media', 'scene-01'))).toBe(true);
    // an unrelated prose card dims rather than reading as linked
    expect(card('prose', 'seg-002').className).toMatch(/opacity-40/);
    // the anchor is also exposed non-visually, so it doesn't read as color-only
    expect(card('prose', 'seg-001').getAttribute('aria-pressed')).toBe('true');
    expect(card('script', 'scene-01').getAttribute('aria-pressed')).toBe('false');

    // Selecting the script scene moves the anchor to the script pane.
    fireEvent.click(card('script', 'scene-01'));
    await waitFor(() => expect(isSelected(card('script', 'scene-01'))).toBe(true));
    expect(isSelected(card('prose', 'seg-001'))).toBe(false);
    expect(isLinked(card('prose', 'seg-001'))).toBe(true);
    expect(isSelected(card('media', 'scene-01'))).toBe(false);

    // …and selecting the media item moves it to the media pane.
    fireEvent.click(card('media', 'scene-01'));
    await waitFor(() => expect(isSelected(card('media', 'scene-01'))).toBe(true));
    expect(isSelected(card('script', 'scene-01'))).toBe(false);
    expect(isLinked(card('script', 'scene-01'))).toBe(true);
  });

  it('toggling the Script pane off hides it but keeps at least one pane', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    await screen.findByText('Opening Scene');
    // toggle Script pane off via the toolbar button
    const scriptToggle = screen.getByTitle('Toggle Script pane');
    fireEvent.click(scriptToggle);
    await waitFor(() => expect(screen.queryByText('Opening Scene')).toBeNull());
    // prose pane still present
    expect(screen.getByText('The hero wakes.')).toBeTruthy();
  });

  it('stacks to a single pane below lg and switches with the mobile selector', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    const { container } = render(<SyncedReview work={work} />);
    await screen.findByText('The hero wakes.');

    const paneClasses = () => Object.fromEntries(
      ['prose', 'script', 'media'].map((k) => [k, container.querySelector(`[data-pane="${k}"]`).className]),
    );

    // Only the active pane is displayed at narrow widths; the rest are display:none
    // until `lg` — no pane is left clipped below the fold (#3566).
    let classes = paneClasses();
    expect(classes.prose).not.toMatch(/\bhidden\b/);
    expect(classes.script).toMatch(/\bhidden\b/);
    expect(classes.media).toMatch(/\bhidden\b/);
    ['prose', 'script', 'media'].forEach((k) => expect(classes[k]).toMatch(/\blg:block\b/));

    fireEvent.click(screen.getByTitle('Show Media pane'));
    await waitFor(() => expect(paneClasses().media).not.toMatch(/\bhidden\b/));
    classes = paneClasses();
    expect(classes.prose).toMatch(/\bhidden\b/);
    expect(classes.script).toMatch(/\bhidden\b/);
    expect(screen.getByTitle('Show Media pane').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to a still-enabled pane when the active one is toggled off', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    await screen.findByText('The hero wakes.');
    // Prose starts active on mobile; disabling it must hand the mobile view to
    // another enabled pane rather than render nothing.
    fireEvent.click(screen.getByTitle('Toggle Prose pane'));
    await waitFor(() => expect(screen.getByTitle('Show Script pane').getAttribute('aria-pressed')).toBe('true'));
  });

  it('re-enables a disabled pane when it is picked from the mobile selector', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    await screen.findByText('Opening Scene');
    fireEvent.click(screen.getByTitle('Toggle Script pane'));
    await waitFor(() => expect(screen.queryByText('Opening Scene')).toBeNull());
    fireEvent.click(screen.getByTitle('Show Script pane'));
    expect(await screen.findByText('Opening Scene')).toBeTruthy();
    expect(screen.getByTitle('Toggle Script pane').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the stale badge when the script is stale', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      script: { ...payload().script, stale: true },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/Script is stale/)).toBeTruthy();
  });

  it('renders an empty state when the draft has no prose segments', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      prose: { segments: [] },
      script: { ...payload().script, available: false, scenes: [] },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/Nothing to review yet/)).toBeTruthy();
  });

  it('prompts to run Adapt when no script is available', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload({
      script: { available: false, status: null, stale: false, scenes: [], error: null },
    }));
    render(<SyncedReview work={work} />);
    expect(await screen.findByText(/run .*Adapt/i)).toBeTruthy();
  });
});

// ---- cast pane (#6415 / #6417) ----

function castPayload(overrides = {}) {
  const base = payload();
  return payload({
    prose: {
      segments: base.prose.segments.map((seg, i) => ({ ...seg, castCharacterIds: i === 0 ? ['wr-char-hero'] : [] })),
    },
    script: { ...base.script, scenes: base.script.scenes.map((sc) => ({ ...sc, castCharacterIds: ['wr-char-hero'] })) },
    cast: {
      available: true,
      castCount: 2,
      reviewedCount: 2,
      semanticReviewedCount: 0,
      passed: false,
      findings: [
        {
          id: 'wr-char-hero::missing::lie', characterId: 'wr-char-hero', characterName: 'Hero',
          kind: 'missing', field: 'psychology.drives.status.fear', dimension: null,
          evidence: 'The status drive has no fear.', suggestion: '',
        },
      ],
      coverage: [
        {
          characterId: 'wr-char-hero', characterName: 'Hero', depth: 'full', status: 'findings',
          findingCount: 1, semanticReviewed: false, staged: true,
          scriptSceneIds: ['scene-01'], proseSegmentIds: ['seg-001'],
        },
        {
          characterId: 'wr-char-aunt', characterName: 'Offstage Aunt', depth: 'light', status: 'passed',
          findingCount: 0, semanticReviewed: false, staged: false,
          scriptSceneIds: [], proseSegmentIds: [],
        },
      ],
      staging: {
        available: true, stale: false, stagedCount: 1, unstagedCount: 1,
        unmatchedNames: ['The Ferryman'],
      },
      ...overrides,
    },
  });
}

describe('SyncedReview — cast pane', () => {
  it('opens the cast pane from the toolbar gap chip and lists findings by field path', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload());
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/1 cast gap/));
    expect(await screen.findByText('Hero')).toBeTruthy();
    expect(screen.getByText(/Psychology › Drives › Status › Fear/)).toBeTruthy();
    expect(screen.getByText(/The status drive has no fear/)).toBeTruthy();
  });

  it('never presents the deterministic sweep as a clean bill of health', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload({ findings: [], coverage: [] }));
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/cast fields filled/));
    expect(await screen.findByText(/no model has read this cast/i)).toBeTruthy();
  });

  it('keeps the cold read separate from author knowledge', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload());
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/1 cast gap/));
    // A script-only name is reported as such, never as a finding.
    expect(await screen.findByText(/Named only in the script/)).toBeTruthy();
    expect(screen.getByText('The Ferryman')).toBeTruthy();
    // An unstaged authored character is a fact, not a defect.
    expect(screen.getByText(/not staged in the script/)).toBeTruthy();
    expect(screen.getByText('Offstage Aunt')).toBeTruthy();
  });

  it('cross-links a character to the scenes and prose segments that stage them', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload());
    const { container } = render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/1 cast gap/));
    const card = (pane, syncId) => container.querySelector(`[data-pane="${pane}"] [data-sync-id="${syncId}"]`);
    fireEvent.click(await screen.findByText('Hero'));
    await waitFor(() => expect(card('cast', 'wr-char-hero').getAttribute('aria-pressed')).toBe('true'));
    expect(card('script', 'scene-01').className).toMatch(/border-port-accent\/50/);
    expect(card('prose', 'seg-001').className).toMatch(/border-port-accent\/50/);
    // Selecting the prose segment highlights the character it stages.
    fireEvent.click(card('prose', 'seg-001'));
    await waitFor(() => expect(card('cast', 'wr-char-hero').className).toMatch(/border-port-accent\/50/));
  });

  // ---- selective augmentation (#6417) ----

  it('sharpens only the ticked field, and only from an explicit click', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload());
    proposeAugment.mockResolvedValue({
      entry: { id: 'wr-char-hero', name: 'Hero' },
      fingerprint: 'fp-1',
      proposals: [
        { field: 'psychology.drives.status.fear', before: '', after: 'Being thanked instead of hired.', rationale: 'names the moment' },
        { field: 'lie', before: 'A generic belief.', after: 'A sharper belief.', rationale: '' },
      ],
    });
    applyAugment.mockResolvedValue({ entry: { id: 'wr-char-hero' }, appliedFields: ['lie'], fingerprint: 'fp-2' });

    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/1 cast gap/));
    // Opening the pane spends nothing.
    expect(proposeAugment).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText(/Sharpen 1 field/));
    await waitFor(() => expect(screen.getByText(/tick what to keep/)).toBeTruthy());
    expect(proposeAugment).toHaveBeenCalledWith(
      'wr-work-1', 'wr-char-hero', { fields: ['psychology.drives.status.fear'] }, { silent: true },
    );

    // Nothing is accepted until the author ticks it.
    const applyButton = screen.getByRole('button', { name: /Apply/ });
    expect(applyButton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Lie/));
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(applyAugment).toHaveBeenCalledWith(
      'wr-work-1', 'wr-char-hero',
      { fields: [{ field: 'lie', value: 'A sharper belief.' }], fingerprint: 'fp-1' },
      { silent: true },
    ));
    // The findings, the depth ruling and the staging join are all derived from
    // the record that just changed, so the pane re-reads rather than patching.
    await waitFor(() => expect(getWritersRoomSyncedReview).toHaveBeenCalledTimes(2));
  });

  it('offers no repair for a contradictory finding — only the author can settle it', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload({
      findings: [{
        id: 'wr-char-hero::contradictory::lie', characterId: 'wr-char-hero', characterName: 'Hero',
        kind: 'contradictory', field: 'lie', dimension: 'control-predicts-behavior',
        evidence: 'The belief and the described behavior disagree.', suggestion: '',
      }],
      coverage: [{
        characterId: 'wr-char-hero', characterName: 'Hero', depth: 'full', status: 'findings',
        findingCount: 1, semanticReviewed: true, staged: true,
        scriptSceneIds: ['scene-01'], proseSegmentIds: ['seg-001'],
      }],
    }));
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/1 cast gap/));
    expect(await screen.findByText('Hero')).toBeTruthy();
    expect(screen.queryByText(/Sharpen/)).toBeNull();
  });

  it('says staging is unknown rather than absent when no script has run', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(castPayload({
      staging: { available: false, stale: false, stagedCount: 0, unstagedCount: 2, unmatchedNames: [] },
      coverage: [{
        characterId: 'wr-char-hero', characterName: 'Hero', depth: 'full', status: 'passed',
        findingCount: 0, semanticReviewed: false, staged: false, scriptSceneIds: [], proseSegmentIds: [],
      }],
      findings: [],
    }));
    render(<SyncedReview work={work} />);
    fireEvent.click(await screen.findByText(/cast fields filled/));
    expect(await screen.findByText(/staging unknown/)).toBeTruthy();
  });

  it('hides the cast chip entirely for a work with no character bible', async () => {
    getWritersRoomSyncedReview.mockResolvedValue(payload());
    render(<SyncedReview work={work} />);
    await screen.findByText('The hero wakes.');
    expect(screen.queryByText(/cast gap/)).toBeNull();
    expect(screen.queryByText(/cast fields filled/)).toBeNull();
  });
});
