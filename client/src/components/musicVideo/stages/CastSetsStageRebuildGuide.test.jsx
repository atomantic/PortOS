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
});
