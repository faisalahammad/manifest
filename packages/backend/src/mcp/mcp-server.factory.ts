import { McpServer } from '@modelcontextprotocol/server';
import { McpOperator, MCP_WRITE_SCOPE } from './mcp-auth';
import { McpToolDeps } from './tool-deps';
import { registerAgentTools } from './tools/agents.tools';
import { registerEnvironmentTools, registerGuideTool } from './tools/environment.tools';
import { registerIdentityTools } from './tools/identity.tools';
import { registerModelTools } from './tools/models.tools';
import { registerProviderTools } from './tools/providers.tools';
import { registerRequestTools } from './tools/requests.tools';
import { registerRoutingTools } from './tools/routing.tools';

/**
 * Array elements plus object keys one `tools/call` may carry. The largest tool
 * input is a custom provider's model list (500). Without a cap, one request can
 * exhaust memory during validation (GHSA-46jr-4wx8-v453).
 */
export const MAX_TOOL_INPUT_ELEMENTS = 1_000;

/**
 * Build the MCP server for ONE request.
 *
 * The transport is stateless — a fresh server per POST — so the acting operator
 * can be closed over instead of threaded through every handler, which is what
 * makes tenant scoping automatic and un-forgeable by the caller.
 */
export function buildMcpServer(deps: McpToolDeps, operator: McpOperator): McpServer {
  const canWrite = operator.scopes.has(MCP_WRITE_SCOPE);
  const server = new McpServer(
    { name: 'manifest', version: '1.0.0' },
    {
      // A server built per POST and closed with it has no channel to push on,
      // and replicas share no event bus, so `notifications/tools/list_changed`
      // can never be sent. Advertising `listChanged` is what invites a client
      // to open a `subscriptions/listen` stream against this endpoint — one
      // that could only ever sit open carrying nothing. `McpServer` turns the
      // bit on by default as soon as a tool is registered, so say no here.
      capabilities: { tools: { listChanged: false } },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions:
        'TierGate is an LLM gateway control plane. Use these tools to manage harnesses ' +
        '(agents), provider connections, routing, model catalogs, and to read the request ' +
        'ledger. ' +
        (canWrite
          ? 'This token can also create, update, and delete resources.'
          : 'This token is read-only; reconnect with the mcp:write scope to change anything.'),
    },
  );

  registerIdentityTools(server, deps, operator);
  registerAgentTools(server, deps, operator);
  registerEnvironmentTools(server, deps, operator);
  registerProviderTools(server, deps, operator);
  registerRoutingTools(server, deps, operator);
  registerModelTools(server, deps, operator);
  registerRequestTools(server, deps, operator);
  registerGuideTool(server);
  return server;
}
