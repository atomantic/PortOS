/** Registers federation categories, their wire handlers, and the sources that invalidate their checksums. */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { RECORD_KIND_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';
import { getChangeToken } from '../changeToken.js';
import { DIGITAL_TWIN_CHECKSUM_PATHS, getDigitalTwinSnapshot, applyDigitalTwinRemote } from '../digital-twin-sync.js';
import { USAGE_CHECKSUM_PATHS, getUsageSnapshot, getUsageManifest, applyUsageRemote } from '../peerUsage.js';
import { getStoryBuilderMutationEpoch } from '../storyBuilderStore/store.js';
import { GOALS_FILE, getGoalsSnapshot, applyGoalsRemote } from './categories/goals.js';
import { getCharacterSnapshot, applyCharacterRemote } from './categories/character.js';
import { MEATSPACE_DIR, MEATSPACE_FILES, getMeatspaceSnapshot, applyMeatspaceRemote } from './categories/meatspace.js';
import { getUniverseSnapshot, applyUniverseRemote } from './categories/universe.js';
import { getPipelineSnapshot, applyPipelineRemote } from './categories/pipeline.js';
import {
  getMediaCollectionsSnapshot,
  applyMediaCollectionsRemote,
  mediaCollectionsChecksumSources,
} from './categories/mediaCollections.js';
import { VIDEO_HISTORY_FILE, MEDIA_TOMBSTONES_FILE, getVideoHistorySnapshot, applyVideoHistoryRemote } from './categories/videoHistory.js';
import { getStoryBuilderSnapshot, applyStoryBuilderRemote } from './categories/storyBuilder.js';
import {
  UNIVERSE_DIR,
  PIPELINE_SERIES_DIR,
  PEER_SUBSCRIPTIONS_FILE,
  UNIVERSE_CHECKSUM_EPOCH,
  PIPELINE_CHECKSUM_EPOCH,
} from './recordChecksumSources.js';

// File fingerprints skip rebuilding unchanged snapshots. DB-backed stores also
// contribute mutation epochs because a record edit can leave the files untouched.
// Schema keys name only the layouts an adapter writes. An empty list explicitly
// marks an unversioned category.
export const CATEGORIES = {
  goals: {
    getSnapshot: getGoalsSnapshot,
    applyRemote: applyGoalsRemote,
    checksumPaths: [GOALS_FILE],
    schemaKeys: [],
  },
  character: {
    getSnapshot: getCharacterSnapshot,
    applyRemote: applyCharacterRemote,
    checksumPaths: [join(PATHS.data, 'character.json')],
    schemaKeys: [],
  },
  digitalTwin: {
    getSnapshot: getDigitalTwinSnapshot,
    applyRemote: applyDigitalTwinRemote,
    checksumPaths: DIGITAL_TWIN_CHECKSUM_PATHS,
    schemaKeys: [],
  },
  meatspace: {
    getSnapshot: getMeatspaceSnapshot,
    applyRemote: applyMeatspaceRemote,
    checksumPaths: Object.keys(MEATSPACE_FILES).map((filename) => join(MEATSPACE_DIR, filename)),
    schemaKeys: ['meatspace'],
  },
  universe: {
    getSnapshot: getUniverseSnapshot,
    applyRemote: applyUniverseRemote,
    checksumPaths: [UNIVERSE_DIR, PEER_SUBSCRIPTIONS_FILE],
    checksumEpochs: UNIVERSE_CHECKSUM_EPOCH,
    schemaKeys: RECORD_KIND_SCHEMA_CATEGORIES.universe,
    scopeByPeer: true,
  },
  pipeline: {
    getSnapshot: getPipelineSnapshot,
    applyRemote: applyPipelineRemote,
    // The series directory also holds file-primary manuscript reviews.
    checksumPaths: [PIPELINE_SERIES_DIR, join(PATHS.data, 'pipeline-issues'), PEER_SUBSCRIPTIONS_FILE],
    checksumEpochs: PIPELINE_CHECKSUM_EPOCH,
    schemaKeys: [...RECORD_KIND_SCHEMA_CATEGORIES.series, ...RECORD_KIND_SCHEMA_CATEGORIES.issue],
    scopeByPeer: true,
  },
  mediaCollections: {
    getSnapshot: getMediaCollectionsSnapshot,
    applyRemote: applyMediaCollectionsRemote,
    ...mediaCollectionsChecksumSources,
    schemaKeys: RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection,
    scopeByPeer: true,
    hasMediaInventory: true,
  },
  videoHistory: {
    getSnapshot: getVideoHistorySnapshot,
    applyRemote: applyVideoHistoryRemote,
    checksumPaths: [VIDEO_HISTORY_FILE, MEDIA_TOMBSTONES_FILE],
    schemaKeys: ['videoHistory'],
    hasMediaInventory: true,
  },
  storyBuilder: {
    getSnapshot: getStoryBuilderSnapshot,
    applyRemote: applyStoryBuilderRemote,
    // A local-only write may invalidate the cache, but it cannot change the wire snapshot.
    checksumPaths: [join(PATHS.data, 'story-builder')],
    checksumEpochs: { __storyBuilderEpoch: getStoryBuilderMutationEpoch },
    schemaKeys: RECORD_KIND_SCHEMA_CATEGORIES.storyBuilder,
  },
  usage: {
    getSnapshot: getUsageSnapshot,
    getManifest: getUsageManifest,
    applyRemote: applyUsageRemote,
    checksumPaths: USAGE_CHECKSUM_PATHS,
    checksumRevision: () => getChangeToken('usage'),
    checksumMaxAgeMs: 5000,
    schemaKeys: [],
  },
};
