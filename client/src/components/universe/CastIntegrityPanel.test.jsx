/**
 * Rendered interaction for the cast-integrity panel (#6415).
 *
 * The behaviors worth pinning here are the ones the server cannot enforce: that
 * the panel costs nothing until the user asks, that it names what a review will
 * spend BEFORE spending it, that a `contradictory` finding offers no repair
 * button, and that applying a proposal is opt-in per field.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CastIntegrityPanel from './CastIntegrityPanel';

const apiMocks = vi.hoisted(() => ({
  getUniverseCastIntegrity: vi.fn(),
  reviewUniverseCastIntegrity: vi.fn(),
  proposeCharacterAugmentation: vi.fn(),
  applyCharacterAugmentation: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder', () => apiMocks);
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toastMock }));

const coverage = [
  { characterId: 'c-1', characterName: 'Wren', depth: 'full', status: 'findings', findingCount: 1, semanticReviewed: false },
  { characterId: 'c-2', characterName: 'Dockhand', depth: 'light', status: 'not-reviewed', findingCount: 0, semanticReviewed: false },
];

const underspecified = {
  id: 'c-1::underspecified::lie',
  characterId: 'c-1',
  characterName: 'Wren',
  kind: 'underspecified',
  field: 'lie',
  dimension: 'control-predicts-behavior',
  evidence: 'The belief is stated so broadly it predicts no particular behavior.',
  suggestion: 'Name the moment she refuses to hand over the chart.',
};

const contradictory = {
  ...underspecified,
  id: 'c-1::contradictory::want',
  kind: 'contradictory',
  field: 'want',
  evidence: 'The want and the need describe the same outcome.',
};

const report = (over = {}) => ({
  findings: [underspecified],
  coverage,
  fingerprints: { 'c-1': 'fp-1' },
  reviewedCount: 1,
  castCount: 2,
  semanticReviewedCount: 0,
  reviewScope: {
    characterIds: ['c-1', 'c-2'],
    characterCount: 2,
    remainingCount: 0,
    batchMax: 12,
    providerId: 'prov-1',
    providerName: 'Local Llama',
    model: 'llama-3.3',
  },
  ...over,
});

const props = { open: true, universeId: 'u-1', onClose: () => {}, onUniverseChange: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getUniverseCastIntegrity.mockResolvedValue(report());
});

describe('CastIntegrityPanel', () => {
  it('opens on the free deterministic report and starts no review of its own', async () => {
    render(<CastIntegrityPanel {...props} />);
    // 'Wren' renders in both the coverage table and the findings list.
    expect(await screen.findAllByText('Wren')).not.toHaveLength(0);
    expect(apiMocks.getUniverseCastIntegrity).toHaveBeenCalledTimes(1);
    expect(apiMocks.reviewUniverseCastIntegrity).not.toHaveBeenCalled();
  });

  it('names the provider, model and character count on the review button before it is pressed', async () => {
    render(<CastIntegrityPanel {...props} />);
    expect(await screen.findByRole('button', { name: /Review 2 characters with Local Llama · llama-3\.3/ })).toBeInTheDocument();
  });

  it('shows a not-reviewed character as such rather than as a pass', async () => {
    render(<CastIntegrityPanel {...props} />);
    expect(await screen.findByText('Dockhand')).toBeInTheDocument();
    expect(screen.getByText('Not reviewed')).toBeInTheDocument();
  });

  it('reports partial coverage after a truncated review instead of a clean result', async () => {
    apiMocks.reviewUniverseCastIntegrity.mockResolvedValue(report({
      findings: [],
      truncated: true,
      coverage: [{ ...coverage[0], status: 'passed', findingCount: 0, semanticReviewed: true }, { ...coverage[1], status: 'truncated' }],
      reviewScope: { ...report().reviewScope, characterCount: 1, remainingCount: 1 },
    }));
    render(<CastIntegrityPanel {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Review 2 characters/ }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('still unreviewed')));
    expect(await screen.findByText('Truncated')).toBeInTheDocument();
  });

  it('offers no repair path on a contradictory finding — only the author can resolve it', async () => {
    apiMocks.getUniverseCastIntegrity.mockResolvedValue(report({ findings: [contradictory] }));
    render(<CastIntegrityPanel {...props} />);
    expect(await screen.findByText('Contradictory')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Propose improvements/ })).toBeNull();
  });

  it('proposes, then applies ONLY the field the author ticked', async () => {
    apiMocks.proposeCharacterAugmentation.mockResolvedValue({
      entry: { id: 'c-1', name: 'Wren' },
      fingerprint: 'fp-1',
      proposals: [
        { field: 'lie', before: 'old lie', after: 'a sharper lie', rationale: 'names the act' },
        { field: 'want', before: 'old want', after: 'a sharper want', rationale: 'concrete goal' },
      ],
    });
    apiMocks.applyCharacterAugmentation.mockResolvedValue({
      universe: { id: 'u-1' }, entry: { id: 'c-1', name: 'Wren' }, appliedFields: ['lie'],
    });

    render(<CastIntegrityPanel {...props} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Propose improvements/ }));

    // Nothing is pre-accepted — the author opts in per field.
    const lieBox = await screen.findByLabelText('Lie');
    expect(lieBox).not.toBeChecked();
    expect(screen.getByLabelText('Want')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled();

    fireEvent.click(lieBox);
    fireEvent.click(screen.getByRole('button', { name: /^Apply 1/ }));

    await waitFor(() => expect(apiMocks.applyCharacterAugmentation).toHaveBeenCalled());
    const [, entryId, body] = apiMocks.applyCharacterAugmentation.mock.calls[0];
    expect(entryId).toBe('c-1');
    expect(body).toEqual({ fields: [{ field: 'lie', value: 'a sharper lie' }], fingerprint: 'fp-1' });
    // The touched character is marked stale IN PLACE. Re-deriving the report
    // would re-run the free deterministic pass and throw away the semantic
    // review the user just paid a provider call for.
    expect(await screen.findByText('Stale')).toBeInTheDocument();
    expect(apiMocks.getUniverseCastIntegrity).toHaveBeenCalledTimes(1);
  });

  it('keeps the semantic findings after an apply instead of discarding them', async () => {
    apiMocks.getUniverseCastIntegrity.mockResolvedValue(report({
      findings: [underspecified],
      coverage: [{ ...coverage[0], semanticReviewed: true }, coverage[1]],
      semanticReviewedCount: 1,
    }));
    apiMocks.proposeCharacterAugmentation.mockResolvedValue({
      entry: { id: 'c-1', name: 'Wren' },
      fingerprint: 'fp-1',
      proposals: [{ field: 'lie', before: 'old lie', after: 'a sharper lie', rationale: '' }],
    });
    apiMocks.applyCharacterAugmentation.mockResolvedValue({
      universe: { id: 'u-1' }, entry: { id: 'c-1' }, appliedFields: ['lie'],
    });

    render(<CastIntegrityPanel {...props} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Propose improvements/ }));
    fireEvent.click(await screen.findByLabelText('Lie'));
    fireEvent.click(screen.getByRole('button', { name: /^Apply 1/ }));

    expect(await screen.findByText('Stale')).toBeInTheDocument();
    expect(screen.getByText(underspecified.evidence)).toBeInTheDocument();
  });

  it('blocks a mixed-character selection instead of firing one call per character', async () => {
    apiMocks.getUniverseCastIntegrity.mockResolvedValue(report({
      findings: [underspecified, { ...underspecified, id: 'c-2::underspecified::want', characterId: 'c-2', characterName: 'Dockhand', field: 'want' }],
    }));
    render(<CastIntegrityPanel {...props} />);
    const boxes = await screen.findAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(screen.getByRole('button', { name: /Propose improvements/ })).toBeDisabled();
    expect(screen.getByText(/one character at a time/)).toBeInTheDocument();
  });

  it('surfaces a stale apply as an error instead of pretending it landed', async () => {
    apiMocks.proposeCharacterAugmentation.mockResolvedValue({
      entry: { id: 'c-1', name: 'Wren' },
      fingerprint: 'fp-stale',
      proposals: [{ field: 'lie', before: 'old lie', after: 'a sharper lie', rationale: '' }],
    });
    apiMocks.applyCharacterAugmentation.mockRejectedValue(new Error('This character changed since the proposal was generated'));

    render(<CastIntegrityPanel {...props} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Propose improvements/ }));
    fireEvent.click(await screen.findByLabelText('Lie'));
    fireEvent.click(screen.getByRole('button', { name: /^Apply 1/ }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('changed since the proposal')));
    expect(props.onUniverseChange).not.toHaveBeenCalled();
  });
});
