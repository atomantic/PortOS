import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Add missing starter entries to an installed JSON document without replacing
 * custom values. A present but malformed merge map is preserved as-is.
 */
export const mergeJsonStarter = ({ samplePath, dataPath, mergeKey, displayPath = dataPath, log = console.log }) => {
  if (!existsSync(samplePath) || !existsSync(dataPath)) return { status: 'missing', added: [] };

  let sample;
  let data;
  try {
    sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: ${err.message}`);
    return { status: 'invalid-json', added: [] };
  }

  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: expected a starter object document`);
    return { status: 'invalid-sample', added: [] };
  }
  const sampleEntries = sample[mergeKey];
  if (!sampleEntries || typeof sampleEntries !== 'object' || Array.isArray(sampleEntries)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: starter has no object at ${mergeKey}`);
    return { status: 'invalid-sample-map', added: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: expected an object document`);
    return { status: 'invalid-document', added: [] };
  }

  const hasMap = Object.hasOwn(data, mergeKey);
  if (hasMap && (!data[mergeKey] || typeof data[mergeKey] !== 'object' || Array.isArray(data[mergeKey]))) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: ${mergeKey} is present but is not an object`);
    return { status: 'invalid-map', added: [] };
  }
  if (!hasMap) data[mergeKey] = {};

  const added = [];
  for (const [key, value] of Object.entries(sampleEntries)) {
    if (!Object.hasOwn(data[mergeKey], key)) {
      data[mergeKey][key] = value;
      added.push(key);
    }
  }
  if (added.length > 0) {
    writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
    log(`📝 ${displayPath}: merged ${added.length} new ${mergeKey} ${added.length === 1 ? 'entry' : 'entries'} (${added.join(', ')})`);
  }
  return { status: 'merged', added };
};
