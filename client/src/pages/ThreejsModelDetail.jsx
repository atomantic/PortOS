import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Box, Code2, Download, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MediaImage from '../components/MediaImage';
import ProviderModelSelector from '../components/ProviderModelSelector';
import ThreejsModelPreview from '../components/threejsModels/ThreejsModelPreview';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import useProviderModels from '../hooks/useProviderModels';
import {
  deleteThreejsModel,
  generateThreejsModel,
  getThreejsModel,
  getThreejsModelSource,
  threejsModelSourceUrl,
} from '../services/api';
import toast from '../components/ui/Toast';
import { copyToClipboard } from '../lib/clipboard';
import { timeAgo } from '../utils/formatters';

const providerFilter = (provider) =>
  provider.enabled !== false && ['api', 'cli', 'tui'].includes(provider.type);

export default function ThreejsModelDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [starting, setStarting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const providerSyncRef = useRef('');
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({ filter: providerFilter, silent: true });

  const load = async ({ initial = false } = {}) => {
    const next = await getThreejsModel(id, { silent: true }).catch((error) => {
      if (error.status === 404) setNotFound(true);
      else if (initial) toast.error(error.message || 'Failed to load model');
      return null;
    });
    if (next) {
      setRecord(next);
      setNotFound(false);
    }
    if (initial) setLoading(false);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    getThreejsModel(id, { silent: true })
      .then((next) => { if (!cancelled) setRecord(next); })
      .catch((error) => {
        if (cancelled) return;
        if (error.status === 404) setNotFound(true);
        else toast.error(error.message || 'Failed to load model');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (record?.status !== 'generating') return undefined;
    const handle = setInterval(() => { void load(); }, 2_000);
    return () => clearInterval(handle);
  }, [record?.status, id]);

  useEffect(() => {
    if (!record || providers.length === 0) return;
    const key = `${record.id}:${record.providerId}:${record.model || ''}`;
    if (providerSyncRef.current === key) return;
    if (providers.some((provider) => provider.id === record.providerId)) {
      setSelectedProviderId(record.providerId);
      setSelectedModel(record.model || '');
    }
    providerSyncRef.current = key;
  }, [record, providers, setSelectedProviderId, setSelectedModel]);

  const handleGenerate = async () => {
    if (!selectedProviderId || record?.status === 'generating') return;
    setStarting(true);
    const next = await generateThreejsModel(id, {
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      prompt: record.prompt || '',
      feedback: feedback.trim(),
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start generation');
      return null;
    });
    setStarting(false);
    if (next) {
      setRecord(next);
      setFeedback('');
      toast.success(record.spec ? 'Refinement started' : 'Generation started');
    }
  };

  const handleCopySource = async () => {
    const source = await getThreejsModelSource(id, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to load source');
      return null;
    });
    if (source) await copyToClipboard(source, 'Three.js source copied');
  };

  const handleDelete = async () => {
    const ok = await deleteThreejsModel(id, { silent: true }).then(() => true).catch((error) => {
      toast.error(error.message || 'Delete failed');
      return false;
    });
    if (ok) navigate('/media/threejs');
  };

  if (loading) return <div className="py-10 text-center text-sm text-gray-500">Loading…</div>;
  if (notFound || !record) {
    return (
      <div className="py-12 text-center">
        <p className="mb-3 text-gray-400">That Three.js model does not exist.</p>
        <Link to="/media/threejs" className="text-port-accent hover:underline">Back to models</Link>
      </div>
    );
  }

  const generating = record.status === 'generating' || starting;
  const latestRun = Array.isArray(record.runs) ? record.runs[record.runs.length - 1] : null;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/media/threejs" className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-white">
            <ArrowLeft className="h-3.5 w-3.5" /> Three.js Models
          </Link>
          <div className="flex items-center gap-2">
            <Box className="h-6 w-6 text-port-accent" />
            <h1 className="text-xl font-semibold text-white">{record.name}</h1>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${
              record.status === 'ready' ? 'bg-port-success/15 text-port-success'
                : record.status === 'failed' ? 'bg-port-error/15 text-port-error'
                  : 'bg-port-accent/15 text-port-accent'
            }`}>
              {record.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {record.providerId}{record.model ? ` · ${record.model}` : ''} · updated {timeAgo(record.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {record.spec && (
            <>
              <button
                type="button"
                onClick={handleCopySource}
                className="inline-flex items-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-gray-300 hover:bg-port-border/50 hover:text-white"
              >
                <Code2 className="h-3.5 w-3.5" /> Copy source
              </button>
              <a
                href={threejsModelSourceUrl(id)}
                download
                className="inline-flex items-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-gray-300 hover:bg-port-border/50 hover:text-white"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </>
          )}
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded p-1.5 text-gray-500 hover:bg-port-error/10 hover:text-port-error"
            aria-label={`Delete ${record.name}`}
            title="Delete model"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      {confirmingDelete && (
        <InlineConfirmRow
          question={`Delete "${record.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}

      {record.error && (
        <div className="rounded-lg border border-port-error/30 bg-port-error/10 px-3 py-2 text-sm text-port-error">
          {record.error}
        </div>
      )}

      <section className="grid min-h-[520px] overflow-hidden rounded-xl border border-port-border bg-port-card lg:grid-cols-[240px_1fr]">
        <aside className="border-b border-port-border p-3 lg:border-b-0 lg:border-r">
          <div className="aspect-square overflow-hidden rounded-lg bg-port-bg">
            <MediaImage
              src={record.sourceImage?.path}
              alt={`Reference for ${record.name}`}
              className="h-full w-full object-contain"
            />
          </div>
          <p className="mt-2 break-all text-xs text-gray-500">{record.sourceImage?.filename}</p>
          {record.spec?.summary && <p className="mt-3 text-xs leading-relaxed text-gray-300">{record.spec.summary}</p>}
          {record.spec?.limitations?.length > 0 && (
            <div className="mt-3">
              <h2 className="text-[10px] uppercase tracking-wide text-gray-500">Known limitations</h2>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-400">
                {record.spec.limitations.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
        </aside>
        <div className="relative min-h-[520px]">
          <ThreejsModelPreview spec={record.spec} className="h-full min-h-[520px] w-full" />
          {generating && (
            <div className="absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-black/65 px-3 py-2 text-xs text-white backdrop-blur-sm">
              <LoaderCircle className="h-4 w-4 animate-spin text-port-accent" />
              Inspecting the reference and building procedural geometry…
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-4 rounded-xl border border-port-border bg-port-card p-4 lg:grid-cols-[1fr_2fr_auto] lg:items-end">
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={setSelectedProviderId}
          onModelChange={setSelectedModel}
          disabled={providersLoading || generating}
          alwaysShowModel
          emptyModelOption="Provider default"
          label={record.spec ? 'Refinement provider' : 'Generation provider'}
          layout="stacked"
        />
        <div>
          <label htmlFor="threejs-feedback" className="mb-1 block text-xs text-gray-400">
            {record.spec ? 'Refinement feedback' : 'Generation direction'}
          </label>
          <textarea
            id="threejs-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            maxLength={2_000}
            rows={3}
            disabled={generating}
            placeholder={record.spec
              ? 'Make the handle thicker, separate the lid pivot, and match the warm brass trim.'
              : 'Describe what matters most in this reconstruction.'}
            className="w-full resize-y rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating || !selectedProviderId}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {record.spec ? 'Refine model' : 'Generate model'}
        </button>
      </section>

      {record.spec?.detailInventory?.length > 0 && (
        <section className="rounded-xl border border-port-border bg-port-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">Detail inventory</h2>
            <span className="text-xs text-gray-600">{record.spec.detailInventory.length} modeled features</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {record.spec.detailInventory.map((detail, index) => (
              <div key={`${detail.feature}-${index}`} className="rounded-lg border border-port-border bg-port-bg/50 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-xs font-medium text-gray-200">{detail.feature}</h3>
                  <span className="rounded bg-port-border px-1.5 py-0.5 text-[9px] uppercase text-gray-400">{detail.priority}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{detail.evidence}</p>
                <p className="mt-1 text-[10px] text-port-accent">{detail.implementationPartIds.join(' · ')}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {latestRun && (
        <p className="text-right text-[10px] text-gray-600">
          Latest run {latestRun.status}{latestRun.runId ? ` · ${latestRun.runId}` : ''}
        </p>
      )}
    </div>
  );
}
