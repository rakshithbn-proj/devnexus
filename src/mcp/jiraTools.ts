import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JiraClient } from '../api/jiraClient';
import { McpConfig } from './mcpAuth';
import { ok } from './toolHelpers';

type Srv = InstanceType<typeof McpServer>;

const ERR = 'Jira credentials not configured. Check ~/.devnexus-env.';

export function registerJiraTools(server: Srv, client: JiraClient, cfg: McpConfig): void {

    // ── Get Issue ────────────────────────────────────────────────
    server.tool('devnexus_jira_get_issue', 'Fetch a Jira issue details: summary, status, labels, fix versions, assignee, subtasks.',
        { issueKey: z.string().describe('Jira issue key, e.g. PROJ-123') },
        async ({ issueKey }) => {
            const issue = await client.getIssue(issueKey);
            const subtasks = issue.fields.subtasks?.map((s: any) =>
                `  - ${s.key}: ${s.fields.summary} [${s.fields.status.name}]${s.fields.assignee ? ` (${s.fields.assignee.displayName})` : ''}`
            ).join('\n') || '  (none)';

            const fieldNames: Record<string, string> = issue.names || {};
            const SYSTEM_DATE_FIELDS = new Set(['created', 'updated', 'resolutiondate', 'lastViewed', 'statuscategorychangedate', 'duedate']);
            const flds = issue.fields as Record<string, unknown>;

            let startFieldId: string | undefined = cfg.jiraStartDateFieldId && flds[cfg.jiraStartDateFieldId] !== undefined
                ? cfg.jiraStartDateFieldId : undefined;
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

            return ok([
                `**${issue.key}** — ${issue.fields.summary}`,
                `Status: ${issue.fields.status.name}`,
                `Type: ${issue.fields.issuetype.name}`,
                `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`,
                `Start Date: ${startDate}`,
                `Due Date: ${dueDate}`,
                `Labels: ${issue.fields.labels.join(', ') || 'none'}`,
                `Fix Versions: ${issue.fields.fixVersions.map((v: any) => v.name).join(', ') || 'none'}`,
                `Priority: ${issue.fields.priority?.name || 'none'}`,
                `Subtasks:\n${subtasks}`,
                `URL: ${client.getBrowseUrl(issue.key)}`,
            ].join('\n'));
        }
    );

    // ── Create Issue ─────────────────────────────────────────────
    server.tool('devnexus_jira_create_issue', 'Create a new Jira issue (Story, Task, or Bug).',
        {
            projectKey: z.string().describe('Project key, e.g. PROJ'),
            issueType: z.enum(['Story', 'Task', 'Bug']).describe('Issue type'),
            summary: z.string().describe('Issue summary/title'),
            description: z.string().optional().describe('Issue description'),
            labels: z.array(z.string()).optional().describe('Labels'),
            fixVersions: z.array(z.string()).optional().describe('Fix version names'),
            assignee: z.string().optional().describe('Username or "self"'),
        },
        async (input) => {
            const assignee = input.assignee === 'self' ? cfg.jiraUser : input.assignee;
            const result = await client.createIssue({
                projectKey: input.projectKey, issueType: input.issueType, summary: input.summary,
                description: input.description, labels: input.labels, fixVersions: input.fixVersions,
                assignee: assignee || undefined,
            });
            return ok(`Created **${result.key}** — "${input.summary}"\nURL: ${client.getBrowseUrl(result.key)}`);
        }
    );

    // ── Create Subtask ───────────────────────────────────────────
    server.tool('devnexus_jira_create_subtask', 'Create a subtask under a parent Jira issue. Inherits fix versions from parent if not specified.',
        {
            parentKey: z.string().describe('Parent issue key, e.g. PROJ-123'),
            summary: z.string().describe('Subtask summary'),
            description: z.string().optional(),
            labels: z.array(z.string()).optional().describe('Labels'),
            fixVersions: z.array(z.string()).optional().describe('Fix versions (inherited from parent if omitted)'),
            assignee: z.string().optional().describe('Username or "self"'),
        },
        async (input) => {
            const parent = await client.getIssue(input.parentKey);
            const projectKey = parent.fields.project.key;
            const fixVersions = input.fixVersions?.length ? input.fixVersions : parent.fields.fixVersions.map((v: any) => v.name);
            const assignee = input.assignee === 'self' ? cfg.jiraUser : input.assignee;
            const result = await client.createSubtask({
                parentKey: input.parentKey, projectKey, summary: input.summary,
                description: input.description, labels: input.labels, fixVersions,
                assignee: assignee || undefined,
            });
            return ok(`Created subtask **${result.key}** — "${input.summary}"\nParent: ${input.parentKey} | Labels: ${input.labels?.join(', ') || 'none'} | Assigned: ${assignee || 'unassigned'}\nURL: ${client.getBrowseUrl(result.key)}`);
        }
    );

    // ── Search ───────────────────────────────────────────────────
    server.tool('devnexus_jira_search', 'Search Jira issues using JQL. Returns key, summary, status, assignee.',
        {
            jql: z.string().describe('JQL query, e.g. "project = PROJ AND assignee = currentUser() AND status != Done"'),
            maxResults: z.number().optional().describe('Max results (default 20)'),
        },
        async ({ jql, maxResults }) => {
            const data = await client.search(jql, maxResults || 20);
            const lines = data.issues.map((i: any) => {
                const due = i.fields.duedate ? ` | Due: ${i.fields.duedate}` : '';
                const subtaskCount = i.fields.subtasks?.length ? ` | Subtasks: ${i.fields.subtasks.length}` : '';
                return `- **${i.key}** — ${i.fields.summary} [${i.fields.status.name}] ${i.fields.assignee?.displayName || 'Unassigned'}${due}${subtaskCount}`;
            });
            return ok(`Found ${data.total} issues (showing ${data.issues.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Transition ───────────────────────────────────────────────
    server.tool('devnexus_jira_transition', 'Transition a Jira issue to a new status.',
        {
            issueKey: z.string().describe('Issue key'),
            transitionName: z.string().describe('Target status: "In Progress", "Resolved", "Done", "Closed", "Open"'),
        },
        async ({ issueKey, transitionName }) => {
            await client.transitionIssue(issueKey, transitionName);
            return ok(`Transitioned **${issueKey}** → **${transitionName}**`);
        }
    );

    // ── Add Comment ──────────────────────────────────────────────
    server.tool('devnexus_jira_add_comment', 'Add a comment to a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            body: z.string().describe('Comment text'),
        },
        async ({ issueKey, body }) => {
            await client.addComment(issueKey, body);
            return ok(`Comment added to **${issueKey}**`);
        }
    );

    // ── Update Fields ────────────────────────────────────────────
    server.tool('devnexus_jira_update_fields', 'Update fields on a Jira issue (summary, description, labels, fixVersions, assignee, priority, time estimates, dates).',
        {
            issueKey: z.string().describe('Issue key'),
            fields: z.object({
                summary: z.string().optional(),
                description: z.string().optional(),
                labels: z.array(z.string()).optional(),
                fixVersions: z.array(z.string()).optional(),
                assignee: z.string().optional(),
                priority: z.string().optional(),
                originalEstimate: z.string().optional().describe('e.g. "2h", "1d"'),
                remainingEstimate: z.string().optional().describe('e.g. "2h", "30m"'),
                dueDate: z.string().optional().describe('YYYY-MM-DD'),
                startDate: z.string().optional().describe('YYYY-MM-DD'),
                forecastDate: z.string().optional().describe('YYYY-MM-DD'),
            }).describe('Fields to update'),
        },
        async ({ issueKey, fields }) => {
            const f = { ...fields };
            if (f.assignee === 'self') { f.assignee = cfg.jiraUser; }
            await client.updateFields(issueKey, f);
            return ok(`Updated **${issueKey}** fields: ${Object.keys(f).join(', ')}`);
        }
    );

    // ── Review Complete ──────────────────────────────────────────
    server.tool('devnexus_jira_review_complete', 'Posts "Independent review complete" on the originating ticket if FMS_*_REVIEW label; otherwise on the ticket itself.',
        { issueKey: z.string().describe('The review ticket key, e.g. PROJ-789') },
        async ({ issueKey }) => {
            const issue = await client.getIssue(issueKey);
            const labels: string[] = issue.fields.labels || [];
            const isReviewTicket = labels.some(l => /^FMS_.+_REVIEW$/i.test(l));
            const issuelinks = issue.fields.issuelinks || [];
            const relatedLink = issuelinks.find((l: any) =>
                l.type?.name?.toLowerCase().includes('relates') && (l.outwardIssue || l.inwardIssue)
            );
            const relatedKey = relatedLink?.outwardIssue?.key || relatedLink?.inwardIssue?.key;
            const commentTarget = (isReviewTicket && relatedKey) ? relatedKey : issueKey;
            const commentBody = 'Independent review complete';
            await client.addComment(commentTarget, commentBody);
            return ok(isReviewTicket && relatedKey
                ? `Posted "${commentBody}" on **${commentTarget}** (originating ticket of review ${issueKey})`
                : `Posted "${commentBody}" on **${commentTarget}** (no FMS_*_REVIEW label or no related link found)`
            );
        }
    );

    // ── Log Work ─────────────────────────────────────────────────
    server.tool('devnexus_jira_log_work', 'Log time spent working on a Jira issue.',
        {
            issueKey: z.string().describe('Issue key, e.g. PROJ-456'),
            timeSpent: z.string().describe('Time spent, e.g. "2h", "1h 30m"'),
            started: z.string().optional().describe('ISO 8601 start time. Defaults to now.'),
        },
        async ({ issueKey, timeSpent, started }) => {
            await client.logWork(issueKey, timeSpent, started);
            return ok(`Logged **${timeSpent}** of work on **${issueKey}**`);
        }
    );

    // ── Link Issues ──────────────────────────────────────────────
    server.tool('devnexus_jira_link_issues', 'Link two Jira issues (blocks, relates to, is caused by, duplicates).',
        {
            linkType: z.string().describe('Link type: "blocks", "relates to", "is caused by", "duplicates"'),
            inwardKey: z.string().describe('Inward issue key'),
            outwardKey: z.string().describe('Outward issue key'),
        },
        async ({ linkType, inwardKey, outwardKey }) => {
            await client.linkIssues(linkType, inwardKey, outwardKey);
            return ok(`Linked: ${outwardKey} **${linkType}** ${inwardKey}`);
        }
    );

    // ── List Subtasks ────────────────────────────────────────────
    server.tool('devnexus_jira_list_subtasks', 'List all subtasks of a parent Jira issue.',
        { parentKey: z.string().describe('Parent issue key') },
        async ({ parentKey }) => {
            const issue = await client.getIssue(parentKey);
            const subtasks = issue.fields.subtasks || [];
            if (subtasks.length === 0) { return ok(`${parentKey} has no subtasks.`); }
            const lines = subtasks.map((s: any) =>
                `- **${s.key}** — ${s.fields.summary} [${s.fields.status.name}]${s.fields.assignee ? ` (${s.fields.assignee.displayName})` : ''}`
            );
            return ok(`**${parentKey}** subtasks (${subtasks.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Assign ───────────────────────────────────────────────────
    server.tool('devnexus_jira_assign', 'Assign a Jira issue. Use "self" to assign to yourself.',
        {
            issueKey: z.string().describe('Issue key'),
            assignee: z.string().describe('Username or "self"'),
        },
        async ({ issueKey, assignee }) => {
            const resolved = assignee === 'self' ? cfg.jiraUser : assignee;
            await client.assignIssue(issueKey, resolved);
            return ok(`Assigned **${issueKey}** to ${resolved}`);
        }
    );

    // ── List Initiative Issues ────────────────────────────────────
    server.tool('devnexus_jira_list_initiative_issues', 'List all child issues and their sub-issues under a Jira epic/initiative. Shows key, summary, status, assignee, dates.',
        {
            initiativeKey: z.string().describe('Initiative/epic issue key, e.g. PROJ-100'),
            assignee: z.string().optional().describe('Username to filter by. Omit or "self" for current user.'),
        },
        async ({ initiativeKey, assignee }) => {
            const filterByMe = !assignee || assignee === 'self';
            const usernameForQuery = filterByMe ? cfg.jiraUser : assignee;

            const { initiative, issues: allIssues, subIssues, queriesAttempted, fieldNames } =
                await client.getInitiativeIssues(initiativeKey, filterByMe ? usernameForQuery : assignee);

            const formatDate = (val: any): string =>
                typeof val === 'string' && val ? val.substring(0, 10) : '—';

            const SYSTEM_DATE_FIELDS = new Set(['created', 'updated', 'resolutiondate', 'lastViewed', 'statuscategorychangedate', 'duedate']);
            const findByName = (pattern: RegExp): string | undefined =>
                Object.entries(fieldNames).find(([, name]) => pattern.test(name))?.[0];

            const startFieldId =
                (cfg.jiraStartDateFieldId && allIssues.some((i: any) => i.fields?.[cfg.jiraStartDateFieldId] !== undefined) ? cfg.jiraStartDateFieldId : undefined)
                || findByName(/^start\s*date$/i)
                || findByName(/\bstart\b.*\bdate\b/i)
                || (allIssues.some((i: any) => i.fields?.startDate) ? 'startDate' : undefined);

            const forecastFieldId =
                (cfg.jiraForecastDateFieldId && allIssues.some((i: any) => i.fields?.[cfg.jiraForecastDateFieldId] !== undefined) ? cfg.jiraForecastDateFieldId : undefined)
                || findByName(/forecast|target\s*(completion|date|end)|planned\s*(end|completion)/i);

            const startLabel = startFieldId ? (fieldNames[startFieldId] || 'Start Date') : 'Start Date';
            const forecastLabel = forecastFieldId ? (fieldNames[forecastFieldId] || 'Forecast') : 'Forecast';

            const header = `**${initiativeKey}** — ${initiative.fields?.summary || initiativeKey}\nURL: ${client.getBrowseUrl(initiativeKey)}`;

            if (allIssues.length === 0) {
                return ok([header, '', '⚠️ No child issues found.', `Queries attempted: \`${queriesAttempted.join('` | `')}\``].join('\n'));
            }

            const lines: string[] = [
                `| Key | Summary | Status | Assignee | ${startLabel} | Due Date | ${forecastLabel} |`,
                '|-----|---------|--------|----------|------------|----------|---------------------|',
            ];
            for (const i of allIssues) {
                const f = i.fields;
                const sd = startFieldId ? formatDate(f[startFieldId]) : '—';
                const dd = formatDate(f.duedate);
                const fc = forecastFieldId ? formatDate(f[forecastFieldId]) : '—';
                lines.push(`| **${i.key}** | ${f.summary} | ${f.status?.name || '?'} | ${f.assignee?.displayName || 'Unassigned'} | ${sd} | ${dd} | ${fc} |`);
                for (const sub of (subIssues.get(i.key) || [])) {
                    const sf = sub.fields;
                    lines.push(`| ↳ ${sub.key} | ${sf.summary} | ${sf.status?.name || '?'} | ${sf.assignee?.displayName || 'Unassigned'} | ${startFieldId ? formatDate(sf[startFieldId]) : '—'} | ${formatDate(sf.duedate)} | ${forecastFieldId ? formatDate(sf[forecastFieldId]) : '—'} |`);
                }
            }
            return ok([header, `Issues (${allIssues.length}):`, '', lines.join('\n')].join('\n'));
        }
    );

    // ── Update Issue Dates ────────────────────────────────────────
    server.tool('devnexus_jira_update_issue_dates', 'Update date fields on a Jira issue: start date, due date, or forecast completion.',
        {
            issueKey: z.string().describe('Issue key, e.g. PROJ-111'),
            startDate: z.string().optional().describe('Start date YYYY-MM-DD. Empty string to clear.'),
            dueDate: z.string().optional().describe('Due date YYYY-MM-DD. Empty string to clear.'),
            forecastCompletion: z.string().optional().describe('Forecast completion YYYY-MM-DD. Empty string to clear.'),
            forecastFieldId: z.string().optional().describe('Override custom field ID for forecast completion.'),
        },
        async (input) => {
            if (!input.startDate && !input.dueDate && input.forecastCompletion === undefined) {
                return ok('No date fields specified. Provide at least one of: startDate, dueDate, or forecastCompletion.');
            }
            await client.updateIssueDates(input.issueKey, {
                startDate: input.startDate,
                startDateFieldId: cfg.jiraStartDateFieldId || undefined,
                dueDate: input.dueDate,
                forecastCompletion: input.forecastCompletion,
                forecastFieldId: input.forecastFieldId || cfg.jiraForecastDateFieldId || undefined,
            });
            const updated: string[] = [];
            if (input.startDate !== undefined) { updated.push(`Start Date → **${input.startDate || 'cleared'}**`); }
            if (input.dueDate !== undefined) { updated.push(`Due Date → **${input.dueDate || 'cleared'}**`); }
            if (input.forecastCompletion !== undefined) { updated.push(`Forecast → **${input.forecastCompletion || 'cleared'}**`); }
            return ok(`Updated **${input.issueKey}** dates:\n${updated.join('\n')}\nURL: ${client.getBrowseUrl(input.issueKey)}`);
        }
    );

    // ── Delete Issue ──────────────────────────────────────────────
    server.tool('devnexus_jira_delete_issue', 'Permanently delete a Jira issue.',
        { issueKey: z.string().describe('Issue key to delete') },
        async ({ issueKey }) => {
            await client.deleteIssue(issueKey);
            return ok(`Deleted **${issueKey}**`);
        }
    );

    // ── Clone Issue ───────────────────────────────────────────────
    server.tool('devnexus_jira_clone_issue', 'Clone an existing Jira issue, copying its type, description, labels, and fix versions.',
        {
            sourceKey: z.string().describe('Source issue key to clone'),
            summary: z.string().optional().describe('New summary (defaults to "[Clone] original summary")'),
            assignee: z.string().optional().describe('Assignee username or "self"'),
            labels: z.array(z.string()).optional().describe('Override labels'),
            fixVersions: z.array(z.string()).optional().describe('Override fix versions'),
        },
        async (input) => {
            const assignee = input.assignee === 'self' ? cfg.jiraUser : input.assignee;
            const result = await client.cloneIssue(input.sourceKey, {
                summary: input.summary, assignee: assignee || undefined,
                labels: input.labels, fixVersions: input.fixVersions,
            });
            return ok(`Cloned **${input.sourceKey}** → **${result.key}**\nURL: ${client.getBrowseUrl(result.key)}`);
        }
    );

    // ── Bulk Create ───────────────────────────────────────────────
    server.tool('devnexus_jira_bulk_create', 'Create multiple Jira issues in a single API call.',
        {
            issues: z.array(z.object({
                projectKey: z.string(),
                issueType: z.enum(['Story', 'Task', 'Bug']),
                summary: z.string(),
                description: z.string().optional(),
                labels: z.array(z.string()).optional(),
                fixVersions: z.array(z.string()).optional(),
                assignee: z.string().optional(),
            })).describe('Array of issues to create'),
        },
        async ({ issues }) => {
            const result = await client.bulkCreateIssues(issues);
            const keys = result.issues.map((i: any) => `**${i.key}**`).join(', ');
            const errorCount = result.errors?.length || 0;
            return ok(`Created ${result.issues.length} issue(s): ${keys}${errorCount ? `\n${errorCount} error(s): ${JSON.stringify(result.errors)}` : ''}`);
        }
    );

    // ── List Comments ─────────────────────────────────────────────
    server.tool('devnexus_jira_list_comments', 'List all comments on a Jira issue.',
        { issueKey: z.string().describe('Issue key') },
        async ({ issueKey }) => {
            const comments = await client.listComments(issueKey);
            if (comments.length === 0) { return ok(`No comments on **${issueKey}**.`); }
            const lines = comments.map((c: any) => {
                const date = new Date(c.created).toISOString().replace('T', ' ').substring(0, 16);
                return `**#${c.id}** [${date}] **${c.author.displayName}**: ${c.body.substring(0, 200)}${c.body.length > 200 ? '...' : ''}`;
            });
            return ok(`Comments on **${issueKey}** (${comments.length}):\n\n${lines.join('\n\n')}`);
        }
    );

    // ── Update Comment ────────────────────────────────────────────
    server.tool('devnexus_jira_update_comment', 'Update the text of an existing comment on a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            commentId: z.string().describe('Comment ID (from list_comments)'),
            body: z.string().describe('New comment text'),
        },
        async ({ issueKey, commentId, body }) => {
            await client.updateComment(issueKey, commentId, body);
            return ok(`Updated comment #${commentId} on **${issueKey}**`);
        }
    );

    // ── Delete Comment ────────────────────────────────────────────
    server.tool('devnexus_jira_delete_comment', 'Delete a comment from a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            commentId: z.string().describe('Comment ID to delete'),
        },
        async ({ issueKey, commentId }) => {
            await client.deleteComment(issueKey, commentId);
            return ok(`Deleted comment #${commentId} from **${issueKey}**`);
        }
    );

    // ── List Worklogs ─────────────────────────────────────────────
    server.tool('devnexus_jira_list_worklogs', 'List all work log entries on a Jira issue.',
        { issueKey: z.string().describe('Issue key') },
        async ({ issueKey }) => {
            const worklogs = await client.listWorklogs(issueKey);
            if (worklogs.length === 0) { return ok(`No worklogs on **${issueKey}**.`); }
            const lines = worklogs.map((w: any) => {
                const date = new Date(w.started).toISOString().replace('T', ' ').substring(0, 16);
                return `**#${w.id}** [${date}] **${w.author.displayName}**: ${w.timeSpent}`;
            });
            const totalSec = worklogs.reduce((sum: number, w: any) => sum + (w.timeSpentSeconds || 0), 0);
            return ok(`Worklogs on **${issueKey}** (${worklogs.length}, total ~${(totalSec / 3600).toFixed(1)}h):\n\n${lines.join('\n')}`);
        }
    );

    // ── Update Worklog ────────────────────────────────────────────
    server.tool('devnexus_jira_update_worklog', 'Update an existing worklog entry.',
        {
            issueKey: z.string().describe('Issue key'),
            worklogId: z.string().describe('Worklog ID (from list_worklogs)'),
            timeSpent: z.string().describe('New time spent, e.g. "2h", "30m"'),
            started: z.string().optional().describe('ISO 8601 start time (optional)'),
        },
        async ({ issueKey, worklogId, timeSpent, started }) => {
            await client.updateWorklog(issueKey, worklogId, timeSpent, started);
            return ok(`Updated worklog #${worklogId} on **${issueKey}** → ${timeSpent}`);
        }
    );

    // ── Delete Worklog ────────────────────────────────────────────
    server.tool('devnexus_jira_delete_worklog', 'Delete a worklog entry from a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            worklogId: z.string().describe('Worklog ID to delete'),
        },
        async ({ issueKey, worklogId }) => {
            await client.deleteWorklog(issueKey, worklogId);
            return ok(`Deleted worklog #${worklogId} from **${issueKey}**`);
        }
    );

    // ── Delete Issue Link ─────────────────────────────────────────
    server.tool('devnexus_jira_delete_link', 'Delete a link between two Jira issues by link ID.',
        { linkId: z.string().describe('Issue link ID') },
        async ({ linkId }) => {
            await client.deleteIssueLink(linkId);
            return ok(`Deleted issue link #${linkId}`);
        }
    );

    // ── List Link Types ───────────────────────────────────────────
    server.tool('devnexus_jira_list_link_types', 'List all valid issue link type names.',
        {},
        async () => {
            const types = await client.getLinkTypes();
            const lines = types.map((t: any) => `- **${t.name}** (inward: "${t.inward}", outward: "${t.outward}")`);
            return ok(`Issue link types (${types.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Watchers ──────────────────────────────────────────────────
    server.tool('devnexus_jira_get_watchers', 'Get the list of watchers on a Jira issue.',
        { issueKey: z.string().describe('Issue key') },
        async ({ issueKey }) => {
            const data = await client.getWatchers(issueKey);
            const names = data.watchers.map((w: any) => w.displayName).join(', ') || 'none';
            return ok(`**${issueKey}** has ${data.watchCount} watcher(s): ${names}`);
        }
    );

    server.tool('devnexus_jira_watch_issue', 'Start watching a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            username: z.string().optional().describe('Username to add as watcher (omit for self)'),
        },
        async ({ issueKey, username }) => {
            const resolved = username === 'self' ? cfg.jiraUser : username;
            await client.watchIssue(issueKey, resolved || undefined);
            return ok(`Now watching **${issueKey}**${resolved ? ` (added ${resolved})` : ''}`);
        }
    );

    server.tool('devnexus_jira_unwatch_issue', 'Stop watching a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            username: z.string().optional().describe('Username to remove (omit for self)'),
        },
        async ({ issueKey, username }) => {
            const resolved = username === 'self' ? cfg.jiraUser : username;
            await client.unwatchIssue(issueKey, resolved || undefined);
            return ok(`Unwatched **${issueKey}**${resolved ? ` (removed ${resolved})` : ''}`);
        }
    );

    // ── Vote ──────────────────────────────────────────────────────
    server.tool('devnexus_jira_vote_issue', 'Vote for a Jira issue.',
        { issueKey: z.string().describe('Issue key') },
        async ({ issueKey }) => {
            await client.voteIssue(issueKey);
            return ok(`Voted for **${issueKey}**`);
        }
    );

    // ── Projects ──────────────────────────────────────────────────
    server.tool('devnexus_jira_list_projects', 'List all accessible Jira projects.',
        {},
        async () => {
            const projects = await client.listProjects();
            const lines = (projects as any[]).map((p: any) => `- **${p.key}** — ${p.name} (${p.projectTypeKey})${p.lead ? ` | Lead: ${p.lead.displayName}` : ''}`);
            return ok(`Projects (${(projects as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_jira_get_project_versions', 'List all fix versions in a Jira project.',
        { projectKey: z.string().describe('Project key, e.g. PROJ') },
        async ({ projectKey }) => {
            const versions = await client.getProjectVersions(projectKey);
            if (!(versions as any[]).length) { return ok(`No versions in ${projectKey}.`); }
            const lines = (versions as any[]).map((v: any) => {
                const flags = [v.released ? 'released' : '', v.archived ? 'archived' : ''].filter(Boolean).join(', ');
                return `- **${v.name}** (id: ${v.id})${flags ? ` [${flags}]` : ''}${v.releaseDate ? ` — release: ${v.releaseDate}` : ''}`;
            });
            return ok(`Versions in **${projectKey}** (${(versions as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_jira_get_project_components', 'List all components in a Jira project.',
        { projectKey: z.string().describe('Project key') },
        async ({ projectKey }) => {
            const components = await client.getProjectComponents(projectKey);
            if (!(components as any[]).length) { return ok(`No components in ${projectKey}.`); }
            const lines = (components as any[]).map((c: any) => `- **${c.name}**${c.description ? ` — ${c.description}` : ''}`);
            return ok(`Components in **${projectKey}** (${(components as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    // ── Metadata ──────────────────────────────────────────────────
    server.tool('devnexus_jira_get_issue_types', 'List all available Jira issue types.',
        {},
        async () => {
            const types = await client.getIssueTypes();
            const lines = (types as any[]).map((t: any) => `- **${t.name}** (id: ${t.id})${t.subtask ? ' [subtask]' : ''}`);
            return ok(`Issue types (${(types as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_jira_get_priorities', 'List all available issue priority levels.',
        {},
        async () => {
            const priorities = await client.getPriorities();
            const lines = (priorities as any[]).map((p: any) => `- **${p.name}** (id: ${p.id})`);
            return ok(`Priorities (${(priorities as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_jira_get_fields', 'List all Jira fields — standard and custom — with their IDs and types.',
        {},
        async () => {
            const fields = await client.getFields();
            const custom = (fields as any[]).filter((f: any) => f.custom);
            const standard = (fields as any[]).filter((f: any) => !f.custom);
            const fmt = (f: any) => `- **${f.id}** — ${f.name}${f.schema?.type ? ` (${f.schema.type})` : ''}`;
            return ok(`Fields — ${standard.length} standard, ${custom.length} custom:\n\n**Custom fields:**\n${custom.map(fmt).join('\n')}\n\n**Standard fields:**\n${standard.map(fmt).join('\n')}`);
        }
    );

    // ── Changelog ─────────────────────────────────────────────────
    server.tool('devnexus_jira_get_changelog', 'Get the full change history of a Jira issue.',
        {
            issueKey: z.string().describe('Issue key'),
            maxResults: z.number().optional().describe('Max history entries (default 20)'),
        },
        async ({ issueKey, maxResults }) => {
            const histories = await client.getChangelog(issueKey, maxResults || 20);
            if (!histories.length) { return ok(`No change history for **${issueKey}**.`); }
            const lines = (histories as any[]).map((h: any) => {
                const date = new Date(h.created).toISOString().replace('T', ' ').substring(0, 16);
                const changes = h.items.map((it: any) => `${it.field}: "${it.fromString || '—'}" → "${it.toString || '—'}"`).join('; ');
                return `**[${date}] ${h.author.displayName}**: ${changes}`;
            });
            return ok(`Changelog for **${issueKey}** (${histories.length} entries):\n\n${lines.join('\n\n')}`);
        }
    );

    // ── Versions CRUD ─────────────────────────────────────────────
    server.tool('devnexus_jira_create_version', 'Create a new fix version in a Jira project.',
        {
            projectKey: z.string().describe('Project key'),
            name: z.string().describe('Version name'),
            description: z.string().optional(),
            startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
            releaseDate: z.string().optional().describe('Release date (YYYY-MM-DD)'),
        },
        async (input) => {
            const result = await client.createVersion(input);
            return ok(`Created version **${(result as any).name}** (id: ${(result as any).id}) in ${input.projectKey}`);
        }
    );

    server.tool('devnexus_jira_update_version', 'Update a fix version (mark as released/archived, change name or dates).',
        {
            versionId: z.string().describe('Version ID (from get_project_versions)'),
            name: z.string().optional().describe('New version name'),
            description: z.string().optional(),
            released: z.boolean().optional().describe('Mark as released'),
            archived: z.boolean().optional().describe('Mark as archived'),
            startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
            releaseDate: z.string().optional().describe('Release date (YYYY-MM-DD)'),
        },
        async ({ versionId, ...updates }) => {
            const result = await client.updateVersion(versionId, updates);
            return ok(`Updated version **${(result as any).name}** (id: ${(result as any).id})`);
        }
    );

    // ── Users ─────────────────────────────────────────────────────
    server.tool('devnexus_jira_search_users', 'Search for Jira users by name or username.',
        {
            query: z.string().describe('Name or username to search'),
            maxResults: z.number().optional().describe('Max results (default 10)'),
        },
        async ({ query, maxResults }) => {
            const users = await client.searchUsers(query, maxResults || 10);
            if (!(users as any[]).length) { return ok(`No users found matching "${query}".`); }
            const lines = (users as any[]).map((u: any) => `- **${u.displayName}** (username: \`${u.name}\`${u.emailAddress ? `, email: ${u.emailAddress}` : ''})`);
            return ok(`Users matching "${query}" (${(users as any[]).length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_jira_get_user', 'Get a Jira user profile by exact username.',
        { username: z.string().describe('Exact Jira username') },
        async ({ username }) => {
            const user = await client.getUser(username);
            return ok(`**${user.displayName}** (username: \`${user.name}\`${(user as any).emailAddress ? `, email: ${(user as any).emailAddress}` : ''})`);
        }
    );

    // ── Agile: Boards ─────────────────────────────────────────────
    server.tool('devnexus_jira_get_boards', 'List Agile boards. Optionally filter by project key.',
        { projectKey: z.string().optional().describe('Filter by project key, e.g. PROJ') },
        async ({ projectKey }) => {
            const boards = await client.getBoards(projectKey);
            if (!boards.length) { return ok(`No boards found${projectKey ? ` for ${projectKey}` : ''}.`); }
            const lines = boards.map((b: any) => `- **#${b.id}** ${b.name} [${b.type}]`);
            return ok(`Boards (${boards.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Agile: Sprints ────────────────────────────────────────────
    server.tool('devnexus_jira_get_sprints', 'List sprints on a board. Filter by state: active, future, or closed.',
        {
            boardId: z.number().describe('Board ID (from get_boards)'),
            state: z.enum(['active', 'future', 'closed']).optional().describe('Sprint state filter'),
        },
        async ({ boardId, state }) => {
            const sprints = await client.getSprints(boardId, state);
            if (!sprints.length) { return ok(`No sprints found on board #${boardId}.`); }
            const lines = sprints.map((s: any) => {
                const dates = s.startDate ? ` (${s.startDate.substring(0, 10)} → ${s.endDate?.substring(0, 10)})` : '';
                return `- **#${s.id}** ${s.name} [${s.state}]${dates}`;
            });
            return ok(`Sprints on board #${boardId} (${sprints.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Agile: Sprint Issues ──────────────────────────────────────
    server.tool('devnexus_jira_get_sprint_issues', 'List all issues in a sprint.',
        {
            sprintId: z.number().describe('Sprint ID (from get_sprints)'),
            maxResults: z.number().optional().describe('Max results (default 50)'),
        },
        async ({ sprintId, maxResults }) => {
            const data = await client.getSprintIssues(sprintId, maxResults || 50);
            if (!data.issues.length) { return ok(`No issues in sprint #${sprintId}.`); }
            const lines = data.issues.map((i: any) =>
                `- **${i.key}** — ${i.fields.summary} [${i.fields.status.name}] ${i.fields.assignee?.displayName || 'Unassigned'}`
            );
            return ok(`Sprint #${sprintId} issues (${data.issues.length} of ${data.total}):\n${lines.join('\n')}`);
        }
    );

    // ── Agile: Move to Sprint ─────────────────────────────────────
    server.tool('devnexus_jira_move_to_sprint', 'Move one or more issues into a sprint.',
        {
            sprintId: z.number().describe('Sprint ID'),
            issueKeys: z.array(z.string()).describe('Issue keys to move, e.g. ["PROJ-123"]'),
        },
        async ({ sprintId, issueKeys }) => {
            await client.moveToSprint(sprintId, issueKeys);
            return ok(`Moved ${issueKeys.map(k => `**${k}**`).join(', ')} to sprint #${sprintId}`);
        }
    );

    // ── Agile: Epics ──────────────────────────────────────────────
    server.tool('devnexus_jira_get_epics', 'List epics on a board.',
        {
            boardId: z.number().describe('Board ID'),
            done: z.boolean().optional().describe('Include done epics (default false)'),
        },
        async ({ boardId, done }) => {
            const epics = await client.getEpics(boardId, done || false);
            if (!epics.length) { return ok(`No epics on board #${boardId}.`); }
            const lines = epics.map((e: any) => `- **${e.key}** (id: ${e.id}) — ${e.summary}`);
            return ok(`Epics on board #${boardId} (${epics.length}):\n${lines.join('\n')}`);
        }
    );

    // suppress unused variable warning
    void ERR;
}
