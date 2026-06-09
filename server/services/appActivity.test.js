/**
 * Tests for the split review-marker functions in appActivity.js (issue #978).
 *
 * The phantom-active-agent bug: `markAppReviewStarted` advanced the cooldown
 * AND bound `activeAgentId` in one step, called *before* the per-app task
 * generator ran. When the generator returned null (no claimable PLAN item,
 * watcher no-op, precondition skip), the bind was left stranded and the app
 * read as "in review" until stale-agent cleanup or a restart.
 *
 * The fix splits the marker into `markAppReviewCooldown` (advance the re-pick
 * guard, no bind) + `bindAppReviewAgent` (bind only once a task exists). These
 * tests pin that split's semantics directly.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'app-activity-test-'));

// appActivity.js reads PATHS.cos (data/cos), which is computed independently of
// PATHS.data — so redirecting `data` alone leaves writes landing in the real
// data/cos dir. Redirect `cos` too via extraOverrides.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({ cos: join(root, 'cos') }),
  }));

const appActivity = await import('./appActivity.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('appActivity review markers (issue #978)', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
  });

  it('markAppReviewCooldown advances the cooldown without binding an agent', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.lastReviewedAt, 'cooldown stamp must be set').toBeTruthy();
    expect(rec.activeAgentId, 'no agent must be bound by the cooldown stamp alone').toBeNull();
  });

  it('cooldown stamp alone puts the app on cooldown (re-pick-storm guard)', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    // A wide window means lastReviewedAt is recent enough to be on cooldown.
    expect(await appActivity.isAppOnCooldown('app-1', 60_000)).toBe(true);
  });

  it('a null-task idle poll (cooldown only, no bind) does NOT leave a phantom active agent', async () => {
    // Simulate the idle-review path when the task generator returns null:
    // cooldown is advanced, bind is skipped.
    await appActivity.markAppReviewCooldown('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId, 'app must not read as in-review after a no-op poll').toBeNull();
  });

  it('bindAppReviewAgent binds the active agent after a task exists', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.bindAppReviewAgent('app-1', 'idle-review-123');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId).toBe('idle-review-123');
    expect(rec.lastReviewedAt, 'cooldown stamp survives the bind').toBeTruthy();
  });

  it('bindAppReviewAgent preserves the cooldown stamp set earlier in the cycle', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    const afterStamp = (await appActivity.getAppActivityById('app-1')).lastReviewedAt;
    await appActivity.bindAppReviewAgent('app-1', 'on-demand-456');
    const afterBind = await appActivity.getAppActivityById('app-1');
    expect(afterBind.lastReviewedAt).toBe(afterStamp);
    expect(afterBind.activeAgentId).toBe('on-demand-456');
  });
});

/**
 * Tests for releaseAppReviewMarker (issue #989).
 *
 * The remaining gap after #978: bindAppReviewAgent writes a synthetic
 * `activeAgentId` (`idle-review-*` / `on-demand-*`) the instant a task is
 * produced, but spawnAgentForTask can still `return null` *after* that bind
 * (provider resolution, prep deferred/blocked, in_progress updateTask failure,
 * max-spawns). On those paths processAgentCompletion never fires, so the
 * synthetic marker was stranded until the next daemon restart. releaseAppReviewMarker
 * clears ONLY a synthetic marker, leaves stats and the advanced cooldown intact,
 * and refuses to touch a real `agent-*` marker.
 */
describe('releaseAppReviewMarker (issue #989)', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
  });

  it('clears a stranded idle-review marker (provider resolution / prep / updateTask failure)', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.bindAppReviewAgent('app-1', 'idle-review-123');
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId, 'synthetic marker must be cleared on spawn failure').toBeNull();
  });

  it('clears a stranded on-demand marker', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.bindAppReviewAgent('app-1', 'on-demand-456');
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId).toBeNull();
  });

  it('preserves the advanced cooldown so the app is re-picked later, not immediately', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    const stamp = (await appActivity.getAppActivityById('app-1')).lastReviewedAt;
    await appActivity.bindAppReviewAgent('app-1', 'idle-review-789');
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.lastReviewedAt, 'cooldown stamp survives the release').toBe(stamp);
    expect(await appActivity.isAppOnCooldown('app-1', 60_000), 'app stays on cooldown after release').toBe(true);
  });

  it('does NOT bump review stats (no review actually ran)', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.bindAppReviewAgent('app-1', 'idle-review-1');
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.stats?.reviewCount ?? 0, 'release must not count as a completed review').toBe(0);
  });

  it('refuses to clear a real agent-* marker held by a different live agent', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.updateAppActivity('app-1', { activeAgentId: 'agent-abcd1234' });
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId, 'a real bound agent must be left untouched').toBe('agent-abcd1234');
  });

  it('is a no-op for an app with no marker', async () => {
    await appActivity.markAppReviewCooldown('app-1');
    await appActivity.releaseAppReviewMarker('app-1');
    const rec = await appActivity.getAppActivityById('app-1');
    expect(rec.activeAgentId).toBeNull();
  });

  it('is a no-op for an unknown app id (no record created)', async () => {
    await appActivity.releaseAppReviewMarker('never-seen');
    const rec = await appActivity.getAppActivityById('never-seen');
    expect(rec, 'release must not materialize a record for an unknown app').toBeNull();
  });

  it('is a no-op when appId is falsy', async () => {
    const result = await appActivity.releaseAppReviewMarker(undefined);
    expect(result).toBeNull();
  });
});
