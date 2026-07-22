/**
 * Pipeline — Arc Canvas
 *
 * Phase 4 of the Story Arc Planning redesign. Replaces the flat issue-card
 * grid on PipelineSeries with a structural Arc → Season → Episode tree:
 *
 *   ┌─ Arc ─────────────────────────────────────────────┐
 *   │ Logline / themes / [Verify arc] [Regenerate arc]  │
 *   └───────────────────────────────────────────────────┘
 *
 *   ▼ Season 1 — "Pilot" [8 episodes]
 *      Episode 1 — "First Light" [draft]   <delete>
 *      Episode 2 — "Hollow Bones" [ready]  <delete>
 *      ...
 *      [+ Add episode] [Generate episodes (LLM)]
 *
 *   ▶ Season 2 — "Diaspora" [collapsed]
 *
 *   [+ Add season] [Generate arc (LLM)]
 *
 * The LLM passes (arc/generate, episodes/generate, verify) hit the Phase 3
 * routes; mutations are reflected in local state so the canvas stays
 * responsive without a refetch.
 *
 * This module is the page entry (default export ArcCanvas). Every subcomponent
 * lives in its own file under ./arcCanvas/ — see that directory for the split.
 * ArcRoadmapChart is re-exported here so its existing public import path
 * (`{ ArcRoadmapChart } from '.../ArcCanvas'`, used by PipelineSeriesRoadmap)
 * keeps working.
 */

import { useEffect, useMemo, useState } from 'react';
import ArcHeader from './arcCanvas/ArcHeader.jsx';
import EditorialRoadmapPanel from './arcCanvas/EditorialRoadmapPanel.jsx';
import VolumeNavigator from './arcCanvas/VolumeNavigator.jsx';
import SeasonRow from './arcCanvas/SeasonRow.jsx';
import UngroupedIssues from './arcCanvas/UngroupedIssues.jsx';
import AddSeasonRow from './arcCanvas/AddSeasonRow.jsx';

export { default as ArcRoadmapChart } from './arcCanvas/ArcRoadmapChart.jsx';

export default function ArcCanvas({ series, issues, onSeriesUpdate, onIssuesUpdate, onFlushPending }) {
  const seasons = useMemo(() => series.seasons || [], [series.seasons]);
  const [activeSeasonId, setActiveSeasonId] = useState(seasons[0]?.id || null);
  // Bucket + sort issues by season once per (seasons, issues) change rather than
  // on every render. Stale seasonIds (e.g. after a verify-resolve season rewrite)
  // bucket under null so they show as ungrouped instead of vanishing into an
  // un-iterated key.
  const issuesBySeason = useMemo(() => {
    const validSeasonIds = new Set(seasons.map((s) => s.id));
    const map = new Map();
    for (const iss of issues) {
      const key = iss.seasonId && validSeasonIds.has(iss.seasonId) ? iss.seasonId : null;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(iss);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0));
    }
    return map;
  }, [seasons, issues]);
  const ungroupedIssues = issuesBySeason.get(null) || [];
  const activeSeason = seasons.find((s) => s.id === activeSeasonId) || seasons[0] || null;

  useEffect(() => {
    if (seasons.length === 0) {
      if (activeSeasonId !== null) setActiveSeasonId(null);
      return;
    }
    if (!activeSeasonId || !seasons.some((s) => s.id === activeSeasonId)) {
      setActiveSeasonId(seasons[0].id);
    }
  }, [activeSeasonId, seasons]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 @5xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.55fr)] gap-4 items-start">
        <ArcHeader
          series={series}
          onSeriesUpdate={onSeriesUpdate}
          onIssuesUpdate={onIssuesUpdate}
          onFlushPending={onFlushPending}
        />
        <EditorialRoadmapPanel series={series} seasons={seasons} issues={issues} />
      </div>

      {seasons.length > 0 ? (
        <section className="space-y-3">
          <VolumeNavigator
            seasons={seasons}
            issuesBySeason={issuesBySeason}
            activeSeasonId={activeSeason?.id || null}
            onSelect={setActiveSeasonId}
          />
          {activeSeason ? (
            <ul className="space-y-3">
              <SeasonRow
                key={activeSeason.id}
                series={series}
                season={activeSeason}
                seasons={seasons}
                issues={issuesBySeason.get(activeSeason.id) || []}
                onSeriesUpdate={onSeriesUpdate}
                onIssuesUpdate={onIssuesUpdate}
              />
            </ul>
          ) : null}
        </section>
      ) : null}

      {ungroupedIssues.length > 0 ? (
        <UngroupedIssues
          issues={ungroupedIssues}
          seasons={seasons}
          onIssuesUpdate={onIssuesUpdate}
        />
      ) : null}

      <AddSeasonRow series={series} onSeriesUpdate={onSeriesUpdate} />
    </div>
  );
}
