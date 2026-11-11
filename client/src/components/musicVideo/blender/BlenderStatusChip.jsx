import Pill from '../../ui/Pill';

/**
 * One render status as colour plus words ("Preview rendering 42%", "Final
 * stale"). `view` is a `blenderShotRenderStatus(…)` reading; its `detail`
 * (why it is stale, how far a partial render got) is the tooltip.
 */
export default function BlenderStatusChip({ label, view }) {
  return (
    <Pill size="xs" tone={view.tone} title={view.detail || undefined} className="whitespace-nowrap">
      {label} {view.text}
    </Pill>
  );
}
