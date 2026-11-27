import { useEffect } from 'react';
import { ArrowLeft, Box, Code2, Download, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router';
import ModelReferencePanel from '../components/threejsModels/ModelReferencePanel';
import ProviderModelSelector from '../components/ProviderModelSelector';
import ReferenceImagesEditor from '../components/threejsModels/ReferenceImagesEditor';
import SubjectFamilySelect from '../components/threejsModels/SubjectFamilySelect';
import ThreejsModelPreview from '../components/threejsModels/ThreejsModelPreview';
import PageSkeleton from '../components/ui/PageSkeleton';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import { useModelLifecycle } from '../hooks/useModelLifecycle';
import { GENERAL_FAMILY_ID, resolveFamilyId } from '../hooks/useThreejsModelFamilies';
import { getThreejsModel, threejsModelSourceUrl } from '../services/apiThreejsModels.js';
import toast from '../components/ui/Toast';
import { timeAgo } from '../utils/formatters';
import ModelReviewPanels from '../components/threejsModels/ModelReviewPanels';
import useThreejsModelActions from '../components/threejsModels/useThreejsModelActions';

export default function ThreejsModelDetail() {
  const { id } = useParams();
  const { data: record, updateData: setRecord, refetch, loading, error } = useModelLifecycle(id, getThreejsModel, { procedural: true });
  const notFound = !loading && !error && !record;
  useEffect(() => {
    if (error) toast.error(error.message || 'Could not refresh the model');
  }, [error]);
  const {
    families, familiesStatus, retryFamilies, family, setFamily, referenceImages, setReferenceImages,
    confirmingDelete, setConfirmingDelete, seekToken, previewRef, providers, selectedProviderId,
    selectedModel, availableModels, setSelectedProviderId, setSelectedModel, providersLoading,
    effort, setEffort, starting, feedback, setFeedback, handleGenerate, handleShowFinding,
    handleCopySource, handleDelete,
  } = useThreejsModelActions({ id, record, setRecord, refetch });

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl">
        <PageSkeleton label="Loading model" titleWidthClass="w-56" cards={2} sidebar={false} />
      </div>
    );
  }
  if (notFound || !record) {
    return (
      <div className="py-12 text-center">
        <p className="mb-3 text-gray-400">{error ? 'Could not load this model. Return to this tab or reconnect to retry.' : 'That Three.js model does not exist.'}</p>
        <Link to="/3d/threejs" className="text-port-accent hover:underline">Back to models</Link>
      </div>
    );
  }

  const generating = record.status === 'generating' || starting;
  const latestRun = Array.isArray(record.runs) ? record.runs[record.runs.length - 1] : null;
  // Only present when the generation ran with a family — a record generated
  // under `general` (or before families shipped) has no checklist to render.
  const coverageFamily = Array.isArray(record.coverage?.family?.components)
    ? record.coverage.family
    : null;
  // The record's own family, not the coverage snapshot's — the header should
  // read the current setting even before the next generation re-runs the gate.
  // Resolved like the picker is, so a record holding a family this install no
  // longer ships does not have the header and the picker naming two different
  // things; the coverage panel below still reports the checklist that ran.
  const activeFamily = resolveFamilyId(families, record.family);
  const familyLabel = activeFamily && activeFamily !== GENERAL_FAMILY_ID
    ? (families.find((option) => option.id === activeFamily)?.label || activeFamily)
    : '';

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/3d/threejs" className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-white">
            <ArrowLeft className="h-3.5 w-3.5" /> Three.js Models
          </Link>
          <div className="flex items-center gap-2">
            <Box className="h-6 w-6 text-port-accent" />
            <h2 className="text-xl font-semibold text-white">{record.name}</h2>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${
              record.status === 'ready' ? 'bg-port-success/15 text-port-success'
                : record.status === 'failed' ? 'bg-port-error/15 text-port-error'
                  : 'bg-port-accent/15 text-port-accent'
            }`}>
              {record.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {record.providerId}{record.model ? ` · ${record.model}` : ''}{record.effort ? ` · ${record.effort} effort` : ''}
            {familyLabel ? ` · ${familyLabel}` : ''} · updated {timeAgo(record.updatedAt)}
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
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded p-1.5 text-gray-500 hover:bg-port-error/10 hover:text-port-error"
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
        <div role="status" className="rounded-lg border border-port-error/30 bg-port-error/10 px-3 py-2 text-sm text-port-error">
          {record.error}
        </div>
      )}

      <section className="grid min-h-[520px] overflow-hidden rounded-xl border border-port-border bg-port-card lg:grid-cols-[240px_1fr]">
        <ModelReferencePanel record={record} />
        <div ref={previewRef} className="relative min-h-[520px]">
          <ThreejsModelPreview spec={record.spec} family={coverageFamily} seekToken={seekToken} className="h-full min-h-[520px] w-full" />
          {generating && (
            <div className="port-media-overlay absolute inset-x-0 top-0 flex items-center justify-center gap-2 border-b border-port-border px-3 py-2 text-xs">
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
          effort={effort}
          onEffortChange={setEffort}
          disabled={providersLoading || generating}
          alwaysShowModel
          emptyModelOption="Provider default"
          label={record.spec ? 'Refinement provider' : 'Generation provider'}
          layout="stacked"
        />
        <div>
          <ReferenceImagesEditor value={referenceImages} onChange={setReferenceImages} disabled={generating} primaryFilename={record.sourceImage?.filename || ''} />
          <SubjectFamilySelect
            id="threejs-family"
            families={families}
            status={familiesStatus}
            onRetry={retryFamilies}
            value={family}
            onChange={setFamily}
            disabled={generating}
            className="mb-3"
          />
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

      <ModelReviewPanels record={record} coverageFamily={coverageFamily} handleShowFinding={handleShowFinding} />

      {latestRun && (
        <p className="text-right text-[10px] text-gray-600">
          Latest run {latestRun.status}{latestRun.runId ? ` · ${latestRun.runId}` : ''}
        </p>
      )}
    </div>
  );
}
