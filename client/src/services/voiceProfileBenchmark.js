import { benchmarkProfileInteractive, completeVoiceProfileInteractiveBenchmark } from './apiVoice';

/** Measure a fresh render through the browser's actual playback-start event. */
export async function qualifyProfilePlayback(profileId, payload = {}, options) {
  const startedAt = performance.now();
  const { benchmark } = await benchmarkProfileInteractive(profileId, payload, options);
  if (!benchmark?.benchmarkId || !benchmark?.audioBase64) throw new Error('No playable benchmark was returned');
  const audio = new Audio(`data:audio/wav;base64,${benchmark.audioBase64}`);
  const playbackLatencyMs = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      const elapsed = Math.ceil(performance.now() - startedAt);
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
    Promise.resolve().then(() => audio.play()).catch(finish);
  });
  return completeVoiceProfileInteractiveBenchmark(profileId, {
    benchmarkId: benchmark.benchmarkId, playbackLatencyMs,
  }, options);
}
