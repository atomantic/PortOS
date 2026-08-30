/**
 * FableLoom episode outline — a text-first reading order for an episode graph.
 *
 * Reachable scenes are ordered breadth-first from the opening scene so the
 * outline follows the same progression as the graph layout. Scene titles and
 * metadata stay visible in the tree while authored prose and intent paths are
 * available behind collapsed disclosures; selecting a path returns to the
 * visual editor with that scene selected.
 */

import { useMemo } from 'react';
import { ArrowRight, ChevronRight, Flag, Play, Waypoints } from 'lucide-react';
import { sceneProseClass } from './fieldStyles';

const asArray = (value) => (Array.isArray(value) ? value : []);

const orderEpisodeNodes = (episode) => {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = [];
  const visited = new Set();
  const queue = byId.has(episode?.startNodeId) ? [episode.startNodeId] : [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const nodeId = queue[queueIndex];
    queueIndex += 1;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) continue;
    ordered.push(node);
    for (const transition of asArray(node.transitions)) {
      if (byId.has(transition?.targetNodeId) && !visited.has(transition.targetNodeId)) {
        queue.push(transition.targetNodeId);
      }
    }
  }

  return {
    reachable: ordered,
    unreachable: nodes.filter((node) => !visited.has(node.id)),
    byId,
  };
};

function SceneBlock({ node, number, episode, format, byId, onSelectNode }) {
  const isStart = node.id === episode.startNodeId;
  const transitions = asArray(node.transitions);

  return (
    <li className="relative pl-8 sm:pl-10" data-testid={`outline-scene-${node.id}`}>
      <span className="absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-full border border-port-border bg-port-card text-[10px] font-semibold text-port-text-muted sm:h-7 sm:w-7">
        {number}
      </span>
      <details className="group rounded-lg border border-port-border bg-port-card">
        <summary className="flex list-none items-start justify-between gap-3 p-4 text-left hover:bg-port-bg/30 [&::-webkit-details-marker]:hidden">
          <div className="flex min-w-0 items-start gap-2">
            <ChevronRight
              size={16}
              className="mt-0.5 shrink-0 text-port-text-muted transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h3 className="font-semibold text-port-text break-words">{node.title || 'Untitled scene'}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-port-text-muted">
                {isStart && <span className="inline-flex items-center gap-1 text-port-accent"><Play size={11} /> Opening</span>}
                {node.isEnding && (
                  <span className="inline-flex items-center gap-1 text-port-success">
                    <Flag size={11} /> {node.endingLabel || 'Ending'}
                  </span>
                )}
                {!node.isEnding && (
                  <span>{node.playbackMode === 'cut' ? 'Automatic cut' : 'Decision loop'}</span>
                )}
                {node.protagonistPresence && (
                  <span className={node.protagonistPresence === 'offscreen' ? 'text-port-accent' : ''}>
                    Protagonist {node.protagonistPresence === 'offscreen' ? 'off-screen · side-device' : 'on-screen'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <span className="shrink-0 text-[11px] text-port-text-muted">Scene {number}</span>
        </summary>

        <div className="space-y-3 border-t border-port-border p-4">
          {node.prose?.trim() ? (
            <div className={`${sceneProseClass(format)} text-port-text`}>
              {node.prose}
            </div>
          ) : (
            <p className="text-sm italic text-port-text-muted">No scene text yet.</p>
          )}

          {transitions.length > 0 && (
            <div className="border-t border-port-border pt-3">
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-port-text-muted">
                {node.playbackMode === 'cut' ? 'Next cut' : 'Viewer paths'}
              </h4>
              <ul className="space-y-1.5">
                {transitions.map((transition) => {
                  const target = byId.get(transition.targetNodeId);
                  return (
                    <li key={transition.id || `${node.id}-${transition.targetNodeId}-${transition.intent}`} className="flex items-start gap-2 text-xs">
                      <ArrowRight size={13} className="mt-0.5 shrink-0 text-port-accent" />
                      <span className="min-w-0">
                        <span className="font-medium">{transition.intent || 'Unlabeled path'}</span>
                        {transition.description && <span className="text-port-text-muted"> — {transition.description}</span>}
                        {' '}
                        {target ? (
                          <button
                            type="button"
                            onClick={() => onSelectNode?.(target.id)}
                            className="text-port-accent hover:underline"
                          >
                            Scene {target.number}: {target.title || 'Untitled scene'}
                          </button>
                        ) : (
                          <span className="text-port-error">Missing scene</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

function BeatOutline({ outline }) {
  const scenes = asArray(outline?.scenes);
  if (!scenes.length) return null;
  return (
    <section className="rounded-lg border border-port-accent/30 bg-port-accent/5 p-4" aria-label="Story beat outline">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Story beat outline</h3>
          <p className="mt-1 text-xs text-port-text-muted">The validated log-line arc that this teleplay expands.</p>
        </div>
        <span className={`shrink-0 text-xs ${outline.validation?.status === 'valid' ? 'text-port-success' : 'text-port-warning'}`}>
          {outline.validation?.status || 'draft'}
        </span>
      </div>
      <ol className="mt-3 space-y-2">
        {scenes.map((scene, index) => (
          <li key={scene.key || index} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-[10px] font-semibold text-port-accent">{index + 1}</span>
            <span className="min-w-0">
              <span className="font-medium">{scene.title || 'Untitled beat'}</span>
              <span className="block whitespace-pre-wrap text-xs text-port-text-muted">{scene.summary || 'No log-line yet.'}</span>
              {scene.protagonistPresence && (
                <span className="mt-1 block text-[11px] text-port-accent">
                  Protagonist {scene.protagonistPresence === 'offscreen' ? 'off-screen · side-device' : 'on-screen'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function LoomEpisodeOutline({ loom, episode, onSelectNode }) {
  const { reachable, unreachable, byId } = useMemo(() => orderEpisodeNodes(episode), [episode]);
  const nodes = asArray(episode?.nodes);
  const endingCount = nodes.filter((node) => node.isEnding).length;
  const numberedNodes = useMemo(() => {
    const numbers = new Map();
    [...reachable, ...unreachable].forEach((node, index) => numbers.set(node.id, index + 1));
    return numbers;
  }, [reachable, unreachable]);

  const numberedById = useMemo(
    () => new Map([...byId].map(([id, node]) => [id, { ...node, number: numberedNodes.get(id) }])),
    [byId, numberedNodes],
  );

  if (!reachable.length && !unreachable.length && !episode.storyOutline?.scenes?.length) {
    return (
      <section className="flex-1 overflow-y-auto p-4 md:p-6" aria-label="Episode outline">
        <div className="mx-auto grid min-h-full max-w-4xl place-items-center text-center">
          <div>
            <Waypoints size={32} className="mx-auto mb-3 text-port-text-muted" />
            <h2 className="font-semibold">No scenes yet</h2>
            <p className="mt-1 text-sm text-port-text-muted">Add a scene or weave this episode to start its outline.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 overflow-y-auto p-4 md:p-6" aria-label="Episode outline">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-port-accent">{loom.name}</p>
              <h2 className="mt-1 text-xl font-semibold">{episode.title || 'Untitled episode'}</h2>
            </div>
            <span className="shrink-0 text-xs text-port-text-muted">
              {nodes.length} scene{nodes.length === 1 ? '' : 's'} · {endingCount} ending{endingCount === 1 ? '' : 's'}
            </span>
          </div>
          {episode.synopsis && <p className="mt-2 max-w-3xl text-sm text-port-text-muted">{episode.synopsis}</p>}
        </header>

        {episode.storyOutline?.scenes?.length ? <BeatOutline outline={episode.storyOutline} /> : null}

        {reachable.length || unreachable.length ? (
          <>
            <p className="text-xs uppercase tracking-wide text-port-text-muted">Expanded teleplay scenes</p>
            <ol className="space-y-4 border-l border-port-border pl-0">
              {reachable.map((node) => (
                <SceneBlock
                  key={node.id}
                  node={node}
                  number={numberedNodes.get(node.id)}
                  episode={episode}
                  format={loom.format}
                  byId={numberedById}
                  onSelectNode={onSelectNode}
                />
              ))}
            </ol>
          </>
        ) : (
          <p className="rounded border border-port-border p-4 text-sm text-port-text-muted">No teleplay scenes yet. Expand the validated beat outline from Episode setup.</p>
        )}

        {unreachable.length > 0 && (
          <section className="rounded-lg border border-port-warning/40 bg-port-warning/5 p-4" aria-label="Unreachable scenes">
            <div className="mb-3">
              <h3 className="font-semibold">Unreachable scenes</h3>
              <p className="mt-1 text-xs text-port-text-muted">These scenes are saved in the episode but cannot be reached from its opening scene.</p>
            </div>
            <ol className="space-y-4 border-l border-port-border pl-0">
              {unreachable.map((node) => (
                <SceneBlock
                  key={node.id}
                  node={node}
                  number={numberedNodes.get(node.id)}
                  episode={episode}
                  format={loom.format}
                  byId={numberedById}
                  onSelectNode={onSelectNode}
                />
              ))}
            </ol>
          </section>
        )}
      </div>
    </section>
  );
}
