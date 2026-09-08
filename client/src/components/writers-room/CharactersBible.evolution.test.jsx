/**
 * The story-scoped five-stage evolution lens, authored in the Writers Room cast
 * bible (#6445, epic #6418).
 *
 * What this pins: the lens round-trips through the bible editor, a stale
 * segment anchor stays visible and re-pickable rather than vanishing, and the
 * lens never becomes a gate — a character with none is not "missing" anything.
 *
 * Obviously-fake fixtures only — never a record from a live instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomCharacters: vi.fn(),
  createWritersRoomCharacter: vi.fn(),
  updateWritersRoomCharacter: vi.fn(),
  deleteWritersRoomCharacter: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import CharactersBible from './CharactersBible';
import {
  listWritersRoomCharacters,
  updateWritersRoomCharacter,
} from '../../services/apiWritersRoom';

const CHARACTER = {
  id: 'wr-char-1',
  name: 'Wren Calloway',
  aliases: [],
  role: 'protagonist',
  physicalDescription: 'Short, silver hair, sharp eyes.',
  personality: '',
  background: '',
  notes: '',
  motivations: '',
  ghost: '',
  wound: '',
  lie: '',
  need: '',
  want: '',
  arcType: null,
  secrets: [],
  sliders: { proactivity: null, likability: null, competence: null },
  relationshipLinks: [],
  source: 'user',
};

const SEGMENTS = [
  { id: 'seg-001', kind: 'chapter', heading: 'Ledger' },
  { id: 'seg-002', kind: 'chapter', heading: 'Harbor' },
];

const withLens = (evolution) => ({ ...CHARACTER, evolution });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('CharactersBible — five-stage evolution lens (#6445)', () => {
  it('authors an outcome, a stage and a manuscript anchor, then shows them after a reload', async () => {
    const CHOICE = 'She lets the boat go without counting.';
    const QUOTE = 'let the boat go';
    const saved = withLens({
      outcome: 'full-change',
      outcomeNote: '',
      stages: [{
        stageId: 'final-proof',
        testedBelief: '',
        externalPressure: '',
        characterChoice: CHOICE,
        causalConsequence: '',
        evidence: { atIssue: null, atSceneAnchor: '', transitionId: '', episodeId: '', sceneKey: '', segmentId: 'seg-002', anchorQuote: QUOTE },
      }],
    });
    listWritersRoomCharacters.mockResolvedValue([CHARACTER]);
    updateWritersRoomCharacter.mockResolvedValue(saved);

    const { unmount } = render(<CharactersBible workId="wr-work-1" segments={SEGMENTS} />);
    await screen.findByText('Wren Calloway');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));

    await userEvent.selectOptions(screen.getByLabelText('Declared outcome'), 'full-change');
    await userEvent.type(screen.getByLabelText('final proof — Character choice'), CHOICE);
    await userEvent.selectOptions(screen.getByLabelText('final proof — Evidence segment'), 'seg-002');
    await userEvent.type(screen.getByLabelText('final proof — Anchor quote'), QUOTE);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalled());
    const { evolution } = updateWritersRoomCharacter.mock.calls[0][2];
    expect(evolution.outcome).toBe('full-change');
    expect(evolution.stages).toHaveLength(1);
    expect(evolution.stages[0]).toMatchObject({ stageId: 'final-proof', characterChoice: CHOICE });
    expect(evolution.stages[0].evidence).toMatchObject({ segmentId: 'seg-002', anchorQuote: QUOTE });

    unmount();
    listWritersRoomCharacters.mockResolvedValue([saved]);
    render(<CharactersBible workId="wr-work-1" segments={SEGMENTS} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Wren Calloway' }));
    expect(screen.getByLabelText('Declared outcome')).toHaveValue('full-change');
    expect(screen.getByLabelText('final proof — Character choice')).toHaveValue(CHOICE);
    expect(screen.getByLabelText('final proof — Evidence segment')).toHaveValue('seg-002');
    expect(screen.getByLabelText('final proof — Anchor quote')).toHaveValue(QUOTE);
  });

  it('keeps a stale segment anchor visible and re-pickable, preserving the quote', async () => {
    // The writer cut the chapter this stage pointed at; `seg-009` is gone.
    const stale = withLens({
      outcome: 'full-change',
      outcomeNote: '',
      stages: [{
        stageId: 'final-proof',
        characterChoice: 'She lets the boat go.',
        evidence: { atIssue: null, atSceneAnchor: '', transitionId: '', episodeId: '', sceneKey: '', segmentId: 'seg-009', anchorQuote: 'let the boat go' },
      }],
    });
    listWritersRoomCharacters.mockResolvedValue([stale]);
    updateWritersRoomCharacter.mockImplementation(async (_w, _id, patch) => ({ ...stale, ...patch }));

    render(<CharactersBible workId="wr-work-1" segments={SEGMENTS} />);
    await screen.findByText('Wren Calloway');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));

    expect(screen.getByText('Stale anchor')).toBeInTheDocument();
    // The dead pointer is still selected, labelled "(missing)" — never silently
    // dropped, and never rendered as a live anchor.
    expect(screen.getByLabelText('final proof — Evidence segment')).toHaveValue('seg-009');
    expect(screen.getByRole('option', { name: 'seg-009 (missing)' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Re-pick final proof anchor/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalled());
    const [stageOut] = updateWritersRoomCharacter.mock.calls[0][2].evolution.stages;
    expect(stageOut.evidence.segmentId).toBe('');
    // The quote survives the re-pick — it is the hint the writer re-anchors by.
    expect(stageOut.evidence.anchorQuote).toBe('let the boat go');
    expect(stageOut.characterChoice).toBe('She lets the boat go.');
  });

  it('never gates on the lens: an unset one is not listed as missing and clears to null', async () => {
    listWritersRoomCharacters.mockResolvedValue([CHARACTER]);
    updateWritersRoomCharacter.mockImplementation(async (_w, _id, patch) => ({ ...CHARACTER, ...patch }));

    render(<CharactersBible workId="wr-work-1" segments={SEGMENTS} />);
    await screen.findByText('Wren Calloway');
    // The row's completeness warning never mentions the optional lens.
    expect(screen.queryByText(/Missing:.*evolution/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalled());
    // Present-but-null is how the server tells a deliberate clear from an
    // untouched key; an unauthored lens sends null, not an empty husk.
    expect(updateWritersRoomCharacter.mock.calls[0][2].evolution).toBeNull();
  });

  it('still edits the prose half when the work has no segment index to anchor to', async () => {
    listWritersRoomCharacters.mockResolvedValue([CHARACTER]);
    updateWritersRoomCharacter.mockImplementation(async (_w, _id, patch) => ({ ...CHARACTER, ...patch }));

    render(<CharactersBible workId="wr-work-1" />);
    await screen.findByText('Wren Calloway');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Wren Calloway' }));

    await userEvent.type(screen.getByLabelText('cost tested — Belief under test'), 'The ledger keeps people.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateWritersRoomCharacter).toHaveBeenCalled());
    const [stageOut] = updateWritersRoomCharacter.mock.calls[0][2].evolution.stages;
    expect(stageOut).toMatchObject({ stageId: 'cost-tested', testedBelief: 'The ledger keeps people.' });
  });
});
