import { describe, expect, it } from 'vitest';
import {
  buildEpisodeProductionPlan,
  computeTopologicalNodeOrder,
  verifyExactInputProvenance,
} from './fableLoomProduction.js';

describe('fableLoomProduction', () => {
  const sampleEpisode = {
    id: 'ep-1',
    startNodeId: 'node-1',
    nodes: [
      {
        id: 'node-1',
        title: 'Opening Scene',
        prose: 'Opening scene prose.',
        imagePrompt: 'A wide vista at sunset.',
        videoPrompt: 'Camera slowly pans left.',
        transitions: [
          { id: 'tr-1', targetNodeId: 'node-2', intent: 'Go north' },
          { id: 'tr-2', targetNodeId: 'node-3', intent: 'Go south' },
        ],
      },
      {
        id: 'node-2',
        title: 'North Forest',
        prose: 'Dark misty woods.',
        imagePrompt: 'Misty forest path.',
        videoPrompt: 'Tracking shot through trees.',
        transitions: [
          { id: 'tr-3', targetNodeId: 'node-4', intent: 'Enter cave' },
        ],
      },
      {
        id: 'node-3',
        title: 'South Bridge',
        prose: 'Old stone bridge over river.',
        imagePrompt: 'Ancient stone bridge.',
        videoPrompt: 'Aerial shot over water.',
        transitions: [
          { id: 'tr-4', targetNodeId: 'node-4', intent: 'Cross into cave' },
        ],
      },
      {
        id: 'node-4',
        title: 'Convergence Cave',
        prose: 'Deep subterranean cavern.',
        imagePrompt: 'Crystal cave interior.',
        videoPrompt: 'Dolly forward into cavern.',
        isEnding: true,
        transitions: [],
      },
      {
        id: 'node-unreachable',
        title: 'Floating Island',
        prose: 'An unreachable island in the clouds.',
        transitions: [],
      },
    ],
  };

  it('computes topological node ordering and detects convergence', () => {
    const topo = computeTopologicalNodeOrder(sampleEpisode);
    expect(topo.orderedNodes.map((n) => n.id)).toEqual(['node-1', 'node-2', 'node-3', 'node-4']);
    expect(topo.depthById.get('node-1')).toBe(0);
    expect(topo.depthById.get('node-2')).toBe(1);
    expect(topo.depthById.get('node-3')).toBe(1);
    expect(topo.depthById.get('node-4')).toBe(2);

    expect(topo.convergenceNodeIds.has('node-4')).toBe(true);
    expect(topo.unreachableNodeIds.has('node-unreachable')).toBe(true);
  });

  it('builds comprehensive episode production plan with assets and dependencies', () => {
    const plan = buildEpisodeProductionPlan({
      episode: sampleEpisode,
      loom: { id: 'loom-1' },
      mode: 'current_canon',
    });

    expect(plan.mode).toBe('current_canon');
    expect(plan.totalNodes).toBe(5);
    expect(plan.reachableNodeCount).toBe(4);
    expect(plan.unreachableNodeCount).toBe(1);
    expect(plan.assetsByType.image).toBe(4);
    expect(plan.assetsByType.video).toBeGreaterThanOrEqual(4);

    // Node-1 (opening) should have no image dependencies
    const node1Image = plan.plannedAssets.find((a) => a.id === 'asset-node-1-still');
    expect(node1Image.dependencies).toEqual([]);

    // Node-2 (child of node-1) should depend on node-1 still
    const node2Image = plan.plannedAssets.find((a) => a.id === 'asset-node-2-still');
    expect(node2Image.dependencies).toEqual(['asset-node-1-still']);

    // Video should depend on own still
    const node1Video = plan.plannedAssets.find((a) => a.id === 'asset-node-1-video-entry');
    expect(node1Video.dependencies).toEqual(['asset-node-1-still']);

    // Convergence note for node-4
    expect(plan.convergenceIssues.length).toBe(1);
    expect(plan.convergenceIssues[0].nodeId).toBe('node-4');
    expect(plan.convergenceIssues[0].selectedPredecessorId).toBeNull();
    expect(plan.plannedAssets.find((a) => a.id === 'asset-node-4-still').temporalSourceNodeId).toBeNull();

    const stillStage = plan.executionStages.find((stage) => stage.assetIds.includes('asset-node-1-still'));
    const videoStage = plan.executionStages.find((stage) => stage.assetIds.includes('asset-node-1-video-entry'));
    expect(videoStage.stageIndex).toBeGreaterThan(stillStage.stageIndex);
  });

  it('refuses exact-input planning when a node has no recorded provenance', () => {
    const plan = buildEpisodeProductionPlan({
      episode: sampleEpisode,
      mode: 'exact_inputs',
    });

    expect(plan.isFullyReady).toBe(false);
    expect(plan.exactInputIssues.length).toBe(4);
    expect(plan.exactInputIssues[0].errors[0]).toContain('No recorded provenance');
  });

  it('verifies exact input provenance matching without silent substitution', () => {
    const validProvenance = {
      version: 1,
      characters: [
        {
          characterId: 'char-1',
          lora: { filename: 'char-1-flux.safetensors', sha256: 'abc123sha' },
          voice: {
            profileId: 'vp-1', profileVersion: 2, engine: 'kokoro', modelRevision: 'rev-1',
          },
        },
      ],
    };

    const universe = { characters: [{ id: 'char-1', name: 'Hero' }] };
    const localVoiceProfiles = [{ id: 'vp-1', version: 2, engine: 'kokoro', modelRevision: 'rev-1' }];
    const localLoras = [{ filename: 'char-1-flux.safetensors', sha256: 'abc123sha' }];

    const result = verifyExactInputProvenance(validProvenance, {
      universe,
      localVoiceProfiles,
      localLoras,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Mismatched LoRA hash
    const mismatchedLora = verifyExactInputProvenance(validProvenance, {
      universe,
      localVoiceProfiles,
      localLoras: [{ filename: 'char-1-flux.safetensors', sha256: 'different-hash' }],
    });
    expect(mismatchedLora.valid).toBe(false);
    expect(mismatchedLora.errors[0]).toContain('checksum mismatch');

    // Mismatched Voice Profile version
    const mismatchedVoice = verifyExactInputProvenance(validProvenance, {
      universe,
      localVoiceProfiles: [{ id: 'vp-1', version: 3, engine: 'kokoro', modelRevision: 'rev-1' }],
      localLoras,
    });
    expect(mismatchedVoice.valid).toBe(false);
    expect(mismatchedVoice.errors[0]).toContain('version mismatch');

    const missingModelRevision = verifyExactInputProvenance(validProvenance, {
      universe,
      localVoiceProfiles: [{ id: 'vp-1', version: 2, engine: 'kokoro' }],
      localLoras,
    });
    expect(missingModelRevision.valid).toBe(false);
    expect(missingModelRevision.errors.some((error) => error.includes('model revision mismatch'))).toBe(true);
  });

  it('refuses exact visual reproduction when local inputs are empty, missing, or revised', () => {
    const visualProvenance = {
      version: 1,
      compilerVersion: 'visual-v1',
      status: 'locked',
      universeId: 'univ-1',
      capability: {
        kind: 'image',
        backend: 'local',
        modelId: 'image-model',
        modelRevision: 'revision-1',
      },
      bindings: { inferred: false, characterAppearances: [], objectIds: [] },
      assets: [{ role: 'environment', required: true, filename: 'environment.png' }],
      adapters: [],
      omitted: [],
      warnings: [],
    };
    const baseOptions = {
      universe: { id: 'univ-1', characters: [], places: [], objects: [] },
      availableImageModels: [{ id: 'image-model', revision: 'revision-1' }],
      resolveAsset: () => '/safe/environment.png',
    };

    expect(verifyExactInputProvenance(visualProvenance, baseOptions).valid).toBe(true);
    expect(verifyExactInputProvenance(visualProvenance, {
      ...baseOptions,
      availableImageModels: [],
    }).errors).toContain('Recorded image model "image-model" is not available locally.');
    expect(verifyExactInputProvenance(visualProvenance, {
      ...baseOptions,
      availableImageModels: [{ id: 'image-model', revision: 'revision-2' }],
    }).errors.some((error) => error.includes('revision mismatch'))).toBe(true);
    const unpinned = structuredClone(visualProvenance);
    delete unpinned.capability.modelRevision;
    expect(verifyExactInputProvenance(unpinned, baseOptions).errors.some((error) => error.includes('immutable model revision'))).toBe(true);
    expect(verifyExactInputProvenance(visualProvenance, {
      ...baseOptions,
      resolveAsset: () => null,
    }).errors).toContain('Recorded visual conditioning asset "environment.png" is unavailable locally.');
  });
});
