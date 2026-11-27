/**
 * 蜂群协作 MCP 服务（stdio）。
 *
 * 由宿主进程按本次 run 的配置拉起：它只知道一个带 token 的本地地址，身份由主进程按
 * token 解析，Agent 无法通过参数冒充别的成员。工具清单从网关取，避免两处定义漂移。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = process.env.SWARM_BUS_URL ?? '';
const token = process.env.SWARM_BUS_TOKEN ?? '';

const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

async function fetchJson(target, init) {
  const response = await fetch(`${url}${target}`, { ...init, headers });
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  return body;
}

let tools = [];
try {
  const listing = await fetchJson('/tools', { method: 'GET' });
  tools = Array.isArray(listing.tools) ? listing.tools : [];
} catch (error) {
  process.stderr.write(`[swarm-mcp] 读取工具清单失败：${error?.message ?? error}\n`);
}

const server = new Server({ name: 'swarm-bus', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  const result = await fetchJson('/tool', { method: 'POST', body: JSON.stringify({ name, args }) });
  if (!result.ok) {
    return { content: [{ type: 'text', text: `调用失败：${result.error}` }], isError: true };
  }
  const structured = result.data;
  const isRecord = Boolean(structured) && typeof structured === 'object' && !Array.isArray(structured);
  return {
    content: [{ type: 'text', text: typeof result.text === 'string' ? result.text : JSON.stringify(result.text) }],
    // MCP 的 structuredContent 必须是对象；数组只走文本，避免客户端解包失败
    ...(isRecord ? { structuredContent: structured } : {}),
  };
});

await server.connect(new StdioServerTransport());
process.stderr.write('[swarm-mcp] 已连接\n');
