import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  exportUniverseMarkdown: vi.fn(),
  waitForUniverseWrites: vi.fn(),
}));
const downloadMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const hookMocks = vi.hoisted(() => ({
  useUniverseDraft: vi.fn(),
  useUniverseExpand: vi.fn(),
  useUniverseGallery: vi.fn(),
  useUniverseRender: vi.fn(),
  useUniverseTabs: vi.fn(),
  useUniverseBucketActions: vi.fn(),
  useUniverseNav: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  ...apiMocks,
  WORLD_CATEGORY_KEY_MAX: 64,
}));
vi.mock('../../lib/downloadBlob', () => downloadMock);
vi.mock('../ui/Toast', () => ({ default: toastMock }));
vi.mock('../../hooks/useUniverseDraft', () => ({ default: hookMocks.useUniverseDraft }));
vi.mock('../../hooks/useUniverseExpand', () => ({ default: hookMocks.useUniverseExpand }));
vi.mock('../../hooks/useUniverseGallery', () => ({ default: hookMocks.useUniverseGallery }));
vi.mock('../../hooks/useUniverseRender', () => ({ default: hookMocks.useUniverseRender }));
vi.mock('../../hooks/useUniverseTabs', () => ({ default: hookMocks.useUniverseTabs }));
vi.mock('../../hooks/useUniverseBucketActions', () => ({ default: hookMocks.useUniverseBucketActions }));
vi.mock('../../hooks/useUniverseNav', () => ({ useUniverseNav: hookMocks.useUniverseNav }));
vi.mock('../EntityCombobox', () => ({ default: () => null }));
vi.mock('../ui/InlineConfirmRow', () => ({ default: () => null }));
vi.mock('../media/MediaPreview', () => ({ default: () => null }));
vi.mock('../sharing/OriginBadge', () => ({ default: () => null }));
vi.mock('../sharing/ShareToButton', () => ({ default: () => null }));
vi.mock('../sharing/SyncToPeerButton', () => ({ default: () => null }));
vi.mock('../ui/TabPills', () => ({ default: () => null }));
vi.mock('./CompositeSheetsEditor', () => ({ default: () => null }));
vi.mock('./RenderTab', () => ({ default: () => null }));
vi.mock('./UniverseBibleTab', () => ({ default: () => null }));
vi.mock('./graph/UniverseGraphTab', () => ({ default: () => null }));
vi.mock('./UniverseCategoryEditor', () => ({ CategoryEditor: () => null }));
vi.mock('./UniverseTrunkPanels', () => ({ OtherTab: () => null, TrunkView: () => null }));
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    ArrowLeft: Icon, BookOpen: Icon, FolderTree: Icon, ImagePlus: Icon, Layers: Icon,
    Loader2: Icon, MapPin: Icon, Network: Icon, Package: Icon, Plus: Icon, Save: Icon,
    Trash2: Icon, Users: Icon,
  };
});

import UniverseBuilderPage from './UniverseBuilderPage.jsx';

const navigateRef = { current: null };

function NavigationProbe() {
  navigateRef.current = useNavigate();
  return null;
}

const makeDraft = (id) => ({
  id,
  name: id === 'u1' ? 'First World' : 'Second World',
  categories: {},
  compositeSheets: [],
  characters: [],
  places: [],
  objects: [],
  influences: { embrace: [], avoid: [] },
  styleReferences: [],
  origin: null,
});

const fn = () => vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  navigateRef.current = null;
  apiMocks.waitForUniverseWrites.mockResolvedValue(true);
  hookMocks.useUniverseNav.mockReturnValue(vi.fn());
  hookMocks.useUniverseDraft.mockImplementation(({ selectedId }) => {
    const draft = makeDraft(selectedId);
    return {
      activeProviderId: null,
      addCategory: fn(),
      assignBucketKind: fn(),
      availableBackends: [],
      availableLoras: [],
      clearPendingCanonAdditions: fn(),
      draft,
      draftRef: { current: draft },
      effectiveDefaultMode: null,
      flushDraftIfDirty: vi.fn().mockResolvedValue(true),
      handleCanonChange: fn(),
      handleCreateNamed: fn(),
      handleDelete: fn(),
      handleSave: fn(),
      imageCfg: {},
      imageModels: [],
      loading: false,
      markDraftSaved: fn(),
      mountedRef: { current: true },
      newCategoryName: '',
      pendingCanonAdditionsRef: { current: {} },
      pendingDeleteId: null,
      providerLabel: '',
      providerModels: [],
      providers: [],
      adoptStyleGuideFromBoard: fn(),
      persistStyleReference: fn(),
      removeCategory: fn(),
      removeStyleReference: fn(),
      runs: [],
      saving: false,
      setCanonDirty: fn(),
      setDraft: fn(),
      setNewCategoryName: fn(),
      setPendingDeleteId: fn(),
      setRenderPin: fn(),
      setRuns: fn(),
      setSaving: fn(),
      setWorlds: fn(),
      styleProbeDirty: false,
      syncEntryIdsFromServer: fn(),
      toggleLock: fn(),
      universes: [],
      updateCategory: fn(),
      updateCompositeSheets: fn(),
      updateDraft: fn(),
    };
  });
  hookMocks.useUniverseExpand.mockReturnValue({
    expanding: false, handleExpand: fn(), refine: fn(),
  });
  hookMocks.useUniverseGallery.mockReturnValue({
    previewItems: [], preview: null, setPreview: fn(), previewActions: {
      handleClean: fn(), handleContinue: fn(), handleRemix: fn(),
      handleRemoveWatermark: fn(), handleSendToImage: fn(), handleSendToVideo: fn(),
    }, openPreviewByFilename: fn(), openVariationPreview: fn(), annotations: {},
    updateAnnotation: fn(), bumpGalleryRefresh: fn(),
  });
  hookMocks.useUniverseRender.mockReturnValue({
    canRender: false, clearPendingForEntry: fn(), handleRender: fn(),
    pendingHeadByEntryId: {}, renderOpts: {}, rendering: false, runRender: fn(), setRenderOpts: fn(),
  });
  hookMocks.useUniverseTabs.mockReturnValue({
    activeBucket: null, activeTab: 'bible', bucketsByKind: {
      characters: [], places: [], objects: [], other: [],
    }, hasOtherBuckets: false, setBucket: fn(), setTab: fn(),
  });
  hookMocks.useUniverseBucketActions.mockReturnValue({
    autoSorting: false, handleAutoSort: fn(), handleGenerateInCategory: fn(),
    handlePromoteVariation: fn(), promoting: false,
  });
});

describe('UniverseBuilderPage Markdown export', () => {
  it('does not download a response after navigating to another universe', async () => {
    let resolveExport;
    apiMocks.exportUniverseMarkdown.mockReturnValueOnce(new Promise((resolve) => {
      resolveExport = resolve;
    }));

    render(
      <MemoryRouter initialEntries={['/universes/u1']}>
        <NavigationProbe />
        <Routes>
          <Route path="/universes/:universeId" element={<UniverseBuilderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Export .md' }));
    await waitFor(() => expect(apiMocks.exportUniverseMarkdown).toHaveBeenCalledWith('u1', { silent: true }));

    act(() => { navigateRef.current('/universes/u2'); });
    await act(async () => { resolveExport('# First World\n'); });

    expect(downloadMock.downloadBlob).not.toHaveBeenCalled();
  });

  it('downloads the current universe Markdown with the shared filename and MIME type', async () => {
    apiMocks.exportUniverseMarkdown.mockResolvedValueOnce('# First World\n');

    render(
      <MemoryRouter initialEntries={['/universes/u1']}>
        <NavigationProbe />
        <Routes>
          <Route path="/universes/:universeId" element={<UniverseBuilderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Export .md' }));
    await waitFor(() => expect(downloadMock.downloadBlob).toHaveBeenCalledWith(
      '# First World\n', 'first-world.md', 'text/markdown',
    ));
    expect(toastMock.success).toHaveBeenCalledWith('Downloaded first-world.md');
  });

  it('refuses export when a pending universe write exceeds the wait bound', async () => {
    apiMocks.waitForUniverseWrites.mockResolvedValueOnce(false);

    render(
      <MemoryRouter initialEntries={['/universes/u1']}>
        <NavigationProbe />
        <Routes>
          <Route path="/universes/:universeId" element={<UniverseBuilderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Export .md' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(
      'Changes are still saving — try the export again in a moment',
    ));
    expect(apiMocks.exportUniverseMarkdown).not.toHaveBeenCalled();
  });
});
