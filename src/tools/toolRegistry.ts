import * as vscode from 'vscode';

export type ToolHandler = (input: any, token: vscode.CancellationToken) => Promise<string>;

const registry = new Map<string, ToolHandler>();

export function registerToolHandler(name: string, handler: ToolHandler): void {
    registry.set(name, handler);
}

export async function invokeToolDirect(name: string, input: any, token: vscode.CancellationToken): Promise<string> {
    const handler = registry.get(name);
    if (!handler) {
        throw new Error(`Tool "${name}" is not registered. Available tools: ${[...registry.keys()].join(', ')}`);
    }
    return handler(input, token);
}

export function getRegisteredToolNames(): string[] {
    return [...registry.keys()];
}
