/**
 * Shared mock scaffold for the ImageGen page suites.
 *
 * Five suites (`pages/ImageGen.probeGating`, `.objectUrls`, `.federatedTarget`,
 * `.flux2VenvShare`, `.defaultLocalModel`) each carried a near-verbatim ~70-line
 * copy of the same ~25 `vi.mock` registrations, the same model fixture and the
 * same `mount()` helper. Every endpoint or hook the page started calling had to
 * be added in five places, or four suites broke at once.
 *
 * **Importing this module registers the mocks** — that is the whole point, and it
 * is what the vitest hoisting rules allow. `vi.mock` is hoisted to the top of the
 * file it is written in, so these registrations run when this module is evaluated,
 * which is while the importing test file's static imports are being resolved and
 * therefore before its `await loadImageGenPage()`. The relative specifiers resolve
 * identically from here and from `pages/` (`src/test/../services/api` and
 * `src/pages/../services/api` are the same module), so the mocked paths are the
 * ones the page itself imports. The page's `usePreviewRoute` stays real: this
 * module imports nothing the page doesn't already import, and the deep-link
 * behaviour one suite pins is cheap to carry everywhere.
 *
 * Every mock reads through the exported `state`, so a suite varies behavior by
 * assigning to it in `beforeEach` rather than by re-registering a mock (a suite
 * file's own `vi.mock` calls are hoisted ABOVE its import of this module, so
 * re-registration cannot win — the delegating component stubs below exist for
 * exactly that reason). Call `resetImageGenMockState()` first to get the
 * documented defaults back.
 */

import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';

/** Local model as the catalog reports it; `.defaultLocalModel` pins its regressions against this shape. */
export const imageGenModel = (id, overrides = {}) => ({
  id,
  name: `FLUX.1 ${id}`,
  runner: 'mflux',
  steps: 20,
  guidance: 3.5,
  ...overrides,
});

/**
 * `GET /api/instances` peer opted in as an image provider with a live capacity
 * window — the shape that makes the generation-target picker appear. A suite
 * seeds it with `state.peers = [imageGenPeer()]`; the expiry probe overrides
 * `mediaProviderStatus.freshUntil` on a spread of the base record.
 */
export const imageGenPeer = (overrides = {}) => ({
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, imageModels: [{ engine: 'local', modelId: 'peer-flux' }] },
  mediaProviderStatus: {
    state: 'ready',
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
      capabilities: [{
        kind: 'image', engine: 'local', engineName: 'Local image', modelId: 'peer-flux',
        modelName: 'FLUX.2 Klein', ready: true, unavailableReason: null,
        runtimeReady: true, platformSupported: true, cudaRequired: false, cudaState: 'available',
      }],
    },
  },
  ...overrides,
});

/** Universe style the stub picker hands to the page when its button is clicked. */
const DEFAULT_UNIVERSE_STYLE = {
  id: 'u-1',
  name: 'Example Universe',
  influences: { embrace: ['inky linework'], avoid: ['glossy'] },
};

/** Settings `getSettings` resolves to until a suite reassigns `state.settings`. */
export const DEFAULT_SETTINGS = {
  imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } },
};

const defaultStatus = async () => ({
  connected: true, mode: 'local', model: state.models[0]?.name ?? null, readiness: 'ready',
});

/**
 * Every knob the suites vary. Mutated in `beforeEach`; read lazily by the
 * mock factories below, so a reassignment takes effect on the next render.
 * The spies are here (rather than trapped inside the `vi.mock` factories) so a
 * suite can defer, count or reject calls on the same object it uses for data.
 */
export const state = {
  /** Catalog `listImageModels` resolves to; reassign for a different model list. */
  models: [imageGenModel('dev', { name: 'FLUX.1 Dev' })],
  listImageModels: vi.fn(async () => state.models),
  getGalleryImages: vi.fn(async () => []),
  locationSearch: '',
  initImagePickerProps: null,
  loraPickerProps: null,
  resolutionFieldProps: null,
  /** `GET /api/instances` peers — a media-provider peer makes the target picker appear. */
  peers: [],
  /** `getImageGenStatus`; a spy so a suite can hold the probe open or vary the payload. */
  getImageGenStatus: vi.fn(defaultStatus),
  /** `generateImage`; a spy so a suite can assert payloads or reject. */
  generateImage: vi.fn(async () => ({ jobId: 'job-1' })),
  /**
   * `useMediaJobSse('image')`'s `attach`; a spy so federatedTarget can hold the
   * job stream open while it asserts over the submitted payload.
   */
  attachJobEvents: vi.fn(),
  /** `getActiveImageJob`'s payload. */
  activeJob: null,
  /** Settings `getSettings` resolves to; reset restores DEFAULT_SETTINGS. */
  settings: DEFAULT_SETTINGS,
  /** `getSettings`; a spy so a suite can reject it (the offline fallback path). */
  getSettings: vi.fn(async () => state.settings),
  /** `deleteImage`; a spy so a suite can reject a deletion. */
  deleteImage: vi.fn(async () => ({})),
  /** `listImageGalleryPage`; a spy so a suite can seed the recent strip. */
  listImageGalleryPage: vi.fn(async () => ({ items: [], total: 0, hiddenTotal: 0 })),
  /** `getFlux2Status` payload — the install banner reads the venv/token fields. */
  flux2Status: { installed: true, ready: true },
  /** `useHfTokenStatus` → `{ present, refresh }`. */
  hfTokenPresent: true,
  /** The library `listLorasFull` resolves to by default. */
  availableLoras: [],
  /** `listLorasFull`; a spy so a suite can defer or seed the library. */
  listLorasFull: vi.fn(async () => state.availableLoras),
  /**
   * Interactive factories for the components the suites render through, read at
   * render time by the delegating stubs below. Null renders nothing — the
   * default every suite except the ones driving that component wants. Factories
   * live in `state` (not per-suite `vi.mock` re-registrations) because vitest
   * hoists a suite file's own `vi.mock` calls above its import of this module.
   */
  initImagePickerFactory: null,
  referenceImagePickerFactory: null,
  galleryImagePickerFactory: null,
  mediaCardFactory: null,
  mediaPreviewFactory: null,
};

/** Restore every documented default, including fresh spies. Call it first in `beforeEach`. */
export function resetImageGenMockState() {
  state.models = [imageGenModel('dev', { name: 'FLUX.1 Dev' })];
  state.listImageModels.mockReset().mockImplementation(async () => state.models);
  state.getGalleryImages.mockReset().mockResolvedValue([]);
  state.locationSearch = '';
  state.initImagePickerProps = null;
  state.loraPickerProps = null;
  state.resolutionFieldProps = null;
  state.peers = [];
  state.getImageGenStatus.mockReset().mockImplementation(defaultStatus);
  state.generateImage.mockReset().mockResolvedValue({ jobId: 'job-1' });
  // A never-resolving attach keeps a local job stream open, the way the real
  // SSE hook behaves mid-render, without leaking timers into the test.
  state.attachJobEvents.mockReset().mockReturnValue(new Promise(() => {}));
  state.activeJob = null;
  state.settings = DEFAULT_SETTINGS;
  state.getSettings.mockReset().mockImplementation(async () => state.settings);
  state.deleteImage.mockReset().mockResolvedValue({});
  state.listImageGalleryPage.mockReset().mockResolvedValue({ items: [], total: 0, hiddenTotal: 0 });
  state.flux2Status = { installed: true, ready: true };
  state.hfTokenPresent = true;
  state.availableLoras = [];
  state.listLorasFull.mockReset().mockImplementation(async () => state.availableLoras);
  state.initImagePickerFactory = null;
  state.referenceImagePickerFactory = null;
  state.galleryImagePickerFactory = null;
  state.mediaCardFactory = null;
  state.mediaPreviewFactory = null;
}

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: state.peers })),
  getImageGenStatus: (...args) => state.getImageGenStatus(...args),
  generateImage: (...args) => state.generateImage(...args),
  generateImageMultipart: vi.fn(async () => ({})),
  listImageModels: (...args) => state.listImageModels(...args),
  getGalleryImages: (...args) => state.getGalleryImages(...args),
  listLorasFull: (...args) => state.listLorasFull(...args),
  listImageGalleryPage: (...args) => state.listImageGalleryPage(...args),
  cancelImageGen: vi.fn(async () => ({})),
  deleteImage: (...args) => state.deleteImage(...args),
  setImageHidden: vi.fn(async () => ({})),
  cleanGalleryImage: vi.fn(async () => ({})),
  getActiveImageJob: vi.fn(async () => ({ activeJob: state.activeJob })),
  getSettings: (...args) => state.getSettings(...args),
  buildFormData: vi.fn(() => new FormData()),
  listMediaJobs: vi.fn(async () => ({ jobs: [] })),
  regenerateGalleryImage: vi.fn(async () => ({})),
  getRegenAvailability: vi.fn(async () => ({ available: false })),
  removeImageWatermark: vi.fn(async () => ({})),
  getFlux2Status: vi.fn(async () => state.flux2Status),
}));

vi.mock('../hooks/useImageGenProgress', () => ({
  useImageGenProgress: () => ({ progress: null, begin: vi.fn(), end: vi.fn(), resume: vi.fn() }),
}));
vi.mock('../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: state.attachJobEvents, eventSourceRef: { current: null } }),
}));
vi.mock('../hooks/useModelDownloadStatus', () => ({
  useModelDownloadStatus: () => ({
    getStatus: () => ({ cached: true }), start: vi.fn(), cancel: vi.fn(), repair: vi.fn(), refresh: vi.fn(),
    downloading: false, repairing: false, progress: null, lastError: null, activeModelId: null, extra: {}, loading: false, statusError: null,
  }),
}));
vi.mock('../hooks/useHfTokenStatus', () => ({
  useHfTokenStatus: () => ({ present: state.hfTokenPresent, refresh: vi.fn() }),
}));
vi.mock('../hooks/useAgyModels', () => ({ useAgyModels: () => ({ models: [], error: null }) }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: vi.fn() }));
vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn(), getCardProps: vi.fn(() => ({})) }),
}));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));

// The prompt helpers stay visible where a suite needs them and harmless where
// one doesn't: probeGating pins their placement inside the Options fold, so the
// stub renders the same buttons the real components do.
vi.mock('../components/media/PromptEnhancer', () => ({
  default: ({ disabled }) => (
    <button type="button" disabled={disabled}>Enhance with AI</button>
  ),
}));
vi.mock('../components/media/PromptFromMedia', () => ({
  default: ({ disabled }) => (
    <button type="button" disabled={disabled}>Prompt from media</button>
  ),
}));
// Interactive so a suite can drive the style into the page; inert everywhere else.
vi.mock('../components/media/UniverseStylePicker', () => ({
  default: ({ onChange }) => (
    <button type="button" onClick={() => onChange(DEFAULT_UNIVERSE_STYLE)}>Use universe style</button>
  ),
}));

// Delegating stubs for the surfaces a suite may need to drive or observe: the
// factories read `state.*Factory` at render time, so a suite can swap in an
// interactive component per test (objectUrls drives the pickers, probeGating
// the gallery card and preview) while every other suite keeps them null.
vi.mock('../components/imageGen/InitImagePicker', () => ({
  default: (props) => {
    state.initImagePickerProps = props;
    const Factory = state.initImagePickerFactory;
    return Factory ? <Factory {...props} /> : null;
  },
}));
vi.mock('../components/imageGen/ReferenceImagePicker', () => ({
  default: (props) => {
    const Factory = state.referenceImagePickerFactory;
    return Factory ? <Factory {...props} /> : null;
  },
}));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({
  default: (props) => {
    const Factory = state.galleryImagePickerFactory;
    return Factory ? <Factory {...props} /> : null;
  },
}));
vi.mock('../components/media/MediaCard', () => ({
  default: (props) => {
    const Factory = state.mediaCardFactory;
    return Factory ? <Factory {...props} /> : null;
  },
}));
vi.mock('../components/media/MediaPreview', () => ({
  default: (props) => {
    const Factory = state.mediaPreviewFactory;
    return Factory ? <Factory {...props} /> : null;
  },
}));

// Keep the policy-bearing controls real; replace unrelated, heavyweight page
// surfaces so these stay focused orchestration tests rather than a gallery/SSE
// integration suite.
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/imageGen/Flux2InstallModal', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({
  default: (props) => {
    state.loraPickerProps = props;
    return null;
  },
}));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({
  default: (props) => {
    state.resolutionFieldProps = props;
    return null;
  },
}));

let ImageGen = null;

/**
 * Import the page under the mocks above. Every suite loads it dynamically at
 * module scope so the registrations are in place first; the component is kept
 * here so `renderImageGenPage()` needs no argument.
 */
export async function loadImageGenPage() {
  ({ default: ImageGen } = await import('../pages/ImageGen.jsx'));
  return ImageGen;
}

/**
 * Mount the page on its own route, flushing the mount effects. `path` overrides
 * the location so a suite can exercise a deep link (`?preview=`, `?modelId=`);
 * `{ strict }` wraps the mount in `<StrictMode>` for the double-invocation
 * checks the objectUrls suite pins.
 */
export async function renderImageGenPage(path = '/media/image', { strict = false } = {}) {
  if (!ImageGen) throw new Error('await loadImageGenPage() at module scope before rendering');
  function LocationProbe() {
    const location = useLocation();
    state.locationSearch = location.search;
    return null;
  }
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <>
        <LocationProbe />
        <ImageGen />
      </>
    </MemoryRouter>
  );
  let view;
  await act(async () => {
    view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return view;
}
