import { Suspense } from 'react';
import { Copy, GitFork, LoaderCircle, Sparkles, Wand2, X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ProviderModelSelector from '../ProviderModelSelector';
import CodeAnimationSoundtrack from './CodeAnimationSoundtrack';
import { lazyWithReload } from '../../utils/lazyWithReload';
import { BOARD_FOLLOW_UNIVERSE } from '../media/UniverseMoodBoardPicker';
import { copyToClipboard } from '../../lib/clipboard';
import { inputClass, buttonPrimary, buttonSecondary } from './codeAnimationFields';

const CodeAnimationPreview = lazyWithReload(() => import('./CodeAnimationPreview'));

function PromptOutput({ draft, boards, built, promptStale, handleBuild, canBuild, building }) {
  const boardName = (id) => boards.find((board) => board.id === id)?.name || 'linked board';

  return (
    <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-prompt-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ca-prompt-heading" className="text-sm font-semibold text-white">Prompt</h2>
        <div className="flex shrink-0 flex-wrap gap-2 border-b border-port-border px-4 py-2">
          <button type="button" onClick={handleBuild} disabled={!canBuild} className={buttonPrimary}>
            {building ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {built ? 'Rebuild prompt' : 'Build prompt'}
          </button>
          <button type="button" onClick={() => built && copyToClipboard(built.prompt, 'Prompt copied')} disabled={!built} className={buttonSecondary}>
            <Copy className="h-4 w-4" /> Copy
          </button>
        </div>
      </div>
      {!draft.concept.trim() && <p className="text-xs text-gray-500">Describe what happens in the brief to build a prompt.</p>}
      {built && (
        <>
          {promptStale && <p className="text-xs text-port-warning">The brief changed since this prompt was built. Rebuild to include your edits.</p>}
          {built.moodBoardId && draft.moodBoardChoice === BOARD_FOLLOW_UNIVERSE && (
            <p className="text-xs text-gray-500">Using the universe&apos;s mood board: {boardName(built.moodBoardId)}</p>
          )}
          <textarea readOnly aria-label="Generated prompt" value={built.prompt} rows={14} className={`${inputClass} font-mono text-xs`} />
          {built.attachments?.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-gray-400">Attach these images, in order, when you paste the prompt into another LLM:</p>
              <div className="flex shrink-0 flex-wrap gap-2 border-b border-port-border px-4 py-2">
                {built.attachments.map((attachment, index) => (
                  <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer" title={`${index + 1}. ${attachment.label} (${attachment.origin})`} className="relative block h-14 w-14 overflow-hidden rounded border border-port-border">
                    <img src={attachment.url} alt={attachment.label} className="h-full w-full object-cover" />
                    <span className="port-media-overlay-strong absolute left-0 top-0 rounded-br px-1 text-[10px]">{index + 1}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function GenerationOutputSection({ draft, options, boards, output }) {
  const {
    handleBuild, canBuild, building, built, promptStale, providers, selectedProviderId,
    selectedModel, availableModels, setSelectedProviderId, setEffort, setSelectedModel, effort,
    providersLoading, starting, generating, handleGenerate, handleCancel, canceling, job,
    jobResource, pastedHtml, setPastedHtml, handlePreviewPasted, preview, handleFork,
  } = output;
  const completedPreview = preview?.jobId && job?.id === preview.jobId && job.status === 'completed';

  return (
    <div className="space-y-4">
      <PromptOutput
        draft={draft}
        boards={boards}
        built={built}
        promptStale={promptStale}
        handleBuild={handleBuild}
        canBuild={canBuild}
        building={building}
      />

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-generate-heading">
        <h2 id="ca-generate-heading" className="text-sm font-semibold text-white">Generate &amp; preview</h2>
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          availableModels={availableModels}
          onProviderChange={(id) => { setSelectedProviderId(id); setEffort(''); }}
          onModelChange={setSelectedModel}
          effort={effort}
          onEffortChange={setEffort}
          disabled={providersLoading || starting}
          alwaysShowModel
          emptyModelOption="Provider default"
          label="Generation provider"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={handleGenerate} disabled={!canBuild || !selectedProviderId || starting || generating} className={buttonPrimary}>
            {starting || generating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? 'Generating…' : 'Generate animation'}
          </button>
          {generating && (
            <button type="button" onClick={handleCancel} disabled={canceling} className={buttonSecondary}>
              {canceling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              {canceling ? 'Canceling…' : 'Cancel generation'}
            </button>
          )}
          {job?.status === 'canceled' && <span role="status" className="text-xs text-port-warning">Generation canceled.</span>}
          {job?.status === 'failed' && <span className="text-xs text-port-error">Generation failed: {job.error}</span>}
          {job?.status === 'missing' && <span className="text-xs text-gray-500">That generation is no longer available.</span>}
        </div>
        {jobResource.error && (
          <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-port-error">
            <span>Could not refresh this generation. Its displayed status may be out of date.</span>
            <button type="button" onClick={jobResource.refetch} className={buttonSecondary}>Retry job status</button>
          </div>
        )}
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer select-none">Preview HTML from another LLM</summary>
          <div className="mt-2 space-y-2">
            <textarea aria-label="Pasted animation HTML" rows={4} value={pastedHtml} onChange={(event) => setPastedHtml(event.target.value)} placeholder="Paste the <!DOCTYPE html> document the model returned" className={`${inputClass} font-mono text-xs`} />
            <button type="button" onClick={handlePreviewPasted} disabled={!pastedHtml.trim()} className={buttonSecondary}>Preview pasted HTML</button>
          </div>
        </details>
        {preview && options && (
          <Suspense fallback={<BrailleSpinner text="Loading preview" />}>
            <CodeAnimationPreview
              html={preview.html}
              audioUrl={preview.audioUrl}
              frame={preview.frame}
              jobId={preview.jobId}
              messages={options.messages}
              audioGlobal={options.audioGlobal}
              title={draft.title || draft.concept.slice(0, 40)}
            />
          </Suspense>
        )}
        {completedPreview && (
          <button type="button" onClick={handleFork} className={buttonSecondary}>
            <GitFork className="h-4 w-4" /> Fork &amp; extend
          </button>
        )}
        {completedPreview && (
          <CodeAnimationSoundtrack
            job={job}
            jobId={job.id}
            soundtrack={job.soundtrack}
            audioUrl={job.audioUrl}
            audioTrackId={job.input?.audio?.trackId}
            durationSeconds={job.frame?.durationSeconds}
            onReady={jobResource.refetch}
          />
        )}
      </section>
    </div>
  );
}
