function targetCopy(target) {
  if (!target) return null;
  const isWarpPad = target.type === 'warpPad';
  const label = target.label || (isWarpPad ? 'REGION' : 'BUILDING');
  return {
    eyebrow: target.eyebrow || (isWarpPad ? 'WARP GATE' : 'NEARBY BUILDING'),
    action: target.action || (isWarpPad ? 'WARP TO' : 'OPEN'),
    label,
  };
}

export default function OpenWorldInteractionPrompt({ target, compact = false }) {
  const copy = targetCopy(target);
  if (!copy) return null;

  return (
    <div
      className={`openworld-interaction-prompt ${compact ? 'openworld-interaction-prompt--compact' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="openworld-interaction-prompt"
    >
      <span className="openworld-hud-eyebrow">{copy.eyebrow}</span>
      <span className="openworld-interaction-prompt__label">{copy.label}</span>
      <span className="openworld-interaction-prompt__action">
        <kbd>{compact ? 'ACTION' : 'F'}</kbd>
        {copy.action}
      </span>
    </div>
  );
}
