/**
 * Loras page contracts:
 *  - the Installed / Discover view split and its `?loraView` URL contract (#7231)
 *  - delete confirmation on the installed cards (#3519) — a LoRA is a
 *    multi-gigabyte file with no undo, so the trash icon must only arm an
 *    inline confirm pair; one stray tap can never reach deleteLoraFull.
 *
 * Discovery now lives behind its own view, so every install/search case below
 * renders through `renderDiscover()` rather than the default Installed view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { clickStartDownload } from '../test/downloadPreflightConfirm.js';
import Loras from './Loras';
import {
  listLorasFull, deleteLoraFull, installLoraFromHuggingfaceStream, probeLoraEffect,
  previewLoraInstall, getCivitaiSuggestions, installLoraFromCivitai, searchVideoLoras,
} from '../services/api';

vi.mock('../services/api', () => ({
  listLorasFull: vi.fn(),
  installLoraFromCivitai: vi.fn(),
  previewLoraInstall: vi.fn(async () => ({
    kind: 'civitai', destPath: 'lora-x.safetensors', expectedBytes: 1024, freeBytes: 1e12, requiredBytes: 1024, headroomBytes: 0, verdict: 'ok',
  })),
  installLoraFromHuggingfaceStream: vi.fn(),
  deleteLoraFull: vi.fn(),
  getCivitaiAuth: vi.fn(async () => ({ hasKey: false, source: 'none' })),
  setCivitaiAuth: vi.fn(),
  clearCivitaiAuth: vi.fn(),
  getCivitaiSuggestions: vi.fn(async () => ({ runners: {}, video: [], fetchedAt: null })),
  searchCivitaiLoras: vi.fn(),
  searchVideoLoras: vi.fn(),
  probeLoraEffect: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const LORA = {
  filename: 'example-lora.safetensors',
  name: 'Example LoRA',
  runnerFamily: 'mflux',
  sizeBytes: 1234567,
  recommendedScale: 0.9,
  triggerWords: [],
};
const OTHER_LORA = { ...LORA, filename: 'second-lora.safetensors', name: 'Second LoRA' };

// Exposes the live location (for the `?loraView` contract) and a navigate()
// handle so a test can exercise Back the way the browser button does.
const router = { search: '', navigate: null };
function RouterProbe() {
  router.search = useLocation().search;
  router.navigate = useNavigate();
  return null;
}

const renderPage = (entry = '/models/loras') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Loras />
    <RouterProbe />
  </MemoryRouter>,
);

// Installed is the default view; everything install/search related lives one
// click away under "Discover / install".
const renderDiscover = async () => {
  const result = renderPage();
  fireEvent.click(await screen.findByRole('tab', { name: /Discover \/ install/ }));
  // Opening Discover is what kicks off the suggestions fetch — settle it here
  // so its state update lands inside act() rather than after the test's first
  // synchronous assertion.
  await act(async () => {});
  return result;
};

const goBack = () => act(() => { router.navigate(-1); });

// #7231 — discovery (curated picks, six per-family Civitai lists, the video
// catalog, two live searches) used to render ABOVE the installed grid, so
// managing an installed adapter meant scrolling past every recommendation, at
// a distance that grew as results arrived. Installed is now the default view
// and discovery is a sibling, which makes that distance structurally zero.
describe('Loras Installed / Discover views', () => {
  const SUGGESTION_CARD = { modelId: 42, versionId: 7, name: 'Suggested LoRA', installUrl: 'https://civitai.com/models/42' };

  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([LORA]);
    getCivitaiSuggestions.mockResolvedValue({ runners: { mflux: [SUGGESTION_CARD] }, video: [], fetchedAt: null });
  });

  it('opens on Installed with the cards rendered and no discovery above them', async () => {
    renderPage();

    expect(await screen.findByText('Example LoRA')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');
    // Not merely below the fold — discovery is not mounted at all, so no
    // number of results can push the installed controls anywhere.
    expect(screen.queryByLabelText('Civitai model URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Suggested LoRA')).not.toBeInTheDocument();
    // And nothing was fetched for a view the user never opened.
    expect(getCivitaiSuggestions).not.toHaveBeenCalled();
  });

  it('switches to Discover, records it in the URL, and restores Installed on Back', async () => {
    renderPage();
    await screen.findByText('Example LoRA');

    fireEvent.click(screen.getByRole('tab', { name: /Discover \/ install/ }));

    expect(await screen.findByLabelText('Civitai model URL')).toBeInTheDocument();
    expect(await screen.findByText('Suggested LoRA')).toBeInTheDocument();
    expect(router.search).toBe('?loraView=discover');

    goBack();

    expect(await screen.findByText('Example LoRA')).toBeInTheDocument();
    expect(screen.queryByLabelText('Civitai model URL')).not.toBeInTheDocument();
    expect(router.search).toBe('');
  });

  it('restores Discover from the URL on load, and falls back to Installed for an unknown view', async () => {
    const { unmount } = renderPage('/models/loras?loraView=discover');
    expect(await screen.findByLabelText('Civitai model URL')).toBeInTheDocument();
    unmount();

    renderPage('/models/loras?loraView=bogus');
    expect(await screen.findByText('Example LoRA')).toBeInTheDocument();
    expect(screen.queryByLabelText('Civitai model URL')).not.toBeInTheDocument();
  });

  it('does not steal focus from the tab that opened Discover', async () => {
    renderPage();
    await screen.findByText('Example LoRA');

    const discoverTab = screen.getByRole('tab', { name: /Discover \/ install/ });
    fireEvent.click(discoverTab);
    await screen.findByLabelText('Civitai model URL');

    // The install form remounts on every switch now, so an autoFocus on it
    // would swallow the arrow key that should walk back to Installed.
    expect(screen.getByLabelText('Civitai model URL')).not.toHaveFocus();
  });

  // A multi-gigabyte HuggingFace download survives the switch to Installed,
  // but every readout of it lives in the Discover panel — without a mirror the
  // transfer runs with no indicator anywhere on the page.
  it('keeps an in-flight download visible after switching away from Discover', async () => {
    listLorasFull.mockResolvedValue([]);
    let reportProgress;
    installLoraFromHuggingfaceStream.mockImplementation(({ onProgress }) => new Promise(() => {
      reportProgress = onProgress;
    }));
    await renderDiscover();

    const input = await screen.findByLabelText('HuggingFace LoRA URL');
    fireEvent.change(input, { target: { value: 'https://huggingface.co/example-org/example-lora' } });
    fireEvent.submit(input.closest('form'));
    await clickStartDownload();
    await waitFor(() => expect(reportProgress).toBeTypeOf('function'));
    act(() => reportProgress({ received: 512, total: 1024, progress: 0.5 }));
    expect(await screen.findByText('Downloading… 50%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Installed/ }));

    expect(await screen.findByText('Downloading… 50%')).toBeInTheDocument();
  });

  it('offers a discovery hand-off from the empty Installed state', async () => {
    listLorasFull.mockResolvedValue([]);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Discover LoRAs to install' }));

    expect(await screen.findByLabelText('Civitai model URL')).toBeInTheDocument();
  });

  it('hands the user to Installed after a successful install instead of leaving them in the catalog', async () => {
    listLorasFull.mockResolvedValueOnce([]).mockResolvedValue([LORA]);
    installLoraFromCivitai.mockResolvedValue({ name: 'example-lora.safetensors' });
    await renderDiscover();

    const input = await screen.findByLabelText('Civitai model URL');
    fireEvent.change(input, { target: { value: 'https://civitai.com/models/123/example' } });
    fireEvent.submit(input.closest('form'));
    await clickStartDownload();

    fireEvent.click(await screen.findByRole('button', { name: 'View installed' }));

    expect(await screen.findByText('Example LoRA')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Installed/ })).toHaveAttribute('aria-selected', 'true');

    // The hand-off is spent — returning to Discover must not re-offer it.
    fireEvent.click(screen.getByRole('tab', { name: /Discover \/ install/ }));
    expect(await screen.findByLabelText('Civitai model URL')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View installed' })).not.toBeInTheDocument();
  });
});

describe('Loras installed-card delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([LORA]);
    deleteLoraFull.mockResolvedValue({});
  });

  it('arms an inline confirm instead of deleting on the first trash click', async () => {
    renderPage();
    const trash = await screen.findByLabelText('Delete Example LoRA');

    fireEvent.click(trash);

    expect(deleteLoraFull).not.toHaveBeenCalled();
    expect(screen.getByText('Delete file?')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete Example LoRA')).not.toBeInTheDocument();
  });

  it('deletes and drops the card from local state once confirmed', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLoraFull).toHaveBeenCalledWith('example-lora.safetensors', { silent: true }));
    await waitFor(() => expect(screen.queryByText('Example LoRA')).not.toBeInTheDocument());
    // Reactive local-state update, not a refetch.
    expect(listLorasFull).toHaveBeenCalledTimes(1);
  });

  it('leaves the model file intact when the confirm is cancelled', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleteLoraFull).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete file?')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Delete Example LoRA')).toBeInTheDocument();
  });

  it('arms only one card at a time', async () => {
    listLorasFull.mockResolvedValue([LORA, OTHER_LORA]);
    renderPage();

    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));
    fireEvent.click(screen.getByLabelText('Delete Second LoRA'));

    expect(screen.getAllByText('Delete file?')).toHaveLength(1);
    expect(screen.getByLabelText('Delete Example LoRA')).toBeInTheDocument();
    expect(deleteLoraFull).not.toHaveBeenCalled();
  });

  it('falls back to the filename when a sidecar-less LoRA has no name', async () => {
    listLorasFull.mockResolvedValue([{ ...LORA, name: undefined }]);
    renderPage();

    const trash = await screen.findByLabelText('Delete example-lora.safetensors');
    fireEvent.click(trash);

    expect(screen.getByLabelText('Confirm delete example-lora.safetensors')).toBeInTheDocument();
  });

  it('keeps the card when the delete fails, re-showing the trash affordance', async () => {
    deleteLoraFull.mockRejectedValue(new Error('Delete failed'));
    renderPage();
    fireEvent.click(await screen.findByLabelText('Delete Example LoRA'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLoraFull).toHaveBeenCalled());
    expect(await screen.findByLabelText('Delete Example LoRA')).toBeInTheDocument();
    expect(screen.getByText('Example LoRA')).toBeInTheDocument();
  });
});

describe('Loras HuggingFace family picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    installLoraFromHuggingfaceStream.mockRejectedValue(
      Object.assign(new Error('could not classify'), { code: 'HF_UNKNOWN_FAMILY' }),
    );
  });

  it('offers image and video families when autodetection fails, not just LTX-Video', async () => {
    await renderDiscover();
    const input = await screen.findByLabelText('HuggingFace LoRA URL');
    fireEvent.change(input, { target: { value: 'https://huggingface.co/Alissonerdx/CharacterSheet' } });
    fireEvent.submit(input.closest('form'));
    await clickStartDownload();
    expect(await screen.findByRole('button', { name: 'Install as Flux 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install as Flux 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install as LTX-Video' })).toBeInTheDocument();
    expect(screen.queryByText(/Install it as an LTX-Video LoRA/)).not.toBeInTheDocument();
  });
});

// A gated Civitai model can fail with CIVITAI_AUTH at the disk-preflight
// PREVIEW step (before any download starts) — the same code the download
// itself would hit. That must still surface the key-entry modal, not a
// dead-end error inside the disk-preflight confirm dialog.
describe('Loras Civitai auth recovery through preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    getCivitaiSuggestions.mockResolvedValue({ runners: {}, video: [], fetchedAt: null });
  });

  it('routes a preflight CIVITAI_AUTH rejection into the key-entry modal, not a generic error', async () => {
    previewLoraInstall.mockRejectedValueOnce(
      Object.assign(new Error('This LoRA needs an API key.'), { code: 'CIVITAI_AUTH' }),
    );
    await renderDiscover();
    const input = await screen.findByLabelText('Civitai model URL');
    fireEvent.change(input, { target: { value: 'https://civitai.com/models/123/gated' } });
    fireEvent.submit(input.closest('form'));

    expect(await screen.findByText('Civitai API key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start download' })).not.toBeInTheDocument();
  });
});

// performInstall() now returns once the PREVIEW resolves (the confirm modal
// is showing), not once the download finishes — the suggestion card's own
// "Installing…" spinner must track the real install lifecycle instead of
// that promise settling, or it flips back to "Quick install" the moment the
// confirm dialog opens while a multi-GB transfer is still ahead of it.
describe('Loras suggestion card busy state', () => {
  const SUGGESTION_CARD = { modelId: 42, versionId: 7, name: 'Example LoRA', installUrl: 'https://civitai.com/models/42' };

  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    getCivitaiSuggestions.mockResolvedValue({ runners: { mflux: [SUGGESTION_CARD] }, video: [], fetchedAt: null });
  });

  it('keeps the card "Installing…" through the confirm step and clears only once the install settles', async () => {
    let resolveInstall;
    installLoraFromCivitai.mockReturnValue(new Promise((resolve) => { resolveInstall = resolve; }));
    await renderDiscover();

    fireEvent.click(await screen.findByRole('button', { name: 'Quick install' }));
    // Preview resolved (the confirm modal opened) — the card must still read
    // "Installing…", not have reverted to "Quick install" already.
    expect(await screen.findByRole('button', { name: 'Installing…' })).toBeInTheDocument();

    await clickStartDownload();
    expect(await screen.findByRole('button', { name: 'Installing…' })).toBeInTheDocument();

    resolveInstall({ name: 'lora-example.safetensors' });
    expect(await screen.findByRole('button', { name: 'Quick install' })).toBeInTheDocument();
  });

  it('clears the spinner when the confirm is cancelled instead of leaving it stuck', async () => {
    await renderDiscover();
    fireEvent.click(await screen.findByRole('button', { name: 'Quick install' }));
    await screen.findByRole('button', { name: 'Start download' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('button', { name: 'Quick install' })).toBeInTheDocument();
    expect(installLoraFromCivitai).not.toHaveBeenCalled();
  });
});

// The curated video suggestion "Quick install" used to call the HF streaming
// installer directly, skipping the disk-preflight confirm every other install
// path now shows. It must go through the same modal, with the card's own
// family/file forwarded so the preview matches the file the install picks.
describe('Loras video suggestion quick-install preflight', () => {
  const VIDEO_CARD = {
    repo: 'fal/ltx2.3-audio-reactive-lora',
    file: 'pytorch_lora_weights.safetensors',
    installUrl: 'https://huggingface.co/fal/ltx2.3-audio-reactive-lora',
    runnerFamily: 'ltx-video',
    name: 'Audio-Reactive LTX LoRA',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    getCivitaiSuggestions.mockResolvedValue({ runners: {}, video: [VIDEO_CARD], fetchedAt: null });
    previewLoraInstall.mockResolvedValue({
      kind: 'huggingface', destPath: 'lora-fal-ltx-hf.safetensors', expectedBytes: 2048,
      freeBytes: 1e12, requiredBytes: 2048, headroomBytes: 0, verdict: 'ok',
    });
    installLoraFromHuggingfaceStream.mockResolvedValue({ name: 'lora-fal-ltx-hf.safetensors' });
  });

  it('shows the disk-preflight confirm before starting the stream install', async () => {
    await renderDiscover();
    fireEvent.click(await screen.findByRole('button', { name: 'Quick install' }));

    expect(await screen.findByRole('button', { name: 'Start download' })).toBeInTheDocument();
    expect(previewLoraInstall).toHaveBeenCalledWith(expect.objectContaining({
      url: VIDEO_CARD.installUrl,
      source: 'huggingface',
      family: VIDEO_CARD.runnerFamily,
      file: VIDEO_CARD.file,
    }));
    expect(installLoraFromHuggingfaceStream).not.toHaveBeenCalled();

    await clickStartDownload();
    await waitFor(() => expect(installLoraFromHuggingfaceStream).toHaveBeenCalledWith(
      expect.objectContaining({ url: VIDEO_CARD.installUrl, family: VIDEO_CARD.runnerFamily, file: VIDEO_CARD.file }),
    ));
  });
});

// #6500 — searching HuggingFace directly (rather than the curated list) and
// installing a hit. Also the "several installable files" case: the search
// result offers two `.safetensors` siblings, so picking the non-default one
// must be what actually installs.
describe('Loras video LoRA search-to-install', () => {
  const SEARCH_CARD = {
    source: 'huggingface',
    repo: 'someorg/some-ltx-lora',
    revision: 'main',
    file: 'pytorch_lora_weights.safetensors',
    files: [
      { file: 'variant-a.safetensors', recommended: false },
      { file: 'pytorch_lora_weights.safetensors', recommended: true },
    ],
    name: 'some-ltx-lora',
    description: 'A searchable LTX LoRA.',
    runnerFamily: 'ltx-video',
    downloads: 12,
    previewImageUrl: null,
    previewVideoUrl: null,
    previewType: null,
    hfUrl: 'https://huggingface.co/someorg/some-ltx-lora',
    installUrl: 'https://huggingface.co/someorg/some-ltx-lora',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listLorasFull.mockResolvedValue([]);
    getCivitaiSuggestions.mockResolvedValue({ runners: {}, video: [], fetchedAt: null });
    searchVideoLoras.mockResolvedValue({ family: 'all', query: 'vhs', author: '', items: [SEARCH_CARD], nextCursor: null });
    previewLoraInstall.mockResolvedValue({
      kind: 'huggingface', destPath: 'lora-someorg-ltx-hf.safetensors', expectedBytes: 2048,
      freeBytes: 1e12, requiredBytes: 2048, headroomBytes: 0, verdict: 'ok',
    });
    installLoraFromHuggingfaceStream.mockResolvedValue({ name: 'lora-someorg-ltx-hf.safetensors' });
  });

  it('searches HuggingFace, lets the user pick a non-default file, and installs that exact file', async () => {
    await renderDiscover();

    const searchInput = await screen.findByLabelText('Search HuggingFace video LoRAs by name or repository');
    const searchForm = searchInput.closest('form');
    fireEvent.change(searchInput, { target: { value: 'vhs' } });
    fireEvent.click(within(searchForm).getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('some-ltx-lora')).toBeInTheDocument();
    expect(searchVideoLoras).toHaveBeenCalledWith(expect.objectContaining({ family: 'all', query: 'vhs', author: '' }));

    // Pick the non-recommended file before installing.
    fireEvent.change(screen.getByLabelText('File'), { target: { value: 'variant-a.safetensors' } });

    fireEvent.click(screen.getByRole('button', { name: 'Quick install' }));
    expect(await screen.findByRole('button', { name: 'Start download' })).toBeInTheDocument();
    expect(previewLoraInstall).toHaveBeenCalledWith(expect.objectContaining({
      url: SEARCH_CARD.installUrl,
      source: 'huggingface',
      family: 'ltx-video',
      file: 'variant-a.safetensors',
    }));

    await clickStartDownload();
    await waitFor(() => expect(installLoraFromHuggingfaceStream).toHaveBeenCalledWith(
      expect.objectContaining({ url: SEARCH_CARD.installUrl, family: 'ltx-video', file: 'variant-a.safetensors' }),
    ));
  });

  it('shows a retryable error banner when the search request fails', async () => {
    searchVideoLoras.mockRejectedValueOnce(new Error('HuggingFace search failed: 503'));
    await renderDiscover();

    const searchInput = await screen.findByLabelText('Search HuggingFace video LoRAs by name or repository');
    const searchForm = searchInput.closest('form');
    fireEvent.change(searchInput, { target: { value: 'vhs' } });
    fireEvent.click(within(searchForm).getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('HuggingFace search failed: 503')).toBeInTheDocument();

    searchVideoLoras.mockResolvedValueOnce({ family: 'all', query: 'vhs', author: '', items: [SEARCH_CARD], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('some-ltx-lora')).toBeInTheDocument();
  });
});

// Adapter-effect diagnostic (#4872). The card seeds from the server's CACHED
// report and re-measures on demand; only a measured all-zero adapter is the
// alarming one, and the badge must never echo itself when there is no summary.
describe('Loras adapter-effect check', () => {
  const withEffect = (effectReport) => ({ ...LORA, effectReport });

  beforeEach(() => {
    vi.clearAllMocks();
    deleteLoraFull.mockResolvedValue({});
  });

  it('renders the cached report without asking the server to re-measure', async () => {
    listLorasFull.mockResolvedValue([withEffect({
      status: 'ok', measured: 8, medianRms: 0.004, maxRms: 0.02,
      skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null,
    })]);
    renderPage();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/median RMS 4.00e-3, max 2.00e-2, across 8 module\(s\)/)).toBeInTheDocument();
    expect(probeLoraEffect).not.toHaveBeenCalled();
  });

  it('shows no effect row at all for a LoRA that was never measured', async () => {
    listLorasFull.mockResolvedValue([withEffect(null)]);
    renderPage();
    await screen.findByText('Example LoRA');
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.queryByText('Not measurable')).not.toBeInTheDocument();
  });

  it('force-re-measures on click and swaps the badge in place', async () => {
    listLorasFull.mockResolvedValue([withEffect(null)]);
    probeLoraEffect.mockResolvedValue({
      status: 'zero', measured: 6, medianRms: 0, maxRms: 0,
      skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 6,
      reason: 'all 6 measurable LoRA module(s) have exactly zero effect',
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check effect of Example LoRA' }));
    expect(probeLoraEffect).toHaveBeenCalledWith('example-lora.safetensors', { force: true, silent: true });
    expect(await screen.findByText('No effect')).toBeInTheDocument();
  });

  it('renders the badge alone — never echoed — when there is nothing to add', async () => {
    listLorasFull.mockResolvedValue([withEffect({
      status: 'unreadable', measured: 0, medianRms: null, maxRms: null,
      skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null,
    })]);
    renderPage();
    expect(await screen.findByText('Unreadable')).toBeInTheDocument();
    expect(screen.queryByText(/Unreadable — Unreadable/)).not.toBeInTheDocument();
  });

  it('keeps the card usable when the probe request fails', async () => {
    listLorasFull.mockResolvedValue([withEffect(null)]);
    probeLoraEffect.mockRejectedValue(new Error('probe exploded'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check effect of Example LoRA' }));
    await waitFor(() => expect(probeLoraEffect).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Check effect of Example LoRA' })).toBeEnabled();
  });
});
