/**
 * "No ltx2-runtime model installed" notice, shared by every mode panel whose
 * pipeline only exists on the dgrauet/ltx2 runtime (Audio, the IC-LoRA remix
 * modes). The install instructions name specific model ids and a setup-script
 * invocation, so a copy per panel would drift the moment either changes.
 *
 * `subject` names the blocked capability ("a2v", "Control") — the rest of the
 * guidance is identical regardless of which mode is asking.
 */
export default function Ltx2RuntimeMissingNotice({ subject }) {
  return (
    <p className="text-[11px] text-port-warning">
      {subject} requires an ltx2-runtime model, but none are installed. Add a dgrauet entry to{' '}
      <code>data/media-models.json</code> (or restore <code>ltx23_dgrauet_q4</code> / <code>_q8</code>{' '}
      from the built-in defaults), then provision the runtime via{' '}
      <code>INSTALL_LTX2=1 bash scripts/setup-image-video.sh</code>.
    </p>
  );
}
