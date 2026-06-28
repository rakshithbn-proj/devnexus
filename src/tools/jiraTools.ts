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

        const fieldNames: Record<string, string> = issue.names || {};
        const SYSTEM_DATE_FIELDS = new Set(['created', 'updated', 'resolutiondate', 'lastViewed', 'statuscategorychangedate', 'duedate']);
        const flds = issue.fields as Record<string, unknown>;
        const configuredStartFieldId = vscode.workspace.getConfiguration('devnexus.jira').get<string>('startDateFieldId');

        // Detect the start date field: config setting → name match → plain startDate field → value scan
        let startFieldId: string | undefined = configuredStartFieldId && flds[configuredStartFieldId] !== undefined
            ? configuredStartFieldId : undefined;
        if (!startFieldId) {
            for (const [id, name] of Object.entries(fieldNames)) {
                if (/^start\s*date$/i.test(name) || /\bstart\b.*\bdate\b/i.test(name)) { startFieldId = id; break; }
            }
        }
        if (!startFieldId && flds.startDate) { startFieldId = 'startDate'; }
        if (!startFieldId) {
            for (const [id, val] of Object.entries(flds)) {
                if (SYSTEM_DATE_FIELDS.has(id)) { continue; }
                if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
                    if (/start/i.test(fieldNames[id] || id)) { startFieldId = id; break; }
                }
            }
        }

        const fmtDate = (val: unknown): string =>
            typeof val === 'string' && val ? val.substring(0, 10) : '—';

        const startDate = startFieldId ? fmtDate(flds[startFieldId]) : '—';
        const dueDate = fmtDate(flds.duedate);

        return [
            `**${issue.key}** — ${issue.fields.summary}`,
            `Status: ${issue.fields.status.name}`,
            `Type: ${issue.fields.issuetype.name}`,
            `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`,
            `Start Date: ${startDate}`,
            `Due Date: ${dueDate}`,
            `Labels: ${issue.fields.labels.join(', ') || 'none'}`,
            `Fix Versions: ${issue.fields.fixVersions.map((v: any) => v.name).join(', ') || 'none'}`,
            `Priority: ${issue.fields.priority?.name || 'none'}`,
            `Due Date: ${(issue.fields as any).duedate || 'not set'}`,
            `Start Date: ${(issue.fields as any).customfield_56601 || 'not set'}`,
            `Forecast Completion: ${(issue.fields as any).customfield_56806 || 'not set'}`,
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
        const lines = data.issues.map((i: any) => {
            const due = i.fields.duedate ? ` | Due: ${i.fields.duedate}` : '';
            const start = i.fields.customfield_56601 ? ` | Start: ${i.fields.customfield_56601}` : '';
            const forecast = i.fields.customfield_56806 ? ` | Forecast: ${i.fields.customfield_56806}` : '';
            const subtaskCount = i.fields.subtasks?.length ? ` | Subtasks: ${i.fields.subtasks.length}` : '';
            return `- **${i.key}** — ${i.fields.summary} [${i.fields.status.name}] ${i.fields.assignee?.displayName || 'Unassigned'}${due}${start}${forecast}${subtaskCount}`;
        });
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
    reg<{ issueKey: string; fields: { summary?: string; description?: string; labels?: string[]; fixVersions?: string[]; assignee?: string; priority?: string; originalEstimate?: string; remainingEstimate?: string; dueDate?: string; startDate?: string; forecastDate?: string } }>('devnexus_jira_update_fields', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const f = input.fields;
        if (f.assignee === 'self') { f.assignee = auth.getJiraUsername(); }
        await client.updateFields(input.issueKey, f);
        return `Updated **${input.issueKey}** fields: ${Object.keys(f).join(', ')}`;
    });

    // ── Review Complete ──────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_review_complete', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const issue = await client.getIssue(input.issueKey);
        const labels: string[] = issue.fields.labels || [];
        const isReviewTicket = labels.some(l => /^FMS_.+_REVIEW$/i.test(l));
        const issuelinks = issue.fields.issuelinks || [];
        const relatedLink = issuelinks.find(l =>
            l.type?.name?.toLowerCase().includes('relates') &&
            (l.outwardIssue || l.inwardIssue)
        );
        const relatedKey = relatedLink?.outwardIssue?.key || relatedLink?.inwardIssue?.key;
        const commentTarget = (isReviewTicket && relatedKey) ? relatedKey : input.issueKey;
        const commentBody = 'Independent review complete';
        await client.addComment(commentTarget, commentBody);
        return isReviewTicket && relatedKey
            ? `Posted "${commentBody}" on **${commentTarget}** (originating ticket of review ${input.issueKey})`
            : `Posted "${commentBody}" on **${commentTarget}** (no FMS_*_REVIEW label or no related link found)`;
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

    // ── List Initiative Issues ───────────────────────────────────
    reg<{ initiativeKey: string; assignee?: string }>('devnexus_jira_list_initiative_issues', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured. Run "DevNexus: Set Jira Credentials" first.'; }

        const profile = auth.getUserProfile();
        const storedUsername = auth.getJiraUsername();
        const filterByMe = !input.assignee || input.assignee === 'self';

        const meIdentifiers = filterByMe
            ? [storedUsername, profile?.username, profile?.email].filter((v): v is string => !!v)
            : (input.assignee ? [input.assignee] : []);

        const usernameForQuery = meIdentifiers[0];

        const { initiative, issues: allIssues, subIssues, queriesAttempted, fieldNames } =
            await client.getInitiativeIssues(input.initiativeKey, filterByMe ? usernameForQuery : input.assignee);

        const formatDate = (val: any): string => {
            if (!val || typeof val !== 'string') { return '—'; }
            return val.substring(0, 10);
        };

        // Discover date fields: first try name-matching against fieldNames map,
        // then fall back to scanning actual field values for date patterns.
        // This handles any Jira configuration without hardcoded custom field IDs.
        const SYSTEM_DATE_FIELDS = new Set(['created', 'updated', 'resolutiondate', 'lastViewed', 'statuscategorychangedate', 'duedate']);

        const findByName = (pattern: RegExp): string | undefined =>
            Object.entries(fieldNames).find(([, name]) => pattern.test(name))?.[0];

        const findByValue = (pattern: RegExp, exclude: string[] = []): string | undefined => {
            const excSet = new Set([...SYSTEM_DATE_FIELDS, ...exclude]);
            for (const issue of allIssues.slice(0, 10)) {
                for (const [key, val] of Object.entries(issue.fields || {})) {
                    if (excSet.has(key)) { continue; }
                    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
                        const label = fieldNames[key] || key;
                        if (pattern.test(label)) { return key; }
                    }
                }
            }
            return undefined;
        };

        // Also collect ALL date-valued fields for labelling
        const allDateFieldIds = new Map<string, string>(); // id → label
        for (const issue of allIssues.slice(0, 10)) {
            for (const [key, val] of Object.entries(issue.fields || {})) {
                if (SYSTEM_DATE_FIELDS.has(key) || allDateFieldIds.has(key)) { continue; }
                if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
                    allDateFieldIds.set(key, fieldNames[key] || key);
                }
            }
        }

        const jiraConfig = vscode.workspace.getConfiguration('devnexus.jira');
        const configuredStartField = jiraConfig.get<string>('startDateFieldId');
        const configuredForecastField = jiraConfig.get<string>('forecastDateFieldId');

        const startFieldId = (configuredStartField && allIssues.some(i => i.fields?.[configuredStartField] !== undefined) ? configuredStartField : undefined)
            || findByName(/^start\s*date$/i)
            || findByName(/\bstart\b.*\bdate\b/i)
            || findByValue(/start/i)
            || (allIssues.some(i => i.fields?.startDate) ? 'startDate' : undefined);

        const forecastFieldId = (configuredForecastField && allIssues.some(i => i.fields?.[configuredForecastField] !== undefined) ? configuredForecastField : undefined)
            || findByName(/forecast|target\s*(completion|date|end)|planned\s*(end|completion)/i)
            || findByValue(/forecast|target|completion|planned/i, startFieldId ? [startFieldId] : []);

        const startLabel = startFieldId ? (fieldNames[startFieldId] || 'Start Date') : 'Start Date';
        const forecastLabel = forecastFieldId ? (fieldNames[forecastFieldId] || 'Forecast') : 'Forecast';

        const buildTable = (issues: any[], subs: Map<string, any[]>) => {
            if (issues.length === 0) { return ''; }
            const lines: string[] = [
                `| Key | Summary | Status | Assignee | ${startLabel} | Due Date | ${forecastLabel} |`,
                '|-----|---------|--------|----------|------------|----------|---------------------|',
            ];
            for (const i of issues) {
                const f = i.fields;
                const startDate = startFieldId ? formatDate(f[startFieldId]) : '—';
                const dueDate = formatDate(f.duedate);
                const forecast = forecastFieldId ? formatDate(f[forecastFieldId]) : '—';
                lines.push(`| **${i.key}** | ${f.summary} | ${f.status?.name || '?'} | ${f.assignee?.displayName || 'Unassigned'} | ${startDate} | ${dueDate} | ${forecast} |`);
                // Sub-issues under this parent
                for (const sub of (subs.get(i.key) || [])) {
                    const sf = sub.fields;
                    const subStart = startFieldId ? formatDate(sf[startFieldId]) : '—';
                    const subDue = formatDate(sf.duedate);
                    const subForecast = forecastFieldId ? formatDate(sf[forecastFieldId]) : '—';
                    lines.push(`| ↳ ${sub.key} | ${sf.summary} | ${sf.status?.name || '?'} | ${sf.assignee?.displayName || 'Unassigned'} | ${subStart} | ${subDue} | ${subForecast} |`);
                }
            }
            return lines.join('\n');
        };

        const initiativeSummary = initiative.fields?.summary || input.initiativeKey;
        const header = `**${input.initiativeKey}** — ${initiativeSummary}\nURL: ${client.getBrowseUrl(input.initiativeKey)}`;

        if (allIssues.length === 0) {
            return [
                header,
                '',
                '⚠️ No child issues found under this initiative.',
                `Queries attempted: \`${queriesAttempted.join('` | `')}\``,
                `Assignee filter: ${usernameForQuery || '(none)'}`,
            ].join('\n');
        }

        // Debug output: show which field IDs were resolved
        const hasStartDates = allIssues.some(i => startFieldId && i.fields?.[startFieldId]);
        const debugParts: string[] = [];
        if (!hasStartDates) {
            if (startFieldId) {
                debugParts.push(`Start Date field resolved to \`${startFieldId}\` (${fieldNames[startFieldId] || 'unknown name'}) but all values are null/empty`);
            } else {
                debugParts.push(`Could not auto-detect Start Date field`);
            }
            if (allDateFieldIds.size > 0) {
                debugParts.push(`Date-valued fields on these issues: ${[...allDateFieldIds.entries()].map(([id, n]) => `**${n}** (\`${id}\`)`).join(', ')}`);
            } else {
                debugParts.push(`No date-valued custom fields found on these issues (Start Date may not be set)`);
            }
        }
        const dateFieldDebug = debugParts.length > 0 ? `\n\n> ℹ️ ${debugParts.join(' · ')}` : '';

        const totalSubIssues = [...subIssues.values()].reduce((s, a) => s + a.length, 0);
        const countLine = totalSubIssues > 0
            ? `Issues assigned to you (${allIssues.length}) with ${totalSubIssues} sub-issues:`
            : `Issues assigned to you (${allIssues.length}):`;

        return [
            header,
            countLine,
            '',
            buildTable(allIssues, subIssues),
            dateFieldDebug,
            '',
            '_To edit dates: "set start date for [KEY] to YYYY-MM-DD" or "update due date for [KEY]"_',
        ].join('\n');
    });

    // ── Update Issue Dates ───────────────────────────────────────
    reg<{ issueKey: string; startDate?: string; dueDate?: string; forecastCompletion?: string; forecastFieldId?: string }>('devnexus_jira_update_issue_dates', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }

        if (!input.startDate && !input.dueDate && input.forecastCompletion === undefined) {
            return 'No date fields specified. Provide at least one of: startDate, dueDate, or forecastCompletion.';
        }

        const jiraUpdateConfig = vscode.workspace.getConfiguration('devnexus.jira');
        const startDateFieldId = jiraUpdateConfig.get<string>('startDateFieldId');
        const forecastDateFieldId = jiraUpdateConfig.get<string>('forecastDateFieldId');
        await client.updateIssueDates(input.issueKey, {
            startDate: input.startDate,
            startDateFieldId: startDateFieldId || undefined,
            dueDate: input.dueDate,
            forecastCompletion: input.forecastCompletion,
            forecastFieldId: input.forecastFieldId || forecastDateFieldId || undefined,
        });

        const updated: string[] = [];
        if (input.startDate !== undefined) { updated.push(`Start Date → **${input.startDate || 'cleared'}**`); }
        if (input.dueDate !== undefined) { updated.push(`Due Date → **${input.dueDate || 'cleared'}**`); }
        if (input.forecastCompletion !== undefined) { updated.push(`Forecast Completion → **${input.forecastCompletion || 'cleared'}**`); }

        return `Updated **${input.issueKey}** dates:\n${updated.join('\n')}\nURL: ${client.getBrowseUrl(input.issueKey)}`;
    });

    // ── Delete Issue ─────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_delete_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.deleteIssue(input.issueKey);
        return `Deleted **${input.issueKey}**`;
    });

    // ── Clone Issue ──────────────────────────────────────────────
    reg<{ sourceKey: string; summary?: string; assignee?: string; labels?: string[]; fixVersions?: string[] }>('devnexus_jira_clone_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const assignee = input.assignee === 'self' ? auth.getJiraUsername() : input.assignee;
        const result = await client.cloneIssue(input.sourceKey, {
            summary: input.summary,
            assignee: assignee || undefined,
            labels: input.labels,
            fixVersions: input.fixVersions,
        });
        return `Cloned **${input.sourceKey}** → **${result.key}**\nURL: ${client.getBrowseUrl(result.key)}`;
    });

    // ── Bulk Create ──────────────────────────────────────────────
    reg<{ issues: Array<{ projectKey: string; issueType: string; summary: string; description?: string; labels?: string[]; fixVersions?: string[]; assignee?: string }> }>('devnexus_jira_bulk_create', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const result = await client.bulkCreateIssues(input.issues);
        const keys = result.issues.map(i => `**${i.key}**`).join(', ');
        const errorCount = result.errors?.length || 0;
        return `Created ${result.issues.length} issue(s): ${keys}${errorCount ? `\n${errorCount} error(s): ${JSON.stringify(result.errors)}` : ''}`;
    });

    // ── List Comments ────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_list_comments', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const comments = await client.listComments(input.issueKey);
        if (comments.length === 0) { return `No comments on **${input.issueKey}**.`; }
        const lines = comments.map((c: any) => {
            const date = new Date(c.created).toISOString().replace('T', ' ').substring(0, 16);
            return `**#${c.id}** [${date}] **${c.author.displayName}**: ${c.body.substring(0, 200)}${c.body.length > 200 ? '...' : ''}`;
        });
        return `Comments on **${input.issueKey}** (${comments.length}):\n\n${lines.join('\n\n')}`;
    });

    // ── Update Comment ───────────────────────────────────────────
    reg<{ issueKey: string; commentId: string; body: string }>('devnexus_jira_update_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.updateComment(input.issueKey, input.commentId, input.body);
        return `Updated comment #${input.commentId} on **${input.issueKey}**`;
    });

    // ── Delete Comment ───────────────────────────────────────────
    reg<{ issueKey: string; commentId: string }>('devnexus_jira_delete_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.deleteComment(input.issueKey, input.commentId);
        return `Deleted comment #${input.commentId} from **${input.issueKey}**`;
    });

    // ── List Worklogs ────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_list_worklogs', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const worklogs = await client.listWorklogs(input.issueKey);
        if (worklogs.length === 0) { return `No worklogs on **${input.issueKey}**.`; }
        const lines = worklogs.map((w: any) => {
            const date = new Date(w.started).toISOString().replace('T', ' ').substring(0, 16);
            const comment = w.comment ? ` — ${w.comment.substring(0, 80)}` : '';
            return `**#${w.id}** [${date}] **${w.author.displayName}**: ${w.timeSpent}${comment}`;
        });
        const totalSec = worklogs.reduce((sum: number, w: any) => sum + (w.timeSpentSeconds || 0), 0);
        const totalHours = (totalSec / 3600).toFixed(1);
        return `Worklogs on **${input.issueKey}** (${worklogs.length}, total ~${totalHours}h):\n\n${lines.join('\n')}`;
    });

    // ── Update Worklog ───────────────────────────────────────────
    reg<{ issueKey: string; worklogId: string; timeSpent: string; started?: string }>('devnexus_jira_update_worklog', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.updateWorklog(input.issueKey, input.worklogId, input.timeSpent, input.started);
        return `Updated worklog #${input.worklogId} on **${input.issueKey}** → ${input.timeSpent}`;
    });

    // ── Delete Worklog ───────────────────────────────────────────
    reg<{ issueKey: string; worklogId: string }>('devnexus_jira_delete_worklog', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.deleteWorklog(input.issueKey, input.worklogId);
        return `Deleted worklog #${input.worklogId} from **${input.issueKey}**`;
    });

    // ── Delete Issue Link ────────────────────────────────────────
    reg<{ linkId: string }>('devnexus_jira_delete_link', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.deleteIssueLink(input.linkId);
        return `Deleted issue link #${input.linkId}`;
    });

    // ── List Link Types ──────────────────────────────────────────
    reg<Record<string, never>>('devnexus_jira_list_link_types', async (_input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const types = await client.getLinkTypes();
        const lines = types.map(t => `- **${t.name}** (inward: "${t.inward}", outward: "${t.outward}")`);
        return `Issue link types (${types.length}):\n${lines.join('\n')}`;
    });

    // ── Watchers ─────────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_get_watchers', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const data = await client.getWatchers(input.issueKey);
        const names = data.watchers.map((w: any) => w.displayName).join(', ') || 'none';
        return `**${input.issueKey}** has ${data.watchCount} watcher(s): ${names}`;
    });

    reg<{ issueKey: string; username?: string }>('devnexus_jira_watch_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const username = input.username === 'self' ? auth.getJiraUsername() : input.username;
        await client.watchIssue(input.issueKey, username || undefined);
        return `Now watching **${input.issueKey}**${username ? ` (added ${username})` : ''}`;
    });

    reg<{ issueKey: string; username?: string }>('devnexus_jira_unwatch_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const username = input.username === 'self' ? auth.getJiraUsername() : input.username;
        await client.unwatchIssue(input.issueKey, username || undefined);
        return `Unwatched **${input.issueKey}**${username ? ` (removed ${username})` : ''}`;
    });

    // ── Vote ─────────────────────────────────────────────────────
    reg<{ issueKey: string }>('devnexus_jira_vote_issue', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.voteIssue(input.issueKey);
        return `Voted for **${input.issueKey}**`;
    });

    // ── Projects ─────────────────────────────────────────────────
    reg<Record<string, never>>('devnexus_jira_list_projects', async (_input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const projects = await client.listProjects();
        const lines = (projects as any[]).map((p: any) => `- **${p.key}** — ${p.name} (${p.projectTypeKey})${p.lead ? ` | Lead: ${p.lead.displayName}` : ''}`);
        return `Projects (${(projects as any[]).length}):\n${lines.join('\n')}`;
    });

    reg<{ projectKey: string }>('devnexus_jira_get_project_versions', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const versions = await client.getProjectVersions(input.projectKey);
        if (!(versions as any[]).length) { return `No versions in ${input.projectKey}.`; }
        const lines = (versions as any[]).map((v: any) => {
            const flags = [v.released ? 'released' : '', v.archived ? 'archived' : ''].filter(Boolean).join(', ');
            return `- **${v.name}** (id: ${v.id})${flags ? ` [${flags}]` : ''}${v.releaseDate ? ` — release: ${v.releaseDate}` : ''}`;
        });
        return `Versions in **${input.projectKey}** (${(versions as any[]).length}):\n${lines.join('\n')}`;
    });

    reg<{ projectKey: string }>('devnexus_jira_get_project_components', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const components = await client.getProjectComponents(input.projectKey);
        if (!(components as any[]).length) { return `No components in ${input.projectKey}.`; }
        const lines = (components as any[]).map((c: any) => `- **${c.name}**${c.description ? ` — ${c.description}` : ''}${c.lead ? ` | Lead: ${c.lead.displayName}` : ''}`);
        return `Components in **${input.projectKey}** (${(components as any[]).length}):\n${lines.join('\n')}`;
    });

    // ── Metadata ─────────────────────────────────────────────────
    reg<Record<string, never>>('devnexus_jira_get_issue_types', async (_input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const types = await client.getIssueTypes();
        const lines = (types as any[]).map((t: any) => `- **${t.name}** (id: ${t.id})${t.subtask ? ' [subtask]' : ''}${t.description ? ` — ${t.description}` : ''}`);
        return `Issue types (${(types as any[]).length}):\n${lines.join('\n')}`;
    });

    reg<Record<string, never>>('devnexus_jira_get_priorities', async (_input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const priorities = await client.getPriorities();
        const lines = (priorities as any[]).map((p: any) => `- **${p.name}** (id: ${p.id})${p.description ? ` — ${p.description}` : ''}`);
        return `Priorities (${(priorities as any[]).length}):\n${lines.join('\n')}`;
    });

    reg<Record<string, never>>('devnexus_jira_get_fields', async (_input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const fields = await client.getFields();
        const custom = (fields as any[]).filter((f: any) => f.custom);
        const standard = (fields as any[]).filter((f: any) => !f.custom);
        const fmt = (f: any) => `- **${f.id}** — ${f.name}${f.schema?.type ? ` (${f.schema.type})` : ''}`;
        return `Fields — ${standard.length} standard, ${custom.length} custom:\n\n**Custom fields:**\n${custom.map(fmt).join('\n')}\n\n**Standard fields:**\n${standard.map(fmt).join('\n')}`;
    });

    // ── Changelog ────────────────────────────────────────────────
    reg<{ issueKey: string; maxResults?: number }>('devnexus_jira_get_changelog', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const histories = await client.getChangelog(input.issueKey, input.maxResults || 20);
        if (!histories.length) { return `No change history for **${input.issueKey}**.`; }
        const lines = (histories as any[]).map((h: any) => {
            const date = new Date(h.created).toISOString().replace('T', ' ').substring(0, 16);
            const changes = h.items.map((it: any) => `${it.field}: "${it.fromString || '—'}" → "${it.toString || '—'}"`).join('; ');
            return `**[${date}] ${h.author.displayName}**: ${changes}`;
        });
        return `Changelog for **${input.issueKey}** (${histories.length} entries):\n\n${lines.join('\n\n')}`;
    });

    // ── Versions CRUD ────────────────────────────────────────────
    reg<{ projectKey: string; name: string; description?: string; startDate?: string; releaseDate?: string }>('devnexus_jira_create_version', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const result = await client.createVersion(input);
        return `Created version **${result.name}** (id: ${result.id}) in ${input.projectKey}`;
    });

    reg<{ versionId: string; name?: string; description?: string; released?: boolean; archived?: boolean; startDate?: string; releaseDate?: string }>('devnexus_jira_update_version', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const { versionId, ...updates } = input;
        const result = await client.updateVersion(versionId, updates);
        return `Updated version **${result.name}** (id: ${result.id})`;
    });

    // ── Users ─────────────────────────────────────────────────────
    reg<{ query: string; maxResults?: number }>('devnexus_jira_search_users', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const users = await client.searchUsers(input.query, input.maxResults || 10);
        if (!(users as any[]).length) { return `No users found matching "${input.query}".`; }
        const lines = (users as any[]).map((u: any) => `- **${u.displayName}** (username: \`${u.name}\`${u.emailAddress ? `, email: ${u.emailAddress}` : ''}${u.active ? '' : ' [inactive]'})`);
        return `Users matching "${input.query}" (${(users as any[]).length}):\n${lines.join('\n')}`;
    });

    reg<{ username: string }>('devnexus_jira_get_user', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const user = await client.getUser(input.username);
        return `**${user.displayName}** (username: \`${user.name}\`${(user as any).emailAddress ? `, email: ${(user as any).emailAddress}` : ''}${user.active ? '' : ' — **inactive**'})`;
    });

    // ── Agile: Boards ────────────────────────────────────────────
    reg<{ projectKey?: string }>('devnexus_jira_get_boards', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const boards = await client.getBoards(input.projectKey);
        if (!boards.length) { return `No boards found${input.projectKey ? ` for ${input.projectKey}` : ''}.`; }
        const lines = boards.map(b => `- **#${b.id}** ${b.name} [${b.type}]${(b as any).location?.projectKey ? ` (${(b as any).location.projectKey})` : ''}`);
        return `Boards (${boards.length}):\n${lines.join('\n')}`;
    });

    // ── Agile: Sprints ───────────────────────────────────────────
    reg<{ boardId: number; state?: 'active' | 'future' | 'closed' }>('devnexus_jira_get_sprints', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const sprints = await client.getSprints(input.boardId, input.state);
        if (!sprints.length) { return `No sprints found on board #${input.boardId}.`; }
        const lines = sprints.map(s => {
            const dates = s.startDate ? ` (${s.startDate?.substring(0, 10)} → ${s.endDate?.substring(0, 10)})` : '';
            return `- **#${s.id}** ${s.name} [${s.state}]${dates}${s.goal ? ` — Goal: ${s.goal}` : ''}`;
        });
        return `Sprints on board #${input.boardId} (${sprints.length}):\n${lines.join('\n')}`;
    });

    // ── Agile: Sprint Issues ─────────────────────────────────────
    reg<{ sprintId: number; maxResults?: number }>('devnexus_jira_get_sprint_issues', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const data = await client.getSprintIssues(input.sprintId, input.maxResults || 50);
        if (!data.issues.length) { return `No issues in sprint #${input.sprintId}.`; }
        const lines = data.issues.map(i =>
            `- **${i.key}** — ${i.fields.summary} [${i.fields.status.name}] ${i.fields.assignee?.displayName || 'Unassigned'}`
        );
        return `Sprint #${input.sprintId} issues (${data.issues.length} of ${data.total}):\n${lines.join('\n')}`;
    });

    // ── Agile: Move to Sprint ────────────────────────────────────
    reg<{ sprintId: number; issueKeys: string[] }>('devnexus_jira_move_to_sprint', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        await client.moveToSprint(input.sprintId, input.issueKeys);
        return `Moved ${input.issueKeys.map(k => `**${k}**`).join(', ')} to sprint #${input.sprintId}`;
    });

    // ── Agile: Epics ─────────────────────────────────────────────
    reg<{ boardId: number; done?: boolean }>('devnexus_jira_get_epics', async (input) => {
        const client = await getClient();
        if (!client) { return 'Jira credentials not configured.'; }
        const epics = await client.getEpics(input.boardId, input.done || false);
        if (!epics.length) { return `No epics on board #${input.boardId}.`; }
        const lines = epics.map(e => `- **${e.key}** (id: ${e.id}) — ${e.summary}${(e as any).color ? ` [${(e as any).color.key}]` : ''}`);
        return `Epics on board #${input.boardId} (${epics.length}):\n${lines.join('\n')}`;
    });
}
