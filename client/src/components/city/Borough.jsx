import { useMemo } from 'react';
import { getBuildingHeight, BOROUGH_PARAMS, cityDayMix, cityShowDetail, cityShowInteriorWindows } from './cityConstants';
import { hashString } from '../../utils/hashString';
import Building from './Building';
import AgentEntity from './AgentEntity';
import ProcessBuilding from './ProcessBuilding';

export default function Borough({ app, position, agentMap, onBuildingClick, playSfx, neonBrightness, isProximity, focused = false, dimmed = false, settings, playback = false, transitionState = null, onExited }) {
  const agentData = agentMap.get(app.id);
  const agents = agentData?.agents || [];
  const height = getBuildingHeight(app);
  // Get processes to render in ring (skip for archived apps)
  const processes = useMemo(() => {
    if (app.archived) return [];
    return app.processes || [];
  }, [app.archived, app.processes]);

  // Build pm2Status lookup map
  const pm2Status = app.pm2Status || {};

  // 0 at night, 1 in full daylight — buildings lighten and shed their neon by day.
  const dayMix = cityDayMix(settings);

  // Compute ring positions for process buildings
  const processPositions = useMemo(() => {
    const count = processes.length;
    if (count === 0) return [];

    return processes.map((proc, i) => {
      const angle = (i / count) * Math.PI * 2;
      const x = Math.cos(angle) * BOROUGH_PARAMS.processRingRadius;
      const z = Math.sin(angle) * BOROUGH_PARAMS.processRingRadius;
      // Rotation to face center: angle + PI so front face points inward
      const rotation = angle + Math.PI;
      const seed = hashString(proc.name || `proc-${i}`);
      return { x, z, rotation, seed, process: proc };
    });
  }, [processes]);

  return (
    <group>
      {/* Main building (the app) */}
      <Building
        app={app}
        position={position}
        agentCount={agents.length}
        onClick={() => onBuildingClick?.(app)}
        playSfx={playSfx}
        rooftops={cityShowDetail(settings)}
        interiorWindows={cityShowInteriorWindows(settings)}
        neonBrightness={neonBrightness}
        isProximity={isProximity}
        focused={focused}
        dimmed={dimmed}
        dayMix={dayMix}
        playback={playback}
        transitionState={transitionState}
        onExited={onExited}
      />

      {/* Process buildings in ring around main building */}
      {processPositions.map(({ x, z, rotation, seed, process: proc }) => (
        <ProcessBuilding
          key={proc.name}
          process={proc}
          pm2Status={pm2Status[proc.name]}
          position={[position.x + x, 0, position.z + z, rotation]}
          seed={seed}
          dimmed={dimmed}
          dayMix={dayMix}
        />
      ))}

      {/* Agent entities floating above main building */}
      {agents.map((agent, i) => (
        <AgentEntity
          key={agent.agentId || i}
          agent={agent}
          position={[position.x, height + 1.5 + i * 1.0, position.z]}
          index={i}
          settings={settings}
        />
      ))}
    </group>
  );
}
