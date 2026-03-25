import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Search, Plus, Wand2, X, Check, Star, Crown } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';
import { layoutGoalNodes } from './goalTreeLayout';
import GoalDetailPanel, { CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_CONFIG, DEFAULT_NEW_GOAL } from './GoalDetailPanel';
import { applyOrganizationSuggestion } from './applyOrganization';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';

const API_PROVIDER_FILTER = p => p.enabled && p.type === 'api';

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

function GoalScene({ graph, selectedId, adjacentIds, onSelect, onHover }) {
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);
  const octaGeo = useMemo(() => new THREE.OctahedronGeometry(1, 0), []);

  const selNode = selectedId ? graph.idMap.get(selectedId) : null;
  const selRadius = selNode ? (selNode.goalType === 'apex' ? 1.6 : selNode.goalType === 'sub-apex' ? 1.1 : 0.5 + (selNode.urgency ?? 0.3) * 0.6) : 0;

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[50, 50, 50]} intensity={0.8} />
      <pointLight position={[-30, -30, -30]} intensity={0.3} />

      <GoalEdges edges={graph.edges} selectedId={selectedId} />

      {graph.nodes.map(node => {
        const isApex = node.goalType === 'apex';
        const isSubApex = node.goalType === 'sub-apex';
        const radius = isApex ? 1.6 : isSubApex ? 1.1 : 0.5 + (node.urgency ?? 0.3) * 0.6;
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

      {selNode && (
        <mesh geometry={sphereGeo} position={[selNode.x, selNode.y, selNode.z]} scale={selRadius + 0.2}>
          <meshBasicMaterial color="#ffffff" transparent opacity={0.15} wireframe />
        </mesh>
      )}

      <OrbitControls enableDamping dampingFactor={0.05} minDistance={5} maxDistance={150} />
    </>
  );
}

function OrganizePanel({ suggestion, goals, onApply, onClose, applying }) {
  const goalMap = useMemo(() => new Map((goals || []).map(g => [g.id, g])), [goals]);
  if (!suggestion) return null;

  return (
    <div className="absolute top-12 right-3 z-20 bg-port-card border border-port-border rounded-lg p-4 w-96 max-h-[80vh] overflow-y-auto shadow-xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-port-accent" />
          <h3 className="text-sm font-semibold text-white">Goal Organization</h3>
        </div>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
      </div>

      {suggestion.analysis && (
        <p className="text-xs text-gray-400 mb-3 leading-relaxed">{suggestion.analysis}</p>
      )}

      {/* Apex goal suggestion */}
      {suggestion.apexGoal && (
        <div className="mb-3 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-center gap-1.5 mb-1">
            <Crown className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-medium text-amber-400">Apex Goal (North Star)</span>
          </div>
          {suggestion.apexGoal.existingId ? (
            <p className="text-xs text-gray-300">{goalMap.get(suggestion.apexGoal.existingId)?.title || suggestion.apexGoal.existingId}</p>
          ) : (
            <div>
              <p className="text-xs text-white font-medium">{suggestion.apexGoal.suggestedTitle}</p>
              {suggestion.apexGoal.suggestedDescription && (
                <p className="text-xs text-gray-400 mt-0.5">{suggestion.apexGoal.suggestedDescription}</p>
              )}
              <span className="text-xs text-amber-500/60 italic">New goal — will be created when applied</span>
            </div>
          )}
        </div>
      )}

      {/* Organization */}
      {suggestion.organization?.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <h4 className="text-xs font-medium text-gray-400">Proposed Hierarchy</h4>
          {suggestion.organization.map(item => {
            const goal = goalMap.get(item.id);
            const typeCfg = GOAL_TYPE_CONFIG[item.goalType] || GOAL_TYPE_CONFIG.standard;
            const parent = item.suggestedParentId ? goalMap.get(item.suggestedParentId) : null;
            return (
              <div key={item.id} className="p-2 rounded bg-port-bg/50 border border-port-border/50">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${typeCfg.bg} ${typeCfg.color}`}>
                    {typeCfg.label}
                  </span>
                  <span className="text-xs text-white truncate">{goal?.title || item.id}</span>
                </div>
                {parent && (
                  <div className="text-xs text-gray-500 mt-0.5 ml-1">
                    under: {parent.title}
                  </div>
                )}
                {item.reasoning && (
                  <p className="text-xs text-gray-600 mt-0.5 ml-1">{item.reasoning}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Suggested sub-apex goals */}
      {suggestion.suggestedSubApex?.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <h4 className="text-xs font-medium text-gray-400">Suggested Sub-Apex Goals</h4>
          {suggestion.suggestedSubApex.map((sg, i) => (
            <div key={i} className="p-2 rounded bg-purple-500/5 border border-purple-500/20">
              <div className="flex items-center gap-1.5">
                <Star className="w-3 h-3 text-purple-400" />
                <span className="text-xs text-white font-medium">{sg.title}</span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{sg.description}</p>
              <span className="text-xs text-purple-500/60 italic">New goal — will be created when applied</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-port-border">
        <button
          onClick={onApply}
          disabled={applying}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-blue-600 disabled:opacity-50 min-h-[40px]"
        >
          <Check className="w-4 h-4" />
          {applying ? 'Applying...' : 'Apply Changes'}
        </button>
        <button
          onClick={onClose}
          className="px-3 py-2 text-sm rounded-lg bg-port-border text-gray-300 hover:bg-gray-600 min-h-[40px]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function GoalsTreeView({ data, onRefresh }) {
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilters, setCategoryFilters] = useState(() =>
    Object.fromEntries(Object.keys(CATEGORY_CONFIG).map(k => [k, true]))
  );
  const [showNewGoal, setShowNewGoal] = useState(false);
  const [newGoal, setNewGoal] = useState({ ...DEFAULT_NEW_GOAL });
  const [organizing, setOrganizing] = useState(false);
  const [orgSuggestion, setOrgSuggestion] = useState(null);
  const [applyingOrg, setApplyingOrg] = useState(false);
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading
  } = useProviderModels({ filter: API_PROVIDER_FILTER });

  const dragStartRef = useRef(null);

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

  const adjacentIds = useMemo(() => {
    if (!selectedNode || !graph) return null;
    const set = new Set();
    for (const e of graph.edges) {
      if (e.source === selectedNode.id) set.add(e.target);
      if (e.target === selectedNode.id) set.add(e.source);
    }
    return set;
  }, [selectedNode, graph]);

  // Find the full goal data for the selected node
  const selectedGoal = selectedNode ? data?.flat?.find(g => g.id === selectedNode.id) : null;

  const handleSelect = useCallback((node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  }, []);

  const handleHover = useCallback((node) => {
    setHoveredNode(node);
  }, []);

  const handlePointerMissed = useCallback((e) => {
    const start = dragStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) {
      setSelectedNode(null);
    }
  }, []);

  const toggleCategory = (cat) => {
    setCategoryFilters(prev => ({ ...prev, [cat]: !prev[cat] }));
    setSelectedNode(null);
  };

  const handleCreateGoal = async () => {
    if (!newGoal.title.trim()) return;
    await api.createGoal(newGoal);
    setNewGoal({ ...DEFAULT_NEW_GOAL });
    setShowNewGoal(false);
    onRefresh();
  };

  const handleOrganize = async () => {
    if (!selectedProviderId) { toast.error('No API provider available'); return; }
    setOrganizing(true);
    const result = await api.organizeGoals({ providerId: selectedProviderId, model: selectedModel }).catch(() => null);
    setOrganizing(false);
    if (result) {
      setOrgSuggestion(result);
    } else {
      toast.error('Failed to organize goals');
    }
  };

  const handleApplyOrganization = async () => {
    if (!orgSuggestion) return;
    setApplyingOrg(true);
    await applyOrganizationSuggestion(orgSuggestion);
    setApplyingOrg(false);
    setOrgSuggestion(null);
    toast.success('Goal hierarchy applied');
    onRefresh();
  };

  return (
    <div className="h-full flex">
      <div className="flex-1 relative">
        {/* Filter bar */}
        <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search goals..."
              className="bg-port-card/90 backdrop-blur border border-port-border rounded-lg pl-7 pr-3 py-1.5 text-sm text-white w-48"
            />
          </div>
          {Object.entries(CATEGORY_CONFIG).map(([key, cfg]) => {
            const Icon = cfg.icon;
            return (
              <button
                key={key}
                onClick={() => toggleCategory(key)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  categoryFilters[key]
                    ? `${cfg.bg} ${cfg.color} border-transparent`
                    : 'bg-port-card/60 text-gray-600 border-port-border'
                }`}
              >
                <Icon className="w-3 h-3" />
                {cfg.label}
              </button>
            );
          })}
          <button
            onClick={() => setShowNewGoal(!showNewGoal)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-port-accent text-white"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
          {(data?.flat?.length ?? 0) >= 2 && (
            <div className="flex items-center gap-2">
              <ProviderModelSelector
                providers={providers}
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                availableModels={availableModels}
                onProviderChange={setSelectedProviderId}
                onModelChange={setSelectedModel}
                label="AI Provider"
                disabled={organizing || providersLoading}
              />
              <button
                onClick={handleOrganize}
                disabled={organizing || !selectedProviderId}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
                title="Use AI to organize goals into a hierarchy with an apex north-star goal"
              >
                <Wand2 className={`w-3 h-3 ${organizing ? 'animate-spin' : ''}`} />
                {organizing ? 'Analyzing...' : 'Organize'}
              </button>
            </div>
          )}
        </div>

        {/* New goal form */}
        {showNewGoal && (
          <div className="absolute top-12 left-3 z-10 bg-port-card border border-port-border rounded-lg p-3 w-72 space-y-2 shadow-lg">
            <input
              type="text"
              value={newGoal.title}
              onChange={e => setNewGoal({ ...newGoal, title: e.target.value })}
              placeholder="Goal title..."
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
              onKeyDown={e => e.key === 'Enter' && handleCreateGoal()}
            />
            <textarea
              value={newGoal.description}
              onChange={e => setNewGoal({ ...newGoal, description: e.target.value })}
              placeholder="Description..."
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white resize-none"
            />
            <div className="flex gap-2">
              <select
                value={newGoal.horizon}
                onChange={e => setNewGoal({ ...newGoal, horizon: e.target.value })}
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {HORIZON_OPTIONS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
              <select
                value={newGoal.category}
                onChange={e => setNewGoal({ ...newGoal, category: e.target.value })}
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateGoal}
                disabled={!newGoal.title.trim()}
                className="px-3 py-1 text-sm rounded bg-port-accent text-white disabled:opacity-50"
              >
                Create
              </button>
              <button onClick={() => setShowNewGoal(false)} className="px-3 py-1 text-sm rounded bg-port-border text-gray-300">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Organization panel */}
        <OrganizePanel
          suggestion={orgSuggestion}
          goals={data?.flat}
          onApply={handleApplyOrganization}
          onClose={() => setOrgSuggestion(null)}
          applying={applyingOrg}
        />

        {/* Legend */}
        <div className="absolute bottom-3 left-3 z-10 bg-port-card/90 backdrop-blur border border-port-border rounded-lg px-3 py-2 text-xs space-y-1">
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
        {hoveredNode && !selectedNode && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm pointer-events-none shadow-lg">
            <div className="text-white font-medium">{hoveredNode.title}</div>
            <div className="text-gray-500 text-xs">
              {hoveredNode.goalType && hoveredNode.goalType !== 'standard' && (
                <span className={hoveredNode.goalType === 'apex' ? 'text-amber-400' : 'text-purple-400'}>
                  {GOAL_TYPE_CONFIG[hoveredNode.goalType]?.label} &middot;{' '}
                </span>
              )}
              {CATEGORY_CONFIG[hoveredNode.category]?.label} &middot; {HORIZON_OPTIONS.find(h => h.value === hoveredNode.horizon)?.label}
              {hoveredNode.urgency != null && ` &middot; ${Math.round(hoveredNode.urgency * 100)}% urgency`}
            </div>
          </div>
        )}

        {/* 3D Canvas */}
        {graph?.nodes?.length ? (
          <Canvas
            camera={{ position: [0, 15, 40], fov: 60 }}
            onPointerDown={(e) => { dragStartRef.current = { x: e.clientX, y: e.clientY }; }}
            onPointerMissed={handlePointerMissed}
            style={{ background: '#0f0f0f' }}
          >
            <GoalScene
              graph={graph}
              selectedId={selectedNode?.id}
              adjacentIds={adjacentIds}
              onSelect={handleSelect}
              onHover={handleHover}
            />
          </Canvas>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            No goals to display. Add a goal to get started.
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedGoal && (
        <GoalDetailPanel
          goal={selectedGoal}
          allGoals={data?.flat}
          onClose={() => setSelectedNode(null)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}
