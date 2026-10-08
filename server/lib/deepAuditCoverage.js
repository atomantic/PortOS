import { canonicalSnapshotChecksum } from './snapshotChecksum.js';

export const DEEP_AUDIT_PARTITION_FILES = 24;
export const DEEP_AUDIT_SCENARIOS = Object.freeze(['normal', 'failure', 'concurrency-recovery']);

/** Partitions own source; groups are conjunctions, never synthetic review receipts. */
export function partitionDeepAuditGroup({ category, subsystem, scenario, files, reason }) {
  const sorted = [...new Set(files)].sort();
  const id = canonicalSnapshotChecksum({ category, subsystem, scenario });
  const units = [];
  for (let offset = 0; offset < sorted.length; offset += DEEP_AUDIT_PARTITION_FILES) {
    const owned = sorted.slice(offset, offset + DEEP_AUDIT_PARTITION_FILES);
    units.push({ id: canonicalSnapshotChecksum({ groupId: id, files: owned }), groupId: id,
      category, subsystem, scenario, files: owned, evidence: {} });
  }
  return { group: { id, category, subsystem, scenario, files: sorted,
    unitIds: units.map(unit => unit.id), ...(reason ? { reason } : {}) }, units };
}

export function createDeepAuditCoverage(category, files) {
  const directories = new Map();
  for (const file of files) {
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    if (!directories.has(directory)) directories.set(directory, []);
    directories.get(directory).push(file.path);
  }
  const groups = [], units = [];
  for (const subsystem of [...directories.keys()].sort()) {
    for (const scenario of DEEP_AUDIT_SCENARIOS) {
      const partitioned = partitionDeepAuditGroup({ category, subsystem, scenario, files: directories.get(subsystem) });
      groups.push(partitioned.group); units.push(...partitioned.units);
    }
  }
  return { groups, units };
}

/** Only the contract may change when retaining the live findings register. */
export function isDeepAuditContractUpgrade(previous, next) {
  const withoutContract = scope => ({ ...scope, promptVersions: { ...scope.promptVersions, contract: null } });
  return [1, 2].includes(previous.promptVersions?.contract) && next.promptVersions?.contract === 3
    && canonicalSnapshotChecksum(withoutContract(previous)) === canonicalSnapshotChecksum(withoutContract(next));
}
