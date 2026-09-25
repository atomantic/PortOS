/**
 * Pipeline text-stage generation progress (#3393). GET and POST may arrive in
 * either order. `generateStage` reserves the channel before its first frame,
 * and a late subscriber replays the latest frame. The stream is advisory:
 * an overlapping run still generates, but cannot publish into or finish the
 * first run's channel.
 */
import { createProgressChannels, CHANNEL_IDLE_MS } from '../../lib/progressChannels.js';

const progress = createProgressChannels({
  label: 'Text-stage progress',
  describeKey: (key) => {
    const [issueId, stageId] = key.split('::');
    return `stage=${stageId} issue=${String(issueId).slice(0, 8)}`;
  },
});

export { CHANNEL_IDLE_MS };
export const channelKey = (issueId, stageId) => `${issueId}::${stageId}`;
export const beginStageProgress = (issueId, stageId) => progress.begin(channelKey(issueId, stageId));
export const attachClient = (issueId, stageId, res) => progress.attach(channelKey(issueId, stageId), res);
export const isChannelOpen = (issueId, stageId) => progress.isOpen(channelKey(issueId, stageId));
export const emitStageProgress = (issueId, stageId, payload) => progress.emit(channelKey(issueId, stageId), payload);
export const finishStageProgress = (issueId, stageId, payload) => progress.finish(channelKey(issueId, stageId), payload);
export const __testing = progress.__testing;
