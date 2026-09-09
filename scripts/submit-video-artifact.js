#!/usr/bin/env node
// Local production-agent handoff. Uses the same validation and persistence as
// the HTTP routes without exporting an interactive session to a CLI process.
import { readFile } from 'node:fs/promises';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { creativeDirectorTreatmentSchema, creativeDirectorPlanSchema } from '../server/lib/creativeDirectorValidation.js';

export async function submitVideoArtifact({ projectId, attemptId, kind, input }) {
  if (!['treatment', 'plan'].includes(kind)) throw new Error('Expected treatment or plan');
  const [{ getProject, setTreatment, setPlan }, { assertVideoAttemptDispatch }] = await Promise.all([
    import('../server/services/creativeDirector/local.js'),
    import('../server/services/creativeDirector/videoExecution.js'),
  ]);
  const project = await getProject(projectId);
  const attempt = project?.videoExecution?.attempts?.find(row => row.id === attemptId);
  if (project?.workspace !== 'video' || !attempt || attempt.kind !== kind) throw new Error('No matching Video production attempt');
  await assertVideoAttemptDispatch(projectId, attemptId);
  const data = (kind === 'treatment' ? creativeDirectorTreatmentSchema : creativeDirectorPlanSchema).parse(input);
  await (kind === 'treatment' ? setTreatment : setPlan)(projectId, data);
  return { saved: true, kind };
}

if (isDirectlyInvoked(import.meta.url)) {
  const [projectId, attemptId, kind, filename] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (!filename) throw new Error('Usage: submit-video-artifact.js PROJECT ATTEMPT treatment|plan JSON_FILE');
    const input = JSON.parse(await readFile(filename, 'utf8'));
    const result = await submitVideoArtifact({ projectId, attemptId, kind, input });
    console.log(JSON.stringify(result));
    process.exit(0);
  }).catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exit(1); });
}
