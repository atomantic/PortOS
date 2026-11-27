import { vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import CatalogIngredient from './CatalogIngredient';
import { getCatalogIngredientDetails, getCatalogUniverseContext, listCatalogRelatedImages, unlinkCatalogIngredientRelation, updateCatalogIngredient, detachCatalogIngredientMedia, restoreCatalogIngredientRevision, uploadCatalogIngredientMediaFile } from '../services/apiCatalog';

// Stable navigate mock — returning a fresh vi.fn() per call would change the
// load effect's dependency identity every render and re-fire the fetch, which
// races the second test in this file into a stuck "loading" state.
const { navigateMock } = vi.hoisted(() => ({ navigateMock: () => {} }));

vi.mock('../hooks/useMediaUsages', () => ({ useMediaUsages: () => ({}), refreshMediaUsages: () => Promise.resolve() }));

vi.mock('react-router', async (io) => {
  const actual = await io();
  return { ...actual, useNavigate: () => navigateMock };
});

const { CHAR_FIXTURE } = vi.hoisted(() => ({
  CHAR_FIXTURE: {
    id: 'cat-chr-1',
    type: 'character',
    name: 'Ada Lovelace',
    tags: ['mentor', 'My Cool Universe'],
    payload: {
      role: 'Mentor',
      pronouns: 'she/her',
      physicalDescription: 'Sharp eyes, ink-stained cuffs.',
      motivations: 'Decode the machine.',
      dislikes: 'Being underestimated.',
      colorPalette: [{ name: 'Brass', hex: '#b08d57' }],
      // storyBible stats are { label, value } — the editor + durable shape
      // standardize on .label (the prior read-only renderer wrongly read .key).
      stats: [{ label: 'Logic', value: '9' }],
      aliases: ['The Countess'],
    },
    refs: [{ refKind: 'universe', refId: 'u-1', refName: 'My Cool Universe', role: 'canon-character' },
      { refKind: 'universe', refId: 'u-1', refName: 'My Cool Universe', role: 'owner' }],
    sources: [],
  },
}));

// The detail page now hydrates via the batched getCatalogIngredientDetails
// ({ ingredient, refs, sources, relations, revisions, media, missingMedia }).
const { detailsOf } = vi.hoisted(() => ({
  detailsOf: (ing) => ({
    ingredient: ing,
    refs: ing.refs || [],
    universeContext: { status: ing.refs?.some((ref) => ref.role === 'owner') ? 'owned' : 'needs-review',
      owner: ing.refs?.find((ref) => ref.role === 'owner') || null, refs: ing.refs || [] },
    sources: ing.sources || [],
    relations: { outbound: [], inbound: [] },
    revisions: [],
    media: [],
    missingMedia: [],
  }),
}));

vi.mock('../services/apiCatalog', () => ({
  getCatalogFamilyContext: vi.fn(async () => ({ additions: [], images: [], imagesAddition: null })),
  getCatalogIngredientDetails: vi.fn(async () => detailsOf(CHAR_FIXTURE)),
  getCatalogUniverseContext: vi.fn(async () => ({ ...detailsOf(CHAR_FIXTURE).universeContext, usageComplete: true })),
  listCatalogRelatedImages: vi.fn(async () => ({ items: [], total: 0, limit: 24, offset: 0 })),
  getCatalogLookAround: vi.fn(async () => ({ motions: [], models: [], defaults: {}, configured: false, mainPlate: null, clips: [], pending: [] })),
  startCatalogLookAround: vi.fn(),
  scoreCatalogLookAroundClip: vi.fn(),
  saveCatalogLookAroundAngles: vi.fn(),
  updateCatalogIngredient: vi.fn(),
  setCatalogIngredientLock: vi.fn(),
  getCatalogIngredientCards: vi.fn(async () => []),
  deleteCatalogIngredient: vi.fn(),
  linkCatalogIngredient: vi.fn(async () => ({ success: true })),
  linkCatalogIngredientRelation: vi.fn(),
  unlinkCatalogIngredientRelation: vi.fn(),
  listCatalogIngredientRevisions: vi.fn(async () => ({ items: [] })),
  restoreCatalogIngredientRevision: vi.fn(),
  uploadCatalogIngredientMediaFile: vi.fn(),
  listCatalogIngredientMedia: vi.fn(async () => []),
  attachCatalogIngredientMedia: vi.fn(),
  setCatalogIngredientPortrait: vi.fn(),
  attachCatalogIngredientGeneratedImage: vi.fn(),
  detachCatalogIngredientMedia: vi.fn(),
  listCatalogSheetVariants: vi.fn(async () => ({ variants: [] })),
  listCatalogSheetJobs: vi.fn(async () => ({ jobs: [], hasMore: false })),
  previewCatalogSheet: vi.fn(async () => ({ preview: null })),
  renderCatalogSheet: vi.fn(),
  removeCatalogPointerSheet: vi.fn(),
  refineCatalogMedia: vi.fn(async () => ({ sentPrompt: 'Example reference refinement' })),
  updateCatalogIngredientMediaLibrary: vi.fn(async () => ({})),
}));

// Universe-delegated sheet renders announce completion on this broadcast.
const { socketHandlers } = vi.hoisted(() => ({ socketHandlers: new Map() }));

vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => socketHandlers.set(event, new Set([...(socketHandlers.get(event) || []), fn])),
    off: (event, fn) => {
      const handlers = socketHandlers.get(event);
      handlers?.delete(fn);
      if (!handlers?.size) socketHandlers.delete(event);
    },
  },
}));

vi.mock('../services/apiSystem', () => ({ generateImage: vi.fn(), getSettings: vi.fn(async () => ({})), updateSettings: vi.fn(async () => ({})), getSelfInstance: vi.fn(async () => ({ instanceId: 'canonical-owner' })), getInstances: vi.fn(async () => ({ peers: [{ instanceId: 'canonical-owner', host: 'canonical.example', port: 5555 }] })) }));

vi.mock('../services/apiCatalogIdentity', () => ({
  listCatalogIdentities: vi.fn(async () => ({ items: [], nextOffset: null })), getCatalogIdentity: vi.fn(), acceptCatalogIdentity: vi.fn(), abortCatalogIdentity: vi.fn(),
}));

vi.mock('../services/apiCatalogTypes', () => ({
  listCatalogTypes: vi.fn(async () => ({ types: [] })),
}));

// The editable-prompt panel lazily fetches the linked universe to layer its
// style preset onto the composed prompt; default to "no universe" so the seed
// renders bare unless a test overrides it.
vi.mock('../services/apiUniverseBuilder', () => ({
  getUniverse: vi.fn(async () => ({ id: 'u-1' })),
  listUniverseNames: vi.fn(async () => [{ id: 'u-1', name: 'Example World' }]),
  listUniverseStyles: vi.fn(async () => [{ id: 'u-1', influences: { embrace: ['Analog photography'] } }]),
}));

vi.mock('../services/apiMoodBoard', () => ({ listMoodBoardNames: vi.fn(async () => [{ id: 'mb-1', name: 'Example Board' }]) }));

// Stand-in for the live image-gen thumb: fire onFilename as soon as a jobId is
// handed in, simulating a completed render without the socket/job machinery.
vi.mock('../components/pipeline/MediaJobThumb', async () => {
  const { useEffect } = await import('react');
  // A jobId of 'fail-job' simulates a failed render (drives onStatus); any other
  // id simulates a completed render (drives onFilename).
  function MockMediaJobThumb({ jobId, onFilename, onStatus }) {
    useEffect(() => {
      if (!jobId) return;
      if (jobId === 'fail-job') onStatus?.('failed');
      else if (!jobId.startsWith('manual-')) onFilename?.(`${jobId}.png`);
    }, [jobId, onFilename, onStatus]);
    return (
      <div data-testid={`job-thumb-${jobId}`}>
        <button onClick={() => onFilename?.(`${jobId}.png`)}>Complete job</button>
      </div>
    );
  }
  return { default: MockMediaJobThumb };
});

vi.mock('../services/apiImageVideo', () => ({
  listImageVariants: vi.fn(async () => ({ items: [] })),
  getGalleryImages: vi.fn(async () => []),
  listMediaGalleryPage: vi.fn(async () => ({ items: [] })),
  listImageGalleryPage: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 60 })),
  applyImageFilmLook: vi.fn(async () => ({ filename: 'one-look.png' })),
  // Echo the request as the "sent" prompt, with its declared additions as chips.
  previewImagePrompt: vi.fn(async (body) => ({
    sentPrompt: body.prompt,
    ...(body.quickEdit ? { reviewedPromptDigest: 'b'.repeat(64) } : {}),
    ...(body.reviewReference ? { reviewedReferenceDigest: 'a'.repeat(64), reviewedReferenceImage: 'data:image/png;base64,eA==' } : {}),
    ...(body.negativePrompt ? { sentNegativePrompt: body.negativePrompt } : {}),
    promptAdditions: body.promptAdditions || [],
  })),
}));

// Closed it renders nothing; open it offers one record so a pick can be driven.
vi.mock('../components/IngredientPicker', () => ({
  default: ({ open, type, excludeIds = [], onSelect }) => (open
    ? <button type="button" data-exclude={excludeIds.join(',')} onClick={() => onSelect({ id: 'cat-chr-rival', name: 'Example Rival', type })}>Pick stub {type}</button>
    : null),
}));

vi.mock('../components/catalog/PhotorealPanel', () => ({
  default: ({ record, onSaved }) => (
    <button type="button" onClick={() => onSaved({ ...record, payload: { ...record.payload, photoreal: { version: 1, lights: [{ id: 'key' }] } } })}>Apply stub look</button>
  ),
}));

const { mediaAnnotationsFixture } = vi.hoisted(() => ({ mediaAnnotationsFixture: { current: {} } }));

vi.mock('../hooks/useMediaAnnotations', () => ({ useMediaAnnotations: () => ({ annotations: mediaAnnotationsFixture.current, updateAnnotation: vi.fn() }) }));

vi.mock('../components/media/AddToCollectionMenu', () => ({ default: () => null }));

vi.mock('../components/media/PinToMoodBoardMenu', () => ({ default: () => null }));

vi.mock('../components/media/PromptRefineModal', () => ({ default: () => null }));

vi.mock('../components/media/PromptFromMedia', () => ({ PromptFromMediaModal: () => null }));

vi.mock('../components/MediaImage', () => ({ default: ({ src, alt, fallbackSrc }) => <img src={src} alt={alt} data-fallback-src={fallbackSrc} /> }));

vi.mock('../components/TagPicker', () => ({
  default: ({ value = [], onChange }) => (
    <button
      type="button"
      onClick={() => onChange(value.includes('example-tag')
        ? value.filter((tag) => tag !== 'example-tag')
        : [...value, 'example-tag'])}
    >
      Change tag
    </button>
  ),
}));

vi.mock('../components/ui/Toast');

vi.mock('../components/catalog/ingredient/CharacterLoraChip', () => ({ default: () => null }));

// Several panels listen to one event, so every listener receives an emit.
const emitSocket = (event, data) => {
  const handlers = socketHandlers.get(event);
  if (!handlers?.size) throw new Error(`No socket listener for ${event}`);
  for (const fn of handlers) fn(data);
};

const renderPage = async (path = '/catalog/character/cat-chr-1?castSheet-cat-chr-1=appearance') => {
  const router = createMemoryRouter([
    { path: '/catalog', element: <div>Catalog index</div> },
    { path: '/catalog/:type/:id', element: <CatalogIngredient /> },
    { path: '/casting', element: <div>Casting index</div> },
    { path: '/casting/:id/:tab?', element: <CatalogIngredient /> },
    { path: '/objects/:id/:tab?', element: <CatalogIngredient /> },
    { path: '/environments/:id/:tab?', element: <CatalogIngredient /> },
  ], { initialEntries: [path] });
  const result = render(<RouterProvider router={router} />);
  await act(async () => {});
  return { ...result, router };
};

function installCatalogIngredientHooks() {
  beforeEach(() => {
    getCatalogIngredientDetails.mockImplementation(async () => detailsOf(CHAR_FIXTURE));
    getCatalogUniverseContext.mockReset().mockResolvedValue({ ...detailsOf(CHAR_FIXTURE).universeContext, usageComplete: true });
    listCatalogRelatedImages.mockReset().mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0 });
    updateCatalogIngredient.mockReset();
    unlinkCatalogIngredientRelation.mockReset();
    detachCatalogIngredientMedia.mockReset();
    restoreCatalogIngredientRevision.mockReset();
    uploadCatalogIngredientMediaFile.mockReset();
  });
}

export {
  CHAR_FIXTURE,
  detailsOf,
  emitSocket,
  renderPage,
  installCatalogIngredientHooks,
  socketHandlers,
  mediaAnnotationsFixture,
};
