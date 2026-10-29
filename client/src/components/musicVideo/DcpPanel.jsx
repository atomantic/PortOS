import { useEffect, useId, useState } from 'react';
import { Film } from 'lucide-react';
import { inspectMusicVideoDcp, getMusicVideoDcpLocation, musicVideoDcpReportUrl } from '../../services/apiMusicVideo.js';
import PublishCard from './PublishCard.jsx';
import { formatCount, formatDateTime } from '../../utils/formatters.js';

const button = 'rounded border border-port-border px-3 py-2 min-h-[44px] disabled:opacity-50';

export default function DcpPanel({ project, dcp }) {
  const gradeId = useId();
  const [inspection, setInspection] = useState(null);
  const [grade, setGrade] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [location, setLocation] = useState(null);
  const renderId = project?.renderHistoryId;
  useEffect(() => { setInspection(null); setGrade(''); setLocation(null); setError(''); }, [project?.id, renderId]);
  const inspect = async () => {
    setBusy(true); setError('');
    try { setInspection(await inspectMusicVideoDcp(project.id, { silent: true })); }
    catch (err) { setError(err.message || 'Could not inspect the final render.'); }
    finally { setBusy(false); }
  };
  const locate = async id => {
    setError('');
    try { setLocation({ id, ...(await getMusicVideoDcpLocation(project.id, id, { silent: true })) }); }
    catch (err) { setError(err.message || 'Could not locate the package.'); }
  };
  const current = inspection?.renderHistoryId === renderId ? inspection : null;
  const source = current?.source;
  return <PublishCard projectId={project?.id} cardId="dcp" label="Cinema DCP" icon={Film}>
    <p>Create a local unencrypted SMPTE 2K Flat package from the final render. The 1998 × 1080 container fits the whole image with padding; it does not add detail or make a smaller source native 2K.</p>
    <p>Install DCP-o-matic 2.18.51 from <a className="text-port-accent underline" href="https://dcpomatic.com/download" target="_blank" rel="noreferrer">the vendor</a> on the PortOS host, including its command-line encoder and verifier, and install ffprobe. No software is downloaded by PortOS.</p>
    <p>Encoding and verification can take considerable time and disk space. The package stays local. FilmFreeway’s DCP slot accepts only packages ordered through its own paid service; ask the festival or venue how to deliver a local package.</p>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    <button type="button" className={button} disabled={!renderId || busy || dcp?.active} onClick={inspect}>{busy ? 'Inspecting…' : 'Inspect final render and tools'}</button>
    {current && <div className="space-y-2">
      <p>Tools: {Object.entries(current.tools).map(([name, available]) => `${name}: ${available ? 'found' : 'missing'}`).join(' · ')}</p>
      {current.sourceError && <p role="alert">{current.sourceError}</p>}
      {source && <p>Measured source: {formatCount(source.width)} × {formatCount(source.height)} pixels, {source.frameRate === '24/1' ? formatCount(24) : source.frameRate || 'unknown'} fps, {source.audioChannels ? formatCount(source.audioChannels) : 'unknown'} audio channels ({source.audioLayout || 'unknown'}); color {source.colorPrimaries || 'unknown'} / {source.colorTransfer || 'unknown'} / {source.colorSpace || 'unknown'} / {source.colorRange || 'unknown'}.</p>}
      {current.problems?.map(problem => <p key={problem} role="alert">{problem}</p>)}
      <label htmlFor={gradeId} className="block">Source grading conversion
        <select id={gradeId} value={grade} onChange={event => setGrade(event.target.value)} className="block bg-port-bg border border-port-border rounded p-2">
          <option value="">Choose the source grade</option><option value="rec709">Rec.709, gamma 2.2</option><option value="rec1886">Rec.1886, gamma 2.4</option>
        </select>
      </label>
      <p>Choose the space the source was graded for; metadata alone does not determine display gamma. This version requires progressive 24 fps, square-pixel BT.709 video-range metadata and one labeled stereo audio stream.</p>
      <button type="button" className={button} disabled={!grade || !source || !!current.sourceError || !!current.problems?.length || !Object.values(current.tools).every(Boolean) || dcp?.active} onClick={() => dcp.build({ grade, renderHistoryId: current.renderHistoryId, sourceSha256: current.sourceSha256 })}>Create cinema package</button>
    </div>}
    {dcp?.active && <p role="status">{dcp.stage || 'Preparing export'} <button type="button" className={button} onClick={dcp.cancel}>Cancel</button></p>}
    {(project?.dcpExports || []).map(item => <div key={item.id} className="border border-port-border rounded p-2 space-y-1">
      <p>{item.status === 'verified' ? 'Verified by DCP-o-matic' : 'Verification failed'} · {item.sourceRenderId === renderId ? 'Current render' : 'Older render'} · {formatDateTime(item.createdAt)}</p>
      {item.hasWarnings && <p>Verifier warnings were reported; inspect the verification report.</p>}
      <p>Source {formatCount(item.source?.width)} × {formatCount(item.source?.height)}; container {formatCount(item.container?.width)} × {formatCount(item.container?.height)}; {item.standard}, 24 fps, {item.grade}.</p>
      <button type="button" className={button} onClick={() => locate(item.id)}>Locate package on host</button>{' '}
      <a className="underline text-port-accent" href={musicVideoDcpReportUrl(project.id, item.id)}>Download verification report</a>
      {location?.id === item.id && <p>Host folder: <code>{location.packagePath}</code></p>}
    </div>)}
    <p>Automated verification does not replace independent checks of picture, sound, synchronization and playback with the festival or a cinema projection system.</p>
  </PublishCard>;
}
