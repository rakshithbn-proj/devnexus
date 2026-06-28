export interface PullRequest {
    id: number;
    title: string;
    description: string;
    state: string;
    author: { user: { name: string; displayName: string } };
    reviewers: { user: { name: string; displayName: string }; status: string }[];
    fromRef: { id: string; displayId: string; latestCommit: string };
    toRef: { id: string; displayId: string; latestCommit: string };
    links: { self: { href: string }[] };
    updatedDate: number;
}

export interface PRChange {
    contentId: string;
    path: { toString: string; name: string };
    type: string; // ADD, MODIFY, DELETE, MOVE, COPY
    srcPath?: { toString: string };
}

export interface PRComment {
    id: number;
    text: string;
    author: { name: string; displayName: string };
    createdDate: number;
    version: number;
    depth?: number;
    anchor?: {
        path: string;
        line: number;
        lineType: string;
    };
}

export interface BitbucketConfig {
    baseUrl: string;
    project: string;
    /** Default repository slug. Optional — tools may pass an explicit repo per call. */
    repo?: string;
}

export interface BitbucketRepo {
    slug: string;
    name: string;
    project: { key: string };
}

export class BitbucketClient {
    private config: BitbucketConfig;
    private pat: string;
    private _currentUser: string | undefined;

    constructor(config: BitbucketConfig, pat: string) {
        // Strip trailing slashes so URL concatenation never produces '//rest/...'.
        this.config = {
            ...config,
            baseUrl: config.baseUrl.replace(/\/+$/, ''),
        };
        this.pat = pat;
    }

    private resolveRepo(explicit?: string): string {
        const slug = (explicit ?? this.config.repo ?? '').trim();
        if (!slug) {
            throw new Error(
                'Bitbucket repository not specified. Pass a `repo` argument to the tool, ' +
                'or set `devnexus.bitbucket.repo` in VS Code Settings as the default.'
            );
        }
        return slug;
    }

    private repoApi(repo?: string): string {
        const slug = this.resolveRepo(repo);
        return `${this.config.baseUrl}/rest/api/1.0/projects/${this.config.project}/repos/${slug}`;
    }

    get currentUser(): string | undefined { return this._currentUser; }

    private get headers(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.pat}`,
            'Content-Type': 'application/json',
        };
    }

    private async apiGet<T>(path: string, params?: Record<string, string>, repo?: string): Promise<T> {
        let url = `${this.repoApi(repo)}${path}`;
        if (params) {
            url += `?${new URLSearchParams(params).toString()}`;
        }
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) {
            throw new Error(`Bitbucket GET ${path} failed: ${resp.status} ${resp.statusText}`);
        }
        return resp.json() as Promise<T>;
    }

    private async apiPost<T>(path: string, body: unknown, repo?: string): Promise<T> {
        const resp = await fetch(`${this.repoApi(repo)}${path}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Bitbucket POST ${path} failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<T>;
    }

    private async apiPut<T>(path: string, body: unknown, repo?: string): Promise<T> {
        const resp = await fetch(`${this.repoApi(repo)}${path}`, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            throw new Error(`Bitbucket PUT ${path} failed: ${resp.status} ${resp.statusText}`);
        }
        return resp.json() as Promise<T>;
    }

    private async apiDelete(path: string, repo?: string): Promise<void> {
        const resp = await fetch(`${this.repoApi(repo)}${path}`, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (!resp.ok) {
            throw new Error(`Bitbucket DELETE ${path} failed: ${resp.status} ${resp.statusText}`);
        }
    }

    // ── Current User ────────────────────────────────────────────

    async resolveCurrentUser(): Promise<string | undefined> {
        if (this._currentUser) { return this._currentUser; }
        try {
            const resp = await fetch(`${this.config.baseUrl}/plugins/servlet/applinks/whoami`, {
                headers: this.headers,
            });
            if (resp.ok) {
                this._currentUser = (await resp.text()).trim() || undefined;
            }
        } catch { /* ignore */ }
        return this._currentUser;
    }

    // ── Pull Requests ───────────────────────────────────────────

    /** List all repositories in the configured Bitbucket project. */
    async listRepos(limit: number = 1000): Promise<BitbucketRepo[]> {
        const url = `${this.config.baseUrl}/rest/api/1.0/projects/${this.config.project}/repos?limit=${limit}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Bitbucket list repos failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        const data = await resp.json() as { values: BitbucketRepo[] };
        return data.values;
    }

    async listPRs(state: string = 'OPEN', limit: number = 25, repo?: string): Promise<PullRequest[]> {
        const data = await this.apiGet<{ values: PullRequest[] }>('/pull-requests', {
            state,
            limit: limit.toString(),
        }, repo);
        return data.values;
    }

    /**
     * List PRs across ALL repos in the configured project where the current user has
     * the given role. Uses the dashboard endpoint, so no specific repo is required.
     */
    private async dashboardPRs(role: 'AUTHOR' | 'REVIEWER', limit: number): Promise<PullRequest[]> {
        const params = new URLSearchParams({
            role,
            state: 'OPEN',
            limit: limit.toString(),
            order: 'NEWEST',
        });
        const url = `${this.config.baseUrl}/rest/api/1.0/dashboard/pull-requests?${params.toString()}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Bitbucket dashboard PRs failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        const data = await resp.json() as { values: PullRequest[] };
        // Filter to the configured project (dashboard returns PRs across all projects).
        return data.values.filter(pr => {
            const projectKey = (pr as any)?.toRef?.repository?.project?.key;
            return !projectKey || projectKey === this.config.project;
        });
    }

    async getMyPRs(limit: number = 25): Promise<PullRequest[]> {
        if (!this.config.repo) {
            return this.dashboardPRs('AUTHOR', limit);
        }
        const allPRs = await this.listPRs('OPEN', limit);
        const username = await this.resolveCurrentUser();
        if (!username) { return allPRs; }
        return allPRs.filter(pr => pr.author.user.name.toLowerCase() === username.toLowerCase());
    }

    async getPRsToReview(limit: number = 25): Promise<PullRequest[]> {
        if (!this.config.repo) {
            return this.dashboardPRs('REVIEWER', limit);
        }
        const allPRs = await this.listPRs('OPEN', limit);
        const username = await this.resolveCurrentUser();
        if (!username) { return []; }
        return allPRs.filter(pr =>
            pr.reviewers.some(r => r.user.name.toLowerCase() === username.toLowerCase())
        );
    }

    async getPR(prId: number, repo?: string): Promise<PullRequest> {
        return this.apiGet<PullRequest>(`/pull-requests/${prId}`, undefined, repo);
    }

    async createPR(params: {
        title: string;
        description?: string;
        fromBranch: string;
        toBranch?: string;
        reviewers?: string[];
        repo?: string;
    }): Promise<PullRequest> {
        const body: Record<string, unknown> = {
            title: params.title,
            description: params.description || '',
            fromRef: { id: `refs/heads/${params.fromBranch}` },
            toRef: { id: `refs/heads/${params.toBranch || 'develop'}` },
        };
        if (params.reviewers?.length) {
            body.reviewers = params.reviewers.map(u => ({ user: { name: u } }));
        }
        return this.apiPost<PullRequest>('/pull-requests', body, params.repo);
    }

    async mergePR(prId: number, repo?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo);
        const version = (pr as any).version ?? 0;
        return this.apiPost<PullRequest>(`/pull-requests/${prId}/merge?version=${version}`, {}, repo);
    }

    async approvePR(prId: number, repo?: string): Promise<void> {
        const resp = await fetch(`${this.repoApi(repo)}/pull-requests/${prId}/approve`, {
            method: 'POST',
            headers: this.headers,
        });
        if (!resp.ok) {
            throw new Error(`Approve failed: ${resp.status} ${resp.statusText}`);
        }
    }

    async declinePR(prId: number, repo?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo);
        const version = (pr as any).version ?? 0;
        return this.apiPost<PullRequest>(`/pull-requests/${prId}/decline?version=${version}`, {}, repo);
    }

    async needsWorkPR(prId: number, repo?: string): Promise<void> {
        const currentUser = (await this.resolveCurrentUser()) || '';
        if (!currentUser) {
            throw new Error('Unable to resolve current Bitbucket user for needs-work action.');
        }

        const resp = await fetch(
            `${this.repoApi(repo)}/pull-requests/${prId}/participants/${encodeURIComponent(currentUser)}`,
            {
                method: 'PUT',
                headers: this.headers,
                body: JSON.stringify({ status: 'NEEDS_WORK' }),
            }
        );

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Mark needs work failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
    }

    // ── Reviewers ───────────────────────────────────────────────

    async addReviewer(prId: number, username: string, repo?: string): Promise<void> {
        const pr = await this.getPR(prId, repo);
        const existing = pr.reviewers.map(r => ({ user: { name: r.user.name } }));
        existing.push({ user: { name: username } });
        await this.apiPut(`/pull-requests/${prId}`, {
            title: pr.title,
            reviewers: existing,
            version: (pr as any).version ?? 0,
        }, repo);
    }

    async removeReviewer(prId: number, username: string, repo?: string): Promise<void> {
        const pr = await this.getPR(prId, repo);
        const filtered = pr.reviewers
            .filter(r => r.user.name.toLowerCase() !== username.toLowerCase())
            .map(r => ({ user: { name: r.user.name } }));
        await this.apiPut(`/pull-requests/${prId}`, {
            title: pr.title,
            reviewers: filtered,
            version: (pr as any).version ?? 0,
        }, repo);
    }

    // ── Changes & Diffs ─────────────────────────────────────────

    async getChanges(prId: number, repo?: string): Promise<PRChange[]> {
        const data = await this.apiGet<{ values: PRChange[] }>(`/pull-requests/${prId}/changes`, { limit: '1000' }, repo);
        return data.values;
    }

    async getDiff(prId: number, filePath: string, contextLines: number = 5, repo?: string): Promise<string> {
        const url = `${this.repoApi(repo)}/pull-requests/${prId}/diff/${filePath}?contextLines=${contextLines}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) {
            throw new Error(`Diff failed: ${resp.status} ${resp.statusText}`);
        }
        return resp.text();
    }

    // ── Comments ────────────────────────────────────────────────

    async getComments(prId: number, repo?: string): Promise<PRComment[]> {
        const url = `${this.repoApi(repo)}/pull-requests/${prId}/activities?limit=500`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Get PR activities failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        const data = await resp.json() as { values: any[] };
        const comments: PRComment[] = [];
        for (const activity of data.values) {
            if (activity.action === 'COMMENTED' && activity.comment) {
                this.collectCommentTree(activity.comment, comments, 0);
            }
        }
        return comments;
    }

    /** Recursively collect a comment and all its replies, tracking depth */
    private collectCommentTree(c: any, out: PRComment[], depth: number): void {
        out.push({
            id: c.id,
            text: c.text,
            author: c.author,
            createdDate: c.createdDate,
            version: c.version,
            anchor: c.anchor,
            depth,
        });
        if (c.comments && Array.isArray(c.comments)) {
            for (const reply of c.comments) {
                this.collectCommentTree(reply, out, depth + 1);
            }
        }
    }

    async addComment(prId: number, text: string, anchor?: {
        path: string;
        line: number;
        lineType?: string;
    }, severity?: 'NORMAL' | 'BLOCKER', repo?: string): Promise<PRComment> {
        const body: Record<string, unknown> = { text };
        if (anchor) {
            body.anchor = {
                path: anchor.path,
                line: anchor.line,
                lineType: anchor.lineType || 'ADDED',
                fileType: 'TO',
            };
        }
        if (severity === 'BLOCKER') {
            body.severity = 'BLOCKER';
        }
        return this.apiPost<PRComment>(`/pull-requests/${prId}/comments`, body, repo);
    }

    // ── Branches ────────────────────────────────────────────────

    async createBranch(branchName: string, startPoint: string = 'develop', repo?: string): Promise<{ id: string; displayId: string }> {
        const slug = this.resolveRepo(repo);
        const url = `${this.config.baseUrl}/rest/branch-utils/1.0/projects/${this.config.project}/repos/${slug}/branches`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                name: branchName,
                startPoint: `refs/heads/${startPoint}`,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Create branch failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<{ id: string; displayId: string }>;
    }

    // ── Helpers ─────────────────────────────────────────────────

    getPRUrl(prId: number, repo?: string): string {
        const slug = this.resolveRepo(repo);
        return `${this.config.baseUrl}/projects/${this.config.project}/repos/${slug}/pull-requests/${prId}`;
    }
}
