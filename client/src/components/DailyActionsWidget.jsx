import ActionQueuePreview from './ActionQueuePreview';

// Saved daily-actions layouts remain a filtered product recommendation view.
export default function DailyActionsWidget() {
  return <ActionQueuePreview title="Today's actions" sources={['product']} />;
}
