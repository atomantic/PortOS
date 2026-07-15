import { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import { computeCityLayout } from './cityLayout';
import { DISTRICT_PARAMS, PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import Borough from './Borough';
import CityLabel from './CityLabel';

export default function BuildingCluster({ apps, agentMap, onBuildingClick, onPositionsReady, playSfx, settings, proximityAppId, dimmedAppIds, focusedAppId, playback = false }) {
  const positions = useMemo(() => computeCityLayout(apps), [apps]);
  const dayMix = cityDayMix(settings);

  // Notify parent when positions change (for data streams, roads, traffic)
  useEffect(() => {
    onPositionsReady?.(positions);
  }, [positions, onPositionsReady]);

  // Teardown lifecycle (playback/scrubber only — issue #967). When an app id
  // disappears between frames, React would unmount its building instantly. To
  // animate the teardown, retain the departed app (with its last-known position)
  // in `exiting` and render it with transitionState='exiting' until the
  // building's scale-out completes and fires onExited. In live mode this stays
  // empty so behavior is unchanged.
  const prevRef = useRef(new Map());            // id → app (previous render)
  const prevPositionsRef = useRef(new Map());   // id → pos (previous render)
  const [exiting, setExiting] = useState([]);
  useEffect(() => {
    const current = new Map(apps.map(a => [a.id, a]));
    if (playback) {
      const departed = [];
      for (const [id, app] of prevRef.current) {
        if (current.has(id)) continue;
        const prevPos = prevPositionsRef.current.get(id);
        if (prevPos) departed.push({ app, pos: prevPos });
      }
      setExiting(prev => {
        // Drop anything that came back this frame, then add newly-departed ids.
        const kept = prev.filter(e => !current.has(e.app.id));
        const have = new Set(kept.map(e => e.app.id));
        return [...kept, ...departed.filter(d => !have.has(d.app.id))];
      });
    } else if (exiting.length > 0) {
      setExiting([]); // leaving playback: clear any in-flight teardowns
    }
    prevRef.current = current;
    prevPositionsRef.current = positions;
  }, [apps, positions, playback]);

  const handleExited = useCallback((id) => {
    setExiting(prev => prev.filter(e => e.app.id !== id));
  }, []);

  const hasArchived = apps.some(a => a.archived);

  const warehouseMinZ = useMemo(() => {
    let minZ = Infinity;
    positions.forEach((pos) => {
      if (pos.district === 'warehouse' && pos.z < minZ) minZ = pos.z;
    });
    return minZ === Infinity ? DISTRICT_PARAMS.warehouseOffset : minZ;
  }, [positions]);

  return (
    <group>
      {apps.map(app => {
        const pos = positions.get(app.id);
        if (!pos) return null;

        return (
          <Borough
            key={app.id}
            app={app}
            position={pos}
            agentMap={agentMap}
            onBuildingClick={onBuildingClick}
            playSfx={playSfx}
            neonBrightness={settings?.neonBrightness ?? 1.2}
            isProximity={proximityAppId === app.id}
            focused={focusedAppId === app.id}
            dimmed={dimmedAppIds?.has?.(app.id) || false}
            settings={settings}
            playback={playback}
            transitionState="entering"
          />
        );
      })}

      {/* Departed buildings animating out (playback teardown) */}
      {exiting.map(({ app, pos }) => (
        <Borough
          key={`exit-${app.id}`}
          app={app}
          position={pos}
          agentMap={agentMap}
          onBuildingClick={onBuildingClick}
          playSfx={playSfx}
          neonBrightness={settings?.neonBrightness ?? 1.2}
          isProximity={false}
          dimmed={dimmedAppIds?.has?.(app.id) || false}
          settings={settings}
          playback={playback}
          transitionState="exiting"
          onExited={handleExited}
        />
      ))}

      {/* Warehouse district label - pixel font (dark ink + halo by day) */}
      {hasArchived && (
        <CityLabel
          position={[0, 1.5, warehouseMinZ - 2]}
          fontSize={0.8}
          color="#475569"
          dayMix={dayMix}
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
        >
          ARCHIVE DISTRICT
        </CityLabel>
      )}
    </group>
  );
}
