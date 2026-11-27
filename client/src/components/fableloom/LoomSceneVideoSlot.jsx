

export default function LoomSceneVideoSlot({ node, compact, title, previewItemClass, onInteract }) {
  return (
    <video
      src={`/data/videos/${encodeURIComponent(node.videoHistoryId)}.mp4`}
      aria-label={`${title} video preview`}
      className={`${previewItemClass} block h-full w-full object-cover`}
      controls={!compact}
      autoPlay={compact}
      muted={compact}
      loop={compact}
      playsInline
      preload={compact ? 'metadata' : 'none'}
      onPointerDown={onInteract}
      onClick={onInteract}
    />
  );
}
