import { TestRunner } from 'vitest';

// Vitest batches result events for 100ms. Native bail=5 alone can therefore
// run past the cap even on one worker. Flush each failure through its normal
// reporting RPC before this worker starts another case. No success-path RPC.
export default class CandidateRunner extends TestRunner {
  bodyErrors = new WeakMap();

  async onBeforeRunTask(test) {
    await super.onBeforeRunTask(test);
    test.retry = 0;
  }

  onTaskFinished(test) {
    this.bodyErrors.set(test, test.result?.errors?.length ?? 0);
  }

  async onAfterRunTask(test) {
    await super.onAfterRunTask(test);
    if (test.result?.state !== 'fail') return;
    const errors = test.result.errors ?? [];
    test.meta.portosDiagnosticRunner = true;
    test.meta.portosDiagnosticUnsafe = !errors.length
      || errors.some(error => error.name !== 'AssertionError')
      || Object.values(test.result.hooks ?? {}).some(state => state !== 'pass')
      || errors.length > (this.bodyErrors.get(test) ?? 0);
    await this.onTaskUpdate([[test.id, test.result, test.meta]], [[test.id, 'test-finished', undefined]]);
  }
}
