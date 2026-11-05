import { useEffect, useState } from 'react';
import { Download, Loader2, Search, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  getCatalogPhotorealTextures, installCatalogPhotorealTexture, saveCatalogPhotorealLook, searchCatalogPhotorealTextures,
} from '../../services/apiCatalog';

// Mirrors PHOTOREAL_TEXTURED_PRESETS on the server: glass, mirror, chrome and neon stay procedural.
const TEXTURED = ['wood-floor', 'painted-wall', 'painted-metal', 'carpet', 'tile', 'concrete', 'plastic', 'vinyl', 'fabric'];
const smallButton = 'min-h-[36px] inline-flex items-center gap-1 rounded-lg border border-port-border px-2.5 text-xs text-gray-200 hover:border-port-accent/60 disabled:opacity-40';

/**
 * Per-preset CC0 photo textures for the saved look. Poly Haven is searched when
 * the picker opens and a texture downloads only when tapped; the pick is saved
 * on the look, so it is a revision like any other look change.
 */
export default function PhotorealTexturesSection({ record, look, readOnly = false, disabled = false, onBusyChange, onSaved }) {
  const presets = [...new Set(look.materials.map((m) => m.preset))].filter((p) => TEXTURED.includes(p));
  const chosen = look.textures || {};
  const [installed, setInstalled] = useState([]);
  const [picking, setPicking] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let live = true;
    getCatalogPhotorealTextures({ silent: true })
      .then((res) => { if (live) setInstalled(res.installed || []); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!picking) return undefined;
    let live = true;
    setResults(null);
    setSearchError('');
    const timer = setTimeout(() => {
      searchCatalogPhotorealTextures(picking, query.trim(), { silent: true })
        .then((res) => { if (live) setResults(res.results || []); })
        .catch((err) => { if (live) { setResults([]); setSearchError(err?.message || 'Poly Haven could not be reached'); } });
    }, query ? 400 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [picking, query]);

  if (!presets.length) return null;
  const named = (id) => installed.find((t) => t.id === id);

  const save = async (textures) => {
    const updated = await saveCatalogPhotorealLook(record.id, { ...look, textures }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to save the texture'); return null; });
    if (updated) onSaved?.(updated);
    return updated;
  };

  const choose = async (preset, texture) => {
    if (busyId) return;
    setBusyId(texture.id);
    onBusyChange?.(true);
    const done = await installCatalogPhotorealTexture(texture.id, { silent: true })
      .catch((err) => { toast.error(err?.message || 'The texture did not download'); return null; });
    if (done) {
      setInstalled((list) => [done, ...list.filter((t) => t.id !== done.id)]);
      if (await save({ ...chosen, [preset]: done.id })) {
        setPicking('');
        toast.success(`${done.name} on ${preset}; render to see it`);
      }
    }
    setBusyId('');
    onBusyChange?.(false);
  };

  // Every texture save goes through busyId, so a second click can't save a stale snapshot.
  const procedural = async (preset) => {
    if (busyId) return;
    const { [preset]: _dropped, ...rest } = chosen;
    setBusyId(`procedural:${preset}`);
    onBusyChange?.(true);
    await save(rest);
    setBusyId('');
    onBusyChange?.(false);
  };

  return (
    <div className="space-y-2" aria-label="Photo textures">
      <p className="text-xs text-gray-400">Photo textures (CC0, Poly Haven). Without one, a material uses PortOS&apos;s procedural surface.</p>
      <ul className="space-y-1.5">
        {presets.map((preset) => {
          const id = chosen[preset];
          const texture = id ? named(id) : null;
          return (
            <li key={preset} className="flex flex-wrap items-center gap-2 text-xs">
              {texture?.thumbnail
                ? <img src={texture.thumbnail} alt="" className="h-8 w-8 rounded object-cover" />
                : <span className="h-8 w-8 rounded border border-port-border" aria-hidden="true" />}
              <span className="min-w-0 flex-1 text-gray-300">
                <span className="text-white">{preset}</span>: {id ? (texture?.name || `${id} (not downloaded here)`) : 'procedural'}
              </span>
              {!readOnly && (
                <>
                  <button type="button" className={smallButton} disabled={disabled || !!busyId} onClick={() => { setQuery(''); setPicking(preset); }}>
                    <Search size={12} aria-hidden="true" /> {id ? 'Change' : 'Choose photo'}
                  </button>
                  {id && <button type="button" className={smallButton} disabled={disabled || !!busyId} onClick={() => procedural(preset)}>Procedural</button>}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {picking && (
        <div className="rounded-lg border border-port-border p-2 space-y-2" role="dialog" aria-label={`Photo textures for ${picking}`}>
          <div className="flex items-center gap-2">
            <label htmlFor="photoreal-texture-search" className="sr-only">Search textures</label>
            <input id="photoreal-texture-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${picking} textures`}
              className="min-h-[36px] min-w-0 flex-1 rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
            <button type="button" className={`${smallButton} min-h-[44px] min-w-[44px] justify-center`} onClick={() => setPicking('')} aria-label="Close">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {searchError && <p role="alert" className="text-xs text-port-warning">{searchError}</p>}
          {results === null
            ? <p className="text-xs text-gray-400 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Searching Poly Haven…</p>
            : results.length === 0 && !searchError
              ? <p className="text-xs text-gray-400">No textures match.</p>
              : (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {results.map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => choose(picking, t)} disabled={disabled || !!busyId}
                        className="w-full space-y-1 rounded-lg border border-port-border p-1 text-left text-[11px] text-gray-300 hover:border-port-accent/60 disabled:opacity-40">
                        <img src={t.thumbnail} alt="" loading="lazy" className="aspect-square w-full rounded object-cover" />
                        <span className="flex items-center gap-1">
                          {busyId === t.id ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : !t.installed && <Download size={11} aria-hidden="true" />}
                          <span className="truncate">{t.name}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          <p className="text-[11px] text-gray-500">Tapping a texture downloads its 2K maps (a few MB) once and saves the pick on this look.</p>
        </div>
      )}
    </div>
  );
}
