import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMemberWorktree, listWorktrees, removeMemberWorktree } from '../../../packages/swarm-shell/src/main/worktree';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
});

describe('worktree isolation', () => {
  it('non-git directory falls back safely without throwing', () => {
    const plainDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-plain-'));
    dirs.push(plainDir);
    const info = ensureMemberWorktree(plainDir, 'S-worker1');
    expect(info.isolated).toBe(false);
    expect(info.path).toBe(plainDir);
    expect(info.branch).toBe('');
  });

  it('creates, reuses and removes isolated git worktree for a member', () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-git-'));
    dirs.push(repoDir);
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(path.join(repoDir, 'README.md'), '# hello\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    const first = ensureMemberWorktree(repoDir, 'S-shard1');
    expect(first.isolated).toBe(true);
    expect(first.branch).toBe('swarm/S-shard1');
    expect(existsSync(path.join(first.path, 'README.md'))).toBe(true);

    const second = ensureMemberWorktree(repoDir, 'S-shard1');
    expect(second.isolated).toBe(true);
    expect(second.path).toBe(first.path);

    const listed = listWorktrees(repoDir);
    expect(listed.some(item => item.branch === 'swarm/S-shard1')).toBe(true);

    const removed = removeMemberWorktree(repoDir, first.path, first.branch);
    expect(removed).toBe(true);
  });
});
