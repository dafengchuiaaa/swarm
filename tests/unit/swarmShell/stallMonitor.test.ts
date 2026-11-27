import { describe, expect, it } from 'vitest';
import { StallMonitor } from '../../../packages/swarm-shell/src/main/stallMonitor';

describe('StallMonitor', () => {
  it('defaults to disabled and does not fire when off', () => {
    let fired = 0;
    const monitor = new StallMonitor({
      now: () => 1_000_000,
      thresholdMs: 60_000,
      scan: () => [{ projectId: 'P-1', pendingCount: 2, lastActivityAt: 0, signature: 'D-1:queued' }],
      onStall: () => {
        fired += 1;
      },
    });
    expect(monitor.isEnabled()).toBe(false);
    expect(monitor.tick()).toEqual([]);
    expect(fired).toBe(0);
  });

  it('triggers once per stall signature when manually enabled', () => {
    let fired = 0;
    let now = 200_000;
    const monitor = new StallMonitor({
      enabled: false,
      now: () => now,
      thresholdMs: 60_000,
      scan: () => [{ projectId: 'P-1', pendingCount: 1, lastActivityAt: 100_000, signature: 'D-1:queued' }],
      onStall: () => {
        fired += 1;
      },
    });
    expect(monitor.setEnabled(true)).toBe(true);
    expect(monitor.tick()).toHaveLength(1);
    expect(fired).toBe(1);

    // 同一停滞签名不重复刷屏
    now = 300_000;
    expect(monitor.tick()).toHaveLength(0);
    expect(fired).toBe(1);

    monitor.setEnabled(false);
    expect(monitor.isEnabled()).toBe(false);
  });
});
