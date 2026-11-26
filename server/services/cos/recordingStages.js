/**
 * Reserved unpublished CoS recording paths shared by compression, backup and restore.
 */

const hex = '[0-9a-f]';
const uuid = [hex.repeat(8), hex.repeat(4), `4${hex.repeat(3)}`, `[89ab]${hex.repeat(3)}`, hex.repeat(12)].join('-');
const stageName = `raw.txt.gz.${uuid}.tmp`;
const stageNamePattern = stageName.replaceAll('.', '\\.');
const archiveDate = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';

export const RECORDING_STAGE_RSYNC_GLOB = `/cos/agents/${archiveDate}/*/${stageName}`;
export const RECORDING_STAGE_NAME = new RegExp(`^${stageNamePattern}$`);
// An rsync exclude also prunes a directory occupying a reserved path.
export const RECORDING_STAGE_PATH = new RegExp(`^cos/agents/${archiveDate}/[^/]+/${stageNamePattern}(?:/|$)`);
