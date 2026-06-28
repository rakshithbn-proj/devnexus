import * as vscode from 'vscode';
import { JiraClient } from '../api/jiraClient';
import { AuthManager } from '../auth/authManager';
import { registerToolHandler } from './toolRegistry';

export function registerJiraTools(context: vscode.ExtensionContext, getClient: () => Promise<JiraClient | undefined>, auth: AuthManager): void {

    // Helper: register both in vscode.lm AND in our direct-call registry
    function reg<T>(name: string, fn: (input: T) => Promise<string>): void {
        registerToolHandler(name, (input, _token) => fn(input as T));
        context.subscriptions.push(vscode.lm.registerTool(name, {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<T>, _token) {
                const text = await fn(options.input);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
            }
        }));
    }

    // ── Get Issue ───────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_get_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured. Run "DevNexus: Set Jira Credentials" first.'; }
        const issue = await client.getIssue(input.issueKey);
        const subtasks = issue.fields.subtasks?.map((s: any) =>
            `  - ${s.key}: ${s.fields.summary} [${s.fields.status.name}]${s.fields.assignee ? ` (${s.fields.assignee.displayName})` : ''}`
        ).join('\n') || '  (none)';
        return [
            `**${issue.key}** — ${issue.fields.summary}`,
            `Status: ${issue.fields.status.name}`,
            `Type: ${issue.fields.issuetype.name}`,
            `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`,
            `Labels: ${issue.fields.labels.join(', ') || 'none'}`,
            `Fix Versions: ${issue.fields.fixVersions.map((v: any) => v.name).join(', ') || 'none'}`,
            `Priority: ${issue.fields.priority?.name || 'none'}`,
            `Subtasks:\n${subtasks}`,
            `URL: ${client.getBrowseUrl(issue.key)}`,
        ].join('\n');
    });

    // ── Create Issue ────────────────────────────────────────────
    reg<{ projectKey: string; issueType: string; summary: string; description?: string; labels?: string[]; fixVersions?: string[]; assignee?: string }>('devnexus_jira_create_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const assignee = input.assignee === 'self' ? auth.getJiraUsername() : input.assignee;
        const result = await client.createIssue({
            projectKey: input.projectKey, issueType: input.issueType, summary: input.summary,
            description: input.description, labels: input.labels, fixVersions: input.fixVersions,
            assignee: assignee || undefined,
        });
        return `Created **${result.key}** — "${input.summary}"\nURL: ${client.getBrowseUrl(result.key)}`;
    });

    // ── Create Subtask ──────────────────────────────────────────
    reg<{ parentKey: string; summary: string; description?: string; labels?: string[]; fixVersions?: string[]; assignee?: string }>('devnexus_jira_create_subtask', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const parent = await client.getIssue(input.parentKey);
        const projectKey = parent.fields.project.key;
        const fixVersions = input.fixVersions?.length ? input.fixVersions : parent.fields.fixVersions.map((v: any) => v.name);
        const assignee = input.assignee === 'self' ? auth.getJiraUsername() : input.assignee;
        const result = await client.createSubtask({
            parentKey: input.parentKey, projectKey, summary: input.summary,
            description: input.description, labels: input.labels, fixVersions,
            assignee: assignee || undefined,
        });
        return `Created subtask **${result.key}** — "${input.summary}"\nParent: ${input.parentKey} | Labels: ${input.labels?.join(', ') || 'none'} | Assigned: ${assignee || 'unassigned'}\nURL: ${client.getBrowseUrl(result.key)}`;
    });

    // ── Search ──────────────────────────────────────────────────
    reg<{ jql: string; maxResults?: number }>('devnexus_jira_search', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const data = await client.search(input.jql, input.maxResults || 20);
        const lines = data.issues.map((i: any) =>
            `- **${i.key}** — ${i.fields.summary} [${i.fields.status.name}] ${i.fields.assignee?.displayName || 'Unassigned'}`
        );
        return `Found ${data.total} issues (showing ${data.issues.length}):\n${lines.join('\n')}`;
    });

    // ── Transition ──────────────────────────────────────────────
    reg<{ issueKey: string; transitionName: string }>('devnexus_jira_transition', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.transitionIssue(input.issueKey, input.transitionName);
        return `Transitioned **${input.issueKey}** → **${input.transitionName}**`;
    });

    // ── Add Comment ─────────────────────────────────────────────
    reg<{ issueKey: string; body: string }>('devnexus_jira_add_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.addComment(input.issueKey, input.body);
        return `Comment added to **${input.issueKey}**`;
    });

    // ── Update Fields ───────────────────────────────────────────
    reg<{ issueKey: string; fields: { summary?: string; description?: string; labels?: string[]; fixVersions?: string[]; assignee?: string; priority?: string; originalEstimate?: string; remainingEstimate?: string } }>('devnexus_jira_update_fields', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const f = input.fields;
        if (f.assignee === 'self') { f.assignee = auth.getJiraUsername(); }
        await client.updateFields(input.issueKey, f);
        return `Updated **${input.issueKey}** fields: ${Object.keys(f).join(', ')}`;
    });

    // ── Log Work ────────────────────────────────────────────────
    reg<{ issueKey: string; timeSpent: string; started?: string }>('devnexus_jira_log_work', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.logWork(input.issueKey, input.timeSpent, input.started);
        return `Logged **${input.timeSpent}** of work on **${input.issueKey}**`;
    });

    // ── Link Issues ─────────────────────────────────────────────
    reg<{ linkType: string; inwardKey: string; outwardKey: string }>('devnexus_jira_link_issues', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.linkIssues(input.linkType, input.inwardKey, input.outwardKey);
        return `Linked: ${input.outwardKey} **${input.linkType}** ${input.inwardKey}`;
    });

    // ── List Subtasks ───────────────────────────────────────────
    reg<{ parentKey: string }>('devnexus_jira_list_subtasks', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const issue = await client.getIssue(input.parentKey);
        const subtasks = issue.fields.subtasks || [];
        if (subtasks.length === 0) { return `${input.parentKey} has no subtasks.`; }
        const lines = subtasks.map((s: any) =>
            `- **${s.key}** — ${s.fields.summary} [${s.fields.status.name}]${s.fields.assignee ? ` (${s.fields.assignee.displayName})` : ''}`
        );
        return `**${input.parentKey}** subtasks (${subtasks.length}):\n${lines.join('\n')}`;
    });

    // ── Assign ──────────────────────────────────────────────────
    reg<{ issueKey: string; assignee: string }>('devnexus_jira_assign', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const assignee = input.assignee === 'self' ? auth.getJiraUsername() || input.assignee : input.assignee;
        await client.assignIssue(input.issueKey, assignee);
        return `Assigned **${input.issueKey}** to ${assignee}`;
    });
}
