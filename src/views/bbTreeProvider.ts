import * as vscode from 'vscode';
import { BitbucketClient, PullRequest } from '../api/bitbucketClient';

type BBSection = 'my' | 'reviewing';

export class BBTreeProvider implements vscode.TreeDataProvider<BBTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BBTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private getClient: () => Promise<BitbucketClient | undefined>;

    constructor(getClient: () => Promise<BitbucketClient | undefined>) {
        this.getClient = getClient;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: BBTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BBTreeItem): Promise<BBTreeItem[]> {
        const client = await this.getClient();
        if (!client) {
            return [new BBTreeItem('Set Bitbucket token to view PRs', 0, '', vscode.TreeItemCollapsibleState.None)];
        }

        // Top level: sections
        if (!element) {
            return [
                new BBTreeItem('My Pull Requests', 0, 'section', vscode.TreeItemCollapsibleState.Expanded, 'my'),
                new BBTreeItem('PRs to Review', 0, 'section', vscode.TreeItemCollapsibleState.Expanded, 'reviewing'),
            ];
        }

        // Section children
        if (element.section) {
            try {
                const prs = element.section === 'my'
                    ? await client.getMyPRs()
                    : await client.getPRsToReview();

                if (prs.length === 0) {
                    return [new BBTreeItem('(none)', 0, '', vscode.TreeItemCollapsibleState.None)];
                }

                return prs.map(pr => {
                    const item = new BBTreeItem(
                        `#${pr.id} — ${pr.title}`,
                        pr.id,
                        'pullRequest',
                        vscode.TreeItemCollapsibleState.None,
                    );
                    const reviewerStatus = pr.reviewers.map(r => {
                        const icon = r.status === 'APPROVED' ? '✅' : r.status === 'NEEDS_WORK' ? '❌' : '⏳';
                        return `${icon} ${r.user.displayName}`;
                    }).join(', ') || 'no reviewers';
                    item.tooltip = `${pr.title}\n${pr.fromRef.displayId} → ${pr.toRef.displayId}\nReviewers: ${reviewerStatus}`;
                    item.description = `${pr.fromRef.displayId} → ${pr.toRef.displayId}`;
                    item.contextValue = 'bbPullRequest';
                    item.url = client.getPRUrl(pr.id);
                    item.iconPath = new vscode.ThemeIcon('git-pull-request');
                    return item;
                });
            } catch (err: any) {
                return [new BBTreeItem(`Error: ${err.message}`, 0, '', vscode.TreeItemCollapsibleState.None)];
            }
        }

        return [];
    }
}

export class BBTreeItem extends vscode.TreeItem {
    url?: string;
    section?: BBSection;

    constructor(
        label: string,
        public readonly prId: number,
        public readonly itemType: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        section?: BBSection,
    ) {
        super(label, collapsibleState);
        this.section = section;
        if (section) {
            this.iconPath = new vscode.ThemeIcon(section === 'my' ? 'account' : 'eye');
        }
    }
}
