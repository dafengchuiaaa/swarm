import { describe, expect, it } from 'vitest';
import {
  canDetachInspector,
  findOccupiedByKey,
  inspectorKey,
  occupiedByOthers,
  occupiedSessionIds,
  toOccupiedItem,
  type InspectorSnapshot,
  type OccupiedInspectorItem,
} from '../../../packages/swarm-shell/src/shared/inspectorSync';

describe('蜂群侧栏多窗拆分与不重复规则', () => {
  it('按模式生成唯一标识：会话 / 预览 / 讨论 / 产出互不冲突', () => {
    const base = { projectId: 'P-1', artifactSessionId: 'S-main', sessionId: 'S-dev', preview: { path: 'D:/a/b.md', name: 'b.md' }, rootId: 'M-1' };
    expect(inspectorKey({ ...base, mode: 'session' })).toBe('session:S-dev');
    expect(inspectorKey({ ...base, mode: 'preview' })).toBe('preview:P-1:D:/a/b.md');
    expect(inspectorKey({ ...base, mode: 'thread' })).toBe('thread:P-1:M-1');
    expect(inspectorKey({ ...base, mode: 'files' })).toBe('files:P-1:S-main');
    expect(inspectorKey({ projectId: 'P-1', mode: 'files', sessionId: null })).toBe('files:P-1:team');
  });

  it('空会话 / 空预览 / 空讨论串不允许拆出；产出允许拆出', () => {
    expect(canDetachInspector({ mode: 'session', sessionId: null }).ok).toBe(false);
    expect(canDetachInspector({ mode: 'preview', sessionId: null, preview: null }).ok).toBe(false);
    expect(canDetachInspector({ mode: 'thread', sessionId: null, rootId: null }).ok).toBe(false);
    expect(canDetachInspector({ mode: 'files', sessionId: null }).ok).toBe(true);
    expect(canDetachInspector({ mode: 'session', sessionId: 'S-1' }).ok).toBe(true);
  });

  it('关闭主面板侧栏时不占用任何席位；打开且在会话模式时占用对应成员', () => {
    const closedMain: InspectorSnapshot = { projectId: 'P-1', mode: 'session', sessionId: 'S-1', open: false };
    expect(toOccupiedItem('main', closedMain)).toBeNull();

    const openMainFiles: InspectorSnapshot = { projectId: 'P-1', mode: 'files', sessionId: 'S-1', open: true };
    expect(toOccupiedItem('main', openMainFiles)?.sessionId).toBeNull();

    const openMainSession: InspectorSnapshot = { projectId: 'P-1', mode: 'session', sessionId: 'S-1', open: true };
    expect(toOccupiedItem('main', openMainSession)?.sessionId).toBe('S-1');
  });

  it('多窗拆分并保持不重复：互查只排除其他窗口，关闭窗口即释放占用', () => {
    const items: OccupiedInspectorItem[] = [
      toOccupiedItem('main', { projectId: 'P-1', mode: 'session', sessionId: 'S-review', open: true })!,
      toOccupiedItem('1', { projectId: 'P-1', mode: 'session', sessionId: 'S-dev', open: true })!,
      toOccupiedItem('2', { projectId: 'P-1', mode: 'preview', sessionId: null, preview: { path: 'D:/x.md', name: 'x.md' }, open: true })!,
    ];

    // 主窗口看候选：排除 1 号窗占用的 S-dev，但不排除自己
    expect([...occupiedSessionIds(items, 'main')]).toEqual(['S-dev']);
    // 1 号窗看候选：排除主窗口 S-review（以及其它独立窗）
    expect([...occupiedSessionIds(items, '1')]).toEqual(['S-review']);
    // 再次尝试拆出 S-dev 或 x.md 时可命中重复项
    expect(findOccupiedByKey(items, 'session:S-dev', ['main'])?.source).toBe('1');
    expect(findOccupiedByKey(items, 'preview:P-1:D:/x.md', ['main'])?.source).toBe('2');

    // 关闭 1 号窗（从列表移除）即等同收回：S-dev 立刻释放
    const afterClose = occupiedByOthers(items, '1');
    expect(findOccupiedByKey(afterClose, 'session:S-dev', ['main'])).toBeUndefined();
    expect([...occupiedSessionIds(afterClose, 'main')]).toEqual([]);
  });
});
