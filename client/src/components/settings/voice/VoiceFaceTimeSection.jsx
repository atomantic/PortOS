import { useState } from 'react';
import { Link } from 'react-router';
import { getFaceTimeStatus, controlFaceTime } from '../../../services/apiVoice';
import FormField from '../../ui/FormField';

const trimmed = (v) => (v || '').trim();

export default function VoiceFaceTimeSection({ facetime, savedFacetime, saving, patch, inputCls }) {
  const [facetimeStatus, setFacetimeStatus] = useState(null);
  const [facetimeAction, setFacetimeAction] = useState(null);
  const [facetimeResult, setFacetimeResult] = useState(null);

  const faceTimeDirty = !trimmed(savedFacetime?.targetHandle) || !trimmed(savedFacetime?.targetName)
    || trimmed(facetime.targetHandle) !== trimmed(savedFacetime.targetHandle)
    || trimmed(facetime.targetName) !== trimmed(savedFacetime.targetName);

  const refreshFaceTime = () => getFaceTimeStatus({ silent: true })
    .then(setFacetimeStatus)
    .catch(() => setFacetimeStatus(null));

  const handleFaceTimeAction = async (action) => {
    setFacetimeAction(action);
    try {
      setFacetimeResult(await controlFaceTime(action, { silent: true }));
    } catch (err) {
      setFacetimeResult({ ok: false, message: err.message });
    } finally {
      setFacetimeAction(null);
      refreshFaceTime();
    }
  };

  return (
    <section className="border border-port-border rounded-lg p-4 space-y-3">
      <h3 className="text-base font-semibold text-white">FaceTime Audio</h3>
      <p className="text-xs text-gray-500">Machine-local macOS call control. Save your identity before testing; it is not shared with peers.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FormField label="Target name"><input id="facetime-target-name" value={facetime.targetName || ''} onChange={(e) => patch('facetime.targetName', e.target.value)} className={inputCls} /></FormField>
        <FormField label="Target handle" hint="E.164 phone number or email address."><input id="facetime-target-handle" value={facetime.targetHandle || ''} onChange={(e) => patch('facetime.targetHandle', e.target.value)} className={inputCls} /></FormField>
        <FormField label="Maximum call length" hint="Minutes before PortOS hangs up on its own."><input id="facetime-max-call-minutes" type="number" min="1" max="120" value={facetime.maxCallMinutes ?? 15} onChange={(e) => patch('facetime.maxCallMinutes', Number(e.target.value))} className={inputCls} /></FormField>
      </div>
      {/* Two-way audio needs a real browser tab on this Mac: device
          permissions and setSinkId do not work from the server. */}
      <p className="text-xs text-gray-400">
        Call audio runs in its own tab — <Link to="/voice/call-host" className="text-port-accent underline">open the call host</Link> on this Mac and attach it before placing a call. Without it, PortOS can dial but nobody can hear the call.
      </p>
      <div className="flex flex-wrap gap-2">
        {['probe', 'call', 'hangup'].map((action) => <button key={action} type="button" onClick={() => handleFaceTimeAction(action)} disabled={saving || faceTimeDirty || facetimeAction !== null} className="px-3 py-2 rounded bg-port-border text-sm text-white disabled:opacity-50">{facetimeAction === action ? 'Working…' : action === 'call' ? 'Test call' : action[0].toUpperCase() + action.slice(1)}</button>)}
        <button type="button" onClick={refreshFaceTime} className="px-3 py-2 rounded bg-port-bg border border-port-border text-sm text-white">Check setup</button>
      </div>
      <div className="border-t border-port-border pt-3 space-y-2">
        <h4 className="text-sm font-semibold text-white">Answer my calls</h4>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            id="facetime-auto-answer"
            type="checkbox"
            checked={facetime.autoAnswer === true}
            onChange={(e) => patch('facetime.autoAnswer', e.target.checked)}
            disabled={faceTimeDirty}
            className="w-4 h-4 mt-0.5 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <span className="text-sm text-white">Automatically answer incoming calls</span>
            <p className="text-xs text-gray-500">
              Only calls from your own configured handle are ever answered — every other caller is left ringing. Needs the <Link to="/voice/call-host" className="text-port-accent underline">call host</Link> tab open on this Mac; without it, an authorized call rings unanswered and a notification tells you why.
            </p>
          </div>
        </label>
      </div>

      <div className="border-t border-port-border pt-3 space-y-2">
        <h4 className="text-sm font-semibold text-white">Call me when it matters</h4>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            id="facetime-escalate-critical"
            type="checkbox"
            checked={facetime.escalateCritical === true}
            onChange={(e) => patch('facetime.escalateCritical', e.target.checked)}
            className="w-4 h-4 mt-0.5 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <span className="text-sm text-white">Escalate unread critical notifications to a call</span>
            <p className="text-xs text-gray-500">Only when the notification is still unread after the delay below and no browser tab can speak it.</p>
          </div>
        </label>
        <FormField label="Escalate after" hint="Minutes a critical notification may stay unread first.">
          <input id="facetime-escalate-after-minutes" type="number" min="1" max="1440" value={facetime.escalateAfterMinutes ?? 10} onChange={(e) => patch('facetime.escalateAfterMinutes', Number(e.target.value))} className={inputCls} />
        </FormField>
        <p className="text-xs text-gray-500">
          Escalations and Persistent Mind calls share one budget: at most 3 calls per rolling 24 hours, at least 30 minutes apart, never during voice quiet hours. The Persistent Mind can only place calls when its own <Link to="/cos/mind?panel=tools" className="text-port-accent underline">call grant</Link> is enabled.
        </p>
      </div>
      {faceTimeDirty && <p className="text-xs text-port-warning">Save both identity fields (and any changes to them) before FaceTime controls are available.</p>}
      {facetimeStatus && <ul className="text-xs text-gray-400">{Object.entries(facetimeStatus).map(([key, value]) => <li key={key}>{value.ok === 'ok' ? '✓' : '•'} {key}: {value.message}</li>)}</ul>}
      {facetimeResult && <pre className="text-xs text-gray-400 whitespace-pre-wrap break-all">{JSON.stringify(facetimeResult, null, 2)}</pre>}
    </section>
  );
}
