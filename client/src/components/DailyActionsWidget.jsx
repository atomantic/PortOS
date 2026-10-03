import ActionQueuePreview from './ActionQueuePreview';

// Saved daily-actions layouts remain a filtered product recommendation view.
export default function DailyActionsWidget() {
  return <ActionQueuePreview
    title="Daily recommendations"
    sources={['product']}
    scopeDescription="Product recommendations only. Required actions from other sources are not shown here."
  />;
}
