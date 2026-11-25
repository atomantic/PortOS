import { Suspense, useState, useEffect, useMemo, useRef, useCallback, useId } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { useNavigate } from 'react-router';
import { Search, Plus, Wand2, Type } from 'lucide-react';
import { GOALS_TREE_PATH, goalTreeDetailPath } from './goalConstants';
import { layoutGoalNodes } from './goalTreeLayout';
import {
  DIMMED_LABEL_OPACITY,
  GOAL_LABEL_FONT_URL,
  computeGraphBounds,
  fitCameraToBounds,
  goalLabelColor,
  goalLabelFontSize,
  goalLabelOffsetY,
  goalLabelText,
  goalNodeRadius,
  labelFadeRange,
  labelOpacityForDistance,
  orbitDistanceLimits
} from './goalTreeScene';
import GoalDetailPanel, { CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_CONFIG, DEFAULT_NEW_GOAL } from './GoalDetailPanel';
import OrganizePanel from './OrganizePanel';
import { useGoalOrganize, useGoalCreate } from '../../hooks/useGoalOrganize';
import useProviderModels from '../../hooks/useProviderModels';
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion';
import { graphMotionSettings } from '../graph3d/GraphScene';
import ProviderModelSelector from '../ProviderModelSelector';
import { enabledApiProviderFilter } from '../../utils/providers';

const EDGE_COLORS = {
  parent: '#3b82f6',
  tag: '#f59e0b'
};

function GoalEdges({ edges, selectedId }) {
  // Split edges into parent and tag groups for different materials
  const parentEdges = useMemo(() => edges.filter(e => e.type === 'parent'), [edges]);
  const tagEdges = useMemo(() => edges.filter(e => e.type === 'tag'), [edges]);

  const parentGeoRef = useRef();
  const tagGeoRef = useRef();
  const tagLineRef = useRef();

  const setupGeo = useCallback((geo, edgeList) => {
    if (!geo) return;
    if (!edgeList.length) {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
      geo.computeBoundingSphere();
      return;
    }
    const count = edgeList.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const tmpColor = new THREE.Color();
    edgeList.forEach((e, i) => {
      const a = e.sourceNode, b = e.targetNode;
      const off = i * 6;
      positions[off] = a.x; positions[off + 1] = a.y; positions[off + 2] = a.z;
      positions[off + 3] = b.x; positions[off + 4] = b.y; positions[off + 5] = b.z;
      const dimmed = selectedId && e.source !== selectedId && e.target !== selectedId;
      tmpColor.set(EDGE_COLORS[e.type] || '#6b7280');
      const intensity = dimmed ? 0.06 : (e.type === 'parent' ? 0.5 : 0.2);
      colors[off] = tmpColor.r * intensity;
      colors[off + 1] = tmpColor.g * intensity;
      colors[off + 2] = tmpColor.b * intensity;
      colors[off + 3] = tmpColor.r * intensity;
      colors[off + 4] = tmpColor.g * intensity;
      colors[off + 5] = tmpColor.b * intensity;
    });
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  }, [selectedId]);

  useEffect(() => {
    setupGeo(parentGeoRef.current, parentEdges);
    setupGeo(tagGeoRef.current, tagEdges);
    // LineDashedMaterial requires computeLineDistances on the LineSegments mesh
    tagLineRef.current?.computeLineDistances();
  }, [parentEdges, tagEdges, setupGeo]);

  return (
    <>
      <lineSegments>
        <bufferGeometry ref={parentGeoRef} />
        <lineBasicMaterial vertexColors />
      </lineSegments>
      <lineSegments ref={tagLineRef}>
        <bufferGeometry ref={tagGeoRef} />
        <lineDashedMaterial vertexColors dashSize={0.5} gapSize={0.3} />
      </lineSegments>
    </>
  );
}

// Labels are decoration over the nodes — they must never eat a click meant for
// the sphere underneath (or, once faded to invisible, swallow one from nothing).
const noRaycast = () => null;
const labelWorldPos = new THREE.Vector3();

// A persistent, camera-facing goal title. Opacity is driven imperatively from the
// frame loop: a per-frame setState would re-render the whole scene 60x a second,
// and troika reads `fillOpacity` off the instance at draw time, so mutating it
// needs no sync() and no React round-trip.
function GoalLabel({ node, dimmed, fadeRange }) {
  const groupRef = useRef();
  const textRef = useRef();
  const stateRef = useRef({ dimmed, fadeRange });
  stateRef.current = { dimmed, fadeRange };

  useFrame(({ camera }) => {
    const group = groupRef.current;
    const text = textRef.current;
    if (!group || !text) return;
    const { dimmed: isDimmed, fadeRange: range } = stateRef.current;
    const distance = camera.position.distanceTo(group.getWorldPosition(labelWorldPos));
    const opacity = labelOpacityForDistance(distance, range) * (isDimmed ? DIMMED_LABEL_OPACITY : 1);
    group.visible = opacity > 0.02;
    text.fillOpacity = opacity;
    text.outlineOpacity = opacity;
  });

  const label = goalLabelText(node.title);
  if (!label) return null;
  const fontSize = goalLabelFontSize(node);

  return (
    <Billboard ref={groupRef} position={[node.x, node.y + goalLabelOffsetY(node), node.z]}>
      <Text
        ref={textRef}
        font={GOAL_LABEL_FONT_URL}
        fontSize={fontSize}
        color={goalLabelColor(node)}
        anchorX="center"
        anchorY="bottom"
        textAlign="center"
        maxWidth={fontSize * 12}
        outlineWidth={fontSize * 0.1}
        outlineColor="#000000"
        raycast={noRaycast}
      >
        {label}
      </Text>
    </Billboard>
  );
}

// Frames the whole graph on mount and whenever the node set changes (a filter or
// search rebuilds the layout), so no goal starts outside the viewport.
function GoalCameraRig({ bounds, fitKey, onFit }) {
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls);
  // Read through a ref: re-running the fit on every `bounds` identity change would
  // yank the camera back after an unrelated refetch. `fitKey` is the real trigger.
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    if (!camera) return;
    const fit = fitCameraToBounds(boundsRef.current, { fov: camera.fov, aspect: camera.aspect });
    if (!fit) return;
    camera.position.set(...fit.position);
    camera.updateProjectionMatrix();
    if (controls?.target) {
      controls.target.set(...fit.target);
      controls.update();
    } else {
      // OrbitControls registers itself as the default controls a tick after mount;
      // until then, aim the camera directly so the first frame is already framed.
      camera.lookAt(...fit.target);
    }
    onFit(fit.distance);
  }, [camera, controls, fitKey, onFit]);

  return null;
}

function GoalScene({ graph, bounds, selectedId, adjacentIds, onSelect, onHover, showLabels }) {
  const invalidate = useThree(state => state.invalidate);
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);
  const octaGeo = useMemo(() => new THREE.OctahedronGeometry(1, 0), []);

  const selNode = selectedId ? graph.idMap.get(selectedId) : null;
  const selRadius = selNode ? goalNodeRadius(selNode) : 0;

  const fitKey = useMemo(() => graph.nodes.map(n => n.id).join('|'), [graph.nodes]);

  const [fitDistance, setFitDistance] = useState(null);
  const handleFit = useCallback((distance) => setFitDistance(distance), []);
  const fadeRange = useMemo(() => labelFadeRange(fitDistance), [fitDistance]);

  // Label opacity and edge geometry are written outside React's host props.
  useEffect(() => {
    invalidate();
  }, [invalidate, graph, selectedId, showLabels, fadeRange]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[50, 50, 50]} intensity={0.8} />
      <pointLight position={[-30, -30, -30]} intensity={0.3} />

      <GoalCameraRig bounds={bounds} fitKey={fitKey} onFit={handleFit} />

      <GoalEdges edges={graph.edges} selectedId={selectedId} />

      {graph.nodes.map(node => {
        const isApex = node.goalType === 'apex';
        const isSubApex = node.goalType === 'sub-apex';
        const radius = goalNodeRadius(node);
        const cat = CATEGORY_CONFIG[node.category] || CATEGORY_CONFIG.mastery;
        const color = isApex ? '#fbbf24' : isSubApex ? '#c084fc' : cat.hex;
        const isSelected = node.id === selectedId;
        const isConnected = adjacentIds?.has(node.id);
        const dimmed = selectedId && !isSelected && !isConnected;
        const geo = isApex ? octaGeo : sphereGeo;

        return (
          <mesh
            key={node.id}
            geometry={geo}
            scale={radius}
            position={[node.x, node.y, node.z]}
            onClick={(e) => { e.stopPropagation(); onSelect(node); }}
            onPointerOver={(e) => { e.stopPropagation(); onHover(node); }}
            onPointerOut={() => onHover(null)}
          >
            <meshStandardMaterial
              color={dimmed ? '#1a1a1a' : color}
              emissive={color}
              emissiveIntensity={isSelected ? 0.6 : (dimmed ? 0.03 : isApex ? 0.5 : isSubApex ? 0.35 : 0.15 + (node.urgency ?? 0) * 0.3)}
            />
          </mesh>
        );
      })}

      {/* Own Suspense boundary: drei's <Text> suspends until the font loads, and
          the Canvas-level boundary would blank the WHOLE scene while it does. */}
      {showLabels && (
        <Suspense fallback={null}>
          {graph.nodes.map(node => (
            <GoalLabel
              key={`label-${node.id}`}
              node={node}
              dimmed={Boolean(selectedId && node.id !== selectedId && !adjacentIds?.has(node.id))}
              fadeRange={fadeRange}
            />
          ))}
        </Suspense>
      )}

      {selNode && (
        <mesh geometry={sphereGeo} position={[selNode.x, selNode.y, selNode.z]} scale={selRadius + 0.2}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.15} wireframe />
        </mesh>
      )}
    </>
  );
}

export default function GoalsTreeView({ data, onRefresh, selectedGoalId }) {
  // Selection lives in the URL (/goals/tree/:goalId) so it survives reload, Back and tab switches.
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const { frameloop } = graphMotionSettings(reducedMotion);
  const clearSelection = useCallback(() => navigate(GOALS_TREE_PATH), [navigate]);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilters, setCategoryFilters] = useState(() =>
    Object.fromEntries(Object.keys(CATEGORY_CONFIG).map(k => [k, true]))
  );
  // Names on by default: without them the tree is a field of unlabelled dots and
  // reads as strictly less than the list view next to it (#3280).
  const [showLabels, setShowLabels] = useState(true);
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [newGoal, setNewGoal] = useState({ ...DEFAULT_NEW_GOAL });
  const { isCreating, createGoal } = useGoalCreate(onRefresh);
  const { organizing, orgSuggestion, applyingOrg, requestOrganize, applySuggestion, dismiss, organizeButtonRef } = useGoalOrganize(onRefresh);
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels({ filter: enabledApiProviderFilter });

  const dragStartRef = useRef(null);
  const addButtonRef = useRef(null);
  const addFormId = useId();
  const detailPanelRef = useRef(null);
  const goalButtonRef = useRef(null);

  const filteredGoals = useMemo(() => {
    if (!data?.flat?.length) return [];
    const query = searchQuery.toLowerCase();
    return data.flat.filter(g => {
      if (!categoryFilters[g.category]) return false;
      if (query && !g.title.toLowerCase().includes(query) && !g.description?.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, categoryFilters, searchQuery]);

  const graph = useMemo(() => {
    if (!filteredGoals.length) return null;
    return layoutGoalNodes(filteredGoals);
  }, [filteredGoals]);

  const bounds = useMemo(() => graph && computeGraphBounds(graph.nodes), [graph]);
  const orbitLimits = useMemo(() => bounds && orbitDistanceLimits(bounds), [bounds]);

  const adjacentIds = useMemo(() => {
    if (!selectedGoalId || !graph) return null;
    const set = new Set();
    for (const e of graph.edges) {
      if (e.source === selectedGoalId) set.add(e.target);
      if (e.target === selectedGoalId) set.add(e.source);
    }
    return set;
  }, [selectedGoalId, graph]);

  // Find the full goal data for the selected node
  const selectedGoal = selectedGoalId ? data?.flat?.find(g => g.id === selectedGoalId) : null;

  useEffect(() => {
    // The detail panel covers the picker at narrow widths.
    if (selectedGoalId && goalButtonRef.current) detailPanelRef.current?.focus();
  }, [selectedGoalId]);

  const closeGoalDetails = useCallback(() => {
    clearSelection();
    goalButtonRef.current?.focus();
    goalButtonRef.current = null;
  }, [clearSelection]);

  const handleSelect = useCallback((node, goalButton = null) => {
    if (node.id === selectedGoalId) {
      closeGoalDetails();
      return;
    }
    goalButtonRef.current = goalButton;
    navigate(goalTreeDetailPath(node.id));
  }, [navigate, selectedGoalId, closeGoalDetails]);

  const closeAddForm = () => {
    setShowNewGoal(false);
    addButtonRef.current?.focus();
  };

  const handleEscape = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
    if (showNewGoal) closeAddForm();
    else if (selectedGoalId) closeGoalDetails();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleHover = useCallback((node) => {
    setHoveredNode(node);
  }, []);

  const handlePointerMissed = useCallback((e) => {
    const start = dragStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) {
      clearSelection();
    }
  }, [clearSelection]);

  const toggleCategory = (cat) => {
    setCategoryFilters(prev => ({ ...prev, [cat]: !prev[cat] }));
    clearSelection();
  };

  const resetFilters = () => {
    setSearchQuery('');
    setCategoryFilters(Object.fromEntries(Object.keys(CATEGORY_CONFIG).map(k => [k, true])));
  };

  const handleCreateGoal = async () => {
    if (await createGoal(newGoal)) {
      setNewGoal({ ...DEFAULT_NEW_GOAL });
      setShowNewGoal(false);
    }
  };

  const handleOrganize = () => requestOrganize({ providerId: selectedProviderId, model: selectedModel });

  return (
    <div className="@container/goals h-full flex relative" onKeyDown={handleEscape}>
      <div className="flex-1 min-w-0 min-h-0 relative flex flex-col">
        {/* Filter bar */}
        <div className="relative z-10 shrink-0 m-2 sm:m-3">
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search..."
                aria-label="Search goals"
                className="bg-port-card/90 backdrop-blur border border-port-border rounded-lg pl-7 pr-3 py-1.5 text-sm text-white w-32 sm:w-48"
              />
            </div>
            {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => {
              const Icon = cfg.icon;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={Boolean(categoryFilters[key])}
                  onClick={() => toggleCategory(key)}
                  className={`flex items-center justify-center shrink-0 min-w-11 min-h-11 gap-1 px-1.5 sm:px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    categoryFilters[key]
                      ? `${cfg.bg} ${cfg.color} border-transparent`
                      : 'bg-port-card/60 text-gray-600 border-port-border'
                  }`}
                  title={cfg.label}
                >
                  <Icon className="w-3 h-3" />
                  <span className="max-sm:sr-only">{cfg.label}</span>
                </button>
              );
            })}
            <button
              onClick={() => setShowLabels(v => !v)}
              aria-pressed={showLabels}
              aria-label="Labels"
              title={showLabels ? 'Hide goal names' : 'Show goal names'}
              className={`flex items-center justify-center shrink-0 min-w-11 min-h-11 gap-1 px-1.5 sm:px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                showLabels
                  ? 'bg-port-accent/20 text-port-accent border-transparent'
                  : 'bg-port-card/60 text-gray-600 border-port-border'
              }`}
            >
              <Type className="w-3 h-3" />
              <span className="hidden sm:inline">Labels</span>
            </button>
            <button
              ref={addButtonRef}
              type="button"
              aria-expanded={showNewGoal}
              aria-controls={showNewGoal ? addFormId : undefined}
              onClick={() => setShowNewGoal(open => !open)}
              className="flex items-center justify-center shrink-0 min-w-11 min-h-11 gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-port-accent text-white"
            >
              <Plus className="w-3 h-3" />
              Add
            </button>
            {/* New goal form */}
            {showNewGoal && (
              <div id={addFormId} className="absolute top-full mt-2 left-0 z-10 bg-port-card border border-port-border rounded-lg p-3 w-72 max-w-[calc(100vw-1rem)] space-y-2 shadow-lg">
                <input
                  type="text"
                  value={newGoal.title}
                  onChange={e => setNewGoal({ ...newGoal, title: e.target.value })}
                  placeholder="Goal title..."
                  aria-label="New goal title"
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
                  onKeyDown={e => e.key === 'Enter' && handleCreateGoal()}
                  disabled={isCreating}
                />
                <textarea
                  value={newGoal.description}
                  onChange={e => setNewGoal({ ...newGoal, description: e.target.value })}
                  placeholder="Description..."
                  aria-label="New goal description"
                  rows={2}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white resize-none"
                  disabled={isCreating}
                />
                <div className="flex gap-2">
                  <select
                    value={newGoal.horizon}
                    onChange={e => setNewGoal({ ...newGoal, horizon: e.target.value })}
                    aria-label="New goal horizon"
                    className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
                    disabled={isCreating}
                  >
                    {HORIZON_OPTIONS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                  <select
                    value={newGoal.category}
                    onChange={e => setNewGoal({ ...newGoal, category: e.target.value })}
                    aria-label="New goal category"
                    className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
                    disabled={isCreating}
                  >
                    {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleCreateGoal}
                    disabled={!newGoal.title.trim() || isCreating}
                    className="px-3 py-1 text-sm rounded bg-port-accent text-white disabled:opacity-50"
                  >
                    Create
                  </button>
                  <button type="button" onClick={closeAddForm} className="px-3 py-1 text-sm rounded bg-port-border text-gray-300">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {(data?.flat?.length ?? 0) >= 2 && (
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 w-full sm:w-auto">
                <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                  <ProviderModelSelector
                    providers={providers}
                    selectedProviderId={selectedProviderId}
                    selectedModel={selectedModel}
                    availableModels={availableModels}
                    onProviderChange={setSelectedProviderId}
                    onModelChange={setSelectedModel}
                    label="AI Provider"
                    disabled={organizing || providersLoading}
                    compact
                  />
                </div>
                <button
                  ref={organizeButtonRef}
                  onClick={handleOrganize}
                  disabled={organizing || !selectedProviderId}
                  className="flex items-center justify-center shrink-0 min-w-11 min-h-11 gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
                  title="Use AI to organize goals into a hierarchy with an apex north-star goal"
                >
                  <Wand2 className={`w-3 h-3 ${organizing ? 'animate-spin' : ''}`} />
                  {organizing ? 'Analyzing...' : 'Organize'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Organization panel */}
        <OrganizePanel
          suggestion={orgSuggestion}
          goals={data?.flat}
          onApply={applySuggestion}
          onClose={dismiss}
          applying={applyingOrg}
        />

        {/* Legend */}
        <div className="hidden sm:block absolute bottom-3 left-3 z-10 bg-port-card/90 backdrop-blur border border-port-border rounded-lg px-3 py-2 text-xs space-y-1">
          <div className="text-gray-400 font-medium mb-1">Legend</div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-blue-500" />
            <span className="text-gray-500">Parent-child</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-0.5 bg-yellow-500" />
            <span className="text-gray-500">Shared tag</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-amber-400 rotate-45" />
            <span className="text-gray-500">Apex</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-purple-400" />
            <span className="text-gray-500">Sub-apex</span>
          </div>
          {graph && (
            <div className="text-gray-600 pt-1 border-t border-port-border mt-1">
              {graph.nodes.length} nodes, {graph.edges.length} edges
            </div>
          )}
        </div>

        {/* Tooltip */}
        {hoveredNode && !selectedGoalId && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm pointer-events-none shadow-lg">
            <div className="text-white font-medium">{hoveredNode.title}</div>
            <div className="text-gray-500 text-xs">
              {hoveredNode.goalType && hoveredNode.goalType !== 'standard' && (
                <span className={hoveredNode.goalType === 'apex' ? 'text-amber-400' : 'text-purple-400'}>
                  {GOAL_TYPE_CONFIG[hoveredNode.goalType]?.label} &middot;{' '}
                </span>
              )}
              {CATEGORY_CONFIG[hoveredNode.category]?.label} &middot; {HORIZON_OPTIONS.find(h => h.value === hoveredNode.horizon)?.label}
              {hoveredNode.urgency != null && ` · ${Math.round(hoveredNode.urgency * 100)}% urgency`}
            </div>
          </div>
        )}

        <section aria-label="Goals 3D tree visualization" className="flex flex-1 min-h-0 flex-col">
          {filteredGoals.length > 0 && (
            <details className="mx-2 mb-2 sm:mx-3 shrink-0">
              <summary className="w-fit cursor-pointer rounded-lg border border-port-border bg-port-card px-2 text-sm text-gray-300">
                Browse goals
              </summary>
              <ul className="mt-1 max-h-32 overflow-y-auto rounded-lg border border-port-border bg-port-card p-1">
                {filteredGoals.map(goal => (
                  <li key={goal.id}>
                    <button
                      type="button"
                      aria-current={goal.id === selectedGoalId ? 'true' : undefined}
                      className="w-full break-words rounded px-2 py-1.5 text-left text-sm text-white hover:bg-port-border aria-[current=true]:bg-port-accent/20"
                      onClick={event => handleSelect(goal, event.currentTarget)}
                    >
                      {goal.title}
                      <span className="text-gray-400">
                        {' · '}{CATEGORY_CONFIG[goal.category].label}
                        {' · '}{HORIZON_OPTIONS.find(h => h.value === goal.horizon)?.label || goal.horizon}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {graph?.nodes?.length ? (
            <Canvas
              frameloop={frameloop}
              camera={{ position: [0, 15, 40], fov: 60 }}
              onPointerDown={(e) => { dragStartRef.current = { x: e.clientX, y: e.clientY }; }}
              onPointerMissed={handlePointerMissed}
              style={{ background: 'rgb(var(--port-bg))', flex: 1, minHeight: 0 }}
            >
              <GoalScene
                graph={graph}
                bounds={bounds}
                selectedId={selectedGoalId}
                adjacentIds={adjacentIds}
                onSelect={handleSelect}
                onHover={handleHover}
                showLabels={showLabels}
              />
              <OrbitControls
                makeDefault
                enableDamping={!reducedMotion}
                dampingFactor={0.05}
                minDistance={orbitLimits.min}
                maxDistance={orbitLimits.max}
              />
            </Canvas>
          ) : (
            (data?.flat?.length ?? 0) > 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 h-full text-gray-500">
                <span>No goals match the current search or category filters.</span>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="px-3 py-1.5 min-h-[40px] rounded-lg bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-sm"
                >
                  Reset filters
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                No goals to display. Add a goal to get started.
              </div>
            )
          )}
        </section>
      </div>

      {/* Detail panel — overlay until the workspace can fit both panes */}
      {selectedGoal && (
        <div
          ref={detailPanelRef}
          tabIndex={-1}
          className="absolute inset-0 z-20 @min-[900px]/goals:relative @min-[900px]/goals:inset-auto @min-[900px]/goals:z-auto @min-[900px]/goals:w-80 shrink-0"
        >
          <GoalDetailPanel
            key={selectedGoal.id}
            goal={selectedGoal}
            allGoals={data?.flat}
            onClose={closeGoalDetails}
            onRefresh={onRefresh}
          />
        </div>
      )}
    </div>
  );
}
