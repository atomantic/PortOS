import CastAndSetsCheckin from '../CastAndSetsCheckin.jsx';
import DevArtifactsPanel from '../DevArtifactsPanel.jsx';
import StageSection from '../StageSection.jsx';
import CreativeSetupPanel from '../CreativeSetupPanel.jsx';
import LookReferencesPanel from '../LookReferencesPanel.jsx';
import VisualSpecPanel from '../VisualSpecPanel.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import { useState } from 'react';
import { formatCount } from '../../../utils/formatters.js';
import { CAST_CHECKIN_ANCHOR, LOOK_GUIDES_ANCHOR } from '../../../lib/musicVideoStages.js';

// Below the sticky project header when a checklist row scrolls here.
const ANCHOR_STYLE = { scrollMarginTop: 'calc(var(--mv-header-h, 9rem) + 1rem)' };

const directionSummary = (project) => {
  const refs = (project.visualSpec?.references || []).length + (project.styleReferences || []).length;
  const characterStyle = project.concept?.characterStyleId
    ? (project.concept.characterStyle?.split(':')[0] || project.concept.characterStyleId) : '';
  return [
    characterStyle ? `Character style: ${characterStyle}` : 'No character style',
    project.concept?.prompt?.trim() ? 'Concept written' : 'No concept yet',
    project.concept?.style?.trim() ? 'Style set' : 'No style yet',
    ...(project.concept?.songStyle?.trim() ? ['Song style set'] : []),
    refs ? `${formatCount(refs)} look ${refs === 1 ? 'reference' : 'references'}` : 'No look references',
  ].join(' · ');
};

/** Re-read the song style from its Suno link, for a song imported before excluded styles were kept. */
function SongStyleFromSuno({ onRead, disabled }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [reading, setReading] = useState(false);
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        className="text-xs text-port-accent hover:underline disabled:opacity-50">Read from Suno</button>
    );
  }
  const read = () => {
    setReading(true);
    onRead(url.trim()).then((ok) => { setReading(false); if (ok) { setOpen(false); setUrl(''); } });
  };
  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-2">
      <label htmlFor="mv-song-style-suno" className="sr-only">Suno song link</label>
      <input id="mv-song-style-suno" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
        placeholder="https://suno.com/song/…"
        className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1 text-sm" />
      <button type="button" disabled={disabled || reading || !url.trim()} onClick={read}
        className="rounded bg-port-accent px-3 py-1 text-xs text-white disabled:opacity-50">{reading ? 'Reading…' : 'Read'}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-port-text-muted hover:underline">Cancel</button>
    </div>
  );
}

/** Concept, style, universe and look references: what the cast and sets are built from. */
function CreativeDirection({ board }) {
  const { project, locked, conceptDraft, styleDraft, songStyleDraft, songStyleFromSuno } = board;
  return (
    <>
      <CreativeSetupPanel
        key={`creative-${project.id}`}
        project={project}
        onPendingChange={board.setCreativeSetupPending}
        onSave={board.saveCreativeSetup}
      />
      <LookReferencesPanel key={`look-${project.id}`} project={project}
        onSave={board.saveStyleReferences} onSaveSpec={board.saveVisualSpec} onAddReference={board.onAddReference}
        onPendingChange={board.setStyleReferencesPending} />
      <fieldset disabled={locked} className="min-w-0 space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="mv-concept" className="mb-1 block text-xs text-port-text-muted">Concept</label>
            <AutoSizeTextarea
              id="mv-concept"
              value={conceptDraft.value}
              rows={2}
              maxLength={8000}
              onChange={conceptDraft.onChange}
              onBlur={conceptDraft.onBlur}
              placeholder="What the video is about: story, theme or thread for the plan to build on."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="mv-style" className="mb-1 block text-xs text-port-text-muted">Visual style</label>
            <AutoSizeTextarea
              id="mv-style"
              value={styleDraft.value}
              rows={2}
              maxLength={2000}
              onChange={styleDraft.onChange}
              onBlur={styleDraft.onBlur}
              placeholder="Art style, palette and mood, added to every frame and shot prompt."
              className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
            />
          </div>
          {songStyleDraft && (
            <div className="sm:col-span-2">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="mv-song-style" className="block text-xs text-port-text-muted">Song style</label>
                {songStyleFromSuno && <SongStyleFromSuno onRead={songStyleFromSuno} disabled={locked} />}
              </div>
              <AutoSizeTextarea
                id="mv-song-style"
                value={songStyleDraft.value}
                rows={2}
                maxLength={2000}
                onChange={songStyleDraft.onChange}
                onBlur={songStyleDraft.onBlur}
                placeholder="The song's Suno style. Excluded styles start with a minus."
                className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
              />
              <p className="mt-1 text-xs text-port-text-muted">With the lyrics, it shapes the world, cast and scenes. It is never added to frame prompts.</p>
            </div>
          )}
        </div>
        <VisualSpecPanel key={project.id} project={project} onSave={board.saveVisualSpec} />
      </fieldset>
    </>
  );
}

/**
 * Look: the creative direction the cast and sets are built from, the check-in
 * the autopilot stops at before planning (approve, regenerate with notes,
 * resume or skip), and the sheets it saved. The art-direction approval closes
 * the step at the bottom of the page.
 */
export default function CastSetsStage({ board }) {
  const { project, locked, castSets, kickoff } = board;
  return (
    <div className="min-w-0 space-y-3">
      <StageSection id="mv-setup-direction" title="Creative direction" summary={directionSummary(project)}
        defaultOpen={!project.concept?.prompt?.trim() && !project.castAndSets}>
        <CreativeDirection board={board} />
      </StageSection>
      {project.castAndSets ? (
        <CastAndSetsCheckin
          id={CAST_CHECKIN_ANCHOR}
          project={project}
          stale={board.productionReadiness?.castAndSets?.stale || null}
          busy={locked || castSets.busy || kickoff.running}
          onOpenSheet={board.openArtifact}
          onOpenPreview={board.openPreview}
          onApprove={board.approveCastAndSets}
          onRegenerate={() => castSets.regenerate()}
          onEditDirection={castSets.editDirection}
          onResume={() => castSets.resume()}
          onRebuild={() => castSets.start()}
          onReconfirm={() => castSets.reconfirm()}
          onRevert={board.onRevertApproval ? (field) => board.onRevertApproval('castAndSets', field) : undefined}
          onSkip={board.skipCastAndSets}
        />
      ) : (
        <div id={CAST_CHECKIN_ANCHOR} tabIndex={-1} style={ANCHOR_STYLE} className="rounded-lg border border-port-border bg-port-card p-3 space-y-3">
          <p className="text-sm text-port-text-muted">Build the cast and sets from your direction, or skip and add your own sheets.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => castSets.start()} disabled={locked || castSets.busy || kickoff.running || !project.audioAnalysis}
              title={project.audioAnalysis ? undefined : 'Analyze the track first'}
              className="min-h-10 rounded-lg bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              Build cast &amp; sets
            </button>
            <button type="button" onClick={() => castSets.skip()} disabled={locked || castSets.busy || kickoff.running}
              className="min-h-10 rounded-lg border border-port-border px-3 py-2 text-sm text-port-text-muted hover:text-white disabled:opacity-50">
              Skip
            </button>
          </div>
        </div>
      )}
      <DevArtifactsPanel
        id={LOOK_GUIDES_ANCHOR}
        project={project}
        busy={board.devArtifacts.busy}
        onOpen={board.openArtifact}
        onUpload={board.onUploadArtifact}
        onUseAsGuide={board.useAsGuide}
        guideId={project.productionReview?.draft?.guideArtifactId || null}
        title="Cast & Sets sheets and visual guides"
        emptyText="The check-in sheet appears here once the cast and sets are built — or import your own guide"
      />
    </div>
  );
}
