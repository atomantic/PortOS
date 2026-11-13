import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CastSetsStage from './CastSetsStage.jsx';
import useCatalogCastSetsCheckin from '../../../hooks/useCatalogCastSetsCheckin.js';

vi.mock('../../../hooks/useCatalogCastSetsCheckin.js', () => ({ default: vi.fn() }));
vi.mock('../../../hooks/useMusicVideoCastingChanges.js', () => ({ default: () => ({ changes: null, loadError: null, retry: () => {} }) }));
vi.mock('../CatalogLookReferences.jsx', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../LookReferencesPanel.jsx', () => ({ default: () => null }));
vi.mock('../VisualSpecPanel.jsx', () => ({ default: () => null }));
vi.mock('../CameoRosterPanel.jsx', () => ({ default: () => null }));
vi.mock('../DevArtifactsPanel.jsx', () => ({ default: () => null }));
vi.mock('../CastAndSetsReferenceProgress.jsx', () => ({ default: () => null }));
vi.mock('../CastAndSetsCheckin.jsx', () => ({ default: () => null }));

const board = (overrides = {}) => ({
  project: { id: 'mv-example', castAndSets: { source: 'catalog', status: 'review' }, concept: {} },
  locked: false,
  castSets: { busy: false, rebuildCatalogGuide: vi.fn(async () => ({ artifact: { id: 'dev-guide' } })) },
  kickoff: { running: false },
  devArtifacts: { busy: false },
  openArtifact: vi.fn(),
  goToStage: vi.fn(),
  ...overrides,
});
const button = () => screen.getByRole('button', { name: 'Rebuild guide' });

describe('catalog Cast & Sets guide rebuild', () => {
  beforeEach(() => useCatalogCastSetsCheckin.mockReturnValue({ checkin: { items: [], problems: [], basis: 'b', approved: false }, error: null, retry: () => {} }));
  afterEach(cleanup);

  // Uniquely catches the button not rebuilding, or leaving the director without the sheet they just asked for.
  it('rebuilds and opens the saved guide', async () => {
    const stage = board();
    render(<CastSetsStage board={stage} />);
    fireEvent.click(button());
    expect(stage.castSets.rebuildCatalogGuide).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stage.openArtifact).toHaveBeenCalledWith('dev-guide'));
  });

  // Uniquely catches a failed rebuild navigating away, and rebuilding while the catalog read is unresolved.
  it('stays put on failure and waits for a resolved check-in', async () => {
    const stage = board({ castSets: { busy: false, rebuildCatalogGuide: vi.fn(async () => null) } });
    render(<CastSetsStage board={stage} />);
    fireEvent.click(button());
    await waitFor(() => expect(stage.castSets.rebuildCatalogGuide).toHaveBeenCalled());
    expect(stage.openArtifact).not.toHaveBeenCalled();
    cleanup();

    useCatalogCastSetsCheckin.mockReturnValue({ checkin: { items: [], problems: [{ subjectId: 's', code: 'CATALOG_IMAGES_REQUIRED', message: 'Add a usable image to Example.' }], basis: 'b' }, error: null, retry: () => {} });
    render(<CastSetsStage board={board()} />);
    expect(button().disabled).toBe(true);
    expect(screen.getByText('Add a usable image to Example.')).toBeTruthy();
    cleanup();

    useCatalogCastSetsCheckin.mockReturnValue({ checkin: null, error: null, retry: () => {} });
    render(<CastSetsStage board={board()} />);
    expect(button().disabled).toBe(true);
  });

  // Uniquely catches a catalog check-in offering no way to correct its kept direction text, or sending fields the director did not change (#15473).
  it('edits the kept direction text and sends only what changed', async () => {
    const direction = { look: 'Stale look', protagonist: { name: 'Example Lead', signature: 'Old key', rules: ['Never without the key'], expressions: ['wary'] },
      props: [{ id: 'key', name: 'Brass key', owner: '', description: 'An old brass key' }], overlayConcept: { summary: 'Old overlay', elements: [] } };
    const editDirectionText = vi.fn(async () => ({ project: {} }));
    const stage = board({ project: { id: 'mv-example', castAndSets: { source: 'catalog', status: 'approved', direction }, concept: {} },
      castSets: { busy: false, rebuildCatalogGuide: vi.fn(), editDirectionText } });
    render(<CastSetsStage board={stage} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit direction text' }));
    fireEvent.change(screen.getByLabelText('Look'), { target: { value: 'Clean daylight' } });
    fireEvent.change(screen.getByLabelText(/Protagonist rules/), { target: { value: 'Always wears the scarf\n\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove prop 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save direction text' }));
    expect(editDirectionText).toHaveBeenCalledWith({ look: 'Clean daylight', protagonist: { rules: ['Always wears the scarf'] }, props: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit direction text' })).toBeTruthy());
  });

  // Uniquely catches a catalog-first check-in hiding the direction text editor when no generated direction exists yet (#15967).
  it('shows the look editor for a catalog check-in with no direction yet', async () => {
    const editDirectionText = vi.fn(async () => ({ project: {} }));
    const stage = board({ project: { id: 'mv-example', castAndSets: { source: 'catalog', status: 'review' }, concept: {} },
      castSets: { busy: false, rebuildCatalogGuide: vi.fn(), editDirectionText } });
    render(<CastSetsStage board={stage} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit direction text' }));
    const look = 'Night palette: deep blue-black with cyan and pink light.';
    fireEvent.change(screen.getByLabelText('Look'), { target: { value: look } });
    fireEvent.click(screen.getByRole('button', { name: 'Save direction text' }));
    expect(editDirectionText).toHaveBeenCalledWith({ look });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit direction text' })).toBeTruthy());
  });
});
