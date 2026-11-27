import { afterEach, describe, expect, it } from 'vitest';
import { BusGateway } from '../../../packages/swarm-shell/src/main/busServer';
import { TeamService } from '../../../packages/swarm-team/src/service';
import type { BusState } from '../../../packages/swarm-team/src/collaborationBus';

const gateways: BusGateway[] = [];

afterEach(() => {
  for (const gw of gateways.splice(0)) {
    // 关闭 http server 防止挂起
    (gw as unknown as { http: { close: () => void } }).http.close();
  }
});

describe('BusGateway swarm_fanout', () => {
  it('fans out batch tasks to dedicated shard members and triggers actions', async () => {
    let saved: { channelId: string; runId: string; state: BusState } | undefined;
    const sessions = [
      { id: 'S-leader', member_label: '主导者', host: 'CodeBuddy', model: 'glm-5.3-flash', host_session_id: null },
    ];
    const team = new TeamService({
      project: id => (id === 'P-1' ? { id: 'P-1', name: '测试项目', workspace: process.cwd() } : undefined),
      sessions: () => sessions,
      load: () => saved,
      save: (_id, snapshot) => {
        saved = snapshot;
      },
    });

    const actions: Array<{ memberId: string; workspaceMode?: string }> = [];
    let counter = 0;
    const gw = new BusGateway(
      team,
      action => actions.push({ memberId: action.memberId, workspaceMode: action.workspaceMode }),
      undefined,
      async input => {
        counter += 1;
        const id = `S-shard-${counter}`;
        sessions.push({
          id,
          member_label: input.label ?? `分片-${counter}`,
          host: input.host,
          model: input.model,
          host_session_id: null,
        });
        team.refreshMembers(input.projectId);
        return id;
      },
    );
    gateways.push(gw);
    const url = await gw.listen();
    const { token } = gw.issue('P-1', 'S-leader', 'R-1');

    const toolsRes = await fetch(`${url}/tools`, { headers: { authorization: `Bearer ${token}` } });
    const toolsJson = (await toolsRes.json()) as { tools: Array<{ name: string }> };
    expect(toolsJson.tools.some(t => t.name === 'swarm_fanout')).toBe(true);

    const res = await fetch(`${url}/tool`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'swarm_fanout',
        args: {
          default_host: 'CodeBuddy',
          default_model: 'glm-5.3-flash',
          tasks: [
            { label: '分片-A', text: '处理模块 A' },
            { label: '分片-B', text: '处理模块 B' },
          ],
        },
      }),
    });
    const json = (await res.json()) as { ok: boolean; data: { dispatches: Array<{ member_id: string }> } };
    expect(json.ok).toBe(true);
    expect(json.data.dispatches).toHaveLength(2);
    expect(actions).toHaveLength(2);
    expect(actions[0].workspaceMode).toBe('worktree');
    expect(actions[1].workspaceMode).toBe('worktree');
  });
});
