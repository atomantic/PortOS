import { IDENTITY_ASSET_ROLES, IDENTITY_PACK_REQUIRED_ROLES } from '../../../../../server/lib/storyBibleRoles.js';
import { Plus, Trash2, Images } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../../lib/bibleLimits';
import { REL_SELECT_CLASS } from './editorClasses';
import BoxedSection from './BoxedSection';

export default function IdentityPackSection({ entry, onPatch, disabled }) {
  const pack = entry.identityPack || {};
  const assets = Array.isArray(pack.assets) ? pack.assets : [];
  const approved = assets.filter((asset) => asset?.approved === true);
  const counts = new Map();
  for (const asset of approved) counts.set(asset.role, (counts.get(asset.role) || 0) + 1);
  const missing = IDENTITY_PACK_REQUIRED_ROLES.filter((role) => !counts.get(role));
  const ambiguous = IDENTITY_PACK_REQUIRED_ROLES.filter((role) => (counts.get(role) || 0) > 1);
  const status = ambiguous.length ? 'ambiguous' : missing.length ? 'missing' : 'ready';
  const commit = (patch) => onPatch?.({ identityPack: { ...pack, ...patch } });
  const add = () => {
    const imageRef = entry.imageRefs?.[0];
    if (!imageRef) return;
    commit({ assets: [...assets, { imageRef, role: 'neutral', approved: false }] });
  };
  return (
    <BoxedSection icon={Images} label="Identity pack" summary={status}>
      <p className="text-[10px] leading-snug text-gray-500">
        Curate existing character references. Canon-locked production requires one approved neutral, profile, and full-body reference; duplicate approved roles are ambiguous.
      </p>
      {assets.length ? (
        <div className="space-y-1.5">
          {assets.map((asset, idx) => (
            <div key={`${asset.role}-${asset.imageRef}-${idx}`} className="flex items-center gap-1.5">
              <select
                value={asset.imageRef} disabled={disabled} aria-label={`identity asset ${idx + 1} image`}
                onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, imageRef: e.target.value, approved: false } : item) })}
                className={REL_SELECT_CLASS}
              >
                {(entry.imageRefs || []).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
              </select>
              <select
                value={asset.role} disabled={disabled} aria-label={`identity asset ${idx + 1} role`}
                onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, role: e.target.value, approved: false } : item) })}
                className="w-32 shrink-0 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
              >
                {IDENTITY_ASSET_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <label className="inline-flex items-center gap-1 text-[10px] text-gray-300 whitespace-nowrap">
                <input
                  type="checkbox" checked={asset.approved === true} disabled={disabled}
                  aria-label={`approve identity asset ${idx + 1} ${asset.role}`}
                  onChange={(e) => commit({ assets: assets.map((item, i) => i === idx ? { ...item, approved: e.target.checked } : item) })}
                /> Approve
              </label>
              <button
                type="button" disabled={disabled} onClick={() => commit({ assets: assets.filter((_, i) => i !== idx) })}
                title="Remove identity asset" aria-label={`remove identity asset ${idx + 1}`}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="text-[11px] text-gray-500 italic">No identity assets curated yet.</p>}
      {entry.imageRefs?.length ? (
        <button
          type="button" onClick={add} disabled={disabled || assets.length >= L.IDENTITY_PACK_ASSETS_MAX}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add reference
        </button>
      ) : <p className="text-[11px] text-gray-500 italic">Generate or attach a character reference before curating this pack.</p>}
      {status !== 'ready' ? <p className="text-[10px] text-port-warning">{ambiguous.length ? `Ambiguous: ${ambiguous.join(', ')}` : `Missing: ${missing.join(', ')}`}</p> : null}
    </BoxedSection>
  );
}
