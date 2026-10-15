// Bound both filesystem pressure and PostgreSQL concurrency. Every record still
// writes its own files and passes through the canonical single-row index writer.
export const SEED_BATCH_SIZE = 8;

export async function seedFixtureRecords(total, writeRecord, completeBatch) {
  for (let offset = 0; offset < total; offset += SEED_BATCH_SIZE) {
    const end = Math.min(offset + SEED_BATCH_SIZE, total);
    const results = await Promise.allSettled(Array.from({ length: end - offset },
      (_, index) => Promise.resolve().then(() => writeRecord(offset + index))));
    // Drain the whole bounded batch before propagating failure: cleanup must
    // never race sibling writes that still own resources below the fixture root.
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    completeBatch(end);
  }
}
