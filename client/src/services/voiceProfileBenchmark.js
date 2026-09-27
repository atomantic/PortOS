import { benchmarkProfileInteractive, completeVoiceProfileInteractiveBenchmark } from './apiVoice';

/** Prepare a fresh probe; its returned play action needs a second user gesture. */
export async function prepareProfilePlayback(profileId, payload = {}, options) {
  const startedAt = performance.now();
  const { benchmark } = await benchmarkProfileInteractive(profileId, payload, options);
  const renderRequestLatencyMs = Math.ceil(performance.now() - startedAt);
  if (!benchmark?.benchmarkId || !benchmark?.audioBase64) throw new Error('No playable benchmark was returned');
  return {
    profileId, profileRevision: benchmark.profileRevision,
    // No await before play(): this runs directly in the operator's click gesture.
    play: async () => {
      const playbackStartedAt = performance.now();
      const audio = new Audio(`data:audio/wav;base64,${benchmark.audioBase64}`);
      const playbackStartupMs = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          const elapsed = Math.ceil(performance.now() - playbackStartedAt);
          clearTimeout(timeout);
          audio.removeEventListener('playing', onPlaying);
          audio.removeEventListener('error', onError);
          audio.pause();
          audio.removeAttribute('src');
          if (error) reject(error);
          else resolve(elapsed);
        };
        const onPlaying = () => finish();
        const onError = () => finish(new Error('The benchmark audio could not play'));
        const timeout = setTimeout(() => finish(new Error('Benchmark playback timed out')), 30000);
        audio.addEventListener('playing', onPlaying);
        audio.addEventListener('error', onError);
        // Browser play() reports playback denial through its promise.
        audio.play().catch(finish);
      });
      return completeVoiceProfileInteractiveBenchmark(profileId, {
        benchmarkId: benchmark.benchmarkId, renderRequestLatencyMs, playbackStartupMs,
      }, options);
    },
  };
}
