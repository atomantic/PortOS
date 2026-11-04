/** Exact saved inputs for one generated Cast & Sets image; shared by cards and admission. */
export function castSetsInspectionInputs(stage, key) {
  const image = stage?.images?.[key];
  const plan = stage?.plan?.[key];
  if (!plan || image?.status !== 'done' || !image.imageId) return null;
  return { key, imageId: image.imageId, jobId: image.jobId || null,
    imageRevision: image.submittedRevision ?? stage.revision, planPrompt: plan.prompt,
    submittedPrompt: image.submittedPrompt ?? null };
}

export const sameCastSetsInspectionInputs = (a, b) => !!a && !!b
  && ['key', 'imageId', 'jobId', 'imageRevision', 'planPrompt', 'submittedPrompt'].every((key) => a[key] === b[key]);

export function currentCastSetsInspection(stage, key) {
  const evidence = stage?.images?.[key]?.inspection;
  return sameCastSetsInspectionInputs(evidence?.inputs, castSetsInspectionInputs(stage, key)) ? evidence : null;
}

export function castSetsImageAccepted(stage, key) {
  const inputs = castSetsInspectionInputs(stage, key);
  if (!inputs) return false;
  const evidence = currentCastSetsInspection(stage, key);
  const acknowledgement = stage.images[key].inspectionAcknowledgement;
  return evidence?.verdict === 'pass' || (sameCastSetsInspectionInputs(acknowledgement?.inputs, inputs)
    && acknowledgement.inspectionId === (evidence?.id || null));
}

export const castSetsInspectionBlockers = (stage) => Object.keys(stage?.plan || {}).filter((key) => !castSetsImageAccepted(stage, key));
