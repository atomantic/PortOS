/**
 * Strip the retired `series.visualStyleDefault` + stage `visualStyleOverride`
 * fields from persisted JSON. Sanitizers already drop the keys on read; this
 * rewrites the files so share-bucket exports and data-dir diffs stay clean.
 * Idempotent.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJson = async (path, data) => {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
};

const stripSeriesState = async (rootDir) => {
  const path = join(rootDir, 'data/pipeline-series.json');
  const state = await readJsonOrNull(path);
  if (!state || !Array.isArray(state.series)) return;
  let touched = 0;
  for (const s of state.series) {
    if ('visualStyleDefault' in s) {
      delete s.visualStyleDefault;
      touched += 1;
    }
  }
  if (touched > 0) {
    await writeJson(path, state);
    console.log(`📝 data/pipeline-series.json: stripped visualStyleDefault from ${touched} series record${touched === 1 ? '' : 's'}`);
  } else {
    console.log(`✅ data/pipeline-series.json: no visualStyleDefault present`);
  }
};

const stripIssuesState = async (rootDir) => {
  const path = join(rootDir, 'data/pipeline-issues.json');
  const state = await readJsonOrNull(path);
  if (!state || !Array.isArray(state.issues)) return;
  let touched = 0;
  for (const issue of state.issues) {
    if (!issue || typeof issue.stages !== 'object' || issue.stages === null) continue;
    for (const stage of Object.values(issue.stages)) {
      if (stage && typeof stage === 'object' && 'visualStyleOverride' in stage) {
        delete stage.visualStyleOverride;
        touched += 1;
      }
    }
  }
  if (touched > 0) {
    await writeJson(path, state);
    console.log(`📝 data/pipeline-issues.json: stripped visualStyleOverride from ${touched} stage record${touched === 1 ? '' : 's'}`);
  } else {
    console.log(`✅ data/pipeline-issues.json: no visualStyleOverride present`);
  }
};

export default {
  async up({ rootDir }) {
    await Promise.all([stripSeriesState(rootDir), stripIssuesState(rootDir)]);
  },
};
