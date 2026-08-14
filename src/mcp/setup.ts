#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getVSCodeMcpJsonPath(): string {
    const platform = os.platform();
    if (platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
    } else if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    } else {
        return path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
    }
}

function main(): void {
    const serverPath = path.resolve(__dirname, 'server.js').replace(/\\/g, '/');
    const mcpJsonPath = getVSCodeMcpJsonPath();

    let config: any = { servers: {} };
    if (fs.existsSync(mcpJsonPath)) {
        try {
            config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
            if (!config.servers) config.servers = {};
        } catch {
            console.error(`Warning: could not parse existing ${mcpJsonPath}, it will be overwritten.`);
            config = { servers: {} };
        }
    }

    config.servers['devnexus'] = {
        type: 'stdio',
        command: 'node',
        args: [serverPath],
    };

    fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, '\t'), 'utf8');

    console.log(`DevNexus MCP server registered in VS Code.`);
    console.log(`Config written to: ${mcpJsonPath}`);
    console.log(`\nReload VS Code (Ctrl+Shift+P → Developer: Reload Window) to activate.`);
}

main();
