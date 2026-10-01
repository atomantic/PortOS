import { formatCount } from '../../utils/formatters';

export default function ProductionSoundEvidence({ run, currentRevisionId }) {
  const sound = run.data.soundtrack;
  const evidence = run.data.output?.audioEvidence;
  if (!sound) return null;
  const stale = currentRevisionId && currentRevisionId !== sound.revisionId;
  return <div className="min-w-0 space-y-2 text-sm">
    <p role="status">{stale ? 'Sound evidence belongs to an older revision.' : sound.intentional ? 'Intentionally silent soundtrack' : 'Offline soundtrack ready for preview'}</p>
    {sound.artifact && <audio aria-label="Production soundtrack preview" controls preload="none" src={`/data/${sound.artifact.relativePath}`} className="w-full min-w-0" />}
    {sound.measured && <p className="text-xs text-gray-400">Measured sound: {formatCount(sound.measured.durationMs / 1000, { maximumFractionDigits: 3 })} seconds · {formatCount(sound.measured.sampleRate)} Hz</p>}
    {sound.events?.map((event, index) => <p key={index} className="break-words text-xs text-gray-400">{event.label}: measured onset {formatCount(event.firstSeconds, { maximumFractionDigits: 3 })} seconds · frame {formatCount(event.frame)}</p>)}
    {evidence && <p role="status" className="text-xs">{evidence.intentional ? 'Final film intentionally silent' : `Final MP4 audio decoded and measured: ${formatCount(evidence.decodedDurationSeconds, { maximumFractionDigits: 3 })} seconds`}</p>}
    {run.data.output?.path && <video aria-label="Production final film" controls preload="none" src={run.data.output.path} className="w-full min-w-0 rounded" />}
    {sound.unverified?.map(item => <p key={item.dimension} className="break-words text-xs text-gray-400">Unverified: {item.reason}</p>)}
    <p className="break-all text-xs text-gray-400">Sound revision: {sound.packageHash}</p>
  </div>;
}
