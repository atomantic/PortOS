#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { browserFidelityTarget, assertFidelityStatus, needsBrowserFidelity } from './lib/browserFidelity.js';
import { githubJson, repoApiPath } from './lib/githubActionsApi.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export async function verifyBrowserFidelity({ env = process.env, fetchImpl = fetch } = {}) {
  const files = JSON.parse(env.CI_BROWSER_FILES);
  if (!needsBrowserFidelity(files)) return { required: false };
  const repository = env.GITHUB_REPOSITORY;
  const repoPath = repoApiPath(env), token = env.GITHUB_TOKEN;
  let pr = Number(env.CI_PULL_REQUEST);
  if (!pr && env.GITHUB_EVENT_PATH) pr = Number(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).number);
  if (!repoPath || !token) throw Error('Browser fidelity verification credentials unavailable.');
  const request = async path => {
    const prefix = `repos/${repository}`;
    if (!path.startsWith(`${prefix}/`)) throw Error('Invalid fidelity API target.');
    const body = await githubJson(fetchImpl, `${repoPath}${path.slice(prefix.length)}`, token);
    if (body === null) throw Error('Browser fidelity API evidence unavailable.');
    return body;
  };
  if (!/^[a-f0-9]{40}$/.test(env.CI_EXPECTED_HEAD ?? '')) {
    throw Error('CI browser fidelity checkout identity unavailable.');
  }
  const target = await browserFidelityTarget(repository, pr, request, {
    head: env.CI_EXPECTED_HEAD,
  });
  const statuses = await request(`repos/${repository}/commits/${target.head}/statuses?per_page=100`);
  return { required: true, ...assertFidelityStatus(target, statuses) };
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    const result = await verifyBrowserFidelity();
    console.log(result.required ? '✅ Current trusted browser fidelity receipt verified.' : '✅ No deferred browser fidelity selected.');
  } catch {
    console.error('❌ Browser fidelity admission failed: current trusted exact-head/tree/profile evidence is required.');
    process.exitCode = 1;
  }
}
