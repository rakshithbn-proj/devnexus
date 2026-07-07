#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadMcpConfig, createClients } from './mcpAuth';
import { registerJiraTools } from './jiraTools';
import { registerBbTools } from './bbTools';

async function main(): Promise<void> {
    let cfg;
    try {
        cfg = loadMcpConfig();
    } catch (err: any) {
        process.stderr.write(err.message + '\n');
        process.exit(1);
    }

    const { jira, bb } = createClients(cfg);

    const server = new McpServer({
        name: 'devnexus',
        version: '1.1.0',
    });

    registerJiraTools(server, jira, cfg);
    registerBbTools(server, bb);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    process.stderr.write('DevNexus MCP server running on stdio\n');
}

main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
