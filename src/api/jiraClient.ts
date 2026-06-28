import { JiraCredentials } from '../auth/authManager';

const SUBTASK_TYPE_ID = '5';

export interface JiraIssue {
    key: string;
    self: string;
    fields: {
        summary: string;
        status: { name: string };
        issuetype: { name: string; id: string };
        assignee?: { name: string; displayName: string } | null;
        labels: string[];
        fixVersions: { name: string }[];
        project: { key: string };
        description?: string;
        priority?: { name: string };
        subtasks?: {
            key: string;
            fields: {
                summary: string;
                status: { name: string };
                assignee?: { name: string; displayName: string } | null;
            };
        }[];
    };
}

export interface JiraTransition {
    id: string;
    name: string;
    to: { name: string };
}

export interface JiraSearchResult {
    issues: JiraIssue[];
    total: number;
    maxResults: number;
}

export class JiraClient {
    private baseUrl: string;
    private apiBase: string;
    private authHeader: string;

    constructor(baseUrl: string, credentials: JiraCredentials) {
        this.baseUrl = baseUrl;
        this.apiBase = `${baseUrl}/rest/api/2`;
        // Jira Server PAT uses Bearer auth
        this.authHeader = `Bearer ${credentials.pat}`;
    }

    private get headers(): Record<string, string> {
        return {
            'Authorization': this.authHeader,
            'Content-Type': 'application/json',
        };
    }

    private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.apiBase}/${path}`;
        const resp = await fetch(url, {
            method,
            headers: this.headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!resp.ok) {
            const text = await resp.text();
            let detail = text.substring(0, 500);
            try {
                const errJson = JSON.parse(text);
                const msgs = errJson.errorMessages || [];
                const fieldErrors = errJson.errors ? Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`) : [];
                detail = [...msgs, ...fieldErrors].join('; ') || detail;
            } catch { /* use raw text */ }
            throw new Error(`Jira ${method} ${path} failed (${resp.status}): ${detail}`);
        }
        if (resp.status === 204) { return {} as T; }
        return resp.json() as Promise<T>;
    }

    // ── Issues ──────────────────────────────────────────────────

    async getIssue(issueKey: string): Promise<JiraIssue> {
        return this.apiRequest<JiraIssue>('GET', `issue/${issueKey}`);
    }

    async createIssue(params: {
        projectKey: string;
        issueType: string;
        summary: string;
        description?: string;
        labels?: string[];
        fixVersions?: string[];
        assignee?: string;
    }): Promise<{ key: string; self: string }> {
        const issueTypeMap: Record<string, string> = {
            'story': '7',
            'task': '3',
            'bug': '1',
        };
        const typeId = issueTypeMap[params.issueType.toLowerCase()] || params.issueType;

        const fields: Record<string, unknown> = {
            project: { key: params.projectKey },
            issuetype: { id: typeId },
            summary: params.summary,
        };
        if (params.description) { fields.description = params.description; }
        if (params.labels?.length) { fields.labels = params.labels; }
        if (params.fixVersions?.length) { fields.fixVersions = params.fixVersions.map(v => ({ name: v })); }
        if (params.assignee) { fields.assignee = { name: params.assignee }; }

        return this.apiRequest<{ key: string; self: string }>('POST', 'issue', { fields });
    }

    async createSubtask(params: {
        parentKey: string;
        projectKey: string;
        summary: string;
        description?: string;
        labels?: string[];
        fixVersions?: string[];
        assignee?: string;
    }): Promise<{ key: string; self: string }> {
        const fields: Record<string, unknown> = {
            project: { key: params.projectKey },
            parent: { key: params.parentKey },
            issuetype: { id: SUBTASK_TYPE_ID },
            summary: params.summary,
        };
        if (params.description) { fields.description = params.description; }
        if (params.labels?.length) { fields.labels = params.labels; }
        if (params.fixVersions?.length) { fields.fixVersions = params.fixVersions.map(v => ({ name: v })); }
        if (params.assignee) { fields.assignee = { name: params.assignee }; }

        return this.apiRequest<{ key: string; self: string }>('POST', 'issue', { fields });
    }

    // ── Search ──────────────────────────────────────────────────

    async search(jql: string, maxResults: number = 20): Promise<JiraSearchResult> {
        return this.apiRequest<JiraSearchResult>('POST', 'search', {
            jql,
            maxResults,
            fields: ['summary', 'status', 'assignee', 'labels', 'fixVersions', 'issuetype', 'priority', 'project'],
        });
    }

    // ── Transitions ─────────────────────────────────────────────

    async getTransitions(issueKey: string): Promise<JiraTransition[]> {
        const data = await this.apiRequest<{ transitions: JiraTransition[] }>('GET', `issue/${issueKey}/transitions`);
        return data.transitions;
    }

    async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
        const transitions = await this.getTransitions(issueKey);
        const match = transitions.find(t =>
            t.name.toLowerCase() === transitionName.toLowerCase() ||
            t.to.name.toLowerCase() === transitionName.toLowerCase()
        );
        if (!match) {
            const available = transitions.map(t => `"${t.name}" → ${t.to.name}`).join(', ');
            throw new Error(`No transition matching "${transitionName}". Available: ${available}`);
        }
        await this.apiRequest<void>('POST', `issue/${issueKey}/transitions`, {
            transition: { id: match.id },
        });
    }

    // ── Comments ────────────────────────────────────────────────

    async addComment(issueKey: string, body: string): Promise<{ id: string }> {
        return this.apiRequest<{ id: string }>('POST', `issue/${issueKey}/comment`, { body });
    }

    // ── Update Fields ───────────────────────────────────────────

    async updateFields(issueKey: string, fields: {
        summary?: string;
        description?: string;
        labels?: string[];
        fixVersions?: string[];
        assignee?: string;
        priority?: string;
        originalEstimate?: string;
        remainingEstimate?: string;
    }): Promise<void> {
        const update: Record<string, unknown> = {};
        if (fields.summary !== undefined) { update.summary = fields.summary; }
        if (fields.description !== undefined) { update.description = fields.description; }
        if (fields.labels !== undefined) { update.labels = fields.labels; }
        if (fields.fixVersions !== undefined) { update.fixVersions = fields.fixVersions.map(v => ({ name: v })); }
        if (fields.assignee !== undefined) { update.assignee = { name: fields.assignee }; }
        if (fields.priority !== undefined) { update.priority = { name: fields.priority }; }
        if (fields.originalEstimate !== undefined || fields.remainingEstimate !== undefined) {
            update.timetracking = {
                ...(fields.originalEstimate !== undefined ? { originalEstimate: fields.originalEstimate } : {}),
                ...(fields.remainingEstimate !== undefined ? { remainingEstimate: fields.remainingEstimate } : {}),
            };
        }

        await this.apiRequest<void>('PUT', `issue/${issueKey}`, { fields: update });
    }

    // ── Worklog ──────────────────────────────────────────────────

    async logWork(issueKey: string, timeSpent: string, started?: string): Promise<{ id: string }> {
        // started must be in ISO 8601 with milliseconds and timezone offset, e.g. "2026-06-04T09:00:00.000+0000"
        const startedStr = started ?? new Date().toISOString().replace('Z', '+0000').replace(/\.\d{3}\+/, '.000+');
        return this.apiRequest<{ id: string }>('POST', `issue/${issueKey}/worklog`, {
            timeSpent,
            started: startedStr,
        });
    }

    // ── Assign ──────────────────────────────────────────────────

    async assignIssue(issueKey: string, assignee: string): Promise<void> {
        await this.apiRequest<void>('PUT', `issue/${issueKey}/assignee`, { name: assignee });
    }

    // ── Link Issues ─────────────────────────────────────────────

    async linkIssues(linkType: string, inwardKey: string, outwardKey: string): Promise<void> {
        await this.apiRequest<void>('POST', 'issueLink', {
            type: { name: linkType },
            inwardIssue: { key: inwardKey },
            outwardIssue: { key: outwardKey },
        });
    }

    // ── Helpers ─────────────────────────────────────────────────

    getBrowseUrl(issueKey: string): string {
        return `${this.baseUrl}/browse/${issueKey}`;
    }
}
