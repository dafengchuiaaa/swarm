/**
 * 自动 Git Worktree 隔离：让并发写代码的蜂群成员各自在独立工作树副本中工作，互不踩踏。
 *
 * 非 Git 仓库或尚无提交的空仓库会安全降级回原工作区，不阻塞正常派工。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface WorktreeInfo {
  path: string;
  branch: string;
  isolated: boolean;
}

export interface ListedWorktree {
  path: string;
  branch: string;
  head: string;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function repoTopLevel(workspace: string): string | null {
  try {
    const top = runGit(workspace, ['rev-parse', '--show-toplevel']);
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

function hasAnyCommit(repoRoot: string): boolean {
  try {
    runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function ensureExcluded(repoRoot: string, entry: string): void {
  try {
    const gitDirRaw = runGit(repoRoot, ['rev-parse', '--git-common-dir']);
    const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(repoRoot, gitDirRaw);
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    mkdirSync(path.dirname(excludeFile), { recursive: true });
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const lines = existing.split(/\r?\n/).map(line => line.trim());
    if (!lines.includes(entry)) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      appendFileSync(excludeFile, `${prefix}${entry}\n`, 'utf8');
    }
  } catch {
    // 忽略 exclude 写入失败，不影响主流程
  }
}

function safeBranchSuffix(memberId: string): string {
  const cleaned = memberId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'worker';
}

export function listWorktrees(workspace: string): ListedWorktree[] {
  const top = repoTopLevel(workspace);
  if (!top) return [];
  try {
    const raw = runGit(top, ['worktree', 'list', '--porcelain']);
    const items: ListedWorktree[] = [];
    let current: Partial<ListedWorktree> = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        if (current.path) {
          items.push({ path: path.resolve(current.path), branch: current.branch ?? '', head: current.head ?? '' });
        }
        current = {};
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
      else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    if (current.path) {
      items.push({ path: path.resolve(current.path), branch: current.branch ?? '', head: current.head ?? '' });
    }
    return items;
  } catch {
    return [];
  }
}

export function ensureMemberWorktree(repoWorkspace: string, memberId: string): WorktreeInfo {
  const top = repoTopLevel(repoWorkspace);
  if (!top || !hasAnyCommit(top)) {
    return { path: repoWorkspace, branch: '', isolated: false };
  }
  const suffix = safeBranchSuffix(memberId);
  const worktreeDir = path.join(top, '.swarm-worktrees', suffix);
  const branch = `swarm/${suffix}`;
  const resolvedTarget = path.resolve(worktreeDir);

  const existing = listWorktrees(top).find(item => item.path.toLowerCase() === resolvedTarget.toLowerCase());
  if (existing && existsSync(existing.path)) {
    return { path: existing.path, branch: existing.branch || branch, isolated: true };
  }

  ensureExcluded(top, '.swarm-worktrees/');
  mkdirSync(path.dirname(resolvedTarget), { recursive: true });

  // 如果分支已存在，直接基于该分支挂载；否则从当前 HEAD 新建分支
  let branchExists = false;
  try {
    runGit(top, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    if (branchExists) {
      runGit(top, ['worktree', 'add', resolvedTarget, branch]);
    } else {
      runGit(top, ['worktree', 'add', '-b', branch, resolvedTarget, 'HEAD']);
    }
    return { path: resolvedTarget, branch, isolated: true };
  } catch {
    return { path: repoWorkspace, branch: '', isolated: false };
  }
}

export function removeMemberWorktree(repoWorkspace: string, worktreePath: string, branch?: string): boolean {
  const top = repoTopLevel(repoWorkspace);
  if (!top || !worktreePath) return false;
  const resolved = path.resolve(worktreePath);
  if (resolved.toLowerCase() === top.toLowerCase()) return false;
  try {
    runGit(top, ['worktree', 'remove', '--force', resolved]);
    if (branch) {
      try {
        runGit(top, ['branch', '-D', branch]);
      } catch {
        // 分支若未合并或不存在可忽略
      }
    }
    return true;
  } catch {
    return false;
  }
}
