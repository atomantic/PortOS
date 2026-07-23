import { useEffect, useMemo, useState } from 'react';
import { Box, ImagePlus, LoaderCircle, Sparkles } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import MediaImage from '../components/MediaImage';
import ProviderModelSelector from '../components/ProviderModelSelector';
import useProviderModels from '../hooks/useProviderModels';
import { createThreejsModel, listThreejsModels } from '../services/api';
import toast from '../components/ui/Toast';
import { timeAgo } from '../utils/formatters';

const providerFilter = (provider) =>
  provider.enabled !== false && ['api', 'cli', 'tui'].includes(provider.type);

const nameFromFilename = (filename) => String(filename || '')
  .replace(/\.png$/i, '')
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase())
  .slice(0, 120);

const statusClass = {
  ready: 'bg-port-success/15 text-port-success',
  generating: 'bg-port-accent/15 text-port-accent',
  failed: 'bg-port-error/15 text-port-error',
  draft: 'bg-port-border text-gray-400',
};

export default function ThreejsModels() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const imageFromRoute = searchParams.get('image') || '';
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState(() => (
    imageFromRoute ? { filename: imageFromRoute, previewUrl: `/data/images/${encodeURIComponent(imageFromRoute)}` } : null
  ));
  const [name, setName] = useState(() => nameFromFilename(imageFromRoute));
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({ filter: providerFilter, silent: true });

  useEffect(() => {
    listThreejsModels({ silent: true })
      .then((records) => setModels(Array.isArray(records) ? records : []))
      .catch(() => toast.error('Failed to load Three.js models'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const currentFilename = selectedImage?.filename || '';
    if (currentFilename === imageFromRoute) return;
    setSelectedImage(imageFromRoute
      ? { filename: imageFromRoute, previewUrl: `/data/images/${encodeURIComponent(imageFromRoute)}` }
      : null);
    setName((currentName) => (
      !currentName.trim() || currentName === nameFromFilename(currentFilename)
        ? nameFromFilename(imageFromRoute)
        : currentName
    ));
  }, [imageFromRoute, selectedImage?.filename]);

  const canCreate = useMemo(
    () => selectedImage?.filename && name.trim() && selectedProviderId && !creating,
    [selectedImage, name, selectedProviderId, creating],
  );

  const handlePick = (item) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('image', item.filename);
    setSearchParams(nextParams);
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    const created = await createThreejsModel({
      name: name.trim(),
      filename: selectedImage.filename,
      prompt: prompt.trim(),
      providerId: selectedProviderId,
      model: selectedModel || undefined,
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start model generation');
      return null;
    });
    setCreating(false);
    if (created) navigate(`/media/threejs/${encodeURIComponent(created.id)}`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex items-start gap-3">
        <Box className="mt-0.5 h-7 w-7 shrink-0 text-port-accent" />
        <div>
          <h1 className="text-xl font-semibold text-white">Three.js Models</h1>
          <p className="mt-1 text-sm text-gray-400">
            Reconstruct a gallery image as validated procedural geometry, preview it live, and export a standalone Three.js factory.
          </p>
        </div>
      </header>

      <form onSubmit={handleCreate} className="grid gap-4 rounded-xl border border-port-border bg-port-card p-4 lg:grid-cols-[220px_1fr]">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="group relative aspect-square overflow-hidden rounded-lg border border-dashed border-port-border bg-port-bg hover:border-port-accent"
        >
          {selectedImage ? (
            <MediaImage
              src={selectedImage.previewUrl || `/data/images/${encodeURIComponent(selectedImage.filename)}`}
              alt="Selected gallery reference"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-2 text-sm text-gray-500 group-hover:text-port-accent">
              <ImagePlus className="h-7 w-7" /> Pick gallery image
            </span>
          )}
          {selectedImage && (
            <span className="absolute inset-x-2 bottom-2 rounded bg-black/70 px-2 py-1 text-center text-xs text-white">
              Change image
            </span>
          )}
        </button>

        <div className="space-y-3">
          <div>
            <label htmlFor="threejs-model-name" className="mb-1 block text-xs text-gray-400">Model name</label>
            <input
              id="threejs-model-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Clockwork courier"
              className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="threejs-model-direction" className="mb-1 block text-xs text-gray-400">
              Modeling direction <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              id="threejs-model-direction"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={2_000}
              rows={3}
              placeholder="Prioritize the silhouette, articulated shoulder joints, and worn brass trim."
              className="w-full resize-y rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none"
            />
          </div>
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            disabled={providersLoading || creating}
            alwaysShowModel
            emptyModelOption="Provider default"
            label="Generation provider"
          />
          <p className="text-xs text-gray-500">
            API providers should use a vision-capable model. CLI/TUI agents inspect the gallery file with their native image tools.
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-xs text-gray-500">
              {selectedImage?.filename || 'Choose an image to continue'}
            </span>
            <button
              type="submit"
              disabled={!canCreate}
              className="inline-flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {creating ? 'Starting…' : 'Generate model'}
            </button>
          </div>
        </div>
      </form>

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Model workspaces</h2>
        {loading ? (
          <div className="py-8 text-center text-sm text-gray-500">Loading…</div>
        ) : models.length === 0 ? (
          <div className="rounded-xl border border-dashed border-port-border py-10 text-center text-sm text-gray-500">
            No procedural models yet.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((model) => (
              <Link
                key={model.id}
                to={`/media/threejs/${encodeURIComponent(model.id)}`}
                className="flex gap-3 rounded-xl border border-port-border bg-port-card p-3 hover:border-port-accent"
              >
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-port-bg">
                  <MediaImage
                    src={model.sourceImage?.path}
                    alt={model.name}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="truncate text-sm font-medium text-white">{model.name}</h3>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${statusClass[model.status] || statusClass.draft}`}>
                      {model.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500">{model.sourceImage?.filename}</p>
                  <p className="mt-2 text-xs text-gray-500">
                    {model.providerId}{model.model ? ` · ${model.model}` : ''} · {timeAgo(model.updatedAt)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={handlePick} />
    </div>
  );
}
