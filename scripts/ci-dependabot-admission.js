#!/usr/bin/env node

// GitHub permits workflow reruns only to repository writers and preserves the
// original SHA/ref AND token restrictions. Do not replace this with a label:
// labels survive synchronize events and would approve unreviewed future code.
import { readFileSync } from 'node:fs';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export function requireDependabotAdmission({ eventName, event, attempt, triggeringActor }) {
  if (eventName !== 'pull_request') return;
  if (!event?.pull_request?.user?.login) throw new Error('Missing pull request author; refusing CI admission.');
  if (event.pull_request.user.login !== 'dependabot[bot]') return;
  const runAttempt = Number(attempt);
  // Actions cancel recovery is automated, so an attempt counter alone must
  // never release a held update. Only a writer's explicit rerun may do that.
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 2
      || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(triggeringActor ?? '')
      || ['dependabot', 'github-actions'].includes(triggeringActor.toLowerCase())) {
    throw new Error('Dependabot CI is held for maintainer review. Review this run’s commit, then choose Re-run all jobs (or gh run rerun RUN_ID). New commits and rebases need a new release.');
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    requireDependabotAdmission({
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    });
    console.log('CI admission passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
