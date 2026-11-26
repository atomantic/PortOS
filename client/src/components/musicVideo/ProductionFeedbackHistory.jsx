import { useImperativeHandle, useMemo, useRef, useState } from 'react';
import { reviewButtonClass as buttonClass, reviewFieldClass as fieldClass } from './controlClasses.js';

export default function ProductionFeedbackHistory({ ref, project, review, ready, stage, fieldId, blocked, openRequests }) {
  const inputRef = useRef(null);
  const [feedback, setFeedback] = useState({ target: '', text: '', decision: 'request-changes' });
  const [resolutions, setResolutions] = useState({});
  const [savedRequestStage, setSavedRequestStage] = useState(null);
  const items = project.productionReview?.feedback;
  const revisions = project.productionReview?.reviewedRevisions;
  const history = useMemo(() => (items || []).filter(item => item.stage === stage).map(item => ({
    item, draftJson: JSON.stringify(revisions?.[item.basis]?.draft, null, 2),
  })), [items, revisions, stage]);

  useImperativeHandle(ref, () => ({
    requestChanges() {
      setFeedback(current => ({ ...current, decision: 'request-changes' }));
      const input = inputRef.current;
      const fold = input.closest('details');
      fold.open = true;
      input.scrollIntoView({ block: 'center' });
      input.focus({ preventScroll: true });
    },
  }), []);

  const saveFeedback = async () => {
    if (await review.feedback({ ...feedback, stage })) {
      setFeedback(current => current === feedback ? { ...current, text: '' } : current);
      setSavedRequestStage(feedback.decision === 'request-changes' ? stage : null);
    }
  };

  return <details>
    <summary className="cursor-pointer min-h-[44px] py-2 text-sm">Review feedback and revision history</summary>
    <label htmlFor={fieldId('feedback-target')} className="block text-sm">Feedback target<input id={fieldId('feedback-target')} className={fieldClass} value={feedback.target} placeholder="Cast: operator; shot: chorus; frame: 12.5s" onChange={e => setFeedback({ ...feedback, target: e.target.value })} /></label>
    <label htmlFor={fieldId('feedback-text')} className="block text-sm">Requested change<textarea ref={inputRef} id={fieldId('feedback-text')} className={fieldClass} rows={3} value={feedback.text} onChange={e => setFeedback({ ...feedback, text: e.target.value })} /></label>
    <label htmlFor={fieldId('feedback-decision')} className="block text-sm">Review decision<select id={fieldId('feedback-decision')} className={fieldClass} value={feedback.decision} onChange={e => setFeedback({ ...feedback, decision: e.target.value })}>
      <option value="request-changes">Request changes — blocks affected approvals</option><option value="comment">Comment</option><option value="structure-accepted">Accept structure only — art remains unapproved</option>
    </select></label>
    <button type="button" className={buttonClass} disabled={blocked || !feedback.target.trim() || !feedback.text.trim()} onClick={saveFeedback}>Save revision feedback</button>
    {savedRequestStage === stage && openRequests.length > 0 && <p role="status" className="text-sm">
      Approval stays blocked until these are resolved. Revise from feedback or mark each one resolved from the Feedback row at the top of this step.
    </p>}
    <ul className="mt-3 space-y-3">{history.map(({ item, draftJson }) => <li key={item.id} className="rounded border border-port-border p-2">
      <p className="text-sm"><strong>{item.target}</strong> · {item.decision} · {item.resolvedAt ? 'Resolved' : 'Open'}</p>
      <p className="text-sm whitespace-pre-wrap">{item.text}</p>
      <p className="text-xs text-port-text-muted">Reviewed revision {item.basis.slice(0, 12)}{ready?.basis[item.stage] !== item.basis ? ' · content has changed since review' : ' · current revision'}</p>
      <details><summary className="cursor-pointer py-2 text-sm">Original reviewed content</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{draftJson}</pre></details>
      {item.resolvedAt ? (item.resolution ? <p className="text-sm">Resolution: {item.resolution}</p> : null) : <>
        <label htmlFor={fieldId(`resolution-${item.id}`)} className="block text-sm">How it was resolved (optional)<textarea id={fieldId(`resolution-${item.id}`)} className={fieldClass} value={resolutions[item.id] || ''} onChange={e => setResolutions({ ...resolutions, [item.id]: e.target.value })} /></label>
        <button type="button" className={buttonClass} disabled={blocked} onClick={async () => {
          await review.resolveFeedback(item.id, resolutions[item.id]?.trim() || '');
        }}>Mark resolved</button>
      </>}
    </li>)}</ul>
  </details>;
}
