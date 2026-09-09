import { useState } from 'react';
import { updateCreativeDirectorScene } from '../../services/apiCreativeDirector.js';
import GalleryImagePicker from '../imageGen/GalleryImagePicker.jsx';
import toast from '../ui/Toast';

export default function VideoShotEditor({ project, scene, onChange }) {
  const [prompt, setPrompt] = useState(scene.prompt);
  const [sourceImageFile, setSourceImageFile] = useState(scene.sourceImageFile || null);
  const [continuation, setContinuation] = useState(Boolean(scene.useContinuationFromPrior));
  const [muteAudio, setMuteAudio] = useState(Boolean(scene.muteAudio));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = ['planning', 'rendering', 'stitching'].includes(project.status);
  const dirty = muteAudio !== Boolean(scene.muteAudio) || prompt !== scene.prompt || sourceImageFile !== (scene.sourceImageFile || null) || continuation !== Boolean(scene.useContinuationFromPrior);
  const save = async () => {
    if (saving || active || !dirty || !prompt.trim()) return;
    setSaving(true);
    const saved = await updateCreativeDirectorScene(project.id, scene.sceneId, {
      prompt, sourceImageFile, muteAudio, useContinuationFromPrior: continuation, expectedWorkRevision: scene.workRevision || 0,
    }, { silent: true }).catch(error => { toast.error(error.message || 'Could not save shot'); return null; });
    setSaving(false);
    if (saved) { toast.success('Shot saved. Review the updated production before resuming.'); onChange?.(); }
  };
  return <section aria-label="Edit shot" className="space-y-3 border-t border-port-border pt-3">
    <label htmlFor="video-shot-prompt" className="block text-sm">Render prompt</label>
    <textarea id="video-shot-prompt" className="w-full rounded border border-port-border bg-port-bg p-2 text-sm" rows={8} maxLength={8000} value={prompt} onChange={event => setPrompt(event.target.value)} disabled={active || saving} />
    <p className="text-xs text-port-text-muted">Include the action, character appearance, and any native dialogue or sound in this prompt.</p>
    {sourceImageFile && <img src={`/data/images/${encodeURIComponent(sourceImageFile)}`} alt="Shot reference frame" className="max-h-64 w-full rounded object-contain" />}
    <div className="flex flex-wrap gap-2">
      <button className="rounded border border-port-border px-3 py-2 text-sm" disabled={active || saving} onClick={() => setPickerOpen(true)}>{sourceImageFile ? 'Change reference frame' : 'Choose reference frame'}</button>
      {sourceImageFile && <button className="text-sm underline" disabled={active || saving} onClick={() => setSourceImageFile(null)}>Remove reference frame</button>}
    </div>
    <label htmlFor="video-shot-continuation" className="flex items-center gap-2 text-sm"><input id="video-shot-continuation" type="checkbox" checked={continuation} disabled={active || saving || scene.order === 0} onChange={event => setContinuation(event.target.checked)} />Continue from the previous shot's last frame</label>
    {continuation && <p className="text-xs text-port-text-muted">Continuation uses the previous clip instead of the selected reference frame.</p>}
    <label htmlFor="video-shot-mute-audio" className="flex items-center gap-2 text-sm"><input id="video-shot-mute-audio" type="checkbox" checked={muteAudio} disabled={active || saving} onChange={event => setMuteAudio(event.target.checked)} />Mute generated audio in the final cut</label>
    <p className="text-xs text-port-text-muted">Muting removes all sound from this shot. Changing only this control preserves its rendered picture and requires a fresh review.</p>
    <p className="text-xs text-port-text-muted">{active ? 'Pause production before editing this shot.' : 'Saving pauses production and requires a fresh review. It makes no provider calls.'}</p>
    <button className="rounded bg-port-accent px-3 py-2 text-white disabled:opacity-40" disabled={active || saving || !dirty || !prompt.trim()} onClick={save}>{saving ? 'Saving…' : 'Save shot'}</button>
    <GalleryImagePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={item => { setSourceImageFile(item.filename); setContinuation(false); }} allowUpload />
  </section>;
}
