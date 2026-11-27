/**
 * 防卡死巡检器（Stall Monitor）：默认关闭，由用户手动开启。
 *
 * 开启后定期检查各项目是否存在「仍有未完成派工，但全员已空闲停滞超过阈值」的情况，
 * 一旦命中只对同一停滞快照触发一次提醒，避免刷屏。
 */
export interface StallCandidate {
  projectId: string;
  pendingCount: number;
  lastActivityAt: number;
  signature: string;
}

export interface StallMonitorOptions {
  enabled?: boolean;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  scan: () => StallCandidate[];
  onStall: (candidate: StallCandidate) => void;
}

export class StallMonitor {
  private enabled: boolean;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly scan: () => StallCandidate[];
  private readonly onStall: (candidate: StallCandidate) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly notifiedSignatures = new Map<string, string>();

  constructor(options: StallMonitorOptions) {
    this.enabled = Boolean(options.enabled);
    this.intervalMs = options.intervalMs ?? 30_000;
    this.thresholdMs = options.thresholdMs ?? 180_000;
    this.now = options.now ?? (() => Date.now());
    this.scan = options.scan;
    this.onStall = options.onStall;
    if (this.enabled) this.startTimer();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(next: boolean): boolean {
    this.enabled = Boolean(next);
    if (this.enabled) {
      this.startTimer();
    } else {
      this.stop();
      this.notifiedSignatures.clear();
    }
    return this.enabled;
  }

  tick(): StallCandidate[] {
    if (!this.enabled) return [];
    const current = this.now();
    const triggered: StallCandidate[] = [];
    const activeProjects = new Set<string>();
    for (const candidate of this.scan()) {
      activeProjects.add(candidate.projectId);
      if (candidate.pendingCount <= 0) {
        this.notifiedSignatures.delete(candidate.projectId);
        continue;
      }
      if (current - candidate.lastActivityAt < this.thresholdMs) continue;
      if (this.notifiedSignatures.get(candidate.projectId) === candidate.signature) continue;
      this.notifiedSignatures.set(candidate.projectId, candidate.signature);
      triggered.push(candidate);
      this.onStall(candidate);
    }
    for (const projectId of [...this.notifiedSignatures.keys()]) {
      if (!activeProjects.has(projectId)) this.notifiedSignatures.delete(projectId);
    }
    return triggered;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
