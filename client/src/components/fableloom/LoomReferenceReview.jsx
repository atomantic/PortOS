import MediaImage from '../MediaImage';

function ReferenceFrame({ node, label, onSelectNode, paired = false }) {
  return <figure className={paired ? "min-w-0 grid gap-2 sm:row-span-4 sm:grid-rows-subgrid" : "min-w-0 space-y-2"}>
    <figcaption className="text-xs font-medium">
      {label}: {node.title || 'Untitled shot'}
      {onSelectNode && <button type="button" className="ml-2 min-h-11 text-port-accent hover:underline" onClick={() => onSelectNode(node.id)} aria-label={`Edit reference shot: ${node.title || 'Untitled shot'}`}>Edit shot</button>}
    </figcaption>
    {node.image
      ? <a href={`/data/images/${encodeURIComponent(node.image)}`} target="_blank" rel="noreferrer" aria-label={`Open full reference: ${node.title || 'Untitled shot'}`} className="block rounded border border-port-border overflow-hidden">
          <MediaImage src={`/data/images/${encodeURIComponent(node.image)}`} alt={`${label}: ${node.title || 'Untitled shot'}`} className="aspect-video w-full object-contain bg-port-bg" />
        </a>
      : <div className="aspect-video grid place-items-center rounded border border-dashed border-port-border p-3 text-xs text-port-text-muted">No reference image yet</div>}
    <p className="text-xs text-port-text-muted">{node.shot?.framing || 'Framing not specified'}{node.shot?.durationSeconds ? ` · ${node.shot.durationSeconds}s` : ''}</p>
    {node.visualCanon?.shotNotes && <p className="text-xs whitespace-pre-wrap">Continuity: {node.visualCanon.shotNotes}</p>}
  </figure>;
}

/** Compare actual incoming graph shots, including every path at a branch merge. */
export default function LoomReferenceReview({ episode, node, onSelectNode }) {
  const predecessors = (episode.nodes || []).filter((candidate) => candidate.id !== node.id
    && !candidate.isEnding && candidate.transitions?.some((transition) => transition.targetNodeId === node.id));
  const preferred = node.visualCanon?.continuitySourceNodeId;
  return <section className="rounded border border-port-accent/30 p-3 space-y-3" aria-label={`Reference image review: ${node.title || 'Untitled shot'}`}>
    <h4 className="text-sm font-semibold">Review images before video</h4>
    <p className="text-xs text-port-text-muted">Compare camera angle, room layout, lighting, wardrobe, and props across the cut. Open either image at full size to inspect details.</p>
    {predecessors.length > 1 && <p className="text-xs text-port-warning">This shot follows {predecessors.length} incoming paths. Check continuity from each one.</p>}
    {predecessors.length ? predecessors.map((previous) => <div key={previous.id} className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-port-border pt-3">
      <ReferenceFrame paired node={previous} label={previous.id === preferred ? 'Previous · chosen continuity source' : 'Previous'} onSelectNode={onSelectNode} />
      <ReferenceFrame paired node={node} label="Current" />
    </div>) : <>
      <p className="text-xs text-port-text-muted">{episode.startNodeId === node.id ? 'Opening shot — establishes the visual setting.' : 'No incoming graph shot to compare.'}</p>
      <ReferenceFrame node={node} label="Current" />
    </>}
  </section>;
}
