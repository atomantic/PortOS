/**
 * Brain Graph Data Service
 *
 * Computes a graph of brain entities with edges derived from:
 * - Semantic similarity (via CoS memory embeddings through the bridge)
 * - Shared tags (Jaccard similarity)
 * - Explicit CoS memory links (through the bridge)
 */

import * as brainStorage from './brainStorage.js';
import * as memoryBackend from './memoryBackend.js';
import { loadBridgeMap, bridgeKey } from './brainMemoryBridge.js';

const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories'];

function jaccardSimilarity(tagsA, tagsB) {
  if (!tagsA?.length || !tagsB?.length) return 0;
  const setA = new Set(tagsA);
  const setB = new Set(tagsB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function getBrainGraphData() {
  // 1. Load all brain entities, filter archived
  const nodes = [];
  for (const type of ENTITY_TYPES) {
    const records = await brainStorage.getAll(type);
    for (const record of records) {
      if (record.archived) continue;
      nodes.push({
        id: record.id,
        brainType: type,
        label: record.name || record.title || '(untitled)',
        summary: record.context || record.oneLiner || record.notes || record.content || '',
        tags: record.tags || [],
        importance: 0.6,
        status: record.status
      });
    }
  }

  if (!nodes.length) return { nodes: [], edges: [], hasEmbeddings: false };

  // 2. Load bridge map and build reverse map (memoryId → brainId)
  const bridgeMap = await loadBridgeMap();
  const reverseBridge = {};
  for (const [bKey, memId] of Object.entries(bridgeMap)) {
    reverseBridge[memId] = bKey.split(':')[1]; // extract brainId from "type:id"
  }

  // Build brainId set for quick lookup
  const brainIdSet = new Set(nodes.map(n => n.id));

  // 3. Get CoS graph data and remap edges through bridge
  const edges = [];
  const seenEdges = new Set();
  let hasEmbeddings = false;

  const cosGraph = await memoryBackend.getGraphData().catch(() => null);
  if (cosGraph) {
    for (const edge of cosGraph.edges) {
      const brainSourceId = reverseBridge[edge.source];
      const brainTargetId = reverseBridge[edge.target];
      if (!brainSourceId || !brainTargetId) continue;
      if (!brainIdSet.has(brainSourceId) || !brainIdSet.has(brainTargetId)) continue;
      if (brainSourceId === brainTargetId) continue;

      const edgeKey = [brainSourceId, brainTargetId].sort().join('-');
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      hasEmbeddings = true;

      edges.push({
        source: brainSourceId,
        target: brainTargetId,
        type: edge.type === 'linked' ? 'linked' : 'similar',
        weight: edge.weight
      });
    }
  }

  // 4. Compute tag-based edges (Jaccard >= 0.3)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const edgeKey = [a.id, b.id].sort().join('-');
      if (seenEdges.has(edgeKey)) continue;

      const similarity = jaccardSimilarity(a.tags, b.tags);
      if (similarity >= 0.3) {
        seenEdges.add(edgeKey);
        edges.push({
          source: a.id,
          target: b.id,
          type: 'shared_tag',
          weight: similarity
        });
      }
    }
  }

  return { nodes, edges, hasEmbeddings };
}
