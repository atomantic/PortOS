import { GitFork, Globe, LoaderCircle, PenLine, Sparkles } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import FilmStylePicker from './FilmStylePicker';
import UniverseMoodBoardPicker from '../media/UniverseMoodBoardPicker';
import { inputClass, labelClass, buttonSecondary } from './codeAnimationFields';

export default function BriefInputSection({
  draft,
  update,
  limits,
  options,
  updateFormat,
  styleLists,
  onStyleGrammarChange,
  writer,
}) {
  const {
    handleWriteBrief, canWriteBrief, briefSeeds, writingBrief, briefProviders, briefProviderId,
    briefModel, briefModels, setBriefProviderId, setBriefEffort, setBriefModel, briefEffort,
    briefProvidersLoading,
  } = writer;

  return (
    <>
      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-style-heading">
        <h2 id="ca-style-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><Globe className="h-4 w-4 text-port-accent" /> Style</h2>
        <UniverseMoodBoardPicker
          lists={styleLists}
          idPrefix="ca"
          universeLabel="Universe (sets the art style)"
          labelClass={labelClass}
          inputClass={inputClass}
          universeId={draft.universeId}
          moodBoardChoice={draft.moodBoardChoice}
          onUniverseChange={(universeId) => update({ universeId })}
          onBoardChoiceChange={(moodBoardChoice) => update({ moodBoardChoice })}
        />
        <FilmStylePicker id="ca-film-style" value={draft.styleGrammarId} onChange={onStyleGrammarChange} labelClass={labelClass} inputClass={inputClass} />
        <div>
          <label htmlFor="ca-style-notes" className={labelClass}>Style refinements <span className="text-gray-600">(optional, applied on top of the universe style)</span></label>
          <textarea id="ca-style-notes" rows={2} value={draft.styleNotes} maxLength={limits?.styleNotesMax} onChange={(event) => update({ styleNotes: event.target.value })} placeholder="Heavier film grain, slower camera, dusk palette" className={`${inputClass} resize-y`} />
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={draft.includeMoodBoardImages} onChange={(event) => update({ includeMoodBoardImages: event.target.checked })} />
          Attach mood board images as references
        </label>
      </section>

      <section className="rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-format-heading">
        <h2 id="ca-format-heading" className="mb-3 text-sm font-semibold text-white">Format</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="ca-duration" className={labelClass}>Duration (s)</label>
            <input id="ca-duration" type="number" min={limits?.durationMin ?? 3} max={limits?.durationMax ?? 180} value={draft.format.durationSeconds} onChange={(event) => updateFormat({ durationSeconds: Math.round(Number(event.target.value) || 0) })} className={inputClass} />
          </div>
          <div>
            <label htmlFor="ca-aspect" className={labelClass}>Aspect</label>
            <select id="ca-aspect" value={draft.format.aspectRatio} onChange={(event) => updateFormat({ aspectRatio: event.target.value })} className={inputClass}>
              {(options?.aspectRatios || ['16:9']).map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ca-resolution" className={labelClass}>Resolution</label>
            <select id="ca-resolution" value={draft.format.resolution} onChange={(event) => updateFormat({ resolution: event.target.value })} className={inputClass}>
              {(options?.resolutions || ['1080p']).map((res) => <option key={res} value={res}>{res}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ca-fps" className={labelClass}>FPS</label>
            <select id="ca-fps" value={draft.format.fps} onChange={(event) => updateFormat({ fps: Number(event.target.value) })} className={inputClass}>
              {(limits?.fpsOptions || [30]).map((fps) => <option key={fps} value={fps}>{fps}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ca-renderer" className={labelClass}>Renderer</label>
            <select id="ca-renderer" value={draft.renderer} onChange={(event) => update({ renderer: event.target.value })} className={inputClass}>
              {(options?.renderers || ['auto']).map((renderer) => <option key={renderer} value={renderer}>{renderer}</option>)}
            </select>
          </div>
          <label className="flex items-end gap-2 pb-2 text-xs text-gray-300">
            <input type="checkbox" checked={draft.interactive} onChange={(event) => update({ interactive: event.target.checked })} />
            Interactive
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-brief-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ca-brief-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><Sparkles className="h-4 w-4 text-port-accent" /> Brief</h2>
          <button type="button" onClick={handleWriteBrief} disabled={!canWriteBrief} className={buttonSecondary} title={briefSeeds ? undefined : 'Pick a universe or write a starting idea first'}>
            {writingBrief ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
            Write brief
          </button>
        </div>
        {draft.base && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-port-accent/40 bg-port-accent/10 p-2 text-xs text-gray-200">
            <GitFork className="h-4 w-4 shrink-0 text-port-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Extending <span className="font-semibold">{draft.base.title || 'an animation'}</span>
              {draft.base.durationSeconds ? ` (${draft.base.durationSeconds}s)` : ''}. Its code is sent with the prompt; set the new duration in Format.
              {draft.base.durationSeconds && draft.format.durationSeconds <= draft.base.durationSeconds ? ' The duration is not longer than the original yet.' : ''}
            </span>
            <button type="button" onClick={() => update({ base: null })} className="text-gray-400 hover:text-white">Stop extending</button>
          </div>
        )}
        <ProviderModelSelector
          providers={briefProviders}
          selectedProviderId={briefProviderId}
          selectedModel={briefModel}
          availableModels={briefModels}
          onProviderChange={(id) => { setBriefProviderId(id); setBriefEffort(''); }}
          onModelChange={setBriefModel}
          effort={briefEffort}
          onEffortChange={setBriefEffort}
          disabled={briefProvidersLoading || writingBrief}
          alwaysShowModel
          emptyModelOption="Provider default"
          label="Brief writing provider"
        />
        <div>
          <label htmlFor="ca-seed" className={labelClass}>
            Starting idea <span className="text-gray-600">(optional; what the brief writer starts from)</span>
          </label>
          <textarea id="ca-seed" rows={2} value={draft.seedIdea} maxLength={limits?.seedIdeaMax} onChange={(event) => update({ seedIdea: event.target.value })} placeholder="A chase through the lower market that ends in silence" className={`${inputClass} resize-y`} />
          <p className="mt-1 text-xs text-gray-500">
            {draft.universeId
              ? 'Write brief casts the film from this universe\u2019s characters, places, and tone.'
              : 'Pick a universe above to have the brief cast from its characters and places.'}
          </p>
        </div>
        <div>
          <label htmlFor="ca-title" className={labelClass}>Title <span className="text-gray-600">(optional)</span></label>
          <input id="ca-title" value={draft.title} maxLength={200} onChange={(event) => update({ title: event.target.value })} placeholder="The Lantern Keeper" className={inputClass} />
        </div>
        <div>
          <label htmlFor="ca-concept" className={labelClass}>What happens</label>
          <textarea id="ca-concept" rows={6} value={draft.concept} maxLength={limits?.conceptMax} onChange={(event) => update({ concept: event.target.value })} placeholder={'A paper lantern drifts over a sleeping harbor town, gathers fireflies, and bursts into a constellation.\n0:00–0:04 Low tracking shot: the lantern bobs past rooftops, curious…'} className={`${inputClass} resize-y`} />
        </div>
        <div>
          <label htmlFor="ca-cast" className={labelClass}>Characters <span className="text-gray-600">(optional; design bible the animation rigs)</span></label>
          <textarea id="ca-cast" rows={4} value={draft.cast} maxLength={limits?.castMax} onChange={(event) => update({ cast: event.target.value })} placeholder="Wick — a palm-sized paper lantern: round body, bent-wire handle that droops when sad; palette cream #F3E6C4, ember #E8763A; face: two ink-dot eyes (curious, sleepy, startled, delighted, determined). Identity lock: silhouette and handle never change." className={`${inputClass} resize-y`} />
        </div>
        <div>
          <label htmlFor="ca-text" className={labelClass}>On-screen text / narration <span className="text-gray-600">(optional)</span></label>
          <textarea id="ca-text" rows={2} value={draft.onScreenText} maxLength={limits?.textMax} onChange={(event) => update({ onScreenText: event.target.value })} placeholder={'0:02 "Every night, one light remains"\n0:15 Title card'} className={`${inputClass} resize-y`} />
        </div>
      </section>
    </>
  );
}
