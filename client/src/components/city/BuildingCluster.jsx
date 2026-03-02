import { useMemo, useEffect } from 'react';
import { Text } from '@react-three/drei';
import { computeCityLayout } from './cityLayout';
import { DISTRICT_PARAMS, PIXEL_FONT_URL } from './cityConstants';
import Borough from './Borough';

export default function BuildingCluster({ apps, agentMap, onBuildingClick, onPositionsReady, playSfx, settings, proximityAppId }) {
  const positions = useMemo(() => computeCityLayout(apps), [apps]);

  // Notify parent when positions change (for data streams, roads, traffic)
  useEffect(() => {
    onPositionsReady?.(positions);
  }, [positions, onPositionsReady]);

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
          />
        );
      })}

      {/* Warehouse district label - pixel font */}
      {hasArchived && (
        <Text
          position={[0, 1.5, warehouseMinZ - 2]}
          fontSize={0.8}
          color="#475569"
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
        >
          ARCHIVE DISTRICT
        </Text>
      )}
    </group>
  );
}
