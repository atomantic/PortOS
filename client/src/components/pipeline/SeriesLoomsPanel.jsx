/**
 * SeriesLoomsPanel — the "Branching narratives" card on a series detail page.
 *
 * FableLoom looms are their own record type (`fableloom_stories`), not a series
 * type: a scene graph has no linear stage chain, so the pipeline's issue/stage
 * semantics never applied to it. The integration is a soft ref (`loom.seriesId`)
 * surfaced here — the same posture `CatalogCastPanel` takes for catalog records.
 *
 * The create action mints the loom pre-linked to this series (and to the
 * series' universe, so the AI lanes inherit its canon) and lands in the editor.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Loader2, Plus, Waypoints } from 'lucide-react';
import Pill from '../ui/Pill';
import { FormField } from '../ui/FormField.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { timeAgo } from '../../utils/formatters';
import { createLoom, listLooms } from '../../services/api';
import { fieldClass, labelClass } from '../fableloom/fieldStyles';

// Mirrors LOOM_LIMITS.NAME_MAX (server/lib/fableLoomLimits.js) — the
// derived name is built from the series name, which has its own longer cap, so
// it has to be clamped before the create PATCH hits the door check.
const LOOM_NAME_MAX = 200;

const NEW_LOOM_SUFFIX = ' — branching narrative';

export const deriveLoomName = (seriesName) => {
  const base = String(seriesName || '').trim() || 'Untitled series';
  return `${base}${NEW_LOOM_SUFFIX}`.slice(0, LOOM_NAME_MAX);
};

const countLabel = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export default function SeriesLoomsPanel({ series }) {
  const navigate = useNavigate();
  const seriesId = series?.id;
  const [looms, setLooms] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [participationMode, setParticipationMode] = useState('helper');
  const [communicationMedium, setCommunicationMedium] = useState('');

  useEffect(() => {
    if (!seriesId) return undefined;
    let canceled = false;
    setLooms(null);
    listLooms({ seriesId, silent: true })
      .then((rows) => { if (!canceled) setLooms(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!canceled) setLooms([]); });
    return () => { canceled = true; };
  }, [seriesId]);

  const [runCreate, creating] = useAsyncAction(async () => {
    const loom = await createLoom({
      name: deriveLoomName(series?.name),
      logline: series?.logline || '',
      participationMode,
      audienceCommunicationMedium: participationMode === 'helper' ? communicationMedium.trim() : '',
      universeId: series?.universeId || null,
      seriesId,
    }, { silent: true });
    navigate(`/fableloom/${loom.id}`);
  }, { errorMessage: 'Could not create the branching narrative' });

  if (!seriesId) return null;

  return (
    <section className="rounded-lg border border-port-border bg-port-card/40 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <Waypoints size={13} className="text-port-accent" aria-hidden="true" />
            Branching narratives
          </h3>
          <p className="text-[11px] text-gray-600">
            FableLoom looms linked to this series — scene graphs readers play through, alongside the linear episodes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((shown) => !shown)}
          disabled={creating}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25 disabled:opacity-50"
        >
          {creating
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : <Plus size={12} aria-hidden="true" />}
          New branching narrative
        </button>
      </div>

      {showCreate && (
        <div className="rounded border border-port-border bg-port-card p-3 space-y-3">
          <div className="grid gap-3 @md:grid-cols-2">
            <FormField label="Audience role" labelClassName={labelClass}>
              <select
                className={fieldClass}
                value={participationMode}
                onChange={(event) => setParticipationMode(event.target.value)}
                disabled={creating}
              >
                <option value="helper">Audience helps the protagonist</option>
                <option value="protagonist">Audience acts as the protagonist</option>
              </select>
            </FormField>
            {participationMode === 'helper' && (
              <FormField label="Communication medium" labelClassName={labelClass}>
                <input
                  className={fieldClass}
                  value={communicationMedium}
                  onChange={(event) => setCommunicationMedium(event.target.value)}
                  placeholder="e.g. a radio activated in the opening"
                  disabled={creating}
                />
              </FormField>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              disabled={creating}
              className="px-2.5 py-1.5 rounded border border-port-border text-xs disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={runCreate}
              disabled={creating || (participationMode === 'helper' && !communicationMedium.trim())}
              className="px-2.5 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create narrative'}
            </button>
          </div>
        </div>
      )}

      {looms === null ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Loading branching narratives…
        </div>
      ) : looms.length === 0 ? (
        <p className="text-xs text-gray-600">
          None yet. A branching narrative stays its own record — it just carries this series&apos; canon and shows up here.
        </p>
      ) : (
        <ul className="grid gap-2 @md:grid-cols-2">
          {looms.map((loom) => (
            <li key={loom.id}>
              <Link
                to={`/fableloom/${loom.id}`}
                className="block rounded border border-port-border bg-port-card p-2.5 hover:border-port-accent transition-colors"
              >
                <div className="text-sm text-white truncate">{loom.name}</div>
                {loom.logline ? (
                  <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{loom.logline}</div>
                ) : null}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap text-[10px] text-gray-500">
                  <Pill size="xs">{countLabel(loom.episodeCount, 'episode')}</Pill>
                  <Pill size="xs">{countLabel(loom.sceneCount, 'scene')}</Pill>
                  <Pill size="xs">{countLabel(loom.endingCount, 'ending')}</Pill>
                  <span className="ml-auto">{timeAgo(loom.updatedAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
