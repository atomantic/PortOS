/**
 * Legacy proactive alert aggregation.
 *
 * The Review Queue consumes non-product sources and product metrics
 * separately. This compatibility aggregate keeps the existing alerts API
 * shape, including product engagement, until the attention surfaces migrate.
 */

import { getProductEngagement } from './portosProductMetrics.js';
import { generateNonProductAlerts } from './proactiveAlertSources.js';

/**
 * Generate all legacy proactive alerts by combining non-product health
 * signals with the product-engagement compatibility projection.
 */
export async function generateAlerts() {
  const startMs = Date.now();
  const [nonProductAlerts, productResult] = await Promise.all([
    generateNonProductAlerts(),
    getProductEngagement().catch(() => null),
  ]);
  const productAlerts = productResult?.actions || [];
  const all = [...nonProductAlerts, ...productAlerts];

  // Sort by severity: critical > high > medium > low.
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  all.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  const counts = { total: all.length, critical: 0, high: 0, medium: 0 };
  for (const alert of all) {
    if (counts[alert.severity] !== undefined) counts[alert.severity]++;
  }

  const durationMs = Date.now() - startMs;
  console.log(`🔔 Proactive alerts: ${counts.total} (critical: ${counts.critical}, high: ${counts.high}) in ${durationMs}ms`);

  return { alerts: all, counts, checkedAt: new Date().toISOString() };
}

/** Get a compact summary suitable for dashboard display. */
export async function getAlertsSummary() {
  const result = await generateAlerts();
  return {
    alerts: result.alerts.slice(0, 5),
    counts: result.counts,
    checkedAt: result.checkedAt,
  };
}
