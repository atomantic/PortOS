/**
 * Caption-model picker for the LoRA dataset workbench.
 *
 * Lists vision-capable installed local models (both Ollama + LM Studio, each
 * tagged with the provider that serves it) and lets the user pick which one
 * auto-captioning uses. The choice persists to `settings.loraTraining`
 * (captionProviderId/captionModel) so it sticks across runs and machines, and
 * is lifted to the parent via `onChange` so caption runs pass the explicit
 * provider+model. "Auto" defers to the server's vision-model auto-pick.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import { getVisionModels, getSettings, updateSettings } from '../../services/api';

const AUTO = '__auto__';
const keyFor = (m) => `${m.providerId}::${m.id}`;

export default function CaptionModelPicker({ onChange }) {
  const [models, setModels] = useState(null); // null = loading; [] = none installed
  const [value, setValue] = useState(AUTO);
  const [saving, setSaving] = useState(false);
  // Preserve the rest of settings.loraTraining (training `defaults`) on save —
  // updateSettings merges shallowly at the top level, so writing just the
  // caption fields would clobber the sibling slice.
  const loraTrainingRef = useRef({});

  useEffect(() => {
    let alive = true;
    Promise.all([
      getVisionModels({ silent: true }).catch(() => ({ models: [] })),
      getSettings({ silent: true }).catch(() => ({})),
    ]).then(([vm, settings]) => {
      if (!alive) return;
      const list = vm?.models || [];
      setModels(list);
      loraTrainingRef.current = settings?.loraTraining || {};
      const savedModel = settings?.loraTraining?.captionModel || null;
      const savedProvider = settings?.loraTraining?.captionProviderId || null;
      if (savedModel) {
        const match = list.find((m) => m.id === savedModel
          && (!savedProvider || m.providerId === savedProvider));
        const sel = match || { id: savedModel, providerId: savedProvider || 'lmstudio' };
        setValue(keyFor(sel));
        onChange?.({ providerId: sel.providerId, model: sel.id });
      } else {
        setValue(AUTO);
        onChange?.({ providerId: null, model: null });
      }
    });
    return () => { alive = false; };
    // onChange is a stable setter from the parent; intentionally run once.
  }, []);

  const handleChange = async (next) => {
    setValue(next);
    const picked = next === AUTO ? null : (models || []).find((m) => keyFor(m) === next) || null;
    onChange?.(picked ? { providerId: picked.providerId, model: picked.id } : { providerId: null, model: null });
    setSaving(true);
    const nextLoraTraining = {
      ...loraTrainingRef.current,
      captionProviderId: picked ? picked.providerId : null,
      captionModel: picked ? picked.id : null,
    };
    try {
      await updateSettings({ loraTraining: nextLoraTraining }, { silent: true });
      loraTrainingRef.current = nextLoraTraining;
    } catch {
      toast.error('Could not save caption-model preference');
    } finally {
      setSaving(false);
    }
  };

  if (models === null) {
    return (
      <span className="text-xs text-gray-500 flex items-center gap-1">
        <Loader2 className="w-3 h-3 animate-spin" /> vision models…
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor="lt-caption-model" className="text-xs text-gray-500">Caption model</label>
      <select
        id="lt-caption-model"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white max-w-[16rem] disabled:opacity-50"
      >
        <option value={AUTO}>Auto (first vision model)</option>
        {models.map((m) => (
          <option key={keyFor(m)} value={keyFor(m)}>{m.name} · {m.backend}</option>
        ))}
      </select>
      {saving && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
      {!models.length && (
        <span className="text-[11px] text-port-warning flex items-center gap-1" title="Install a vision model (e.g. Qwen2.5-VL, LLaVA) from Settings → Local LLM">
          <AlertTriangle className="w-3 h-3" /> none installed
        </span>
      )}
    </div>
  );
}
