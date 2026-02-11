import { useMemo } from 'react';
import { Text } from '@react-three/drei';
import { computeCityLayout } from './cityLayout';
import { getBuildingHeight, DISTRICT_PARAMS, PIXEL_FONT_URL } from './cityConstants';
import Building from './Building';
import AgentEntity from './AgentEntity';

export default function BuildingCluster({ apps, agentMap, onBuildingClick }) {
  const positions = useMemo(() => computeCityLayout(apps), [apps]);

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

        const agentData = agentMap.get(app.id);
        const agents = agentData?.agents || [];
        const height = getBuildingHeight(app);

        return (
          <group key={app.id}>
            <Building
              app={app}
              position={pos}
              agentCount={agents.length}
              onClick={() => onBuildingClick?.(app)}
            />
            {agents.map((agent, i) => (
              <AgentEntity
                key={agent.agentId || i}
                agent={agent}
                position={[pos.x, height + 1.5 + i * 1.0, pos.z]}
                index={i}
              />
            ))}
          </group>
        );
      })}

      {/* Warehouse district label - pixel font */}
      {hasArchived && (
        <Text
          position={[0, 0.5, warehouseMinZ - 2]}
          fontSize={0.8}
          color="#1e293b"
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
