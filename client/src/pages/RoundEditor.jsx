/**
 * Round editor — /rounds/:id.
 *
 * Two URL-param-driven modes (`?mode=read` default, `?mode=edit`):
 *  - READ: a clean, desktop-wide performance view — lyrics rendered in full
 *    (no sub-scrollable textareas), sections laid out in a responsive grid to
 *    use horizontal real-estate and cut vertical scrolling, with the recorder
 *    front-and-centre for playing/recording (`<RoundReadView>`).
 *  - EDIT: the editing workbench — metadata, lyric sections, voice layers, and
 *    free-text notation + arrangement notes (`<RoundEditForm>`).
 *
 * Full-width route (Layout.jsx isFullWidth matches `/rounds/`) so this page owns
 * its own vertical scroll, mirroring WritersRoomGuide's column layout. Every view
 * (mode, round stack, reference analysis) lives in the URL — see
 * `useRoundViewParams` — so it's linkable, per the project's "selection lives in
 * the URL" convention.
 *
 * This file is the composition layer only: it wires the per-concern hooks
 * (`useRoundViewParams` / `useRoundDraft` / `useRoundRows` / `useRoundPartners`)
 * to the header chrome and picks which of the three body surfaces renders (#3389).
 * Saves are explicit (the header Save button) rather than per-keystroke, and stay
 * available in READ mode too, because recording a take mutates the draft.
 */

import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, BookOpen, Eye, Music, Pencil, Save } from 'lucide-react';
import useRoundDraft from '../hooks/useRoundDraft.js';
import useRoundPartners from '../hooks/useRoundPartners.js';
import useRoundRows from '../hooks/useRoundRows.js';
import useRoundViewParams from '../hooks/useRoundViewParams.js';
import ReferenceAnalysis from '../components/songs/ReferenceAnalysis';
import RoundEditForm from '../components/songs/RoundEditForm';
import RoundReadView from '../components/songs/RoundReadView';
import { TEMP_ID_RE } from '../lib/roundDraft.js';
import PageSkeleton from '../components/ui/PageSkeleton';

export default function RoundEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { editing, setMode, stackOpen, setStack, analyzeId, setAnalyze } = useRoundViewParams();
  const {
    song, setSong, loading, baseDirty,
    setField, save, saving, refreshTemplate, refreshing, applyGenerated,
  } = useRoundDraft({ id, analyzeId, setAnalyze });
  const rows = useRoundRows({ song, setSong });
  const { partnerSongs, otherSongs, togglePartner } = useRoundPartners({ id, song, setSong });

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading round"
        fullHeight
        padded
        barClassName="px-4 py-3 bg-port-card"
        bodyClassName="p-4"
        headerRowClass="flex items-center gap-3"
        titleWidthClass="w-48"
        cards={2}
        sidebar={false}
      />
    );
  }
  if (!song) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-400 mb-4">Round not found.</p>
        <Link to="/rounds" className="text-port-accent hover:underline">← Back to Rounds</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card shrink-0">
        <button
          type="button"
          onClick={() => navigate("/rounds")}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors"
          title="Back to Rounds"
          aria-label="Back to Rounds"
        >
          <ArrowLeft size={18} />
        </button>
        <Music size={18} className="text-port-accent shrink-0" />
        <span className="text-white font-semibold truncate flex-1 min-w-0">{song.title || 'Untitled round'}</span>
        {/* View / Edit toggle — mode lives in the URL so each view is linkable. */}
        <div className="flex items-center rounded-lg border border-port-border overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => setMode('read')}
            aria-pressed={!editing}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${!editing ? 'bg-port-accent text-white' : 'text-gray-300 hover:text-white hover:bg-port-border/50'}`}
          >
            <Eye size={14} /> View
          </button>
          <button
            type="button"
            onClick={() => setMode('edit')}
            aria-pressed={editing}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors border-l border-port-border ${editing ? 'bg-port-accent text-white' : 'text-gray-300 hover:text-white hover:bg-port-border/50'}`}
          >
            <Pencil size={14} /> Edit
          </button>
        </div>
        <Link
          to="/rounds/guide"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
        >
          <BookOpen size={14} />
          Guide
        </Link>
        <button
          type="button"
          onClick={() => save()}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {/* Reference-audio analysis workbench (#2106) — replaces the reading/
            editing surface while ?analyze=<refId> is set, like ?stack does.
            Renders its own fallbacks for a stale id or a no-audio reference. */}
        {analyzeId && (
          <ReferenceAnalysis
            reference={(song.references || []).find((r) => r.id === analyzeId) || null}
            // Only stable-id layers are offered as segment targets — a blank
            // layer's temp id gets re-minted server-side on Save, which would
            // orphan any segment linked to it.
            layers={(song.layers || []).filter((l) => !TEMP_ID_RE.test(l.id))}
            scoreParts={song.scoreParts || []}
            baseScore={song.score || ''}
            tempo={song.tempo ?? null}
            songKey={song.key || ''}
            onUpdateReference={rows.updateReference}
            onApplyPart={rows.applyProposedPart}
            onClose={() => setAnalyze(null)}
          />
        )}

        {!analyzeId && !editing && (
          <RoundReadView
            song={song}
            setField={setField}
            onRefreshTemplate={refreshTemplate}
            refreshing={refreshing}
            partnerSongs={partnerSongs}
            stackOpen={stackOpen}
            onToggleStack={setStack}
            onAnalyze={setAnalyze}
          />
        )}

        {!analyzeId && editing && (
          <RoundEditForm
            songId={id}
            song={song}
            setField={setField}
            rows={rows}
            otherSongs={otherSongs}
            onTogglePartner={togglePartner}
            baseDirty={baseDirty}
            onApplyGenerated={applyGenerated}
            onRefreshTemplate={refreshTemplate}
            refreshing={refreshing}
            onAnalyze={setAnalyze}
          />
        )}
      </div>
    </div>
  );
}
