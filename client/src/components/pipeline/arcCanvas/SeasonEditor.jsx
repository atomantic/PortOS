import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { updatePipelineSeason } from '../../../services/api';

export default function SeasonEditor({ series, season, seasons, onSeriesUpdate, seasonLocked = false }) {
  const [draft, setDraft] = useState(season);
  const [saving, setSaving] = useState(false);
  // Content fields (title/number/logline/synopsis/endingHook/episodeCountTarget)
  // are frozen when the season is locked — status stays editable since
  // production workflow can advance independently of editorial freeze.
  // Server's `LOCKED_SEASON_ALLOWED_KEYS` mirrors this contract.
  const contentDisabled = seasonLocked;

  const save = async () => {
    setSaving(true);
    const patch = seasonLocked
      ? { status: draft.status }
      : {
        title: draft.title,
        number: Number(draft.number) || season.number,
        logline: draft.logline,
        synopsis: draft.synopsis,
        endingHook: draft.endingHook,
        episodeCountTarget: Number(draft.episodeCountTarget) || 0,
        status: draft.status,
      };
    const updated = await updatePipelineSeason(series.id, season.id, patch, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    setSaving(false);
    if (!updated) return;
    onSeriesUpdate({
      ...series,
      seasons: seasons.map((s) => s.id === season.id ? updated : s).sort((a, b) => (a.number || 0) - (b.number || 0)),
    });
    toast.success('Volume / season saved');
  };

  const contentInputClass = `px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm ${contentDisabled ? 'opacity-60' : ''}`;

  return (
    <div className="px-3 pb-3 space-y-2 bg-port-bg/40 border-t border-port-border">
      <div className="grid grid-cols-[1fr_auto] gap-2 pt-2">
        <input
          value={draft.title || ''}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          disabled={contentDisabled}
          placeholder="Title"
          className={contentInputClass}
          maxLength={200}
        />
        <input
          type="number"
          value={draft.number || 0}
          onChange={(e) => setDraft({ ...draft, number: parseInt(e.target.value, 10) || 0 })}
          disabled={contentDisabled}
          placeholder="#"
          className={`w-16 ${contentInputClass}`}
          min={0}
          max={99}
        />
      </div>
      <input
        value={draft.logline || ''}
        onChange={(e) => setDraft({ ...draft, logline: e.target.value })}
        disabled={contentDisabled}
        placeholder="One-sentence logline"
        className={`w-full ${contentInputClass}`}
        maxLength={500}
      />
      <textarea
        value={draft.synopsis || ''}
        onChange={(e) => setDraft({ ...draft, synopsis: e.target.value })}
        disabled={contentDisabled}
        placeholder="Season synopsis (~200 words)"
        rows={4}
        className={`w-full ${contentInputClass}`}
        maxLength={4000}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          value={draft.endingHook || ''}
          onChange={(e) => setDraft({ ...draft, endingHook: e.target.value })}
          disabled={contentDisabled}
          placeholder="Ending hook"
          className={contentInputClass}
          maxLength={1000}
        />
        <input
          type="number"
          value={draft.episodeCountTarget || 0}
          onChange={(e) => setDraft({ ...draft, episodeCountTarget: parseInt(e.target.value, 10) || 0 })}
          disabled={contentDisabled}
          placeholder="Issue / episode target"
          title="Issue / episode count target for this volume / season"
          className={contentInputClass}
          min={0}
        />
      </div>
      <div className="flex items-center gap-2">
        <select
          value={draft.status || 'draft'}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        >
          <option value="draft">draft</option>
          <option value="verified">verified</option>
          <option value="in-production">in-production</option>
          <option value="complete">complete</option>
        </select>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}
