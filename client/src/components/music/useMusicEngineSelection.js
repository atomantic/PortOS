/**
 * Engine list + engine/model selection for MusicGenPanel: loading, the
 * "first ready engine" default, remix seeding and keeping the model valid for
 * the engine. Seeds the panel's duration/instrumental state via callbacks.
 */

import { useEffect, useMemo, useState } from 'react';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';
import { listMusicEngines, removeAudioModel } from '../../services/apiMusic.js';
import { resolveEngineModel } from './musicEngineModels.js';

export default function useMusicEngineSelection({ remix, setDurationSec, setDurationMode, setInstrumentalOnly }) {
  const [engines, setEngines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [engineId, setEngineId] = useState('');
  const [modelId, setModelId] = useState('');
  const mountedRef = useMounted();

  // Returns the freshly-fetched list as well as storing it: the post-runtime
  // chain below needs the NEW engine record, and reading `engine` off state
  // right after setEngines() would still see the pre-install one.
  const loadEngines = async () => {
    const data = await listMusicEngines({ silent: true }).catch(() => null);
    if (!mountedRef.current) return [];
    const list = Array.isArray(data?.engines) ? data.engines : [];
    setEngines(list);
    setLoading(false);
    // Default to the first READY engine, else the server default, else the first.
    if (!engineId && list.length) {
      const ready = list.find((e) => e.ready);
      const pick = ready || list.find((e) => e.id === data.defaultEngine) || list[0];
      setEngineId(pick.id);
    }
    return list;
  };

  useEffect(() => { loadEngines(); }, []);

  const engine = useMemo(() => engines.find((e) => e.id === engineId) || null, [engines, engineId]);
  // A native <select> displays its first option while React is applying the
  // engine's default id. Use that effective option for readiness and generation
  // too, so the first paint cannot briefly disable an otherwise ready engine.
  const selectedModelId = resolveEngineModel(engine, modelId)?.id || modelId;

  // Remix: seed the engine / model / duration from a past render. Keyed on
  // `remix.nonce` (bumped per Remix click) so re-clicking the SAME render
  // re-applies even when its values are unchanged. An uploaded render carries no
  // engineId — skip the engine swap then and just keep the user's current
  // selection (the parent still prefills the prompt/lyrics form fields). Setting
  // engineId + modelId together lets the engine-validity effect below keep the
  // seeded model (it's in the engine's list because the engine produced it).
  useEffect(() => {
    if (!remix) return;
    if (remix.engineId) setEngineId(remix.engineId);
    if (remix.modelId) setModelId(remix.modelId);
    // Legacy/uploaded renders have no explicit mode. Do not infer vocal intent
    // from an empty lyric snapshot; start those remixes vocal-capable.
    setInstrumentalOnly(remix.instrumentalOnly === true);
    if (remix.durationSec != null) {
      setDurationSec(remix.durationSec);
      // Remix means "recreate this take"; preserve its exact manual ceiling.
      setDurationMode('manual');
    }
  }, [remix?.nonce]);

  // Keep the model selection valid for the current engine: reset to the engine
  // default ONLY when the selected model isn't in this engine's list. Keying on
  // engine.id (not the object) + this guard means a list refresh after installing
  // a model (which replaces the engines array but keeps the same engine id) does
  // NOT clobber a freshly-selected model — it stays selected because it's now in
  // the list. Switching to a different engine still resets (the old model isn't
  // in the new engine's list). Duration seeds once.
  // Functional updater, not a read of `modelId`: this effect is keyed on the
  // ENGINE, so the `modelId` its closure captured is whatever the render that
  // queued it saw. React drains passive effects on its own scheduler task, so a
  // pick made after that commit but before the drain would be read as absent
  // and silently reset to the engine default — reverting a selection the user
  // had already made and quietly re-enabling every gate hanging off it. Reading
  // the value at flush time cannot go stale. (#4348 / PR #4819 CI failure.)
  useEffect(() => {
    if (!engine) return;
    const ids = (engine.models || []).map((m) => m.id);
    setModelId((current) => (ids.includes(current) ? current : (engine.defaultModelId || ids[0] || '')));
    setDurationSec((d) => (d == null ? engine.defaultDurationSec : d));
  }, [engine?.id, engine?.models]);

  const handleRemoveModel = async (id) => {
    if (!engine) return;
    await removeAudioModel(engine.id, id, { silent: true }).catch((err) => { toast.error(err.message || 'Remove failed'); return null; });
    await loadEngines();
    if (modelId === id) setModelId(engine.defaultModelId || '');
  };

  return { engines, loading, engineId, setEngineId, modelId, setModelId, engine, selectedModelId, loadEngines, handleRemoveModel };
}
