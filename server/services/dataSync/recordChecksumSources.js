/** Identifies the file and database changes shared by record-scoped snapshot caches. */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { getPipelineMutationEpoch } from '../pipeline/syncEpoch.js';
import { getUniverseMutationEpoch } from '../universeBuilder/store.js';

export const UNIVERSE_DIR = join(PATHS.data, 'universes');
export const PIPELINE_SERIES_DIR = join(PATHS.data, 'pipeline-series');
// A subscription can change scoped snapshots without changing a record.
export const PEER_SUBSCRIPTIONS_FILE = join(PATHS.data, 'sharing', 'peer_subscriptions.json');
export const UNIVERSE_CHECKSUM_EPOCH = { __universeEpoch: getUniverseMutationEpoch };
export const PIPELINE_CHECKSUM_EPOCH = { __pipelineEpoch: getPipelineMutationEpoch };
