import { estimatedShotSeconds } from '../../../../server/lib/fableLoomShots.js';
import { FormField } from '../ui/FormField.jsx';
import { fieldClass, labelClass, sceneFieldClass } from './fieldStyles';
import { isTeleplayFormat } from './loomFormats';
import { FABLELOOM_PLAYBACK_MODES, FABLELOOM_PROTAGONIST_PRESENCE } from '../../../../server/lib/fableLoomPlayback.js';
import { FABLELOOM_AUDIENCE_CONNECTION_STATES } from '../../../../server/lib/fableLoomParticipation.js';

export default function NodeMetadataFields({
  loom, form, setForm, patchNode, saveField, helperMode, audienceConnected,
  recommendedPresence, scenePresence, presenceControlVisible, setScenePresence,
}) {
  // A teleplay carries its own line breaks, so the editor gives it a taller
  // monospaced field — the same surface prose gets, sized for the format.
  const teleplay = isTeleplayFormat(loom.format);
  return (
    <>
      <FormField label="Title" labelClassName={labelClass}>
        <input
          className={fieldClass}
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          onBlur={() => saveField('title', form.title)}
        />
      </FormField>

      {form.shot ? <div className="rounded border border-port-border p-3 space-y-2">
        <p className="text-xs text-port-text-muted">Dramatic scene: {form.shot.dramaticSceneTitle}</p>
        <label htmlFor="loom-shot-seconds" className="block text-xs">Shot duration (seconds)</label>
        <input id="loom-shot-seconds" type="number" min={5} max={10} step={1} className={fieldClass} value={form.shot.durationSeconds} onChange={(event) => setForm((current) => ({ ...current, shot: { ...current.shot, durationSeconds: Number(event.target.value) } }))} onBlur={() => saveField('shot', form.shot)} />
        <p className="text-xs">{form.shot.framing}</p>
        <p className={`text-xs ${estimatedShotSeconds(form.prose) > form.shot.durationSeconds ? 'text-port-error' : 'text-port-text-muted'}`}>Estimated dialogue + pause: {estimatedShotSeconds(form.prose)}s. {estimatedShotSeconds(form.prose) > form.shot.durationSeconds ? 'Split or shorten before rendering.' : 'Timing estimate; validate the final voice delivery.'}</p>
      </div> : null}

      <FormField label={teleplay ? 'Scene (teleplay)' : 'Scene prose'} labelClassName={labelClass}>
        <textarea
          rows={teleplay ? 12 : 7}
          className={sceneFieldClass(loom.format)}
          value={form.prose}
          onChange={(e) => setForm((p) => ({ ...p, prose: e.target.value }))}
          onBlur={() => saveField('prose', form.prose)}
        />
      </FormField>

      <FormField label="Playback behavior" labelClassName={labelClass}>
        <select
          className={fieldClass}
          aria-label="Playback behavior"
          value={form.playbackMode}
          onChange={(e) => {
            setForm((p) => ({ ...p, playbackMode: e.target.value }));
            patchNode({ playbackMode: e.target.value });
          }}
        >
          {FABLELOOM_PLAYBACK_MODES.map((mode) => (
            <option key={mode} value={mode} disabled={helperMode && !audienceConnected && mode === 'decision'}>
              {mode === 'cut' ? 'Automatic cut — play once, then advance' : 'Decision point — loop while awaiting input'}
            </option>
          ))}
        </select>
      </FormField>

      {helperMode && (
        <FormField label="Audience connection" labelClassName={labelClass}>
          <select
            className={fieldClass}
            aria-label="Audience connection"
            value={form.audienceConnection}
            onChange={(event) => {
              const audienceConnection = event.target.value;
              const nextPlaybackMode = audienceConnection === 'disconnected' ? 'cut' : form.playbackMode;
              setForm((current) => ({
                ...current,
                audienceConnection,
                playbackMode: nextPlaybackMode,
              }));
              patchNode({ audienceConnection, playbackMode: nextPlaybackMode });
            }}
          >
            {FABLELOOM_AUDIENCE_CONNECTION_STATES.map((state) => (
              <option key={state} value={state}>
                {state === 'connected' ? 'Connected — audience can help' : 'Disconnected — passive canon only'}
              </option>
            ))}
          </select>
          <p className="text-xs text-port-text-muted mt-1">
            {form.audienceConnection === 'connected'
              ? `The protagonist can hear the audience through ${loom.audienceCommunicationMedium || 'the configured medium'}.`
              : 'The audience watches but cannot choose until the communication medium is activated or restored.'}
          </p>
        </FormField>
      )}

      {presenceControlVisible && (
        <div className="rounded border border-port-accent/30 bg-port-accent/5 p-3 space-y-2">
          <FormField label="Visual protagonist presence" labelClassName={labelClass}>
            <select
              className={fieldClass}
              aria-label="Visual protagonist presence"
              value={form.protagonistPresence || ''}
              onChange={(event) => setScenePresence(event.target.value)}
            >
              <option value="">
                Inherit story default{recommendedPresence ? ` (${recommendedPresence === 'offscreen' ? 'off-screen' : 'on-screen'})` : ''}
              </option>
              {FABLELOOM_PROTAGONIST_PRESENCE.map((presence) => (
                <option key={presence} value={presence}>
                  {presence === 'offscreen' ? 'Off-screen — omit protagonist from storyboard' : 'On-screen — include protagonist in storyboard'}
                </option>
              ))}
            </select>
          </FormField>
          {scenePresence === 'offscreen' ? (
            <p className="text-[11px] text-port-accent">
              Side-device conversation: the decision loop stays visible while the protagonist speaks directly with the audience. The protagonist is removed from this scene&apos;s visual cast.
            </p>
          ) : (
            <p className="text-[11px] text-port-text-muted">
              On-screen scenes inherit the loom&apos;s canonical protagonist and locked wardrobe when the shot is bound to Universe canon.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-ending">
          <input
            id="loom-node-ending"
            type="checkbox"
            checked={form.isEnding}
            onChange={(e) => {
              setForm((p) => ({ ...p, isEnding: e.target.checked }));
              patchNode({ isEnding: e.target.checked });
            }}
          />
          This scene is an ending
        </label>
      </div>
      {form.isEnding && (
        <FormField label="Ending name" labelClassName={labelClass}>
          <input
            className={fieldClass}
            placeholder="e.g. Treasure found"
            value={form.endingLabel}
            onChange={(e) => setForm((p) => ({ ...p, endingLabel: e.target.value }))}
            onBlur={() => saveField('endingLabel', form.endingLabel)}
          />
        </FormField>
      )}
    </>
  );
}
