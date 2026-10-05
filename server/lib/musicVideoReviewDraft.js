/** An imported animatic is a review snapshot, never a native production approval. */
export function musicVideoReviewDrafts(project) {
  if (!project?.id) return [];
  const artifacts = Array.isArray(project.devArtifacts) ? project.devArtifacts : [];
  const drafts = artifacts.flatMap(artifact => {
    if (artifact?.deleted || artifact?.kind !== 'animatic'
      || !['pending', 'approved', 'changes-requested'].includes(artifact.status)
      || artifact.dependencyState?.status === 'stale') return [];
    const entry = Array.isArray(artifact.versions) ? artifact.versions.find(version => version.version === artifact.version) : null;
    if (!entry || entry.mimeType !== 'video/mp4' || entry.file !== artifact.file
      || entry.mimeType !== artifact.mimeType || !(entry.bytes > 0)) return [];
    const match = /^music-video\/([A-Za-z0-9_-]+)\/dev\/([A-Za-z0-9_-]+)\/v([1-9]\d*)\.mp4$/.exec(entry.file);
    if (!match || match[2] !== artifact.id || Number(match[3]) !== artifact.version) return [];
    const src = `/api/music-video/${encodeURIComponent(project.id)}/dev-artifacts/${encodeURIComponent(artifact.id)}/file?version=${artifact.version}`;
    return [{ kind: 'video', source: 'animatic', artifactId: artifact.id, version: artifact.version,
      ownerProjectId: match[1], src, poster: null, label: `Imported draft · v${artifact.version}`,
      reviewStatus: artifact.status, createdAt: entry.createdAt || artifact.createdAt }];
  });
  // Notes and approvals update updatedAt; they must not promote an older film.
  return drafts.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

export function latestMusicVideoReviewDraft(project) {
  return musicVideoReviewDrafts(project)[0] || null;
}
