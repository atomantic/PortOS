import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_GEN_MODE, RUNWAY_IMAGE_DEFAULT_MODEL, RUNWAY_IMAGE_MODELS } from '../../lib/imageGenBackends';
import { resolveCloudModelPicker } from './cloudModelPicker';
import ImageGenFormEditor from './ImageGenFormEditor';

vi.mock('../media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../media/UniverseStylePicker', () => ({ default: () => null }));
vi.mock('../media/PromptEnhancer', () => ({ default: () => null }));
vi.mock('../media/PromptFromMedia', () => ({ default: () => null }));
vi.mock('../media/MusicVideoFilingSelect', () => ({ default: () => null }));
vi.mock('../federatedMedia/RemoteMediaTargetPicker', () => ({ default: () => null }));

const MODELS = {
  [IMAGE_GEN_MODE.AGY]: ['gemini-saved', 'gemini-selected'],
  [IMAGE_GEN_MODE.RUNWAY]: RUNWAY_IMAGE_MODELS,
};

function renderEditor({
  mode = IMAGE_GEN_MODE.LOCAL,
  derived = {},
  remix = {},
  loraTest = {},
  generation = {},
  override,
  savedModel,
  liveModelsByMode = MODELS,
  setCloudModel = vi.fn(),
} = {}) {
  const form = {
    fields: {
      prompt: 'A test scene',
      negativePrompt: '',
      modelId: '',
      optionsOpen: true,
      setOptionsOpen: vi.fn(),
      selectedLoras: [],
      batchCount: 1,
      width: 1024,
      height: 1024,
    },
    catalogs: { models: [], availableLoras: [] },
    settings: { savedCleanC2PAByMode: {}, savedDenoiseByMode: {} },
    derived: { referenceSlotCount: 0, remoteBlocked: null, ...derived },
    images: { initImage: { source: null }, activeReferenceImages: [] },
    actions: { handleResolutionChange: vi.fn() },
    remix,
    loraTest,
    cloudModelPicker: resolveCloudModelPicker({
      mode,
      cloudModelsByMode: { [mode]: override },
      savedCloudModelsByMode: { [mode]: savedModel },
      liveModelsByMode,
      setCloudModel,
    }),
  };
  return render(
    <ImageGenFormEditor
      form={form}
      backend={{ effectiveMode: mode, isLocalMode: mode === IMAGE_GEN_MODE.LOCAL, isAgyMode: mode === IMAGE_GEN_MODE.AGY, agy: {} }}
      generation={{ modelDownload: { getStatus: () => null }, ...generation }}
    />,
  );
}

describe('ImageGenFormEditor submit guard', () => {
  it('allows a ready render and can queue more while generating', () => {
    renderEditor({ generation: { generating: true } });
    expect(screen.getByRole('button', { name: 'Queue' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel current' })).toBeInTheDocument();
  });

  it.each([
    [{ derived: { unsupportedLocalInputs: true }, loraTest: { pending: true } }, /Remove unsupported LoRAs/],
    [{ derived: { loraHandoffBlocked: true }, loraTest: { pending: true } }, /Preparing this LoRA test/],
    [{ derived: { loraHandoffBlocked: true }, loraTest: { error: 'LoRA unavailable' } }, /LoRA unavailable/],
    [{ remix: { pending: true } }, /Restoring this image’s settings/],
    [{ derived: { localBackendPending: true } }, /Checking the image backend/],
    [{ derived: { remoteTargetActive: true, remoteBlocked: 'Peer unavailable' } }, /Peer unavailable/],
    [{ derived: { editImageMissing: true } }, /needs a source image/],
    [{ derived: { cloudNeedsPrompt: true, cloudPromptHint: 'Enter a prompt first' } }, /Enter a prompt first/],
  ])('explains a blocked render (%j)', (props, title) => {
    renderEditor(props);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate' }).title).toMatch(title);
  });

  it('uses the remote target verdict when the local backend is disconnected', () => {
    renderEditor({ derived: { remoteTargetActive: true, notConnected: true } });
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });
});

describe('ImageGenFormEditor cloud model picker', () => {
  it.each([
    [IMAGE_GEN_MODE.AGY, 'Agent model', 'gemini-selected', 'gemini-saved', /gemini-saved/],
    [IMAGE_GEN_MODE.FAL, 'fal.ai model', 'fal-ai/nano-banana-pro', 'fal-ai/flux-2-pro', /FLUX.2/],
    [IMAGE_GEN_MODE.HIGGSFIELD, 'Higgsfield model', 'ideogram/v4.0', 'z-image/turbo', /Z-Image Turbo/],
    [IMAGE_GEN_MODE.GOOGLE, 'Google model', 'gemini-3-pro-image', 'imagen-4.0-fast-generate-001', /Imagen 4 Fast/],
    [IMAGE_GEN_MODE.RUNWAY, 'Runway model', RUNWAY_IMAGE_MODELS[1].id, RUNWAY_IMAGE_DEFAULT_MODEL, /gen4_image/],
  ])('uses the %s catalog and saved default', (mode, label, override, savedModel, defaultLabel) => {
    const setCloudModel = vi.fn();
    renderEditor({ mode, override, savedModel, setCloudModel });
    const picker = screen.getByRole('combobox', { name: label });
    expect(picker).toHaveValue(override);
    const defaultOption = within(picker).getByRole('option', { name: /Settings default/ });
    expect(defaultOption).toHaveTextContent(defaultLabel);
    fireEvent.change(picker, { target: { value: '' } });
    expect(setCloudModel).toHaveBeenCalledWith(mode, '');
  });

  it('ignores an override outside the provider catalog', () => {
    const { controlProps, resolvedModel } = resolveCloudModelPicker({
      mode: IMAGE_GEN_MODE.AGY,
      cloudModelsByMode: { agy: 'removed-model' },
      savedCloudModelsByMode: { agy: 'gemini-saved' },
      liveModelsByMode: MODELS,
      setCloudModel: vi.fn(),
    });
    expect(controlProps.cloudModel).toBe('');
    expect(resolvedModel).toBe('gemini-saved');
  });

  it('keeps a known but unavailable Runway override visible and blocks generation', () => {
    const override = RUNWAY_IMAGE_MODELS[1].id;
    renderEditor({
      mode: IMAGE_GEN_MODE.RUNWAY,
      override,
      liveModelsByMode: { runway: RUNWAY_IMAGE_MODELS.filter((model) => model.id !== override) },
    });
    const picker = screen.getByRole('combobox', { name: 'Runway model' });
    expect(picker).toHaveValue(override);
    expect(within(picker).getByRole('option', { name: `${override} (unavailable)` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });
});

describe('ImageGenFormEditor references and errors', () => {
  it.each(['FLUX.2', 'Qwen Image 2.1', 'FLUX.3', 'MiniMax H3-Image'])('names %s in the reference caption', (name) => {
    renderEditor({ derived: { referenceSlotCount: 4, currentModel: { name } } });
    expect(screen.getByText(`(up to 4 images for ${name} multi-reference edit)`)).toBeInTheDocument();
  });

  it.each([1, 2])('warns when %i selected reference images cannot be sent', (count) => {
    renderEditor({ derived: { droppedRefCount: count } });
    expect(screen.getByRole('status')).toHaveTextContent(
      `${count} reference ${count === 1 ? 'image' : 'images'} you picked won't be sent`,
    );
  });

  it('renders the full error and a link for a gated model', () => {
    renderEditor({
      generation: { error: 'Access denied\nAccept the model terms.', errorMeta: { kind: 'gated_repo', repo: 'example/model' } },
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Model access required');
    expect(alert).toHaveTextContent('Access denied Accept the model terms.');
    expect(within(alert).getByRole('link', { name: /Request access to example\/model/ }))
      .toHaveAttribute('href', 'https://huggingface.co/example/model');
  });

  it('offers token guidance only when the provider rejects the token', () => {
    renderEditor({ generation: { error: 'Invalid credentials', errorMeta: { kind: 'hf_unauthorized' } } });
    expect(screen.getByRole('alert')).toHaveTextContent('HuggingFace token rejected');
    expect(screen.getByRole('alert')).toHaveTextContent('Paste a fresh token');
    expect(within(screen.getByRole('alert')).queryByRole('link')).toBeNull();
  });
});
