import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import RecordRenderPinRow from '../imageGen/RecordRenderPinRow';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { getStoryboardPanelMake } from '../../services/api';
import { formatCount } from '../../utils/formatters';
import { newStoryboardEntityId } from '../../../../server/lib/storyboardVocabulary.js';
import {
  effectiveRecipe, imageNodePrompt, nodeInputValue, panelNodeState, RECIPE_LIMITS, RECIPE_NODE_PORTS, RECIPE_PORT_LABELS, RECIPE_TYPE_TITLES,
  recipeRunOrder, textNodeValue, upstreamNode,
} from '../../../../server/lib/storyboardRecipe.js';
import TabPills from '../ui/TabPills';
import useUrlParams from '../../hooks/useUrlParams';
import CommitField from './CommitField';
import RecipeCanvas from './RecipeCanvas';
import RecipeLibrary from './RecipeLibrary';
import RecipeNodeCard, { NODE_ICONS } from './RecipeNodeCard';
import { takeSrc } from './storyboardArt';
import DrawPanelButton from './DrawPanelButton';

const labelClass = 'block text-[11px] text-gray-500 mb-0.5';
const selectClass = 'min-h-[44px] w-full bg-port-bg border border-port-border rounded px-2 text-sm text-white';
const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const SOURCE_LABELS = { panel: "This panel's shot", beat: "This beat's description", custom: 'My own text' };
const ADDABLE = [
  { type: 'text', title: 'Text' },
  { type: 'system', title: 'System prompt' },
  { type: 'llm', title: 'Prompt enhancer' },
  { type: 'references', title: 'References' },
  { type: 'image', title: 'Image' },
  { type: 'panel', title: 'Panel' },
];
const RUNNABLE = new Set(['llm', 'image']);
const VIEW_TABS = [{ id: 'chain', label: 'Chain' }, { id: 'canvas', label: 'Canvas' }];

const reaches = (edges, start, target) => {
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.from === id) stack.push(edge.to);
  }
  return false;
};

/** "Prompt ← Prompt writer": which node feeds one of this node's inputs. */
function InputRow({ recipe, node, port, onWire }) {
  const kind = RECIPE_NODE_PORTS[node.type].inputs[port];
  const current = upstreamNode(recipe, node.id, port);
  const otherEdges = recipe.edges.filter((e) => !(e.to === node.id && e.toPort === port));
  const options = recipe.nodes.filter((n) => n.id !== node.id && RECIPE_NODE_PORTS[n.type].output === kind && !reaches(otherEdges, node.id, n.id));
  const id = `wire-${node.id}-${port}`;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{RECIPE_PORT_LABELS[port]} from</label>
      <select id={id} value={current?.id || ''} onChange={(e) => onWire(port, e.target.value || null)} className={selectClass}>
        <option value="">Not connected</option>
        {options.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
      </select>
    </div>
  );
}

function ImageStrip({ images, onRemove, label }) {
  if (!images.length) return <p className="text-xs text-gray-500">No images.</p>;
  return (
    <ul className="grid grid-cols-3 sm:grid-cols-4 gap-1.5" aria-label={label}>
      {images.map((ref) => (
        <li key={ref.image} className="relative">
          <img src={takeSrc(ref)} alt={ref.label || ''} loading="lazy" className="w-full aspect-square object-cover rounded border border-port-border" />
          {ref.label && <span className="block truncate text-[10px] text-gray-400">{ref.label}</span>}
          {onRemove && (
            <button type="button" onClick={() => onRemove(ref)} aria-label={`Remove ${ref.label || 'reference'}`}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute top-0 right-0 min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded bg-black/70 text-white">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The Make tab: the board's recipe as a chain of node cards in run order,
 * each showing what it holds for this panel. Inputs are wired with "from"
 * pickers, so the phone can rewire without dragging. Recipe edits (nodes,
 * wires, system prompt, settings) apply to the whole board; an LLM output and
 * reference picks belong to this panel.
 */
export default function PanelMakeTab({ board, found, sketchNonce, handlers }) {
  const { beat, panel } = found;
  const recipe = useMemo(() => effectiveRecipe(board), [board]);
  const order = useMemo(() => recipeRunOrder(recipe), [recipe]);
  const [linkedRefs, setLinkedRefs] = useState([]);
  const [linkedError, setLinkedError] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [pickingRefsFor, setPickingRefsFor] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [searchParams, updateParams] = useUrlParams();
  const canvas = searchParams.get('makeView') === 'canvas';
  const selectedNode = recipe.nodes.find((n) => n.id === searchParams.get('node')) || null;
  const linkKey = [...panel.castIds, ...panel.environmentIds, ...panel.objectIds].join(',');
  const pickKey = Object.entries(panel.linkMedia || {}).map(([id, image]) => `${id}=${image}`).sort().join('|');

  useEffect(() => {
    let active = true;
    if (!linkKey) {
      setLinkedRefs([]);
      return undefined;
    }
    setLinkedError(false);
    getStoryboardPanelMake(board.id, panel.id, { silent: true })
      .then((res) => { if (active) setLinkedRefs(Array.isArray(res?.linkedRefs) ? res.linkedRefs : []); })
      // A failed read says so; it must not look like a panel with no cast images.
      .catch(() => { if (active) setLinkedError(true); });
    return () => { active = false; };
  }, [board.id, panel.id, linkKey, pickKey]);

  const context = { beat, panel, linkedRefs };
  const saveRecipe = (next) => handlers.onRecipe(next);
  const editNode = (nodeId, patch) => saveRecipe({ ...recipe, nodes: recipe.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) });
  const editSettings = (node, patch) => editNode(node.id, { settings: { ...node.settings, ...patch } });
  const wire = (node) => (port, fromId) => saveRecipe({
    ...recipe,
    edges: [...recipe.edges.filter((e) => !(e.to === node.id && e.toPort === port)), ...(fromId ? [{ from: fromId, to: node.id, toPort: port }] : [])],
  });
  // A canvas wire: the dropped-on input must take the output's kind, and a
  // wire that would close a cycle is refused so the input keeps its old wire.
  const connect = (fromId, toId, port) => {
    const from = recipe.nodes.find((n) => n.id === fromId);
    const to = recipe.nodes.find((n) => n.id === toId);
    if (!from || !to || RECIPE_NODE_PORTS[to.type].inputs[port] !== RECIPE_NODE_PORTS[from.type].output) return;
    if (reaches(recipe.edges.filter((e) => !(e.to === toId && e.toPort === port)), toId, fromId)) return;
    wire(to)(port, fromId);
  };
  const duplicate = (node) => {
    const copy = { ...structuredClone(node), id: newStoryboardEntityId('node'), title: `${node.title} copy`.slice(0, RECIPE_LIMITS.title), x: node.x + 40, y: node.y + 40 };
    const inbound = recipe.edges.filter((e) => e.to === node.id).map((e) => ({ ...e, to: copy.id }));
    saveRecipe({ nodes: [...recipe.nodes, copy], edges: [...recipe.edges, ...inbound] });
  };
  const remove = (node) => saveRecipe({
    nodes: recipe.nodes.filter((n) => n.id !== node.id),
    edges: recipe.edges.filter((e) => e.from !== node.id && e.to !== node.id),
  });
  const addNode = ({ type, title }) => {
    const last = recipe.nodes.at(-1);
    saveRecipe({
      ...recipe,
      nodes: [...recipe.nodes, { id: newStoryboardEntityId('node'), type, title, x: (last?.x ?? 0) + 40, y: (last?.y ?? 0) + 200, text: '', settings: {} }],
    });
  };

  const run = async (node) => {
    setRunningId(node.id);
    const ok = await handlers.onRunNode(node.id);
    setRunningId(null);
    return ok;
  };

  const bodyFor = (node) => {
    const state = panelNodeState(panel, node.id);
    const inputs = Object.keys(RECIPE_NODE_PORTS[node.type].inputs)
      .map((port) => <InputRow key={port} recipe={recipe} node={node} port={port} onWire={wire(node)} />);

    if (node.type === 'text') {
      const source = node.settings.source;
      return (
        <>
          <div>
            <label htmlFor={`src-${node.id}`} className={labelClass}>Words from</label>
            <select id={`src-${node.id}`} value={source} onChange={(e) => editSettings(node, { source: e.target.value })} className={selectClass}>
              {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          {source === 'custom' ? (
            <CommitField id={`text-${node.id}`} ariaLabel={`${node.title} text`} multiline value={node.text}
              maxLength={RECIPE_LIMITS.text} onCommit={(text) => editNode(node.id, { text })} />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-gray-300">{textNodeValue(node, context) || <span className="text-gray-500">Nothing yet: write the shot on the Shot tab.</span>}</p>
          )}
        </>
      );
    }
    if (node.type === 'system') {
      return (
        <CommitField id={`text-${node.id}`} ariaLabel={`${node.title} text`} multiline minHeightClass="min-h-[6rem]" value={node.text}
          maxLength={RECIPE_LIMITS.text} placeholder="How the model should write" onCommit={(text) => editNode(node.id, { text })} />
      );
    }
    if (node.type === 'llm') {
      return (
        <>
          {inputs}
          <div>
            <label htmlFor={`out-${node.id}`} className={labelClass}>Written prompt (yours to edit)</label>
            <CommitField id={`out-${node.id}`} multiline minHeightClass="min-h-[5rem]" value={state.text} maxLength={RECIPE_LIMITS.text}
              placeholder="Run to write it" onCommit={(text) => handlers.onNodePatch(node.id, { text })} />
          </div>
          {state.error && state.status === 'failed' && <p className="text-xs text-port-error" role="alert">{state.error}</p>}
          {state.providerId && <p className="text-[11px] text-gray-500">Last run: {state.providerId}{state.model ? ` · ${state.model}` : ''}</p>}
          <SentPromptPanel prompt={nodeInputValue(recipe, node.id, 'prompt', context)} sentPrompt={state.sentPrompt || null} additions={state.promptAdditions} />
        </>
      );
    }
    if (node.type === 'references') {
      const excluded = new Set(state.excludedRefs);
      const linked = node.settings.linked ? linkedRefs.filter((ref) => !excluded.has(ref.image)) : [];
      return (
        <>
          {node.images?.length > 0 && <ImageStrip label="Every panel" images={node.images} onRemove={(ref) => editNode(node.id, { images: node.images.filter((i) => i.image !== ref.image) })} />}
          {node.settings.linked && (
            <div>
              <span className={labelClass}>This panel's cast and sets</span>
              {linkedError && <p className="text-xs text-port-warning" role="status">Couldn't load the cast and set images; reopen the panel to retry.</p>}
              <ImageStrip label="Linked cast and sets" images={linked} onRemove={(ref) => handlers.onNodePatch(node.id, { excludedRefs: [...state.excludedRefs, ref.image] })} />
              {state.excludedRefs.length > 0 && (
                <button type="button" onClick={() => handlers.onNodePatch(node.id, { excludedRefs: [] })} className="mt-1 min-h-[44px] inline-flex items-center gap-1 text-xs text-gray-400 hover:text-white">
                  <RotateCcw size={12} aria-hidden="true" /> Bring back {state.excludedRefs.length} removed
                </button>
              )}
            </div>
          )}
          <div>
            <span className={labelClass}>Added for this panel</span>
            <ImageStrip label="Added references" images={state.extraRefs} onRemove={(ref) => handlers.onNodePatch(node.id, { extraRefs: state.extraRefs.filter((i) => i.image !== ref.image) })} />
          </div>
          <button type="button" onClick={() => setPickingRefsFor(node.id)} disabled={state.extraRefs.length >= RECIPE_LIMITS.images} className={actionButton}>
            <Plus size={16} aria-hidden="true" /> Add reference
          </button>
        </>
      );
    }
    if (node.type === 'image') {
      const { prompt, additions } = imageNodePrompt(recipe, node.id, context);
      const over = prompt.length > RECIPE_LIMITS.imagePrompt;
      const settled = state.takeIds.length + state.failedJobIds.length;
      return (
        <>
          {inputs}
          <p className={`text-[11px] ${over ? 'text-port-error' : 'text-gray-500'}`}>
            {prompt ? `Prompt ${formatCount(prompt.length)} / ${formatCount(RECIPE_LIMITS.imagePrompt)} characters` : 'No prompt yet: run the node that feeds it.'}
          </p>
          {state.status === 'queued' && <p className="text-xs text-gray-300" role="status">{settled} of {state.jobIds.length} frames back</p>}
          {state.error && <p className="text-xs text-port-error" role="alert">{state.error}</p>}
          <SentPromptPanel prompt={nodeInputValue(recipe, node.id, 'prompt', context)} sentPrompt={state.sentPrompt || prompt || null}
            additions={state.sentPrompt ? state.promptAdditions : additions} />
          {state.sentRefs.length > 0 && <ImageStrip label="References sent" images={state.sentRefs} />}
        </>
      );
    }
    // Panel: the frames of the image run wired in; a tap makes one the art.
    const frames = nodeInputValue(recipe, node.id, 'frames', context);
    const takes = frames.map((id) => panel.takes.find((t) => t.id === id)).filter(Boolean);
    return (
      <>
        {inputs}
        {takes.length ? (
          <>
            <p className="text-[11px] text-gray-500">Tap a frame to make it the panel art. Every frame stays as a take.</p>
            <ul className="grid grid-cols-2 gap-1.5" aria-label="Frames">
              {takes.map((take, index) => (
                <li key={take.id}>
                  <button type="button" onClick={() => handlers.onSelectTake(take.id)} aria-pressed={take.id === panel.selectedTakeId}
                    aria-label={`Frame ${index + 1}`}
                    className={`block w-full rounded overflow-hidden border ${take.id === panel.selectedTakeId ? 'border-port-accent ring-2 ring-port-accent' : 'border-port-border'}`}>
                    <img src={takeSrc(take, sketchNonce(take.sketchKey))} alt="" loading="lazy" className="w-full object-cover" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : <p className="text-xs text-gray-500">Frames from the image run show here.</p>}
      </>
    );
  };

  const settingsFor = (node) => {
    const title = (
      <div>
        <label htmlFor={`title-${node.id}`} className={labelClass}>Title</label>
        <CommitField id={`title-${node.id}`} value={node.title} maxLength={RECIPE_LIMITS.title} onCommit={(t) => editNode(node.id, { title: t.trim() || RECIPE_TYPE_TITLES[node.type] })} />
      </div>
    );
    if (node.type === 'llm') {
      return (
        <>
          {title}
          <MusicVideoLlmPicker idPrefix={`node-${node.id}`} label="Model" value={node.settings}
            emptyProviderOption="Default (active provider)" fallbackName="The active provider" hint={null}
            onChange={(next) => editSettings(node, next)} />
        </>
      );
    }
    if (node.type === 'image') {
      return (
        <>
          {title}
          <RecordRenderPinRow idPrefix={`node-${node.id}`} label="Image model" imageMode={node.settings.imageMode} imageModelId={node.settings.imageModelId}
            onChange={(pin) => editSettings(node, pin)} />
          <div>
            <label htmlFor={`count-${node.id}`} className={labelClass}>Frames per run</label>
            <select id={`count-${node.id}`} value={node.settings.count} onChange={(e) => editSettings(node, { count: Number(e.target.value) })} className={selectClass}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </>
      );
    }
    if (node.type === 'references') {
      return (
        <>
          {title}
          <label className="min-h-[44px] flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={node.settings.linked} onChange={(e) => editSettings(node, { linked: e.target.checked })} aria-label="Include the panel's cast and sets" />
            Include the panel's cast and sets
          </label>
        </>
      );
    }
    return title;
  };

  const nodeCard = (node) => {
    const state = panelNodeState(panel, node.id);
    return (
      <RecipeNodeCard
        key={node.id}
        node={node}
        status={state.status}
        running={runningId === node.id}
        canRun={RUNNABLE.has(node.type)}
        runLabel={node.type === 'image' ? `Make ${node.settings.count} frame${node.settings.count === 1 ? '' : 's'}` : 'Run'}
        onRun={() => run(node)}
        onDuplicate={() => duplicate(node)}
        onDelete={() => remove(node)}
        settings={settingsFor(node)}
      >
        {bodyFor(node)}
      </RecipeNodeCard>
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-300">
        How this board draws a panel: the image model reads the shot as you wrote it, then the storyboard style, with the references beside it.
        No LLM rewrites it unless you add a Prompt enhancer between the shot and the image. Here you can read the exact prompt sent and edit the style.
      </p>
      <DrawPanelButton panel={panel} onDraw={handlers.onDraw} />
      {board.recipe && !confirmReset && (
        <button type="button" onClick={() => setConfirmReset(true)} className={actionButton}>
          <RotateCcw size={16} aria-hidden="true" /> Default recipe
        </button>
      )}
      {confirmReset && (
        <InlineConfirmRow autoFocus aria-label="Restore the default recipe" confirmText="Restore" tone="warning"
          question="Restore the default recipe? This board's node edits and wiring are replaced."
          onConfirm={() => { setConfirmReset(false); saveRecipe(null); }} onCancel={() => setConfirmReset(false)} />
      )}
      <RecipeLibrary recipe={recipe} onLoad={saveRecipe} />
      <p className="text-[11px] text-gray-500">The recipe is shared by every panel on this board.</p>
      <div className="hidden lg:block">
        <TabPills tabs={VIEW_TABS} activeTab={canvas ? 'canvas' : 'chain'} variant="pills" size="sm" ariaLabel="Recipe view"
          onChange={(next) => updateParams({ makeView: next === 'canvas' ? 'canvas' : null }, { replace: true })} />
      </div>
      {canvas ? (
        <>
          <div className="h-[420px]">
            <RecipeCanvas
              recipe={recipe}
              statusOf={(nodeId) => panelNodeState(panel, nodeId).status}
              selectedId={selectedNode?.id || null}
              onSelect={(nodeId) => updateParams({ node: nodeId }, { replace: true })}
              onMove={(nodeId, pos) => editNode(nodeId, pos)}
              onConnect={connect}
            />
          </div>
          {selectedNode ? nodeCard(selectedNode) : <p className="text-xs text-gray-500">Tap a node to open it here. Drag from a node's blue dot to an input to wire it.</p>}
        </>
      ) : order.map(nodeCard)}
      {adding ? (
        <div className="rounded-xl border border-dashed border-port-border p-2">
          <p className="text-[11px] text-gray-500 mb-1">Add a node</p>
          <div className="grid grid-cols-2 gap-1.5">
            {ADDABLE.map((item) => {
              const Icon = NODE_ICONS[item.type];
              return (
                <button key={item.title} type="button" onClick={() => { setAdding(false); addNode(item); }} className={actionButton}>
                  <Icon size={16} aria-hidden="true" /> {item.title}
                </button>
              );
            })}
            <button type="button" onClick={() => setAdding(false)} className={actionButton}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} disabled={recipe.nodes.length >= RECIPE_LIMITS.nodes} className={actionButton}>
          <Plus size={16} aria-hidden="true" /> Node
        </button>
      )}
      <GalleryImagePicker
        open={!!pickingRefsFor}
        allowUpload
        onClose={() => setPickingRefsFor(null)}
        onSelect={(image) => {
          const nodeId = pickingRefsFor;
          setPickingRefsFor(null);
          if (!image?.filename || !nodeId) return;
          const state = panelNodeState(panel, nodeId);
          handlers.onNodePatch(nodeId, { extraRefs: [...state.extraRefs, { image: image.filename }] });
        }}
      />
    </div>
  );
}
