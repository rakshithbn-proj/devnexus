import * as vscode from 'vscode';
import { BitbucketClient, PullRequest } from '../api/bitbucketClient';

type BBItemType = 'section' | 'repo' | 'pullRequest' | 'message';
type BBSection = 'my' | 'reviewing' | 'repos';

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
            return [new BBTreeItem('Set Bitbucket token to view PRs', 0, 'message', vscode.TreeItemCollapsibleState.None)];
        }

        // Top level: sections.
        if (!element) {
            return [
                new BBTreeItem('My Pull Requests', 0, 'section', vscode.TreeItemCollapsibleState.Expanded, 'my'),
                new BBTreeItem('PRs to Review', 0, 'section', vscode.TreeItemCollapsibleState.Expanded, 'reviewing'),
                new BBTreeItem('Repositories', 0, 'section', vscode.TreeItemCollapsibleState.Collapsed, 'repos'),
            ];
        }

        // Section children.
        if (element.itemType === 'section') {
            try {
                if (element.section === 'repos') {
                    const repos = await client.listRepos();
                    if (repos.length === 0) {
                        return [new BBTreeItem('(none)', 0, 'message', vscode.TreeItemCollapsibleState.None)];
                    }
                    return repos.map(r => {
                        const item = new BBTreeItem(
                            r.name,
                            0,
                            'repo',
                            vscode.TreeItemCollapsibleState.Collapsed,
                        );
                        item.repoSlug = r.slug;
                        item.description = r.slug;
                        item.tooltip = `${r.name} (${r.slug})`;
                        item.iconPath = new vscode.ThemeIcon('repo');
                        return item;
                    });
                }

                const prs = element.section === 'my'
                    ? await client.getMyPRs()
                    : await client.getPRsToReview();
                return this.prsToItems(prs, client);
            } catch (err: any) {
                return [new BBTreeItem(`Error: ${err.message}`, 0, 'message', vscode.TreeItemCollapsibleState.None)];
            }
        }

        // Repo children: open PRs in that repo.
        if (element.itemType === 'repo' && element.repoSlug) {
            try {
                const prs = await client.listPRs('OPEN', 50, element.repoSlug);
                return this.prsToItems(prs, client, element.repoSlug);
            } catch (err: any) {
                return [new BBTreeItem(`Error: ${err.message}`, 0, 'message', vscode.TreeItemCollapsibleState.None)];
            }
        }

        return [];
    }

    private prsToItems(prs: PullRequest[], client: BitbucketClient, repoSlug?: string): BBTreeItem[] {
        if (prs.length === 0) {
            return [new BBTreeItem('(none)', 0, 'message', vscode.TreeItemCollapsibleState.None)];
        }
        return prs.map(pr => {
            const slug = repoSlug ?? (pr as any).toRef?.repository?.slug;
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
            const slugLabel = slug && !repoSlug ? `${slug} | ` : '';
            item.tooltip = `${pr.title}\n${pr.fromRef.displayId} → ${pr.toRef.displayId}\nReviewers: ${reviewerStatus}`;
            item.description = `${slugLabel}${pr.fromRef.displayId} → ${pr.toRef.displayId}`;
            item.contextValue = 'bbPullRequest';
            item.url = slug ? client.getPRUrl(pr.id, slug) : undefined;
            item.iconPath = new vscode.ThemeIcon('git-pull-request');
            return item;
        });
    }
}

export class BBTreeItem extends vscode.TreeItem {
    url?: string;
    section?: BBSection;
    repoSlug?: string;

    constructor(
        label: string,
        public readonly prId: number,
        public readonly itemType: BBItemType,
        collapsibleState: vscode.TreeItemCollapsibleState,
        section?: BBSection,
    ) {
        super(label, collapsibleState);
        this.section = section;
        if (section === 'my') {
            this.iconPath = new vscode.ThemeIcon('account');
        } else if (section === 'reviewing') {
            this.iconPath = new vscode.ThemeIcon('eye');
        } else if (section === 'repos') {
            this.iconPath = new vscode.ThemeIcon('repo');
        }
    }
}
