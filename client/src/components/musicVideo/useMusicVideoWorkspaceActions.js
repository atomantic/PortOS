import { useState, useRef } from 'react';
import toast from '../ui/Toast';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';
import { ownWrite } from '../../services/socketWriteOrigin.js';

export default function useMusicVideoWorkspaceActions({
  selected, patchProject, applyEdit, reloadOpenProject, takesRef,
}) {
  // Lyric cues / phrases / pacing (#8964) and the typography manifest (#8984)
  // — optimistic-local + silent PATCH on blur, like the scene editors. Each PATCH replaces a whole list, so the
  // saves are chained: two quick blurs can never land out of order and let an
  // older snapshot of the list overwrite a newer one. Several steps edit these fields.
  const [compositionSavePending, setCompositionSavePending] = useState(0);
  const timedTextSaveChain = useRef(Promise.resolve());
  const editProjectLocal = (patch) => patchProject(selected.id, patch);
  // One project save from this tab, sent with its origin and asking for the edit result (`send(options)` gets
  // both): a reply with one patches the board and its own change broadcast is skipped, so the
  // save costs one request. A reply with `edit: null` wrote nothing. A take decision that started
  // meanwhile may be newer than the reply, and a refused (409) save may leave the board behind: both reload.
  const saveOwnEdit = (projectId, send) => {
    const mark = takesRef.current?.writeMark();
    return send(ownWrite({ edit: true })).then((reply) => {
      if (reply?.edit === null) return reply;
      if (reply?.edit && (!takesRef.current || takesRef.current.settledSince(mark))) applyEdit(projectId, reply.edit);
      else void reloadOpenProject(projectId);
      return reply;
    }, (err) => {
      if (err?.status === 409) void reloadOpenProject(projectId);
      throw err;
    });
  };
  const saveProjectFields = (patch) => {
    const projectId = selected.id;
    setCompositionSavePending((count) => count + 1);
    timedTextSaveChain.current = timedTextSaveChain.current
      .then(() => saveOwnEdit(projectId, (options) => updateMusicVideoProject(projectId, patch, options)))
      .catch((err) => { toast.error(err?.message || 'Failed to save changes'); return false; })
      .finally(() => setCompositionSavePending((count) => count - 1));
    return timedTextSaveChain.current;
  };
  // The finishing film look, saved whole from the image viewer's editor ("Use on project").
  const saveFilmLook = (filmLook) => saveProjectFields({ filmLook });
  return { compositionSavePending, editProjectLocal, saveOwnEdit, saveProjectFields, saveFilmLook };
}
