import * as vscode from 'vscode';
import { AuthManager } from './auth/authManager';
import { JiraClient } from './api/jiraClient';
import { BitbucketClient, BitbucketConfig } from './api/bitbucketClient';
import { registerJiraTools } from './tools/jiraTools';
import { registerBitbucketTools } from './tools/bitbucketTools';
import { registerChatParticipant } from './participant/chatHandler';
import { JiraTreeProvider, JiraTreeItem } from './views/jiraTreeProvider';
import { BBTreeProvider, BBTreeItem } from './views/bbTreeProvider';

let jiraClient: JiraClient | undefined;
let bbClient: BitbucketClient | undefined;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const auth = new AuthManager(context);
    await auth.initializeContextFlags();

    async function getJiraClient(): Promise<JiraClient | undefined> {
        if (jiraClient) { return jiraClient; }
        const creds = await auth.getJiraCredentials();
        if (!creds) { return undefined; }
        const config = vscode.workspace.getConfiguration('devnexus.jira');
        const baseUrl = config.get<string>('baseUrl', '');
        if (!baseUrl.trim()) {
            void vscode.window.showWarningMessage('DevNexus: Jira URL not configured. Open Settings and set devnexus.jira.baseUrl.');
            return undefined;
        }
        jiraClient = new JiraClient(baseUrl, creds);
        return jiraClient;
    }

    async function getBBClient(): Promise<BitbucketClient | undefined> {
        if (bbClient) { return bbClient; }
        const pat = await auth.getBitbucketToken();
        if (!pat) { return undefined; }
        const config = vscode.workspace.getConfiguration('devnexus.bitbucket');
        const bbConfig: BitbucketConfig = {
            baseUrl: config.get<string>('baseUrl', ''),
            project: config.get<string>('project', ''),
            repo: config.get<string>('repo', ''),
        };
        if (!bbConfig.baseUrl.trim()) {
            void vscode.window.showWarningMessage('DevNexus: Bitbucket URL not configured. Open Settings and set devnexus.bitbucket.baseUrl.');
            return undefined;
        }
        if (!bbConfig.project.trim()) {
            void vscode.window.showWarningMessage('DevNexus: Bitbucket project not configured. Open Settings and set devnexus.bitbucket.project.');
            return undefined;
        }
        if (!bbConfig.repo.trim()) {
            void vscode.window.showWarningMessage('DevNexus: Bitbucket repo not configured. Open Settings and set devnexus.bitbucket.repo.');
            return undefined;
        }
        bbClient = new BitbucketClient(bbConfig, pat);
        return bbClient;
    }

    registerJiraTools(context, getJiraClient, auth);
    registerBitbucketTools(context, getBBClient);
    registerChatParticipant(context, auth);

    const jiraTree = new JiraTreeProvider(getJiraClient);
    const bbTree = new BBTreeProvider(getBBClient);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('devnexusJiraIssues', jiraTree),
        vscode.window.registerTreeDataProvider('devnexusBBPullRequests', bbTree),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('devnexus.setJiraCredentials', async () => {
            const ok = await auth.setJiraCredentials();
            if (ok) {
                jiraClient = undefined;
                jiraTree.refresh();
                await updateStatusBar();
            }
        }),

        vscode.commands.registerCommand('devnexus.setBitbucketToken', async () => {
            const ok = await auth.setBitbucketToken();
            if (ok) {
                bbClient = undefined;
                bbTree.refresh();
                await updateStatusBar();
            }
        }),

        vscode.commands.registerCommand('devnexus.refreshJira', () => {
            jiraTree.refresh();
        }),

        vscode.commands.registerCommand('devnexus.refreshBB', () => {
            bbTree.refresh();
        }),

        vscode.commands.registerCommand('devnexus.createEnvFile', () => {
            void auth.createEnvFile();
        }),

        vscode.commands.registerCommand('devnexus.openInBrowser', (item: JiraTreeItem | BBTreeItem) => {
            if (item.url) {
                void vscode.env.openExternal(vscode.Uri.parse(item.url));
            }
        }),
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'devnexus.setJiraCredentials';
    context.subscriptions.push(statusBarItem);
    await updateStatusBar();

    async function updateStatusBar(): Promise<void> {
        const jiraOk = await auth.isJiraAuthenticated();
        const bbOk = await auth.isBitbucketAuthenticated();
        const parts: string[] = [];
        parts.push(jiraOk ? '$(check) Jira' : '$(x) Jira');
        parts.push(bbOk ? '$(check) BB' : '$(x) BB');
        statusBarItem.text = `$(tools) DevNexus: ${parts.join(' | ')}`;
        statusBarItem.tooltip = 'DevNexus — Click to configure credentials';
        statusBarItem.show();
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('devnexus')) {
                jiraClient = undefined;
                bbClient = undefined;
                jiraTree.refresh();
                bbTree.refresh();
            }
        })
    );

    const outputChannel = vscode.window.createOutputChannel('DevNexus');
    outputChannel.appendLine('DevNexus activated — use @nexus in Copilot Chat');
    context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
    // Cleanup handled by disposables
}
