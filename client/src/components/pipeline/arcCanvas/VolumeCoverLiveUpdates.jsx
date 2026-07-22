import { useCallback, useEffect, useRef } from 'react';
import VolumeCoverSlotWatcher from './VolumeCoverSlotWatcher.jsx';

function updateVolumeCoverSlot(season, coverKey, slotKey, filename) {
  if (!season || !filename) return season;
  const coverRecord = season[coverKey] || {};
  const slot = coverRecord[slotKey] || {};
  if (slot.filename === filename) return season;
  return {
    ...season,
    [coverKey]: {
      ...coverRecord,
      [slotKey]: {
        ...slot,
        filename,
      },
    },
  };
}

function updateSeriesVolumeCoverSlot(series, seasonId, coverKey, slotKey, filename) {
  if (!series || !seasonId || !filename) return series;
  let changed = false;
  const nextSeasons = (series.seasons || []).map((season) => {
    if (season.id !== seasonId) return season;
    const nextSeason = updateVolumeCoverSlot(season, coverKey, slotKey, filename);
    if (nextSeason !== season) changed = true;
    return nextSeason;
  });
  return changed ? { ...series, seasons: nextSeasons } : series;
}

export default function VolumeCoverLiveUpdates({ series, season, onSeriesUpdate }) {
  const latestSeriesRef = useRef(series);
  useEffect(() => { latestSeriesRef.current = series; }, [series]);

  const handleFilename = useCallback((coverKey, slotKey, filename) => {
    const current = latestSeriesRef.current;
    const next = updateSeriesVolumeCoverSlot(current, season.id, coverKey, slotKey, filename);
    if (next === current) return;
    latestSeriesRef.current = next;
    onSeriesUpdate(next);
  }, [onSeriesUpdate, season.id]);

  return (
    <>
      <VolumeCoverSlotWatcher
        slot={season.cover?.proofImage}
        coverKey="cover"
        slotKey="proofImage"
        onFilename={handleFilename}
      />
      <VolumeCoverSlotWatcher
        slot={season.cover?.finalImage}
        coverKey="cover"
        slotKey="finalImage"
        onFilename={handleFilename}
      />
      <VolumeCoverSlotWatcher
        slot={season.backCover?.proofImage}
        coverKey="backCover"
        slotKey="proofImage"
        onFilename={handleFilename}
      />
      <VolumeCoverSlotWatcher
        slot={season.backCover?.finalImage}
        coverKey="backCover"
        slotKey="finalImage"
        onFilename={handleFilename}
      />
    </>
  );
}
