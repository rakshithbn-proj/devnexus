export interface JiraCredentials {
    username: string;
    pat: string;
}

const SUBTASK_TYPE_ID = '5';

export interface JiraIssue {
    key: string;
    self: string;
    names?: Record<string, string>;
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
        startDate?: string;
        duedate?: string;
        subtasks?: {
            key: string;
            fields: {
                summary: string;
                status: { name: string };
                assignee?: { name: string; displayName: string } | null;
            };
        }[];
        issuelinks?: {
            type: { name: string; inward: string; outward: string };
            inwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
            outwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
        }[];
        [key: string]: unknown;
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
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiBase = `${this.baseUrl}/rest/api/2`;
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
        return this.apiRequest<JiraIssue>('GET', `issue/${issueKey}?expand=names`);
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
            fields: ['summary', 'status', 'assignee', 'labels', 'fixVersions', 'issuetype', 'priority', 'project', 'duedate', 'customfield_56601', 'customfield_56806', 'subtasks'],
        });
    }

    async searchWithFields(jql: string, fields: string[], maxResults: number = 50): Promise<{ issues: any[]; total: number }> {
        return this.apiRequest<{ issues: any[]; total: number }>('POST', 'search', { jql, maxResults, fields });
    }

    async getInitiativeIssues(initiativeKey: string, username?: string): Promise<{
        initiative: any;
        issues: any[];
        subIssues: Map<string, any[]>;
        queriesAttempted: string[];
        fieldNames: Record<string, string>;
    }> {
        // Fetch initiative details + complete field registry in parallel
        // /field gives ALL custom field definitions regardless of whether they have values on any issue,
        // so we can resolve "Start date" → customfield_XXXXX even when the value is null.
        const [initiative, allFieldDefs] = await Promise.all([
            this.apiRequest<any>('GET', `issue/${initiativeKey}?expand=names`),
            this.apiRequest<any[]>('GET', 'field').catch(() => [] as any[]),
        ]);
        const fieldNames: Record<string, string> = { ...(initiative.names || {}) };
        for (const f of allFieldDefs) {
            if (f.id && f.name) { fieldNames[f.id] = f.name; }
        }

        // Use *all minus heavy text/audit fields so we capture every custom date field
        // regardless of whether it is marked navigable in the Jira field configuration.
        const ALL_FIELDS = ['*all', '-comment', '-description', '-worklog', '-votes', '-watches', '-changelog'];
        const issueMap = new Map<string, any>();
        const queriesAttempted: string[] = [];

        const trySearch = async (jql: string): Promise<number> => {
            queriesAttempted.push(jql);
            try {
                const result = await this.apiRequest<any>('POST', 'search', {
                    jql, maxResults: 100, fields: ALL_FIELDS, expand: ['names'],
                });
                // Merge field names discovered from child issues
                Object.assign(fieldNames, result.names || {});
                (result.issues || []).forEach((i: any) => issueMap.set(i.key, i));
                return (result.issues || []).length;
            } catch { return 0; }
        };

        // Try all hierarchy relationship types in parallel
        await Promise.all([
            trySearch(`parent = ${initiativeKey}`),
            trySearch(`"Epic Link" = ${initiativeKey}`),
            trySearch(`"Parent Link" = ${initiativeKey}`),
            trySearch(`issue in portfolioChildrenOf("${initiativeKey}")`),
            trySearch(`issue in linkedIssuesOf("${initiativeKey}", "contains")`),
            trySearch(`issue in linkedIssuesOf("${initiativeKey}")`),
        ]);

        // Jira REST API uses lowercase "issuelinks"
        const issueLinks: any[] = initiative.fields?.issuelinks || [];
        const linkedKeys = issueLinks
            .flatMap((l: any) => [l.inwardIssue?.key, l.outwardIssue?.key])
            .filter((k: any): k is string => !!k && k !== initiativeKey && !issueMap.has(k));
        if (linkedKeys.length > 0) {
            await trySearch(`key in (${linkedKeys.join(',')})`);
        }

        // If still nothing found: retry with any epic/parent link field names from the registry
        if (issueMap.size === 0) {
            const ALREADY_TRIED = new Set(['Epic Link', 'Parent Link']);
            const linkFields = allFieldDefs.filter(f =>
                !ALREADY_TRIED.has(f.name) &&
                /epic|feature|initiative|parent/i.test(f.name) &&
                f.id?.startsWith('customfield_')
            );
            if (linkFields.length > 0) {
                await Promise.all(linkFields.map(f => trySearch(`"${f.name}" = ${initiativeKey}`)));
            }
        }

        let allIssues = Array.from(issueMap.values());

        if (username) {
            const uLower = username.toLowerCase();
            allIssues = allIssues.filter(i => {
                const a = i.fields?.assignee;
                if (!a) { return false; }
                return a.name?.toLowerCase() === uLower
                    || a.key?.toLowerCase() === uLower
                    || a.emailAddress?.toLowerCase() === uLower
                    || a.emailAddress?.toLowerCase().startsWith(uLower + '@');
            });
        }

        // Fetch sub-issues (children) of each matched issue
        const subIssueMap = new Map<string, any[]>(); // parentKey → sub-issues[]
        const parentKeys = allIssues.map(i => i.key);
        if (parentKeys.length > 0) {
            try {
                const subResult = await this.apiRequest<any>('POST', 'search', {
                    jql: `parent in (${parentKeys.join(',')})`,
                    maxResults: 300,
                    fields: ALL_FIELDS,
                    expand: ['names'],
                });
                Object.assign(fieldNames, subResult.names || {});
                for (const sub of (subResult.issues || [])) {
                    const pKey: string = sub.fields?.parent?.key;
                    if (pKey) {
                        if (!subIssueMap.has(pKey)) { subIssueMap.set(pKey, []); }
                        subIssueMap.get(pKey)!.push(sub);
                    }
                }
            } catch { /* sub-issues are optional */ }
        }

        return { initiative, issues: allIssues, subIssues: subIssueMap, queriesAttempted, fieldNames };
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
        dueDate?: string;        // customfield_10670 — format YYYY-MM-DD
        startDate?: string;      // customfield_56601 — format YYYY-MM-DD
        forecastDate?: string;   // customfield_56806 — format YYYY-MM-DD
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
        if (fields.dueDate !== undefined) { update.duedate = fields.dueDate; }
        if (fields.startDate !== undefined) { update.customfield_56601 = fields.startDate; }
        if (fields.forecastDate !== undefined) { update.customfield_56806 = fields.forecastDate; }

        await this.apiRequest<void>('PUT', `issue/${issueKey}`, { fields: update });
    }

    async updateIssueDates(issueKey: string, dates: {
        startDate?: string;
        startDateFieldId?: string;
        dueDate?: string;
        forecastCompletion?: string;
        forecastFieldId?: string;
    }): Promise<void> {
        const update: Record<string, unknown> = {};
        if (dates.startDate !== undefined) {
            const startField = dates.startDateFieldId || 'startDate';
            update[startField] = dates.startDate || null;
        }
        if (dates.dueDate !== undefined) { update.duedate = dates.dueDate || null; }
        if (dates.forecastCompletion !== undefined) {
            let fieldId = dates.forecastFieldId;
            if (!fieldId) {
                // Discover the forecast field ID from the issue's field names
                try {
                    const issue = await this.apiRequest<any>('GET', `issue/${issueKey}?expand=names`);
                    const names: Record<string, string> = issue.names || {};
                    fieldId = Object.entries(names).find(([, n]) =>
                        /forecast|target\s*(completion|date|end)|planned\s*(end|completion)/i.test(n)
                    )?.[0];
                } catch { /* proceed without field ID */ }
            }
            if (fieldId) {
                update[fieldId] = dates.forecastCompletion || null;
            }
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

    // ── Delete Issue ─────────────────────────────────────────────

    async deleteIssue(issueKey: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `issue/${issueKey}`);
    }

    // ── Clone Issue ──────────────────────────────────────────────

    async cloneIssue(sourceKey: string, overrides: {
        summary?: string;
        assignee?: string;
        labels?: string[];
        fixVersions?: string[];
    }): Promise<{ key: string; self: string }> {
        const source = await this.getIssue(sourceKey);
        const fields: Record<string, unknown> = {
            project: { key: source.fields.project.key },
            issuetype: { id: source.fields.issuetype.id },
            summary: overrides.summary || `[Clone] ${source.fields.summary}`,
        };
        if (source.fields.description) { fields.description = source.fields.description; }
        const labels = overrides.labels ?? source.fields.labels;
        if (labels?.length) { fields.labels = labels; }
        const fixVersions = overrides.fixVersions ?? source.fields.fixVersions.map(v => v.name);
        if (fixVersions?.length) { fields.fixVersions = (fixVersions as string[]).map(v => ({ name: v })); }
        if (overrides.assignee) {
            fields.assignee = { name: overrides.assignee };
        } else if (source.fields.assignee) {
            fields.assignee = { name: source.fields.assignee.name };
        }
        if (source.fields.priority) { fields.priority = { name: source.fields.priority.name }; }
        return this.apiRequest<{ key: string; self: string }>('POST', 'issue', { fields });
    }

    // ── Bulk Create ──────────────────────────────────────────────

    async bulkCreateIssues(issues: Array<{
        projectKey: string;
        issueType: string;
        summary: string;
        description?: string;
        labels?: string[];
        fixVersions?: string[];
        assignee?: string;
    }>): Promise<{ issues: Array<{ key: string; self: string }>; errors?: any[] }> {
        const issueTypeMap: Record<string, string> = { story: '7', task: '3', bug: '1', 'sub-task': '5' };
        const issueUpdates = issues.map(i => {
            const f: Record<string, unknown> = {
                project: { key: i.projectKey },
                issuetype: { id: issueTypeMap[i.issueType.toLowerCase()] || i.issueType },
                summary: i.summary,
            };
            if (i.description) { f.description = i.description; }
            if (i.labels?.length) { f.labels = i.labels; }
            if (i.fixVersions?.length) { f.fixVersions = i.fixVersions.map(v => ({ name: v })); }
            if (i.assignee) { f.assignee = { name: i.assignee }; }
            return { fields: f };
        });
        return this.apiRequest<{ issues: Array<{ key: string; self: string }>; errors?: any[] }>('POST', 'issue/bulk', { issueUpdates });
    }

    // ── List Comments ────────────────────────────────────────────

    async listComments(issueKey: string): Promise<Array<{ id: string; author: { name: string; displayName: string }; body: string; created: string; updated: string }>> {
        const data = await this.apiRequest<{ comments: any[] }>('GET', `issue/${issueKey}/comment`);
        return data.comments;
    }

    // ── Update Comment ───────────────────────────────────────────

    async updateComment(issueKey: string, commentId: string, body: string): Promise<{ id: string }> {
        return this.apiRequest<{ id: string }>('PUT', `issue/${issueKey}/comment/${commentId}`, { body });
    }

    // ── Delete Comment ───────────────────────────────────────────

    async deleteComment(issueKey: string, commentId: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `issue/${issueKey}/comment/${commentId}`);
    }

    // ── List Worklogs ────────────────────────────────────────────

    async listWorklogs(issueKey: string): Promise<Array<{ id: string; author: { name: string; displayName: string }; timeSpent: string; timeSpentSeconds: number; started: string; comment?: string }>> {
        const data = await this.apiRequest<{ worklogs: any[] }>('GET', `issue/${issueKey}/worklog`);
        return data.worklogs;
    }

    // ── Update Worklog ───────────────────────────────────────────

    async updateWorklog(issueKey: string, worklogId: string, timeSpent: string, started?: string): Promise<{ id: string }> {
        const body: Record<string, unknown> = { timeSpent };
        if (started) { body.started = started; }
        return this.apiRequest<{ id: string }>('PUT', `issue/${issueKey}/worklog/${worklogId}`, body);
    }

    // ── Delete Worklog ───────────────────────────────────────────

    async deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `issue/${issueKey}/worklog/${worklogId}`);
    }

    // ── Delete Issue Link ────────────────────────────────────────

    async deleteIssueLink(linkId: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `issueLink/${linkId}`);
    }

    // ── Get Link Types ───────────────────────────────────────────

    async getLinkTypes(): Promise<Array<{ id: string; name: string; inward: string; outward: string }>> {
        const data = await this.apiRequest<{ issueLinkTypes: any[] }>('GET', 'issueLinkType');
        return data.issueLinkTypes;
    }

    // ── Watchers ─────────────────────────────────────────────────

    async getWatchers(issueKey: string): Promise<{ watchCount: number; watchers: Array<{ name: string; displayName: string }> }> {
        return this.apiRequest<{ watchCount: number; watchers: any[] }>('GET', `issue/${issueKey}/watchers`);
    }

    async watchIssue(issueKey: string, username?: string): Promise<void> {
        const url = `${this.apiBase}/issue/${issueKey}/watchers`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: username ? JSON.stringify(username) : undefined,
        });
        if (!resp.ok) { throw new Error(`Watch issue failed: ${resp.status} ${resp.statusText}`); }
    }

    async unwatchIssue(issueKey: string, username?: string): Promise<void> {
        const path = username
            ? `${this.apiBase}/issue/${issueKey}/watchers?username=${encodeURIComponent(username)}`
            : `${this.apiBase}/issue/${issueKey}/watchers`;
        const resp = await fetch(path, { method: 'DELETE', headers: this.headers });
        if (!resp.ok && resp.status !== 204) {
            throw new Error(`Unwatch issue failed: ${resp.status} ${resp.statusText}`);
        }
    }

    // ── Vote ─────────────────────────────────────────────────────

    async voteIssue(issueKey: string): Promise<void> {
        await this.apiRequest<void>('POST', `issue/${issueKey}/votes`);
    }

    // ── Attachment ───────────────────────────────────────────────

    async deleteAttachment(attachmentId: string): Promise<void> {
        await this.apiRequest<void>('DELETE', `attachment/${attachmentId}`);
    }

    // ── Projects ─────────────────────────────────────────────────

    async listProjects(): Promise<Array<{ key: string; name: string; projectTypeKey: string; lead?: { name: string; displayName: string } }>> {
        return this.apiRequest<any[]>('GET', 'project');
    }

    async getProjectVersions(projectKey: string): Promise<Array<{ id: string; name: string; released: boolean; archived: boolean; releaseDate?: string; startDate?: string }>> {
        return this.apiRequest<any[]>('GET', `project/${projectKey}/versions`);
    }

    async getProjectComponents(projectKey: string): Promise<Array<{ id: string; name: string; description?: string; lead?: { name: string; displayName: string } }>> {
        return this.apiRequest<any[]>('GET', `project/${projectKey}/components`);
    }

    // ── Metadata ─────────────────────────────────────────────────

    async getIssueTypes(): Promise<Array<{ id: string; name: string; description: string; subtask: boolean }>> {
        return this.apiRequest<any[]>('GET', 'issuetype');
    }

    async getPriorities(): Promise<Array<{ id: string; name: string; description?: string }>> {
        return this.apiRequest<any[]>('GET', 'priority');
    }

    async getFields(): Promise<Array<{ id: string; name: string; custom: boolean; orderable: boolean; searchable: boolean; clauseNames: string[] }>> {
        return this.apiRequest<any[]>('GET', 'field');
    }

    // ── Changelog ────────────────────────────────────────────────

    async getChangelog(issueKey: string, maxResults: number = 20): Promise<Array<{ id: string; author: { name: string; displayName: string }; created: string; items: Array<{ field: string; fromString: string | null; toString: string | null }> }>> {
        const data = await this.apiRequest<{ changelog: { histories: any[] } }>('GET', `issue/${issueKey}?expand=changelog`);
        const histories = data.changelog?.histories || [];
        return histories.slice(0, maxResults);
    }

    // ── Versions ─────────────────────────────────────────────────

    async createVersion(params: { projectKey: string; name: string; description?: string; startDate?: string; releaseDate?: string }): Promise<{ id: string; name: string }> {
        const body: Record<string, unknown> = { project: params.projectKey, name: params.name };
        if (params.description) { body.description = params.description; }
        if (params.startDate) { body.startDate = params.startDate; }
        if (params.releaseDate) { body.releaseDate = params.releaseDate; }
        return this.apiRequest<{ id: string; name: string }>('POST', 'version', body);
    }

    async updateVersion(versionId: string, updates: { name?: string; description?: string; released?: boolean; archived?: boolean; startDate?: string; releaseDate?: string }): Promise<{ id: string; name: string }> {
        return this.apiRequest<{ id: string; name: string }>('PUT', `version/${versionId}`, updates);
    }

    // ── Users ─────────────────────────────────────────────────────

    async searchUsers(query: string, maxResults: number = 10): Promise<Array<{ name: string; displayName: string; emailAddress?: string; active: boolean }>> {
        return this.apiRequest<any[]>('GET', `user/search?username=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    }

    async getUser(username: string): Promise<{ name: string; displayName: string; emailAddress?: string; active: boolean }> {
        return this.apiRequest<any>('GET', `user?username=${encodeURIComponent(username)}`);
    }

    // ── Agile API ─────────────────────────────────────────────────

    private async agileGet<T>(path: string): Promise<T> {
        const url = `${this.baseUrl}/rest/agile/1.0/${path}`;
        const resp = await fetch(url, { headers: this.headers });
        if (!resp.ok) { throw new Error(`Jira Agile GET ${path} failed: ${resp.status} ${resp.statusText}`); }
        return resp.json() as Promise<T>;
    }

    private async agilePost<T>(path: string, body: unknown): Promise<T> {
        const url = `${this.baseUrl}/rest/agile/1.0/${path}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Jira Agile POST ${path} failed: ${resp.status} — ${text.substring(0, 500)}`);
        }
        if (resp.status === 204) { return {} as T; }
        return resp.json() as Promise<T>;
    }

    async getBoards(projectKey?: string): Promise<Array<{ id: number; name: string; type: string; location?: { projectKey: string } }>> {
        const params = projectKey ? `?projectKeyOrId=${encodeURIComponent(projectKey)}` : '';
        const data = await this.agileGet<{ values: any[] }>(`board${params}`);
        return data.values;
    }

    async getSprints(boardId: number, state?: 'active' | 'future' | 'closed'): Promise<Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }>> {
        const params = state ? `?state=${state}` : '';
        const data = await this.agileGet<{ values: any[] }>(`board/${boardId}/sprint${params}`);
        return data.values;
    }

    async getSprintIssues(sprintId: number, maxResults: number = 50): Promise<{ issues: JiraIssue[]; total: number }> {
        return this.agileGet<{ issues: JiraIssue[]; total: number }>(
            `sprint/${sprintId}/issue?maxResults=${maxResults}&fields=summary,status,assignee,labels,issuetype,priority,project`
        );
    }

    async moveToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
        await this.agilePost<void>(`sprint/${sprintId}/issue`, { issues: issueKeys });
    }

    async getEpics(boardId: number, done: boolean = false): Promise<Array<{ id: number; key: string; summary: string; color?: { key: string } }>> {
        const data = await this.agileGet<{ values: any[] }>(`board/${boardId}/epic?done=${done}`);
        return data.values;
    }

    // ── Helpers ─────────────────────────────────────────────────

    getBrowseUrl(issueKey: string): string {
        return `${this.baseUrl}/browse/${issueKey}`;
    }
}
