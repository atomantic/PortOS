import { useState } from 'react';
import { shotInheritsCameoStill, cameoStillFor } from '../../../../server/lib/musicVideoCameos.js';
import { linkMusicVideoCameoShots, setMusicVideoCameoStillFromShot, unlinkMusicVideoCameoShots } from '../../services/apiMusicVideo.js';
import toast from '../ui/Toast';

const FIELD = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-xs pointer-fine:sm:min-h-[32px] disabled:opacity-50';
const BUTTON = 'min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-xs hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-[32px]';

/**
 * Which roster cameo this shot shows (#14821). While the shot has no still of
 * its own it shows the cameo's chosen still (or the picked variant's), and a
 * new cameo still reaches it with no render. A shot with its own still can
 * hand that still to the cameo, the way a Refine of the cameo's still
 * becomes a variant every shot picking it shows.
 */
export default function SceneCameoLink({ project, scene, onApplyCameos, onEditLocal = null, onSave = null, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const roster = project?.cameos || [];
  if (!roster.length || !onApplyCameos) return null;
  const cameo = roster.find((s) => s.cameoId === scene.cameoId) || null;
  const variantId = cameo ? scene.cameoVariantId || null : null;
  const variant = variantId ? (cameo.variants || []).find((v) => v.variantId === variantId) : null;
  const id = (name) => `mv-scene-${scene.sceneId}-cameo-${name}`;
  const sorted = roster.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const run = (call, failure) => {
    setBusy(true);
    return call().then(onApplyCameos).catch((err) => toast.error(err?.message || failure)).finally(() => setBusy(false));
  };
  const link = (cameoId, nextVariant = null) => (cameoId
    ? run(() => linkMusicVideoCameoShots(project.id, cameoId, { sceneIds: [scene.sceneId], variantId: nextVariant }, { silent: true }), 'Failed to link the cameo')
    : run(() => unlinkMusicVideoCameoShots(project.id, [scene.sceneId], { silent: true }), 'Failed to unlink the cameo'));
  const inherits = shotInheritsCameoStill(scene);
  const still = cameoStillFor(cameo, variantId);
  const cameoName = cameo?.label || cameo?.name || '';
  const target = variant ? `${cameoName} · ${variant.label}` : cameoName;
  let status = null;
  if (cameo && inherits) status = still ? `Shows ${target}'s still.` : `${target} has no still yet. Choose one on Look, or render this shot.`;
  else if (cameo) status = 'This shot uses its own still.';

  return (
    <fieldset disabled={disabled || busy} className="min-w-0 space-y-1">
      <legend className="sr-only">Cameo this shot shows</legend>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-col">
          <label htmlFor={id('cameo')} className="text-[11px] text-port-text-muted">Cameo</label>
          <select id={id('cameo')} className={`${FIELD} max-w-full`} value={cameo?.cameoId || ''}
            onChange={(e) => link(e.target.value || null)}>
            <option value="">None</option>
            {sorted.map((s) => <option key={s.cameoId} value={s.cameoId}>{s.label && s.label !== s.name ? `${s.name} (${s.label})` : s.name}</option>)}
          </select>
        </div>
        {cameo && (cameo.variants || []).length > 0 && (
          <div className="flex min-w-0 flex-col">
            <label htmlFor={id('variant')} className="text-[11px] text-port-text-muted">Variant</label>
            <select id={id('variant')} className={`${FIELD} max-w-full`} value={variantId || ''}
              onChange={(e) => link(cameo.cameoId, e.target.value || null)}>
              <option value="">Main still</option>
              {cameo.variants.map((v) => <option key={v.variantId} value={v.variantId}>{v.label}{v.imageId ? '' : ' (no still yet)'}</option>)}
            </select>
          </div>
        )}
        {cameo && onSave && (
          <div className="flex min-w-0 flex-col">
            <label htmlFor={id('alias')} className="text-[11px] text-port-text-muted">Name on screen here</label>
            <input key={scene.cameoLabel || ''} id={id('alias')} defaultValue={scene.cameoLabel || ''} maxLength={120}
              placeholder={cameo.label || cameo.name} className={`${FIELD} w-40`}
              onBlur={(e) => {
                const cameoLabel = e.target.value.trim() || null;
                if (cameoLabel === (scene.cameoLabel || null)) return;
                onEditLocal?.(scene.sceneId, { cameoLabel });
                onSave(scene.sceneId, { cameoLabel });
              }} />
          </div>
        )}
        {cameo && !inherits && scene.referenceImageId && (
          <button type="button" className={BUTTON}
            onClick={() => run(() => setMusicVideoCameoStillFromShot(project.id, cameo.cameoId, { sceneId: scene.sceneId, variantId }, { silent: true }), 'Failed to use the still')}>
            Use this still for {target}
          </button>
        )}
      </div>
      {status && <p className="text-[11px] text-port-text-muted">{status}</p>}
    </fieldset>
  );
}
