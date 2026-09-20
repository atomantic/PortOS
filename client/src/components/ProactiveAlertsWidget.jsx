import ActionQueuePreview from './ActionQueuePreview';

// Saved proactive-alerts layouts retain their health/product focus.
export default function ProactiveAlertsWidget() {
  return <ActionQueuePreview title="Proactive Alerts" sources={['health', 'backup', 'product']} />;
}
