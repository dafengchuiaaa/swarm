import { expect, it } from 'vitest';
import { BusGateway } from '../../../packages/swarm-shell/src/main/busServer';
import type { BusState } from '../../../packages/swarm-team/src/collaborationBus';
import { OWNER, TeamService } from '../../../packages/swarm-team/src/service';

it('通过一次工具调用保存两类回执，写入失败后可重试原回执', async () => {
  const writes: BusState[] = [];
  let failSave = false;
  let saveAttempts = 0;
  const team = new TeamService({
    project: id => ({ id, name: '验收', workspace: process.cwd() }),
    sessions: () => [{ id: 'dev', member_label: '开发', host: 'CodeBuddy', model: 'test', host_session_id: null }],
    load: () => undefined,
    save: (_key, snapshot) => {
      saveAttempts += 1;
      if (failSave) throw new Error('保存失败');
      writes.push(snapshot.state);
    },
  });
  const [messageId] = team.post({ projectId: 'p', from: OWNER, to: 'dev', text: '请核对' }).messageIds;
  const gateway = new BusGateway(team);
  try {
    const url = await gateway.listen();
    const { token } = gateway.issue('p', 'dev', 'R-1');
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await fetch(`${url}/tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, args }),
      });
      return await response.json() as { ok: boolean; error?: string; data?: { context_receipt?: string } };
    };
    const context = await call('swarm_context');
    expect(context.data?.context_receipt).toEqual(expect.any(String));
    const ack = { context_receipt: context.data?.context_receipt, message_ids: [messageId] };

    failSave = true;
    expect(await call('swarm_ack', ack)).toMatchObject({ ok: false, error: '保存失败' });
    failSave = false;
    const attemptsBeforeRetry = saveAttempts;
    expect(await call('swarm_ack', ack)).toMatchObject({ ok: true });
    expect(saveAttempts - attemptsBeforeRetry).toBe(1);
    expect(writes.at(-1)?.cursors?.dev).toBeDefined();
    expect(writes.at(-1)?.messages.find(message => message.id === messageId)?.receipts.dev).toBe('processed');

    const attemptsAfterRetry = saveAttempts;
    expect(await call('swarm_ack', ack)).toMatchObject({ ok: true });
    expect(saveAttempts).toBe(attemptsAfterRetry);

    const [nextId] = team.post({ projectId: 'p', from: OWNER, to: 'dev', text: '再核对' }).messageIds;
    const nextContext = await call('swarm_context');
    expect(nextContext.data?.context_receipt).toEqual(expect.any(String));
    const attemptsBeforeAck = saveAttempts;
    expect(await call('swarm_ack', {
      context_receipt: nextContext.data?.context_receipt, message_ids: [nextId],
    })).toMatchObject({ ok: true });
    expect(saveAttempts - attemptsBeforeAck).toBe(1);
  } finally {
    (gateway as unknown as { http: { close: () => void } }).http.close();
  }
});
