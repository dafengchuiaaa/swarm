import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

export async function serveSwarmMcp(
  request: IncomingMessage,
  response: ServerResponse,
  tools: Tool[],
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; data?: unknown }>,
): Promise<void> {
  const server = new Server({ name: 'swarm-bus', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const { text, data } = await call(params.name, params.arguments ?? {});
      return {
        content: [{ type: 'text', text }],
        ...(data && typeof data === 'object' && !Array.isArray(data)
          ? { structuredContent: data as Record<string, unknown> }
          : {}),
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `调用失败：${(error as Error).message}` }], isError: true };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once('close', () => void server.close());
  await server.connect(transport);
  await transport.handleRequest(request, response);
}
