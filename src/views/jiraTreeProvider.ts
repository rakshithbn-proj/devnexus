import * as vscode from 'vscode';
import { JiraClient, JiraIssue } from '../api/jiraClient';

export class JiraTreeProvider implements vscode.TreeDataProvider<JiraTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<JiraTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private items: JiraTreeItem[] = [];
    private getClient: () => Promise<JiraClient | undefined>;

    constructor(getClient: () => Promise<JiraClient | undefined>) {
        this.getClient = getClient;
    }

    refresh(): void {
        this.items = [];
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: JiraTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: JiraTreeItem): Promise<JiraTreeItem[]> {
        if (element) { return []; }

        const client = await this.getClient();
        if (!client) {
            return [new JiraTreeItem('Set Jira credentials to view issues', '', '', vscode.TreeItemCollapsibleState.None)];
        }

        try {
            const result = await client.search('assignee = currentUser() AND status != Done AND status != Closed ORDER BY updated DESC', 20);
            this.items = result.issues.map(issue => {
                const item = new JiraTreeItem(
                    `${issue.key}`,
                    issue.fields.summary,
                    issue.fields.status.name,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.tooltip = `${issue.key} — ${issue.fields.summary}\nStatus: ${issue.fields.status.name}\nLabels: ${issue.fields.labels.join(', ') || 'none'}`;
                item.description = `${issue.fields.summary.substring(0, 60)}${issue.fields.summary.length > 60 ? '...' : ''}`;
                item.contextValue = 'jiraIssue';
                item.url = client.getBrowseUrl(issue.key);

                const statusIcon = issue.fields.status.name === 'In Progress' ? '$(sync~spin)' :
                    issue.fields.status.name === 'Done' ? '$(check)' : '$(circle-outline)';
                item.iconPath = new vscode.ThemeIcon(
                    issue.fields.status.name === 'In Progress' ? 'sync' :
                    issue.fields.status.name === 'Done' ? 'check' : 'circle-outline'
                );
                return item;
            });
            return this.items;
        } catch (err: any) {
            return [new JiraTreeItem(`Error: ${err.message}`, '', '', vscode.TreeItemCollapsibleState.None)];
        }
    }
}

export class JiraTreeItem extends vscode.TreeItem {
    url?: string;

    constructor(
        public readonly key: string,
        public readonly summary: string,
        public readonly status: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(key, collapsibleState);
    }
}
