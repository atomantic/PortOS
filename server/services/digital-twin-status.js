import { loadMeta } from './digital-twin-meta.js';
import { getDocuments } from './digital-twin-documents.js';
import { getEnrichmentProgress } from './digital-twin-enrichment.js';

export async function getDigitalTwinStatus() {
  const meta = await loadMeta();
  const documents = await getDocuments();
  const testHistory = meta.testHistory.slice(0, 5);
  const enrichmentProgress = await getEnrichmentProgress();

  // Calculate health score
  const docScore = Math.min(1, documents.filter(d => d.enabled).length / 5);
  const testScore = testHistory.length > 0 ? testHistory[0].score : 0;
  const enrichScore = enrichmentProgress.completedCount / enrichmentProgress.totalCategories;

  const healthScore = Math.round(((docScore + testScore + enrichScore) / 3) * 100);

  return {
    healthScore,
    documentCount: documents.length,
    enabledDocuments: documents.filter(d => d.enabled).length,
    documentsByCategory: {
      core: documents.filter(d => d.category === 'core').length,
      audio: documents.filter(d => d.category === 'audio').length,
      behavioral: documents.filter(d => d.category === 'behavioral').length,
      enrichment: documents.filter(d => d.category === 'enrichment').length
    },
    lastTestRun: testHistory[0] || null,
    enrichmentProgress: {
      completedCategories: enrichmentProgress.completedCount,
      totalCategories: enrichmentProgress.totalCategories
    },
    settings: meta.settings
  };
}

export const getSoulStatus = getDigitalTwinStatus; // Alias for backwards compatibility
