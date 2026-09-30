import { useState } from 'react';
import toast from '../components/ui/Toast';
import {
  uploadMusicVideoDevArtifact,
  addMusicVideoDevArtifactNote,
  resolveMusicVideoDevArtifactNote,
  reviewMusicVideoDevArtifact,
  deleteMusicVideoDevArtifact,
} from '../services/apiMusicVideo.js';

/**
 * A project's development artifacts ("ingredients"): import a file (or a new
 * version of one), notes, review and delete. The list itself is the project's
 * `devArtifacts` field, so every action applies the project the server returns
 * (the socket event covers other tabs).
 *
 * Returns `{ busy, upload(file, fields), addNote(artifactId, body),
 * resolveNote(artifactId, noteId, resolved), review(artifactId, body), remove(artifactId) }`;
 * each resolves with the server response, or null after toasting a failure.
 */
export default function useMusicVideoDevArtifacts({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);

  const call = (request, success) => {
    if (!projectId) return Promise.resolve(null);
    setBusy(true);
    return request()
      .then((res) => {
        if (res?.project) replaceProject?.(res.project);
        if (success) toast.success(typeof success === 'function' ? success(res) : success);
        return res;
      })
      .catch((err) => { toast.error(err?.message || 'Development artifact request failed'); return null; })
      .finally(() => setBusy(false));
  };

  return {
    busy,
    upload: (file, fields) => call(() => uploadMusicVideoDevArtifact(projectId, file, fields, { silent: true }), (res) => `Saved ${res?.artifact?.title || 'artifact'} v${res?.artifact?.version || 1}`),
    addNote: (artifactId, body) => call(() => addMusicVideoDevArtifactNote(projectId, artifactId, body, { silent: true })),
    resolveNote: (artifactId, noteId, resolved) => call(() => resolveMusicVideoDevArtifactNote(projectId, artifactId, noteId, resolved, { silent: true })),
    review: (artifactId, body) => call(() => reviewMusicVideoDevArtifact(projectId, artifactId, body, { silent: true }), body.status === 'approved' ? 'Approved' : 'Changes requested'),
    remove: (artifactId) => call(() => deleteMusicVideoDevArtifact(projectId, artifactId, { silent: true }), 'Artifact removed'),
  };
}
