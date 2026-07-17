import { describe, it, expect } from 'vitest';
import { noQuestionToast, shouldReportGoDeeperError } from './TasteTab.jsx';

describe('TasteTab "Go deeper" reporting', () => {
  describe('noQuestionToast', () => {
    it('points at identity documents only for a genuine lack of context', () => {
      expect(noQuestionToast('no-context')).toMatch(/identity documents/);
    });

    it('does not blame identity documents for a missing provider or unknown section', () => {
      // Both were previously served the documents hint even though neither is about
      // documents — the misattribution this reason map exists to end (#2733).
      expect(noQuestionToast('no-provider')).not.toMatch(/identity documents/);
      expect(noQuestionToast('no-provider')).toMatch(/API provider/);
      expect(noQuestionToast('unknown-section')).not.toMatch(/identity documents/);
    });

    it('falls back to a neutral message for an unrecognized or absent reason', () => {
      // A newer server could name a reason this client build has no copy for; it must
      // degrade to something neutral rather than to the documents hint.
      expect(noQuestionToast('reason-from-a-newer-server')).toBe(noQuestionToast(undefined));
      expect(noQuestionToast(undefined)).not.toMatch(/identity documents/);
    });
  });

  describe('shouldReportGoDeeperError', () => {
    it('stays silent for a provider failure, which ai:status already toasts', () => {
      // Reporting here too would restore the double toast #2669 removed.
      expect(shouldReportGoDeeperError({ code: 'AI_PROVIDER_ERROR', message: 'Provider returned 401' })).toBe(false);
    });

    it('reports every other failure, which has no other voice once the request is silenced', () => {
      expect(shouldReportGoDeeperError({ code: 'VALIDATION_ERROR', message: 'bad section' })).toBe(true);
      expect(shouldReportGoDeeperError({ message: 'Server unreachable' })).toBe(true);
      expect(shouldReportGoDeeperError(undefined)).toBe(true);
    });
  });
});
