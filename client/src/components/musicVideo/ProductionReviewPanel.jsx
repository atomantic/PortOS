import { useState } from 'react';

const EMPTY = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
const fieldClass = 'mt-1 w-full rounded border border-port-border bg-port-bg p-2 text-sm';
const buttonClass = 'min-h-[44px] rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const labels = { art: 'Art direction', storyboard: 'Lyric-timed storyboard', proof: 'Animated proof' };

/** Editable planning content and explicit operator decisions for every render mode. */
export default function ProductionReviewPanel({ project, review, onOpenArtifact }) {
  const fieldId = key => `mv-review-${project.id}-${key}`;
  const saved = project.productionReview?.draft || EMPTY;
  const [local, setLocal] = useState(null);
  const draft = local || saved;
  const dirty = !!local && JSON.stringify(local) !== JSON.stringify(saved);
  const [password, setPassword] = useState('');
  const [feedback, setFeedback] = useState({ stage: 'art', target: '', text: '', decision: 'request-changes' });
  const [resolutions, setResolutions] = useState({});
  const [importError, setImportError] = useState(null);
  const [watched, setWatched] = useState(null);
  const [startSec, setStartSec] = useState(project.productionReview?.proof?.startSec || 0);
  const [endSec, setEndSec] = useState(project.productionReview?.proof?.endSec || Math.min(20, project.audioAnalysis?.durationSec || 20));
  const ready = review.readiness;
  const set = (key, value) => setLocal({ ...draft, [key]: value });
  const shots = [...draft.storyboard, ...(project.scenes || []).filter(scene => !draft.storyboard.some(s => s.sceneId === scene.sceneId)).map(scene => ({
    id: scene.sceneId, sceneId: scene.sceneId, lyricCueIds: [], action: '', staging: '', camera: '', transition: '',
  }))];
  const shotKey = shot => shot.id || shot.sceneId;
  const setShot = (shot, key, value) => set('storyboard', shots.map(s => shotKey(s) === shotKey(shot) ? { ...s, [key]: value } : s));
  const blocked = dirty || review.busy || !ready;
  const prototype = project.excerpts?.find(e => e.id === project.productionReview?.prototype?.excerptId);
  const excerpt = project.excerpts?.find(e => e.id === project.productionReview?.proof?.excerptId);
  const approve = stage => { const secret = password; setPassword(''); return review.approve(stage, secret); };

  return <section id="mv-production-review" aria-label="Production review" className="rounded-lg border border-port-border bg-port-card p-3 space-y-3">
    <h3 className="font-medium">Production review</h3>
    <p className="text-sm text-port-text-muted">Every medium needs visual direction, a timed storyboard and a watched animated proof. Drafts and technical renders do not count as approval.</p>
    {review.error && <p role="alert" className="text-port-error">{review.error}</p>}
    <ol className="grid gap-2 sm:grid-cols-3">
      {Object.entries(labels).map(([key, label]) => <li key={key} className="rounded border border-port-border p-2">
        <strong className="text-sm">{label}</strong>
        <p role="status" className="text-xs">{ready?.[key].approved ? 'Approved for this revision' : 'Human review required'}</p>
        {(ready?.[key].problems || []).map(problem => <p key={problem} className="mt-1 text-xs text-port-text-muted">{problem}</p>)}
        <button type="button" className={`${buttonClass} mt-2`} onClick={() => approve(key)}
          disabled={blocked || !password || ready?.[key].approved || !!ready?.[key].problems.length
            || (key === 'proof' && watched !== ready?.basis.proof)}>
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
        <details><summary className="cursor-pointer py-2 text-sm">Original reviewed content</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(project.productionReview.reviewedRevisions?.[item.basis]?.draft, null, 2)}</pre></details>
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
        {importError && <p role="alert">{importError}</p>}
        {draft.sourceArtifactId && <button type="button" className={buttonClass} onClick={() => onOpenArtifact(draft.sourceArtifactId)}>Read preserved original planning draft</button>}
        <button type="button" className={buttonClass} disabled={dirty || review.busy} onClick={review.prepare}>Prepare planning draft with autopilot</button>
        <p className="text-xs text-port-text-muted">Uses the saved authoring provider and allowed tools. Builds Cast & Sets first, then pauses for art approval before planning shots. Existing edits are retained.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.entries({ cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board', motionLanguage: 'Motion language and choreography' }).map(([key, label]) =>
            <label key={key} htmlFor={fieldId(key)} className="text-sm">{label}<textarea id={fieldId(key)} rows={4} value={draft[key]} onChange={e => set(key, e.target.value)} className={fieldClass} /></label>)}
        </div>
        <label htmlFor={fieldId('implementation')} className="block text-sm">Implementation and feasibility for {project.composition?.mode || 'composed'} rendering
          <textarea id={fieldId('implementation')} rows={5} value={draft.implementationPlan || ''} onChange={e => set('implementationPlan', e.target.value)} className={fieldClass}
            placeholder="Scene graph and layers; vector/mesh construction; rig joints and pose limits; procedural materials; camera and transition mechanics; typography; frame rate, geometry and draw-call budgets." />
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
        {shots.map(shot => {
          const scene = project.scenes?.find(s => s.sceneId === shot.sceneId);
          return <details key={shotKey(shot)} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer min-h-[44px] text-sm">{scene?.label || shot.id || 'Unbound shot'} — {scene ? 'edit choreography' : 'bind to a Board scene'}</summary>
            <label htmlFor={fieldId(`scene-${shotKey(shot)}`)} className="block text-sm">Board scene
              <select id={fieldId(`scene-${shotKey(shot)}`)} value={shot.sceneId || ''} onChange={e => setShot(shot, 'sceneId', e.target.value || null)} className={fieldClass}>
                <option value="">Unbound draft — no scene selected</option>
                {(project.scenes || []).map(s => <option key={s.sceneId} value={s.sceneId}>{s.label || s.sceneId}</option>)}
              </select>
            </label>
            {!scene && <button type="button" className={buttonClass} disabled={dirty || review.busy || !shot.id} onClick={() => review.bindShot(shot.id)}>Create Board scene from this draft shot</button>}
            <p className="text-xs text-port-text-muted">Review exact start/end in Board. Imported timings remain provisional.</p>
            {['action', 'staging', 'camera', 'transition'].map(key => <label key={key} htmlFor={fieldId(`${shotKey(shot)}-${key}`)} className="block text-sm capitalize">{key}
              <textarea id={fieldId(`${shotKey(shot)}-${key}`)} rows={2} value={shot[key]} onChange={e => setShot(shot, key, e.target.value)} className={fieldClass} />
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
      <p className="text-sm">Author the approved storyboard in Compose, then render a 10–45 second chorus with its entry and exit. Watch with sound; check lyric timing, readable type, purposeful action, camera movement and transitions.</p>
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
      <label htmlFor={fieldId('watched')} className="flex gap-2 py-2 text-sm"><input id={fieldId('watched')} type="checkbox" checked={!!ready && watched === ready.basis.proof}
        disabled={!ready || !!ready.proof.problems.length} onChange={e => setWatched(e.target.checked ? ready.basis.proof : null)} />I watched this revision with audio and checked the approved visual direction, motion and lyric timing.</label>
    </details>
  </section>;
}
