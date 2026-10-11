import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock('./messagePlaywrightSync.js', () => ({ getPages: vi.fn(), evaluateOnPage: vi.fn(), findOrOpenPage: vi.fn() }));
vi.mock('./browserService.js', () => ({ navigateToUrl: vi.fn() }));
import { getPages } from './messagePlaywrightSync.js';
import { navigateToUrl } from './browserService.js';
import { runSteps, runAutomatedSetup } from "./googleOAuthAutoConfig.js";

describe("runSteps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs named steps in order and logs their progress", async () => {
    const calls = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSteps([
      { name: "first", run: async () => calls.push("first") },
      { name: "second", run: async () => calls.push("second") },
    ]);

    expect(calls).toEqual(["first", "second"]);
    expect(log).toHaveBeenNthCalledWith(
      1,
      "📅 Auto-config step started: first",
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      "📅 Auto-config step completed: first",
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      "📅 Auto-config step started: second",
    );
    expect(log).toHaveBeenNthCalledWith(
      4,
      "📅 Auto-config step completed: second",
    );
  });

  it("fails fast without running later steps", async () => {
    const failure = new Error("step failed");
    const laterStep = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runSteps([
        {
          name: "failure",
          run: async () => {
            throw failure;
          },
        },
        { name: "later", run: laterStep },
      ]),
    ).rejects.toThrow(failure);

    expect(laterStep).not.toHaveBeenCalled();
  });
});

// Stop at mocked navigation after the first real progress emit: no Google account or changes.
describe('automated setup progress wire contract', () => {
  it('echoes correlation without account or project details and keeps legacy frames compatible', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    getPages.mockResolvedValue([{ url: 'https://console.cloud.google.com/?project=synthetic-project' }]);
    navigateToUrl.mockRejectedValue(new Error('Synthetic navigation stop'));
    for (const requestId of ['invented-run-1', undefined]) {
      const io = { emit: vi.fn() };
      await expect(runAutomatedSetup('example@example.com', io, requestId)).rejects.toThrow('Synthetic navigation stop');
      expect(io.emit).toHaveBeenCalledExactlyOnceWith('calendar:google:autoconfig', {
        step: 'enable-api', message: 'Enabling Google Calendar API...', ...(requestId ? { requestId } : {}),
      });
    }
  });
});
