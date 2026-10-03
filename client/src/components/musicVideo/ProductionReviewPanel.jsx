import { useEffect, useState } from 'react';
import { formatTimecode } from '../../utils/formatters.js';

const EMPTY = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
const fieldClass = 'mt-1 w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const labels = { art: 'Art direction', storyboard: 'Lyric-timed storyboard', proof: 'Animated proof' };

/** Editable planning content and explicit operator decisions for every render mode. */
// `framed={false}` drops the card chrome and heading for a host that supplies them (the page's collapsible section).
export default function ProductionReviewPanel({ project, review, onOpenArtifact, framed = true }) {
  const fieldId = key => `mv-review-${project.id}-${key}`;
  const saved = project.productionReview?.draft || EMPTY;
  const [local, setLocal] = useState(null);
  const draft = local || saved;
  const dirty = !!local && JSON.stringify(local) !== JSON.stringify(saved);
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState({ stage: 'art', target: '', text: '', decision: 'request-changes' });
  const [resolutions, setResolutions] = useState({});
  const [importError, setImportError] = useState(null);
  const [playbackReview, setPlaybackReview] = useState({ identity: null, watched: false, energyComparison: '', timecodedNotes: '' });
  const [startSec, setStartSec] = useState(project.productionReview?.proof?.startSec || 0);
  const [endSec, setEndSec] = useState(project.productionReview?.proof?.endSec || Math.min(20, project.audioAnalysis?.durationSec || 20));
  const ready = review.readiness;
  const set = (key, value) => setLocal({ ...draft, [key]: value });
  const documentShots = draft.storyboardSource === 'document';
  const shots = documentShots ? draft.storyboard : [...draft.storyboard, ...(project.scenes || []).filter(scene => !draft.storyboard.some(s => s.sceneId === scene.sceneId)).map(scene => ({
    id: scene.sceneId, sceneId: scene.sceneId, lyricCueIds: [], action: '', staging: '', camera: '', transition: '',
  }))];
  const shotKey = shot => shot.id || shot.sceneId;
  const setShot = (shot, key, value) => set('storyboard', shots.map(s => shotKey(s) === shotKey(shot) ? { ...s, [key]: value } : s));
  const blocked = dirty || review.busy || !ready;
  const prototype = project.excerpts?.find(e => e.id === project.productionReview?.prototype?.excerptId);
  const excerpt = project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId);
  const proofIdentity = JSON.stringify([project.id, ready?.basis.proof ?? project.productionReview?.proof?.basis ?? null, excerpt?.id, excerpt?.filename]);
  const recordedProofReview = project.productionReview?.approvals?.proof?.proofReview;
  const matchingRecordedReview = ready?.proof.approved && recordedProofReview?.excerptId === excerpt?.id
    && recordedProofReview?.filename === excerpt?.filename ? recordedProofReview : null;
  useEffect(() => { setPlaybackReview(current => current.identity === proofIdentity ? current
    : { identity: proofIdentity, watched: false, energyComparison: '', timecodedNotes: '' }); }, [proofIdentity]);
  const playback = playbackReview.identity === proofIdentity ? playbackReview : { watched: false, energyComparison: '', timecodedNotes: '' };
  const setPlayback = patch => setPlaybackReview({ ...playback, identity: proofIdentity, ...patch });
  const playbackBlocked = blocked || review.proof.active || !!ready?.proof.problems.length || excerpt?.status !== 'complete' || !excerpt.filename;
  const playbackComplete = playback.watched && !!playback.energyComparison.trim()
    && /(?:\b\d{1,2}:\d{2}(?:\.\d+)?\b|\b\d+(?:\.\d+)?s\b)/.test(playback.timecodedNotes);
  const approve = stage => {
    const secret = password; setPassword('');
    return review.approve(stage, secret, stage === 'proof' ? { watchedWithAudio: true,
      energyComparison: playback.energyComparison.trim(), timecodedNotes: playback.timecodedNotes.trim(),
      excerptId: excerpt.id, filename: excerpt.filename } : undefined);
  };

  return <section id="mv-production-review" aria-label="Production review" className={framed ? 'rounded-lg border border-port-border bg-port-card p-3 space-y-3' : 'space-y-3'}>
    {framed && <h3 className="font-medium">Production review</h3>}
    <p className="text-sm text-port-text-muted">Every medium needs visual direction, a timed storyboard and a watched animated proof. Drafts and technical renders do not count as approval.</p>
    {review.error && <p role="alert" className="text-port-error">{review.error}</p>}
    <ol className="grid gap-2 sm:grid-cols-3">
      {Object.entries(labels).map(([key, label]) => <li key={key} className="rounded border border-port-border p-2">
        <strong className="text-sm">{label}</strong>
        <p role="status" className="text-xs">{ready?.[key].approved ? 'Approved for this revision' : 'Human review required'}</p>
        {(ready?.[key].problems || []).map(problem => <p key={problem} className="mt-1 text-xs text-port-text-muted">{problem}</p>)}
        <button type="button" className={`${buttonClass} mt-2`} onClick={() => approve(key)}
          disabled={blocked || !password || ready?.[key].approved || !!ready?.[key].problems.length
            || (key === 'proof' && (playbackBlocked || !playbackComplete))}>
          Approve {label.toLowerCase()}
        </button>
      </li>)}
    </ol>
    <label htmlFor={fieldId('password')} className="block text-sm">Instance password for this approval
      <input id={fieldId('password')} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={fieldClass} />
    </label>
    <p className="text-xs text-port-text-muted">Enter it yourself. API tokens cannot approve. Password-free installs can prepare drafts; set an instance password in Settings → Security before approval.</p>
    <details>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Review feedback and revision history</summary>
      <p className="text-sm">Name a cast member, environment, shot, artifact or frame time. Structure acceptance records agreement on organization only; it never approves the art or authorizes production.</p>
      <label htmlFor={fieldId('feedback-stage')} className="block text-sm">Feedback stage<select id={fieldId('feedback-stage')} className={fieldClass} value={feedback.stage} onChange={e => setFeedback({ ...feedback, stage: e.target.value })}>
        {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label htmlFor={fieldId('feedback-target')} className="block text-sm">Feedback target<input id={fieldId('feedback-target')} className={fieldClass} value={feedback.target} placeholder="Cast: operator; shot: chorus; frame: 12.5s" onChange={e => setFeedback({ ...feedback, target: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-text')} className="block text-sm">Requested change<textarea id={fieldId('feedback-text')} className={fieldClass} rows={3} value={feedback.text} onChange={e => setFeedback({ ...feedback, text: e.target.value })} /></label>
      <label htmlFor={fieldId('feedback-decision')} className="block text-sm">Review decision<select id={fieldId('feedback-decision')} className={fieldClass} value={feedback.decision} onChange={e => setFeedback({ ...feedback, decision: e.target.value })}>
        <option value="request-changes">Request changes — blocks affected approvals</option><option value="comment">Comment</option><option value="structure-accepted">Accept structure only — art remains unapproved</option>
      </select></label>
      <button type="button" className={buttonClass} disabled={blocked || !feedback.target.trim() || !feedback.text.trim()} onClick={async () => {
        if (await review.feedback(feedback)) setFeedback({ ...feedback, text: '' });
      }}>Save revision feedback</button>
      <ul className="mt-3 space-y-3">{(project.productionReview?.feedback || []).map(item => <li key={item.id} className="rounded border border-port-border p-2">
        <p className="text-sm"><strong>{item.target}</strong> · {item.decision} · {item.resolvedAt ? 'Resolved' : 'Open'}</p>
        <p className="text-sm whitespace-pre-wrap">{item.text}</p>
        <p className="text-xs text-port-text-muted">Reviewed revision {item.basis.slice(0, 12)}{ready?.basis[item.stage] !== item.basis ? ' · content has changed since review' : ' · current revision'}</p>
        <details><summary className="cursor-pointer py-2 text-sm">Original reviewed content</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(project.productionReview.reviewedRevisions?.[item.basis]?.draft, null, 2)}</pre></details>
        {item.resolvedAt ? <p className="text-sm">Resolution: {item.resolution}</p> : <>
          <label htmlFor={fieldId(`resolution-${item.id}`)} className="block text-sm">Resolution for {item.target}<textarea id={fieldId(`resolution-${item.id}`)} className={fieldClass} value={resolutions[item.id] || ''} onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value })} /></label>
          <button type="button" className={buttonClass} disabled={blocked || !password || !resolutions[item.id]?.trim()} onClick={async () => {
            const secret = password; setPassword(''); await review.resolveFeedback(item.id, resolutions[item.id], secret);
          }}>Resolve feedback after review</button>
        </>}
      </li>)}</ul>
    </details>
    <details>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Edit visual guide and storyboard</summary>
      <div className="space-y-3">
        <label htmlFor={fieldId('import')} className="block text-sm">Import planning JSON as an unapproved draft
          <input id={fieldId('import')} type="file" accept=".json,application/json" disabled={dirty || review.busy} className={fieldClass}
            onChange={async e => {
              const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
              if (!file) return;
              try { if (await review.importPlanning(await file.text())) setLocal(null); }
              catch (error) { setImportError(error.message); }
            }} />
        </label>
        {project.composition?.mode === 'document' && <div className="space-y-2 rounded border border-port-border p-2">
          <p className="text-sm">Document shot manifest</p>
          <p className="text-xs text-port-text-muted">Export the composition in Compose. Have its author extract the actual shot IDs, timings and choreography from the source (for example timeline.js) into the JSON format below, keeping its documentDirectory and audioBasis from when that source was authored. A generic document section or Board row is not a shot list. Reauthor and reimport the composition after changing lyrics or timing, then import its matching manifest here.</p>
          <label htmlFor={fieldId('document-shots')} className="block text-sm">Import document shot manifest
            <input id={fieldId('document-shots')} type="file" accept=".json,application/json" disabled={dirty || review.busy || !project.productionReview?.draft || !project.composition.document} className={fieldClass}
              onChange={async e => {
                const file = e.target.files?.[0]; e.target.value = ''; setImportError(null);
                if (!file) return;
                try {
                  const input = JSON.parse(await file.text());
                  if (await review.importDocumentShots(input)) setLocal(null);
                } catch (error) { setImportError(error.message); }
              }} />
          </label>
          <details><summary className="cursor-pointer py-2 text-sm">Shot manifest format</summary><pre className="overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ ...ready?.documentShotImport, sourceFile: 'timeline.js', shots: [{ id: 'source-shot-id', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: [], action: 'Source action', staging: 'Source staging', camera: 'Source camera', transition: 'Source transition' }] }, null, 2)}</pre></details>
          <p className="text-xs">{project.productionReview?.documentStoryboard ? `Bound source: ${project.productionReview.documentStoryboard.sourceFile}. Reimporting a document, changing audio or editing these shots requires a new matching manifest.` : 'No document shot manifest bound. Board scenes do not stand in for source shots.'}</p>
        </div>}
        {importError && <p role="alert">{importError}</p>}
        {draft.sourceArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.sourceArtifactId)}>Read preserved original planning draft</button>}
        <button type="button" className={buttonClass} disabled={dirty || review.busy || documentShots} onClick={review.prepare}>Prepare planning draft with autopilot</button>
        <p className="text-xs text-port-text-muted">Uses the saved authoring provider and allowed tools. Builds Cast & Sets first, then pauses for art approval before planning shots. Existing edits are retained.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries({ cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' }).map(([key, label]) =>
            <label key={key} htmlFor={fieldId(key)} className="text-sm">{label}<textarea id={fieldId(key)} rows={4} value={draft[key]} onChange={e => set(key, e.target.value)} className={fieldClass} /></label>)}
        </div>
        <label htmlFor={fieldId('motionLanguage')} className="block text-sm">Timed choreography and energy plan
          <textarea id={fieldId('motionLanguage')} rows={7} value={draft.motionLanguage || ''} onChange={e => set('motionLanguage', e.target.value)} className={fieldClass}
            aria-label="Timed choreography and energy plan" aria-describedby={fieldId('motion-help')}
            placeholder={'Energy target: restrained, driving, explosive, or a described arc.\n0:00–0:08 / first downbeat: subject reaches, prop unfolds; camera pushes in; title lands on the vocal.\n0:08–0:16 / chorus hit: full-body turn and prop release; camera arcs; type expands then clears.\nRepeated chorus: preserve the motif, escalate pose range, travel, camera depth or transition scale.'} />
        </label>
        <p id={fieldId('motion-help')} className="text-xs text-port-text-muted">Choose the intended energy explicitly. For each time range and beat, word or section anchor, describe subject and prop actions, pose or travel changes, camera movement, typography and the transition. Name intentional holds and how each repeated chorus develops. The saved plan guides UI authoring and autopilot.</p>
        <label htmlFor={fieldId('implementation')} className="block text-sm">Implementation and feasibility for {project.composition?.mode || 'composed'} rendering
          <textarea id={fieldId('implementation')} rows={5} value={draft.implementationPlan || ''} onChange={e => set('implementationPlan', e.target.value)} className={fieldClass}
            placeholder="Map each timed action to scene graph layers, vector/mesh construction, rig joints, pose limits and prop mechanics; specify camera paths and typography timing, transitions, frame rate, geometry and draw-call budgets." />
        </label>
        <p className="text-xs text-port-text-muted">Concept references establish intent. Document how this renderer can build and animate the look; a raster reference is not code-rendered evidence. Changing the plan invalidates prior art approval.</p>
        <label htmlFor={fieldId('guide')} className="block text-sm">Visual cast and environment sheet
          <select id={fieldId('guide')} value={draft.guideArtifactId || ''} onChange={e => set('guideArtifactId', e.target.value || null)} className={fieldClass}>
            <option value="">Choose a Development artifact</option>
            {(project.devArtifacts || []).filter(a => !a.deleted).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </label>
        {draft.guideArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.guideArtifactId)}>Review visual sheet</button>}
        <label htmlFor={fieldId('song-content')} className="block text-sm">Song content
          <select id={fieldId('song-content')} value={draft.lyricsMode} onChange={e => set('lyricsMode', e.target.value)} className={fieldClass}>
            <option value="vocal">Vocal song — aligned lyrics required</option><option value="instrumental">Instrumental — explicit exception</option>
          </select>
        </label>
        <label htmlFor={fieldId('alignment-status')} className="block text-sm">Alignment status
          <select id={fieldId('alignment-status')} value={draft.timingStatus} onChange={e => set('timingStatus', e.target.value)} className={fieldClass}>
            <option value="provisional">Provisional — needs listening and correction</option><option value="verified">Verified against the current master vocal</option>
          </select>
        </label>
        <label htmlFor={fieldId('alignment-notes')} className="block text-sm">Alignment notes / instrumental rationale<textarea id={fieldId('alignment-notes')} rows={2} value={draft.timingNotes} onChange={e => set('timingNotes', e.target.value)} className={fieldClass} /></label>
        <label htmlFor={fieldId('storyboard-source')} className="block text-sm">Storyboard source
          <select id={fieldId('storyboard-source')} value={draft.storyboardSource || 'board'} onChange={e => set('storyboardSource', e.target.value)} className={fieldClass}>
            <option value="board">Board scenes</option><option value="document">Authored document shot manifest</option>
          </select>
        </label>
        {shots.map(shot => {
          const scene = documentShots ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
          return <details key={shotKey(shot)} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer min-h-[44px] text-sm">{scene?.label || shot.id || 'Unbound shot'} — {documentShots ? 'document source shot' : scene ? 'edit choreography' : 'bind to a Board scene'}</summary>
            {!documentShots && <label htmlFor={fieldId(`scene-${shotKey(shot)}`)} className="block text-sm">Board scene
              <select id={fieldId(`scene-${shotKey(shot)}`)} value={shot.sceneId || ''} onChange={e => setShot(shot, 'sceneId', e.target.value || null)} className={fieldClass}>
                <option value="">Unbound draft — no scene selected</option>
                {(project.scenes || []).map(s => <option key={s.sceneId} value={s.sceneId}>{s.label || s.sceneId}</option>)}
              </select>
            </label>}
            {!documentShots && !scene && <button type="button" className={buttonClass} disabled={dirty || review.busy || !shot.id} onClick={() => review.bindShot(shot.id)}>Create Board scene from this draft shot</button>}
            {documentShots ? <div className="flex flex-wrap gap-2">
              {['startSec', 'endSec'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="text-sm">{key === 'startSec' ? 'Shot start (seconds)' : 'Shot end (seconds)'}<input id={fieldId(`${shotKey(shot)}-${key}`)} type="number" min="0" step="0.01" value={shot[key] ?? ''} onChange={e => setShot(shot, key, e.target.value === '' ? null : Number(e.target.value))} className={fieldClass} /></label>)}
              <p className="text-xs text-port-text-muted">Planning edits do not rewrite source code. Reauthor or reimport in Compose, then import its matching shot manifest before approval.</p>
            </div> : <p className="text-xs text-port-text-muted">{scene && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) ? `Shot window ${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)}. ` : ''}Review exact start/end in Board. Imported timings remain provisional.</p>}
            {['action', 'staging', 'camera', 'transition'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="block text-sm capitalize">{key}
              <textarea id={fieldId(`${shotKey(shot)}-${key}`)} rows={2} value={shot[key]} placeholder={({ action: 'At a beat or word: subject and prop action; pose, travel and energy change.', staging: 'Depth, blocking, prop trajectory and typography placement through the shot.', camera: 'Timed camera path, framing changes and motivated holds.', transition: 'Exact entry/exit anchor, visual handoff and escalation into the next section.' })[key]} onChange={e => setShot(shot, key, e.target.value)} className={fieldClass} />
            </label>)}
            <fieldset><legend className="text-sm">Lyric anchors</legend>
              {(project.lyricCues || []).filter(c => c.startSec < scene?.endSec && c.endSec > scene?.startSec).map(cue =>
                <label key={cue.id} htmlFor={fieldId(`${shotKey(shot)}-${cue.id}`)} className="flex gap-2 py-2 text-sm"><input id={fieldId(`${shotKey(shot)}-${cue.id}`)} type="checkbox" checked={shot.lyricCueIds.includes(cue.id)}
                  onChange={e => setShot(shot, 'lyricCueIds', e.target.checked ? [...shot.lyricCueIds, cue.id] : shot.lyricCueIds.filter(id => id !== cue.id))} />{cue.text}</label>)}
            </fieldset>
          </details>;
        })}
        <button type="button" className={buttonClass} disabled={!dirty || review.busy} onClick={async () => { if (await review.save(draft)) setLocal(null); }}>Save planning edits</button>
        {dirty && <p role="status" className="text-sm">Save edits before preparing, approving or rendering.</p>}
      </div>
    </details>
    <details open={ready?.storyboard.approved && !ready?.proof.approved}>
      <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Animated chorus proof</summary>
      <p className="text-sm">Author the approved storyboard in Compose, then render a 10–45 second chorus with its entry and exit. Watch with sound at normal speed and compare the chosen energy target and timed choreography below against the actual subject, props, camera, typography and transitions. Check accents against beat and lyric anchors, readable holds and repeated-chorus escalation. A strong static frame does not prove the motion works.</p>
      <section aria-label="Saved choreography for proof comparison" className="rounded border border-port-border bg-port-bg p-3">
        <h4 className="text-sm font-medium">Saved energy target and timed choreography</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm">{saved.motionLanguage || 'Save an energy target and timed choreography in the planning editor before judging the proof.'}</p>
        <p className="mt-2 text-xs text-port-text-muted">Compare playback with this saved plan. If the chosen energy or actions are missing, record revision feedback with a time range before approving.</p>
      </section>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={fieldId('proof-start')} className="text-sm">Proof start (seconds)<input id={fieldId('proof-start')} type="number" min="0" step="0.01" value={startSec} onChange={e => setStartSec(Number(e.target.value))} className={fieldClass} /></label>
        <label htmlFor={fieldId('proof-end')} className="text-sm">Proof end (seconds)<input id={fieldId('proof-end')} type="number" min="0" step="0.01" value={endSec} onChange={e => setEndSec(Number(e.target.value))} className={fieldClass} /></label>
        <button type="button" className={buttonClass} disabled={blocked || review.proof.active} onClick={() => review.renderProof({ startSec, endSec, kind: 'prototype' })}>Render feasibility prototype — unapproved</button>
        <button type="button" className={buttonClass} disabled={blocked || !ready?.storyboard.approved || review.proof.active} onClick={() => review.renderProof({ startSec, endSec })}>Render animated proof</button>
      </div>
      {review.proof.active && <p role="status">Rendering proof…</p>}
      <p className="text-xs text-port-text-muted">A feasibility prototype uses the current authored composition and master audio without approving the look or authorizing production. It can be made before art approval; it never becomes approved proof automatically.</p>
      {prototype?.status === 'complete' && prototype.filename && <figure><video controls className="mt-2 w-full rounded" aria-label="Unapproved feasibility prototype" src={`/data/videos/${encodeURIComponent(prototype.filename)}`} /><figcaption className="text-sm">Unapproved feasibility prototype — separate from production proof</figcaption></figure>}
      {excerpt?.status === 'complete'  && excerpt.filename && <video controls className="mt-2 w-full rounded" aria-label="Animated proof with master audio" src={`/data/videos/${encodeURIComponent(excerpt.filename)}`} />}
      {matchingRecordedReview && <section aria-label="Recorded proof review" className="rounded border border-port-border p-3">
        <h4 className="text-sm font-medium">Recorded proof review</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm">{matchingRecordedReview.energyComparison}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{matchingRecordedReview.timecodedNotes}</p>
      </section>}
      <label htmlFor={fieldId('energy-comparison')} className="block text-sm">Playback energy compared with the saved plan
        <textarea id={fieldId('energy-comparison')} rows={3} maxLength={4000} disabled={playbackBlocked} value={playback.energyComparison} onChange={e => setPlayback({ energyComparison: e.target.value })} className={fieldClass}
          placeholder="Chosen energy target; observed subject, prop and camera activity; where playback matches or misses the intended arc." />
      </label>
      <label htmlFor={fieldId('playback-notes')} className="block text-sm">Timecoded playback notes
        <textarea id={fieldId('playback-notes')} rows={3} maxLength={4000} disabled={playbackBlocked} value={playback.timecodedNotes} onChange={e => setPlayback({ timecodedNotes: e.target.value })} className={fieldClass}
          placeholder="0:04 — subject turns on the downbeat; prop opens through 0:06; camera and type clear the lyric. Name any mismatch to revise." />
      </label>
      <p className="text-xs text-port-text-muted">Include at least one playback timestamp such as 0:04 or 4.5s. These notes are saved with this exact proof. A replacement proof requires a new comparison and acknowledgement.</p>
      <label htmlFor={fieldId('watched')} className="flex gap-2 py-2 text-sm"><input id={fieldId('watched')} type="checkbox" checked={playback.watched}
        disabled={playbackBlocked} onChange={e => setPlayback({ watched: e.target.checked })} />I watched this revision with audio at normal speed and compared its energy, timed choreography and lyric timing with the saved plan.</label>
    </details>
  </section>;
}
