import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { BusGateway } from '../../../packages/swarm-shell/src/main/busServer';
import { TeamService } from '../../../packages/swarm-team/src/service';

it('直连和原 stdio 入口共用协作工具，直连使用同一个回合令牌', async () => {
  const team = new TeamService({
    project: id => ({ id, name: '传输验收', workspace: process.cwd() }),
    sessions: () => [{ id: 'dev', member_label: '开发', host: 'Qoder', model: 'test', host_session_id: null }],
    load: () => undefined,
    save: () => {},
  });
  const gateway = new BusGateway(team);
  const direct = new Client({ name: 'test-http', version: '1' });
  const legacy = new Client({ name: 'test-stdio', version: '1' });
  try {
    const url = await gateway.listen();
    const { token } = gateway.issue('p1', 'dev', 'R-1');
    const headers = { Authorization: `Bearer ${token}` };
    const endpoint = new URL('/mcp', url);
    const httpTransport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } });
    const child = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('packages/swarm-team/mcp/server.mjs')],
      env: { SWARM_BUS_URL: url, SWARM_BUS_TOKEN: token },
      stderr: 'pipe',
    });

    await direct.connect(httpTransport);
    await legacy.connect(child);
    expect(child.pid).toEqual(expect.any(Number));
    expect(await direct.listTools()).toEqual(await legacy.listTools());

    const posted = await direct.callTool({ name: 'swarm_say', arguments: { text: '同一账本' } });
    expect(posted.structuredContent).toMatchObject({ messageIds: [expect.any(String)] });
    const inbox = await legacy.callTool({ name: 'swarm_context' });
    expect(inbox.isError).not.toBe(true);
    expect(team.view('p1', 'dev').roots.map(message => message.text)).toContain('同一账本');

    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { headers: { ...headers, Origin: 'https://example.invalid' } })).status).toBe(403);
    gateway.revoke(token);
    expect((await fetch(endpoint, { headers })).status).toBe(401);
  } finally {
    await Promise.allSettled([direct.close(), legacy.close()]);
    (gateway as unknown as { http: { close: () => void } }).http.close();
  }
});
