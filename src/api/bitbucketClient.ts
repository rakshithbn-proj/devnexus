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
    repository?: { slug: string; project?: { key: string } };
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

export interface PRCommit {
    id: string;
    displayId: string;
    message: string;
    author: { name: string; emailAddress: string };
    authorTimestamp: number;
    parents?: Array<{ id: string; displayId: string }>;
}

export interface PRTask {
    id: number;
    text: string;
    state: string;
    author: { name: string; displayName: string };
    createdDate: number;
    version: number;
    anchor?: { id: number; type: string };
}

export interface RepoInfo {
    slug: string;
    name: string;
    description?: string;
}

export interface BranchInfo {
    id: string;
    displayId: string;
    latestCommit: string;
    isDefault?: boolean;
}

export interface BuildStatus {
    state: string;
    key: string;
    name?: string;
    url: string;
    description?: string;
    dateAdded: number;
}

export interface TagInfo {
    id: string;
    displayId: string;
    latestCommit: string;
    hash?: string;
}

export interface BitbucketConfig {
    baseUrl: string;
    project: string;
    repo: string;
}

export class BitbucketClient {
    private config: BitbucketConfig;
    private pat: string;
    private _currentUser: string | undefined;

    constructor(config: BitbucketConfig, pat: string) {
        this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
        this.pat = pat;
    }

    get currentUser(): string | undefined { return this._currentUser; }

    private get headers(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.pat}`,
            'Content-Type': 'application/json',
        };
    }

    private repoBase(repo?: string, project?: string): string {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        return `${this.config.baseUrl}/rest/api/1.0/projects/${proj}/repos/${repoSlug}`;
    }

    private async apiGet<T>(path: string, params?: Record<string, string>, repo?: string, project?: string): Promise<T> {
        const base = this.repoBase(repo, project);
        let url = `${base}${path}`;
        if (params) { url += `?${new URLSearchParams(params).toString()}`; }
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Bitbucket GET ${path} failed: ${resp.status} ${resp.statusText}`); }
        return resp.json() as Promise<T>;
    }

    private async apiPost<T>(path: string, body: unknown, repo?: string, project?: string): Promise<T> {
        const resp = await fetch(`${this.repoBase(repo, project)}${path}`, {
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

    private async apiPut<T>(path: string, body: unknown, repo?: string, project?: string): Promise<T> {
        const resp = await fetch(`${this.repoBase(repo, project)}${path}`, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) { throw new Error(`Bitbucket PUT ${path} failed: ${resp.status} ${resp.statusText}`); }
        return resp.json() as Promise<T>;
    }

    private async apiDelete(path: string, repo?: string, project?: string): Promise<void> {
        const resp = await fetch(`${this.repoBase(repo, project)}${path}`, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (!resp.ok) { throw new Error(`Bitbucket DELETE ${path} failed: ${resp.status} ${resp.statusText}`); }
    }

    // ── Dashboard helper (cross-repo) ───────────────────────────

    private async dashboardPRs(params: Record<string, string>): Promise<PullRequest[]> {
        const url = `${this.config.baseUrl}/rest/api/1.0/dashboard/pull-requests?${new URLSearchParams(params)}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Dashboard PRs failed: ${resp.status} ${resp.statusText}`); }
        const data = await resp.json() as { values: PullRequest[] };
        return data.values;
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

    // ── Pull Requests (all cross-repo via dashboard) ─────────────

    async listPRs(state: string = 'OPEN', limit: number = 25): Promise<PullRequest[]> {
        return this.dashboardPRs({ state, limit: limit.toString() });
    }

    async getMyPRs(limit: number = 25): Promise<PullRequest[]> {
        return this.dashboardPRs({ role: 'AUTHOR', state: 'OPEN', limit: limit.toString() });
    }

    async getPRsToReview(limit: number = 25): Promise<PullRequest[]> {
        return this.dashboardPRs({ role: 'REVIEWER', state: 'OPEN', limit: limit.toString() });
    }

    async getPR(prId: number, repo?: string, project?: string): Promise<PullRequest> {
        return this.apiGet<PullRequest>(`/pull-requests/${prId}`, undefined, repo, project);
    }

    async createPR(params: {
        title: string;
        description?: string;
        fromBranch: string;
        toBranch?: string;
        reviewers?: string[];
        repo?: string;
        project?: string;
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
        return this.apiPost<PullRequest>('/pull-requests', body, params.repo, params.project);
    }

    async mergePR(prId: number, repo?: string, project?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo, project);
        const version = (pr as any).version ?? 0;
        return this.apiPost<PullRequest>(`/pull-requests/${prId}/merge?version=${version}`, {}, repo, project);
    }

    async approvePR(prId: number, repo?: string, project?: string): Promise<void> {
        const resp = await fetch(`${this.repoBase(repo, project)}/pull-requests/${prId}/approve`, {
            method: 'POST',
            headers: this.headers,
        });
        if (!resp.ok) { throw new Error(`Approve failed: ${resp.status} ${resp.statusText}`); }
    }

    async declinePR(prId: number, repo?: string, project?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo, project);
        const version = (pr as any).version ?? 0;
        return this.apiPost<PullRequest>(`/pull-requests/${prId}/decline?version=${version}`, {}, repo, project);
    }

    async needsWorkPR(prId: number, repo?: string, project?: string): Promise<void> {
        const currentUser = (await this.resolveCurrentUser()) || '';
        if (!currentUser) { throw new Error('Unable to resolve current Bitbucket user for needs-work action.'); }
        const resp = await fetch(
            `${this.repoBase(repo, project)}/pull-requests/${prId}/participants/${encodeURIComponent(currentUser)}`,
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

    async addReviewer(prId: number, username: string, repo?: string, project?: string): Promise<void> {
        const pr = await this.getPR(prId, repo, project);
        const existing = pr.reviewers.map(r => ({ user: { name: r.user.name } }));
        existing.push({ user: { name: username } });
        await this.apiPut(`/pull-requests/${prId}`, {
            title: pr.title,
            reviewers: existing,
            version: (pr as any).version ?? 0,
        }, repo, project);
    }

    async removeReviewer(prId: number, username: string, repo?: string, project?: string): Promise<void> {
        const pr = await this.getPR(prId, repo, project);
        const filtered = pr.reviewers
            .filter(r => r.user.name.toLowerCase() !== username.toLowerCase())
            .map(r => ({ user: { name: r.user.name } }));
        await this.apiPut(`/pull-requests/${prId}`, {
            title: pr.title,
            reviewers: filtered,
            version: (pr as any).version ?? 0,
        }, repo, project);
    }

    // ── Changes & Diffs ─────────────────────────────────────────

    async getChanges(prId: number, repo?: string, project?: string): Promise<PRChange[]> {
        const data = await this.apiGet<{ values: PRChange[] }>(`/pull-requests/${prId}/changes`, { limit: '1000' }, repo, project);
        return data.values;
    }

    async getDiff(prId: number, filePath: string, contextLines: number = 5, repo?: string, project?: string): Promise<string> {
        const url = `${this.repoBase(repo, project)}/pull-requests/${prId}/diff/${filePath}?contextLines=${contextLines}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Diff failed: ${resp.status} ${resp.statusText}`); }
        return resp.text();
    }

    // ── Comments ────────────────────────────────────────────────

    async getComments(prId: number, repo?: string, project?: string): Promise<PRComment[]> {
        const url = `${this.repoBase(repo, project)}/pull-requests/${prId}/activities?limit=500`;
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

    private collectCommentTree(c: any, out: PRComment[], depth: number): void {
        out.push({
            id: c.id, text: c.text, author: c.author, createdDate: c.createdDate,
            version: c.version, anchor: c.anchor, depth,
        });
        if (c.comments && Array.isArray(c.comments)) {
            for (const reply of c.comments) { this.collectCommentTree(reply, out, depth + 1); }
        }
    }

    async addComment(prId: number, text: string, anchor?: {
        path: string; line: number; lineType?: string;
    }, severity?: 'NORMAL' | 'BLOCKER', repo?: string, project?: string): Promise<PRComment> {
        const body: Record<string, unknown> = { text };
        if (anchor) {
            body.anchor = { path: anchor.path, line: anchor.line, lineType: anchor.lineType || 'ADDED', fileType: 'TO' };
        }
        if (severity === 'BLOCKER') { body.severity = 'BLOCKER'; }
        return this.apiPost<PRComment>(`/pull-requests/${prId}/comments`, body, repo, project);
    }

    async updateComment(prId: number, commentId: number, text: string, version: number, repo?: string, project?: string): Promise<PRComment> {
        return this.apiPut<PRComment>(`/pull-requests/${prId}/comments/${commentId}`, { text, version }, repo, project);
    }

    async deleteComment(prId: number, commentId: number, version: number, repo?: string, project?: string): Promise<void> {
        await this.apiDelete(`/pull-requests/${prId}/comments/${commentId}?version=${version}`, repo, project);
    }

    async replyToComment(prId: number, parentCommentId: number, text: string, repo?: string, project?: string): Promise<PRComment> {
        return this.apiPost<PRComment>(`/pull-requests/${prId}/comments`, { text, parent: { id: parentCommentId } }, repo, project);
    }

    // ── Branches ────────────────────────────────────────────────

    async createBranch(branchName: string, startPoint: string = 'develop', repo?: string, project?: string): Promise<{ id: string; displayId: string }> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        const url = `${this.config.baseUrl}/rest/branch-utils/1.0/projects/${proj}/repos/${repoSlug}/branches`;
        const resp = await fetch(url, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify({ name: branchName, startPoint: `refs/heads/${startPoint}` }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Create branch failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<{ id: string; displayId: string }>;
    }

    // ── Repos & Branches ────────────────────────────────────────

    async listRepos(project?: string, limit: number = 100): Promise<RepoInfo[]> {
        const proj = project || this.config.project;
        const url = `${this.config.baseUrl}/rest/api/1.0/projects/${proj}/repos?limit=${limit}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`List repos failed: ${resp.status} ${resp.statusText}`); }
        const data = await resp.json() as { values: any[] };
        return data.values.map((r: any) => ({ slug: r.slug, name: r.name, description: r.description }));
    }

    async getBranches(repo: string, project?: string, filter?: string, limit: number = 100): Promise<BranchInfo[]> {
        const proj = project || this.config.project;
        let url = `${this.config.baseUrl}/rest/api/1.0/projects/${proj}/repos/${repo}/branches?limit=${limit}`;
        if (filter) { url += `&filterText=${encodeURIComponent(filter)}`; }
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Get branches failed: ${resp.status} ${resp.statusText}`); }
        const data = await resp.json() as { values: BranchInfo[] };
        return data.values;
    }

    async getDefaultBranch(repo?: string, project?: string): Promise<BranchInfo> {
        return this.apiGet<BranchInfo>('/default-branch', undefined, repo, project);
    }

    async setDefaultBranch(branchName: string, repo?: string, project?: string): Promise<void> {
        const resp = await fetch(`${this.repoBase(repo, project)}/default-branch`, {
            method: 'PUT', headers: this.headers,
            body: JSON.stringify({ id: `refs/heads/${branchName}` }),
        });
        if (!resp.ok) { throw new Error(`Set default branch failed: ${resp.status} ${resp.statusText}`); }
    }

    async deleteBranch(branchName: string, repo?: string, project?: string): Promise<void> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        const url = `${this.config.baseUrl}/rest/branch-utils/1.0/projects/${proj}/repos/${repoSlug}/branches`;
        const resp = await fetch(url, {
            method: 'DELETE', headers: this.headers,
            body: JSON.stringify({ name: `refs/heads/${branchName}`, dryRun: false }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Delete branch failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
    }

    // ── Update & Reopen PR ───────────────────────────────────────

    async updatePR(prId: number, updates: { title?: string; description?: string; targetBranch?: string }, repo?: string, project?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo, project);
        const body: Record<string, unknown> = {
            title: updates.title || pr.title,
            description: updates.description !== undefined ? updates.description : pr.description,
            version: (pr as any).version ?? 0,
            reviewers: pr.reviewers.map(r => ({ user: { name: r.user.name } })),
        };
        if (updates.targetBranch) { body.toRef = { id: `refs/heads/${updates.targetBranch}` }; }
        return this.apiPut<PullRequest>(`/pull-requests/${prId}`, body, repo, project);
    }

    async reopenPR(prId: number, repo?: string, project?: string): Promise<PullRequest> {
        const pr = await this.getPR(prId, repo, project);
        const version = (pr as any).version ?? 0;
        return this.apiPost<PullRequest>(`/pull-requests/${prId}/reopen?version=${version}`, {}, repo, project);
    }

    // ── Commits ──────────────────────────────────────────────────

    async getPRCommits(prId: number, limit: number = 100, repo?: string, project?: string): Promise<PRCommit[]> {
        const data = await this.apiGet<{ values: PRCommit[] }>(`/pull-requests/${prId}/commits`, { limit: limit.toString() }, repo, project);
        return data.values;
    }

    async getCommits(until?: string, limit: number = 25, path?: string, repo?: string, project?: string): Promise<PRCommit[]> {
        const params: Record<string, string> = { limit: limit.toString() };
        if (until) { params.until = until; }
        if (path) { params.path = path; }
        const data = await this.apiGet<{ values: PRCommit[] }>('/commits', params, repo, project);
        return data.values;
    }

    async getCommit(commitId: string, repo?: string, project?: string): Promise<PRCommit> {
        return this.apiGet<PRCommit>(`/commits/${commitId}`, undefined, repo, project);
    }

    // ── PR Tasks ─────────────────────────────────────────────────

    async listTasks(prId: number, repo?: string, project?: string): Promise<PRTask[]> {
        const data = await this.apiGet<{ values: PRTask[] }>(`/pull-requests/${prId}/tasks`, { limit: '200' }, repo, project);
        return data.values;
    }

    async createTask(prId: number, text: string, commentId?: number, repo?: string, project?: string): Promise<PRTask> {
        const body: Record<string, unknown> = { text, state: 'OPEN' };
        if (commentId !== undefined) { body.anchor = { id: commentId, type: 'COMMENT' }; }
        return this.apiPost<PRTask>(`/pull-requests/${prId}/tasks`, body, repo, project);
    }

    async resolveTask(taskId: number, version: number): Promise<PRTask> {
        const url = `${this.config.baseUrl}/rest/api/1.0/tasks/${taskId}`;
        const resp = await fetch(url, {
            method: 'PUT', headers: this.headers,
            body: JSON.stringify({ id: taskId, state: 'RESOLVED', version }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Resolve task failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<PRTask>;
    }

    async reopenTask(taskId: number, version: number): Promise<PRTask> {
        const url = `${this.config.baseUrl}/rest/api/1.0/tasks/${taskId}`;
        const resp = await fetch(url, {
            method: 'PUT', headers: this.headers,
            body: JSON.stringify({ id: taskId, state: 'OPEN', version }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Reopen task failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<PRTask>;
    }

    async deleteTask(taskId: number, version: number): Promise<void> {
        const url = `${this.config.baseUrl}/rest/api/1.0/tasks/${taskId}?version=${version}`;
        const resp = await fetch(url, { method: 'DELETE', headers: this.headers });
        if (!resp.ok) { throw new Error(`Delete task failed: ${resp.status} ${resp.statusText}`); }
    }

    // ── File Browsing ────────────────────────────────────────────

    async getFile(filePath: string, branch?: string, repo?: string, project?: string): Promise<string> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        let url = `${this.config.baseUrl}/rest/api/1.0/projects/${proj}/repos/${repoSlug}/raw/${filePath}`;
        if (branch) { url += `?at=refs/heads/${encodeURIComponent(branch)}`; }
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Get file failed: ${resp.status} ${resp.statusText}`); }
        return resp.text();
    }

    async browse(dirPath: string = '', branch?: string, repo?: string, project?: string): Promise<Array<{ name: string; type: string; size?: number }>> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        const pathPart = dirPath ? `/${dirPath}` : '';
        let url = `${this.config.baseUrl}/rest/api/1.0/projects/${proj}/repos/${repoSlug}/browse${pathPart}?limit=200`;
        if (branch) { url += `&at=refs/heads/${encodeURIComponent(branch)}`; }
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Browse failed: ${resp.status} ${resp.statusText}`); }
        const data = await resp.json() as { children?: { values: any[] } };
        return (data.children?.values || []).map((item: any) => ({
            name: item.path?.name || item.path?.toString || '',
            type: item.type || 'FILE',
            size: item.size,
        }));
    }

    async compare(from: string, to: string, repo?: string, project?: string): Promise<{ changes: PRChange[]; commits: PRCommit[] }> {
        const fromRef = `refs/heads/${from}`;
        const toRef = `refs/heads/${to}`;
        const [changesData, commitsData] = await Promise.all([
            this.apiGet<{ values: PRChange[] }>('/compare/changes', { from: fromRef, to: toRef, limit: '500' }, repo, project),
            this.apiGet<{ values: PRCommit[] }>('/compare/commits', { from: fromRef, to: toRef, limit: '100' }, repo, project),
        ]);
        return { changes: changesData.values, commits: commitsData.values };
    }

    // ── Tags ─────────────────────────────────────────────────────

    async listTags(filter?: string, limit: number = 100, repo?: string, project?: string): Promise<TagInfo[]> {
        const params: Record<string, string> = { limit: limit.toString() };
        if (filter) { params.filterText = filter; }
        const data = await this.apiGet<{ values: TagInfo[] }>('/tags', params, repo, project);
        return data.values;
    }

    async createTag(name: string, commitId: string, message?: string, repo?: string, project?: string): Promise<TagInfo> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        const url = `${this.config.baseUrl}/rest/git/1.0/projects/${proj}/repos/${repoSlug}/tags`;
        const resp = await fetch(url, {
            method: 'POST', headers: this.headers,
            body: JSON.stringify({ name, startPoint: commitId, ...(message ? { message } : {}) }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Create tag failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        return resp.json() as Promise<TagInfo>;
    }

    async deleteTag(name: string, repo?: string, project?: string): Promise<void> {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        const url = `${this.config.baseUrl}/rest/git/1.0/projects/${proj}/repos/${repoSlug}/tags/${encodeURIComponent(name)}`;
        const resp = await fetch(url, { method: 'DELETE', headers: this.headers });
        if (!resp.ok) { throw new Error(`Delete tag failed: ${resp.status} ${resp.statusText}`); }
    }

    // ── Build Status ─────────────────────────────────────────────

    async getBuildStatus(commitId: string): Promise<BuildStatus[]> {
        const url = `${this.config.baseUrl}/rest/build-status/1.0/commits/${commitId}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Get build status failed: ${resp.status} ${resp.statusText}`); }
        const data = await resp.json() as { values: BuildStatus[] };
        return data.values;
    }

    async setBuildStatus(commitId: string, params: {
        state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS';
        key: string; url: string; name?: string; description?: string;
    }): Promise<void> {
        const url = `${this.config.baseUrl}/rest/build-status/1.0/commits/${commitId}`;
        const resp = await fetch(url, { method: 'POST', headers: this.headers, body: JSON.stringify(params) });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Set build status failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
    }

    // ── Merge Check ──────────────────────────────────────────────

    async checkMerge(prId: number, repo?: string, project?: string): Promise<{ canMerge: boolean; vetoes: Array<{ summaryMessage: string; detailedMessage: string }> }> {
        return this.apiGet<{ canMerge: boolean; vetoes: any[] }>(`/pull-requests/${prId}/merge`, undefined, repo, project);
    }

    // ── Helpers ─────────────────────────────────────────────────

    getPRUrl(prId: number, repo?: string, project?: string): string {
        const proj = project || this.config.project;
        const repoSlug = repo || this.config.repo;
        return `${this.config.baseUrl}/projects/${proj}/repos/${repoSlug}/pull-requests/${prId}`;
    }
}
