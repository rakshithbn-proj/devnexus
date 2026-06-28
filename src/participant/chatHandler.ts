import * as vscode from 'vscode';
import { invokeToolDirect } from '../tools/toolRegistry';
import { AuthManager } from '../auth/authManager';

const SYSTEM_PROMPT = `You are DevNexus. You execute Jira and Bitbucket operations using the tools provided.

IMPORTANT: You MUST use the tools to fulfill requests. Never output raw JSON or pseudo-tool-calls as text.

Key conventions:
- Default project: (configured)
- Jira:  | Bitbucket:  (project, configured repo)
- PR listings always span ALL repos via the dashboard API — never restricted to a single repo
- When acting on a PR from a non-default repo (shown as [PROJECT/repo] in listing results), always pass repo and project fields in the tool call
- Subtask labels: whatever the user specifies
- "assign to me" / "assign to myself" → assignee = "self"
- Creating subtasks: inherit fix versions from parent if not specified
- Cross-tool: fetch PR changes first, then create subtask referencing changed files
- Logging work: use devnexus_jira_log_work for any request to "log hours", "log work", "record time spent"
- Setting time estimates: use devnexus_jira_update_fields with originalEstimate / remainingEstimate fields
- "start the progress" → transition to "In Progress"; "mark it resolved" / "resolve" / "mark as resolved" → transition to "Resolved" (NOT "Done")
- Workflow sequences: execute all steps (transition, update fields, log work, add comment) without asking for confirmation
- Review tickets: if asked to comment on the ticket a review was raised from, fetch the review ticket's linked issues to find the originating ticket, then post the comment there — do not ask the user for it
- Date fields: dueDate → duedate (standard field), startDate → customfield_56601, forecastDate → customfield_56806; always use YYYY-MM-DD format

Shorthand syntax: /<ticket>/<ops> — ticket is a number (PROJ- prefix assumed), ops executed in order without confirmation.
  Transitions:  p=In Progress | re=In Review | rs=Resolved | df=In Drafts
  Time:         et-<dur>=originalEstimate | rt-<dur>=remainingEstimate | lt-<dur>=log work
  Dates (DDMM → YYYY-MM-DD, current year; if date already passed use next year):
                tf-DDMM=forecastDate | ts-DDMM=startDate | td-DDMM=dueDate
  Comments:     c-cp → if ticket label matches FMS_*_REVIEW: post "Independent review complete" on the "relates to" linked issue
                c-"<text>" → post custom text; on linked issue if FMS_*_REVIEW label, otherwise on the ticket itself
  Help:         /h (no ticket needed) → print the shorthand reference
Examples:
  /69119/p/et-20m/rt-20m/lt-15m/rs/c-cp   → full review close-out
  /69119/p/tf-2612/td-3112                 → start + forecast Dec 26 + due Dec 31

Be concise. Show created issue keys, URLs, and key fields.`;

// ── Tool schema definitions (passed to the model for structured tool calling) ──

const TOOL_SCHEMAS: vscode.LanguageModelChatTool[] = [
    {
        name: 'devnexus_jira_get_issue',
        description: 'Fetch a Jira issue details: summary, status, labels, fix versions, assignee, subtasks.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Jira issue key, e.g. PROJ-123' }
            },
            required: ['issueKey']
        }
    },
    {
        name: 'devnexus_jira_create_issue',
        description: 'Create a new Jira issue (Story, Task, or Bug).',
        inputSchema: {
            type: 'object',
            properties: {
                projectKey: { type: 'string', description: 'Project key, e.g. PROJ' },
                issueType: { type: 'string', enum: ['Story', 'Task', 'Bug'], description: 'Issue type' },
                summary: { type: 'string', description: 'Issue summary/title' },
                description: { type: 'string', description: 'Issue description' },
                labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
                fixVersions: { type: 'array', items: { type: 'string' }, description: 'Fix version names' },
                assignee: { type: 'string', description: 'Username or "self"' }
            },
            required: ['projectKey', 'issueType', 'summary']
        }
    },
    {
        name: 'devnexus_jira_create_subtask',
        description: 'Create a subtask under a parent Jira issue. Inherits fix versions from parent if not specified.',
        inputSchema: {
            type: 'object',
            properties: {
                parentKey: { type: 'string', description: 'Parent issue key, e.g. PROJ-123' },
                summary: { type: 'string', description: 'Subtask summary' },
                description: { type: 'string', description: 'Subtask description' },
                labels: { type: 'array', items: { type: 'string' }, description: 'Labels (e.g. backend, review, bug)' },
                fixVersions: { type: 'array', items: { type: 'string' }, description: 'Fix versions (inherited from parent if omitted)' },
                assignee: { type: 'string', description: 'Username or "self"' }
            },
            required: ['parentKey', 'summary']
        }
    },
    {
        name: 'devnexus_jira_search',
        description: 'Search Jira issues using JQL. Returns key, summary, status, assignee.',
        inputSchema: {
            type: 'object',
            properties: {
                jql: { type: 'string', description: 'JQL query, e.g. "project = PROJ AND assignee = currentUser() AND status != Done"' },
                maxResults: { type: 'number', description: 'Max results (default 20)' }
            },
            required: ['jql']
        }
    },
    {
        name: 'devnexus_jira_transition',
        description: 'Transition a Jira issue to a new status (e.g. Open → In Progress → Resolved).',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key' },
                transitionName: { type: 'string', description: 'Target status: "In Progress", "Resolved", "Done", "Closed", "Open"' }
            },
            required: ['issueKey', 'transitionName']
        }
    },
    {
        name: 'devnexus_jira_add_comment',
        description: 'Add a comment to a Jira issue.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key' },
                body: { type: 'string', description: 'Comment text' }
            },
            required: ['issueKey', 'body']
        }
    },
    {
        name: 'devnexus_jira_update_fields',
        description: 'Update fields on a Jira issue (summary, description, labels, fixVersions, assignee, priority, originalEstimate, remainingEstimate, dueDate, startDate, forecastDate).',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key' },
                fields: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                        description: { type: 'string' },
                        labels: { type: 'array', items: { type: 'string' } },
                        fixVersions: { type: 'array', items: { type: 'string' } },
                        assignee: { type: 'string' },
                        priority: { type: 'string' },
                        originalEstimate: { type: 'string', description: 'Original time estimate, e.g. "2h", "1d"' },
                        remainingEstimate: { type: 'string', description: 'Remaining time estimate, e.g. "2h", "30m"' },
                        dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format (standard duedate field)' },
                        startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format (customfield_56601)' },
                        forecastDate: { type: 'string', description: 'Forecast completion date in YYYY-MM-DD format (customfield_56806)' }
                    }
                }
            },
            required: ['issueKey', 'fields']
        }
    },
    {
        name: 'devnexus_jira_review_complete',
        description: 'Posts "Independent review complete" comment. If the ticket has a FMS_*_REVIEW label, posts on the "relates to" linked (originating) issue; otherwise posts on the ticket itself. Use for /c-cp shorthand.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'The review ticket key, e.g. PROJ-789' }
            },
            required: ['issueKey']
        }
    },
    {
        name: 'devnexus_jira_log_work',
        description: 'Log time spent working on a Jira issue (adds a worklog entry). Use this whenever the user says to log hours, log work, or record time.',

        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-456' },
                timeSpent: { type: 'string', description: 'Time spent in Jira duration format, e.g. "2h", "1h 30m"' },
                started: { type: 'string', description: 'ISO 8601 datetime when work started. Defaults to now if omitted.' }
            },
            required: ['issueKey', 'timeSpent']
        }
    },
    {
        name: 'devnexus_jira_link_issues',
        description: 'Link two Jira issues (blocks, relates to, is caused by, duplicates).',
        inputSchema: {
            type: 'object',
            properties: {
                linkType: { type: 'string', description: 'Link type: "blocks", "relates to", "is caused by", "duplicates"' },
                inwardKey: { type: 'string', description: 'Inward issue key' },
                outwardKey: { type: 'string', description: 'Outward issue key' }
            },
            required: ['linkType', 'inwardKey', 'outwardKey']
        }
    },
    {
        name: 'devnexus_jira_list_subtasks',
        description: 'List all subtasks of a parent Jira issue.',
        inputSchema: {
            type: 'object',
            properties: {
                parentKey: { type: 'string', description: 'Parent issue key' }
            },
            required: ['parentKey']
        }
    },
    {
        name: 'devnexus_jira_assign',
        description: 'Assign a Jira issue. Use "self" to assign to yourself.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key' },
                assignee: { type: 'string', description: 'Username or "self"' }
            },
            required: ['issueKey', 'assignee']
        }
    },
    {
        name: 'devnexus_bb_list_prs',
        description: 'List pull requests. Filter by state and role.',
        inputSchema: {
            type: 'object',
            properties: {
                state: { type: 'string', enum: ['OPEN', 'MERGED', 'DECLINED'], description: 'PR state (default OPEN)' },
                filter: { type: 'string', enum: ['all', 'mine', 'reviewing'], description: 'Role filter (default all)' },
                limit: { type: 'number', description: 'Max results (default 25)' }
            }
        }
    },
    {
        name: 'devnexus_bb_get_pr',
        description: 'Get full details of a pull request. Pass repo and project if the PR is not in the configured repo.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_create_pr',
        description: 'Create a pull request from source to target branch.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'PR title' },
                description: { type: 'string', description: 'PR description' },
                fromBranch: { type: 'string', description: 'Source branch' },
                toBranch: { type: 'string', description: 'Target branch (default develop)' },
                reviewers: { type: 'array', items: { type: 'string' }, description: 'Reviewer usernames' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['title', 'fromBranch']
        }
    },
    {
        name: 'devnexus_bb_merge_pr',
        description: 'Merge a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_get_changes',
        description: 'List changed files in a PR with change type (ADD/MODIFY/DELETE).',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_get_diff',
        description: 'Get diff of a specific file in a PR.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                filePath: { type: 'string', description: 'File path in repo' },
                contextLines: { type: 'number', description: 'Context lines (default 5)' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'filePath']
        }
    },
    {
        name: 'devnexus_bb_add_comment',
        description: 'Add a general or inline comment on a PR.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                text: { type: 'string', description: 'Comment text' },
                filePath: { type: 'string', description: 'File path for inline comment (omit for general)' },
                line: { type: 'number', description: 'Line number for inline comment' },
                lineType: { type: 'string', enum: ['ADDED', 'REMOVED', 'CONTEXT'], description: 'Line type (default ADDED)' },
                severity: { type: 'string', enum: ['NORMAL', 'BLOCKER'], description: 'Comment severity (use BLOCKER for blocking comments)' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'text']
        }
    },
    {
        name: 'devnexus_bb_list_comments',
        description: 'List ALL comments on a PR — general comments, inline code comments, and their replies. Shows every comment by every author with timestamps and file locations.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_add_reviewer',
        description: 'Add a reviewer to a PR.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                username: { type: 'string', description: 'Reviewer username' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'username']
        }
    },
    {
        name: 'devnexus_bb_remove_reviewer',
        description: 'Remove a reviewer from a PR.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                username: { type: 'string', description: 'Username to remove' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'username']
        }
    },
    {
        name: 'devnexus_bb_approve_pr',
        description: 'Approve a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_decline_pr',
        description: 'Decline a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_needs_work',
        description: 'Mark a pull request as NEEDS_WORK for the current reviewer.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_list_repos',
        description: 'List all repositories in a Bitbucket project. Use to verify a repo slug exists before creating a branch or PR.',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string', description: 'Bitbucket project key (default project)' }
            }
        }
    },
    {
        name: 'devnexus_bb_get_branches',
        description: 'List branches in a Bitbucket repo, optionally filtered by name. Use to check if a branch already exists.',
        inputSchema: {
            type: 'object',
            properties: {
                repo: { type: 'string', description: 'Repo slug' },
                project: { type: 'string', description: 'Bitbucket project key (default project)' },
                filter: { type: 'string', description: 'Filter branches by name (partial match)' }
            },
            required: ['repo']
        }
    },
    {
        name: 'devnexus_bb_create_branch',
        description: 'Create a new branch in any Bitbucket repo. Automatically verifies the repo exists and checks the branch does not already exist before creating.',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string', description: 'New branch name' },
                startPoint: { type: 'string', description: 'Base branch (default develop)' },
                repo: { type: 'string', description: 'Repo slug to create the branch in (defaults to configured repo)' },
                project: { type: 'string', description: 'Bitbucket project key (default project)' }
            },
            required: ['branchName']
        }
    },
    // ── Jira Extended ────────────────────────────────────────────
    {
        name: 'devnexus_jira_delete_issue',
        description: 'Permanently delete a Jira issue.',
        inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] }
    },
    {
        name: 'devnexus_jira_clone_issue',
        description: 'Clone an existing Jira issue. Copies type, description, labels, fix versions. Override any field.',
        inputSchema: {
            type: 'object',
            properties: {
                sourceKey: { type: 'string', description: 'Issue key to clone' },
                summary: { type: 'string', description: 'New summary (default: [Clone] original)' },
                assignee: { type: 'string', description: 'Assignee username or "self"' },
                labels: { type: 'array', items: { type: 'string' } },
                fixVersions: { type: 'array', items: { type: 'string' } }
            },
            required: ['sourceKey']
        }
    },
    {
        name: 'devnexus_jira_bulk_create',
        description: 'Create multiple Jira issues in one call.',
        inputSchema: {
            type: 'object',
            properties: {
                issues: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            projectKey: { type: 'string' }, issueType: { type: 'string', enum: ['Story', 'Task', 'Bug'] },
                            summary: { type: 'string' }, description: { type: 'string' },
                            labels: { type: 'array', items: { type: 'string' } },
                            fixVersions: { type: 'array', items: { type: 'string' } },
                            assignee: { type: 'string' }
                        },
                        required: ['projectKey', 'issueType', 'summary']
                    }
                }
            },
            required: ['issues']
        }
    },
    {
        name: 'devnexus_jira_list_comments',
        description: 'List all comments on a Jira issue with author, date, and text.',
        inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] }
    },
    {
        name: 'devnexus_jira_update_comment',
        description: 'Update the text of an existing comment on a Jira issue.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string' },
                commentId: { type: 'string', description: 'Comment ID (from list_comments)' },
                body: { type: 'string', description: 'New comment text' }
            },
            required: ['issueKey', 'commentId', 'body']
        }
    },
    {
        name: 'devnexus_jira_delete_comment',
        description: 'Delete a comment from a Jira issue.',
        inputSchema: {
            type: 'object',
            properties: { issueKey: { type: 'string' }, commentId: { type: 'string' } },
            required: ['issueKey', 'commentId']
        }
    },
    {
        name: 'devnexus_jira_list_worklogs',
        description: 'List all worklog entries on a Jira issue — who logged time, how much, and when.',
        inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] }
    },
    {
        name: 'devnexus_jira_update_worklog',
        description: 'Update an existing worklog entry (change time spent or start time).',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string' },
                worklogId: { type: 'string', description: 'Worklog ID (from list_worklogs)' },
                timeSpent: { type: 'string', description: 'New time, e.g. "2h", "30m"' },
                started: { type: 'string', description: 'ISO 8601 start time (optional)' }
            },
            required: ['issueKey', 'worklogId', 'timeSpent']
        }
    },
    {
        name: 'devnexus_jira_delete_worklog',
        description: 'Delete a worklog entry from a Jira issue.',
        inputSchema: {
            type: 'object',
            properties: { issueKey: { type: 'string' }, worklogId: { type: 'string' } },
            required: ['issueKey', 'worklogId']
        }
    },
    {
        name: 'devnexus_jira_delete_link',
        description: 'Delete a link between two Jira issues by link ID.',
        inputSchema: { type: 'object', properties: { linkId: { type: 'string' } }, required: ['linkId'] }
    },
    {
        name: 'devnexus_jira_list_link_types',
        description: 'List all valid Jira issue link types (blocks, relates to, duplicates, etc.).',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'devnexus_jira_get_watchers',
        description: 'Get the list of watchers on a Jira issue.',
        inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] }
    },
    {
        name: 'devnexus_jira_watch_issue',
        description: 'Start watching a Jira issue. Optionally add a different user as watcher.',
        inputSchema: {
            type: 'object',
            properties: { issueKey: { type: 'string' }, username: { type: 'string', description: 'Username to add (omit for self)' } },
            required: ['issueKey']
        }
    },
    {
        name: 'devnexus_jira_unwatch_issue',
        description: 'Stop watching a Jira issue. Optionally remove another user.',
        inputSchema: {
            type: 'object',
            properties: { issueKey: { type: 'string' }, username: { type: 'string', description: 'Username to remove (omit for self)' } },
            required: ['issueKey']
        }
    },
    {
        name: 'devnexus_jira_vote_issue',
        description: 'Vote for a Jira issue to indicate importance.',
        inputSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] }
    },
    {
        name: 'devnexus_jira_list_projects',
        description: 'List all accessible Jira projects with keys, names, and leads.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'devnexus_jira_get_project_versions',
        description: 'List all fix versions in a Jira project.',
        inputSchema: { type: 'object', properties: { projectKey: { type: 'string' } }, required: ['projectKey'] }
    },
    {
        name: 'devnexus_jira_get_project_components',
        description: 'List all components in a Jira project.',
        inputSchema: { type: 'object', properties: { projectKey: { type: 'string' } }, required: ['projectKey'] }
    },
    {
        name: 'devnexus_jira_get_issue_types',
        description: 'List all Jira issue types with their IDs.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'devnexus_jira_get_priorities',
        description: 'List all Jira issue priority levels.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'devnexus_jira_get_fields',
        description: 'List all Jira fields — standard and custom — with IDs and types. Use to discover custom field IDs.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'devnexus_jira_get_changelog',
        description: 'Get the full change history of a Jira issue — who changed what field and when.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string' },
                maxResults: { type: 'number', description: 'Max entries (default 20)' }
            },
            required: ['issueKey']
        }
    },
    {
        name: 'devnexus_jira_create_version',
        description: 'Create a new fix version in a Jira project.',
        inputSchema: {
            type: 'object',
            properties: {
                projectKey: { type: 'string' }, name: { type: 'string' },
                description: { type: 'string' }, startDate: { type: 'string', description: 'YYYY-MM-DD' },
                releaseDate: { type: 'string', description: 'YYYY-MM-DD' }
            },
            required: ['projectKey', 'name']
        }
    },
    {
        name: 'devnexus_jira_update_version',
        description: 'Update a fix version (mark released/archived, change name or dates).',
        inputSchema: {
            type: 'object',
            properties: {
                versionId: { type: 'string', description: 'Version ID (from get_project_versions)' },
                name: { type: 'string' }, description: { type: 'string' },
                released: { type: 'boolean' }, archived: { type: 'boolean' },
                startDate: { type: 'string' }, releaseDate: { type: 'string' }
            },
            required: ['versionId']
        }
    },
    {
        name: 'devnexus_jira_search_users',
        description: 'Search for Jira users by name or username. Use to find usernames for assignment.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Name or username to search' },
                maxResults: { type: 'number', description: 'Max results (default 10)' }
            },
            required: ['query']
        }
    },
    {
        name: 'devnexus_jira_get_user',
        description: 'Get a Jira user profile by exact username.',
        inputSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] }
    },
    {
        name: 'devnexus_jira_get_boards',
        description: 'List Agile boards, optionally filtered by project.',
        inputSchema: {
            type: 'object',
            properties: { projectKey: { type: 'string', description: 'Filter by project, e.g. PROJ' } }
        }
    },
    {
        name: 'devnexus_jira_get_sprints',
        description: 'List sprints on an Agile board. Filter by state: active, future, or closed.',
        inputSchema: {
            type: 'object',
            properties: {
                boardId: { type: 'number', description: 'Board ID (from get_boards)' },
                state: { type: 'string', enum: ['active', 'future', 'closed'] }
            },
            required: ['boardId']
        }
    },
    {
        name: 'devnexus_jira_get_sprint_issues',
        description: 'List all issues in a sprint.',
        inputSchema: {
            type: 'object',
            properties: {
                sprintId: { type: 'number', description: 'Sprint ID (from get_sprints)' },
                maxResults: { type: 'number', description: 'Max results (default 50)' }
            },
            required: ['sprintId']
        }
    },
    {
        name: 'devnexus_jira_move_to_sprint',
        description: 'Move one or more Jira issues into a sprint.',
        inputSchema: {
            type: 'object',
            properties: {
                sprintId: { type: 'number' },
                issueKeys: { type: 'array', items: { type: 'string' }, description: 'Issue keys to move' }
            },
            required: ['sprintId', 'issueKeys']
        }
    },
    {
        name: 'devnexus_jira_get_epics',
        description: 'List epics on an Agile board.',
        inputSchema: {
            type: 'object',
            properties: {
                boardId: { type: 'number' },
                done: { type: 'boolean', description: 'Include completed epics (default false)' }
            },
            required: ['boardId']
        }
    },
    // ── Bitbucket Extended ───────────────────────────────────────
    {
        name: 'devnexus_bb_delete_branch',
        description: 'Delete a branch from a Bitbucket repository.',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['branchName']
        }
    },
    {
        name: 'devnexus_bb_get_default_branch',
        description: 'Get the default branch of a repository.',
        inputSchema: {
            type: 'object',
            properties: {
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            }
        }
    },
    {
        name: 'devnexus_bb_set_default_branch',
        description: 'Set the default branch of a repository.',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['branchName']
        }
    },
    {
        name: 'devnexus_bb_update_pr',
        description: 'Update a PR title, description, or target branch.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                title: { type: 'string' }, description: { type: 'string' },
                targetBranch: { type: 'string', description: 'New target branch name' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_reopen_pr',
        description: 'Reopen a declined pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_get_pr_commits',
        description: 'List all commits included in a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                limit: { type: 'number', description: 'Max results (default 100)' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_get_commits',
        description: 'Get commit history for a branch or filtered by file path.',
        inputSchema: {
            type: 'object',
            properties: {
                until: { type: 'string', description: 'Branch name' },
                limit: { type: 'number', description: 'Max results (default 25)' },
                path: { type: 'string', description: 'File path to filter commits by' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            }
        }
    },
    {
        name: 'devnexus_bb_get_commit',
        description: 'Get details of a single commit by SHA.',
        inputSchema: {
            type: 'object',
            properties: {
                commitId: { type: 'string', description: 'Commit SHA' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['commitId']
        }
    },
    {
        name: 'devnexus_bb_list_tasks',
        description: 'List all tasks (to-do items) on a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_create_task',
        description: 'Create a task (to-do) on a pull request, optionally anchored to a comment.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                text: { type: 'string', description: 'Task text' },
                commentId: { type: 'number', description: 'Anchor to comment ID (optional)' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'text']
        }
    },
    {
        name: 'devnexus_bb_resolve_task',
        description: 'Mark a PR task as resolved.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' }, taskId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'taskId']
        }
    },
    {
        name: 'devnexus_bb_delete_task',
        description: 'Delete a task from a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' }, taskId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'taskId']
        }
    },
    {
        name: 'devnexus_bb_update_comment',
        description: 'Update the text of an existing PR comment.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' }, commentId: { type: 'number' }, text: { type: 'string' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'commentId', 'text']
        }
    },
    {
        name: 'devnexus_bb_delete_comment',
        description: 'Delete a comment from a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' }, commentId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'commentId']
        }
    },
    {
        name: 'devnexus_bb_reply_to_comment',
        description: 'Reply to an existing PR comment (threaded reply).',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' }, parentCommentId: { type: 'number' }, text: { type: 'string' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId', 'parentCommentId', 'text']
        }
    },
    {
        name: 'devnexus_bb_get_file',
        description: 'Get the raw content of a file from the repository at a specific branch.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path, e.g. src/main.py' },
                branch: { type: 'string', description: 'Branch name' },
                repo: { type: 'string' }, project: { type: 'string' }
            },
            required: ['path']
        }
    },
    {
        name: 'devnexus_bb_browse',
        description: 'Browse the file tree of the repository at a path and branch.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory to browse (omit for root)' },
                branch: { type: 'string' }, repo: { type: 'string' }, project: { type: 'string' }
            }
        }
    },
    {
        name: 'devnexus_bb_compare',
        description: 'Compare two branches — shows commits and file changes between them.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Source branch' },
                to: { type: 'string', description: 'Target branch' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['from', 'to']
        }
    },
    {
        name: 'devnexus_bb_list_tags',
        description: 'List tags in a repository, optionally filtered by name.',
        inputSchema: {
            type: 'object',
            properties: {
                filter: { type: 'string' }, limit: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            }
        }
    },
    {
        name: 'devnexus_bb_create_tag',
        description: 'Create a new tag pointing to a commit.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Tag name' },
                commitId: { type: 'string', description: 'Commit SHA to tag' },
                message: { type: 'string', description: 'Annotated tag message (optional)' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['name', 'commitId']
        }
    },
    {
        name: 'devnexus_bb_delete_tag',
        description: 'Delete a tag from a repository.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Tag name' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['name']
        }
    },
    {
        name: 'devnexus_bb_get_build_status',
        description: 'Get CI/CD build statuses for a commit. Shows SUCCESSFUL/FAILED/INPROGRESS for each pipeline.',
        inputSchema: { type: 'object', properties: { commitId: { type: 'string', description: 'Full commit SHA' } }, required: ['commitId'] }
    },
    {
        name: 'devnexus_bb_set_build_status',
        description: 'Report a build status for a commit (for CI integrations).',
        inputSchema: {
            type: 'object',
            properties: {
                commitId: { type: 'string' },
                state: { type: 'string', enum: ['SUCCESSFUL', 'FAILED', 'INPROGRESS'] },
                key: { type: 'string', description: 'Unique pipeline key' },
                url: { type: 'string', description: 'Link to build details' },
                name: { type: 'string' }, description: { type: 'string' }
            },
            required: ['commitId', 'state', 'key', 'url']
        }
    },
    {
        name: 'devnexus_bb_check_merge',
        description: 'Check if a PR can be merged and what is blocking it (missing approvals, unresolved tasks, failed checks).',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number' },
                repo: { type: 'string', description: 'Repo slug (defaults to configured repo)' },
                project: { type: 'string', description: 'Project key (default project)' }
            },
            required: ['prId']
        }
    },
];

const log = vscode.window.createOutputChannel('DevNexus', { log: true });

// Session-level token accumulator (resets when extension is reloaded)
let sessionTokensIn = 0;
let sessionTokensOut = 0;
let sessionRequests = 0;

export function registerChatParticipant(context: vscode.ExtensionContext, auth?: AuthManager): void {
    context.subscriptions.push(log);
    log.show(true); // Show output channel (preserves focus)
    log.info('[init] DevNexus chat participant registered');

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      try {
        log.info(`[request] "${request.prompt}"`);

        // ── dry: prefix — plan without executing ──
        const isDryRun = /^dry:\s*/i.test(request.prompt);
        const effectivePrompt = isDryRun ? request.prompt.replace(/^dry:\s*/i, '') : request.prompt;

        // ── /h shorthand: print help without hitting the model ──
        if (effectivePrompt.trim() === '/h') {
            response.markdown([
                '**DevNexus — Shorthand Reference**',
                '',
                '`/<ticket>/<ops>` — ticket is a number, PROJ- prefix assumed, ops run in order',
                '',
                '| Op | Action |',
                '|---|---|',
                '| `p` | → In Progress |',
                '| `re` | → In Review |',
                '| `rs` | → Resolved |',
                '| `df` | → In Drafts |',
                '| `et-<dur>` | Set originalEstimate (e.g. `et-20m`) |',
                '| `rt-<dur>` | Set remainingEstimate |',
                '| `lt-<dur>` | Log work |',
                '| `tf-DDMM` | Set forecastDate (next year if date passed) |',
                '| `ts-DDMM` | Set startDate |',
                '| `td-DDMM` | Set dueDate |',
                '| `c-cp` | "Independent review complete" on originating ticket (if FMS_*_REVIEW label) |',
                '| `c-"text"` | Custom comment (on related ticket if FMS_*_REVIEW, otherwise on self) |',
                '',
                '**Examples**',
                '- `/69119/p/et-20m/rt-20m/lt-15m/rs/c-cp` → full review close-out',
                '- `/69119/p/tf-2612/td-3112` → start + forecast Dec 26 + due Dec 31',
                '',
                '**Dry run** — prefix any command with `dry:` to preview tool calls without executing',
                '- `dry: /69119/p/et-20m/rs` → shows planned steps, nothing sent to Jira',
            ].join('\n'));
            return {};
        }

        // Select model — try Claude families, then any copilot model
        const families = ['claude-sonnet-4-6', 'claude-sonnet-4', 'claude-sonnet-3.5', 'gpt-4o'];
        let model: vscode.LanguageModelChat | undefined;
        for (const family of families) {
            const found = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
            if (found.length > 0) { model = found[0]; break; }
        }
        if (!model) {
            const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            model = allModels[0];
        }
        if (!model) {
            response.markdown('No language model available. Ensure GitHub Copilot is active.');
            return {};
        }
        log.info(`[model] ${model.name} (${model.vendor}/${model.family})`);

        // ── Step 1: Ask model to pick tool + args (NO tools option — pure text) ──
        const planPrompt = buildPlanPrompt(effectivePrompt);
        const historyMessages = buildHistoryMessages(chatContext.history);
        const planMessages: vscode.LanguageModelChatMessage[] = [
            ...historyMessages,
            vscode.LanguageModelChatMessage.User(planPrompt),
        ];

        response.progress('Thinking...');
        log.info(`[plan] Sending plan prompt (${planPrompt.length} chars)`);
        const planInTokens = await Promise.resolve(model.countTokens(planPrompt, token)).catch(() => Math.round(planPrompt.length / 4));
        const planResponse = await model.sendRequest(planMessages, {}, token);
        let planText = '';
        for await (const part of planResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                planText += part.value;
            }
        }
        const planOutTokens = await Promise.resolve(model.countTokens(planText, token)).catch(() => Math.round(planText.length / 4));
        log.info(`[plan] Raw model response: ${planText.substring(0, 500)}`);
        log.info(`[plan] Tokens: in=${planInTokens} out=${planOutTokens}`);

        // ── Step 2: Parse the tool call(s) from the response ──
        const toolCalls = parseToolCalls(planText);

        if (toolCalls.length === 0) {
            log.warn('[plan] No tool calls parsed from response');
            response.markdown('I could not determine which action to take. Please try rephrasing, e.g.:\n\n' +
                '- `@nexus list my open bug tickets`\n' +
                '- `@nexus get issue PROJ-123`\n' +
                '- `@nexus create subtask under PROJ-123`\n');
            return {};
        }
        log.info(`[plan] Parsed ${toolCalls.length} tool call(s): ${toolCalls.map(t => t.name).join(', ')}`);

        // ── Dry run: execute reads, skip writes ──
        if (isDryRun) {
            const READ_TOOLS = new Set([
                'devnexus_jira_get_issue', 'devnexus_jira_search', 'devnexus_jira_list_subtasks',
                'devnexus_jira_list_comments', 'devnexus_jira_list_worklogs', 'devnexus_jira_get_watchers',
                'devnexus_jira_list_link_types', 'devnexus_jira_list_projects', 'devnexus_jira_get_project_versions',
                'devnexus_jira_get_project_components', 'devnexus_jira_get_issue_types', 'devnexus_jira_get_priorities',
                'devnexus_jira_get_fields', 'devnexus_jira_get_changelog', 'devnexus_jira_search_users', 'devnexus_jira_get_user',
                'devnexus_jira_get_boards', 'devnexus_jira_get_sprints', 'devnexus_jira_get_sprint_issues', 'devnexus_jira_get_epics',
                'devnexus_bb_list_prs', 'devnexus_bb_get_pr', 'devnexus_bb_get_changes',
                'devnexus_bb_get_diff', 'devnexus_bb_list_comments',
                'devnexus_bb_list_repos', 'devnexus_bb_get_branches', 'devnexus_bb_get_default_branch',
                'devnexus_bb_get_pr_commits', 'devnexus_bb_get_commits', 'devnexus_bb_get_commit',
                'devnexus_bb_list_tasks', 'devnexus_bb_list_tags', 'devnexus_bb_get_build_status',
                'devnexus_bb_check_merge', 'devnexus_bb_browse', 'devnexus_bb_get_file', 'devnexus_bb_compare',
            ]);

            // For create_branch: expand with verification reads (repo exists, source branch exists, target doesn't)
            const expandedCalls: { name: string; input: object }[] = [];
            for (const tc of toolCalls) {
                if (tc.name === 'devnexus_bb_create_branch') {
                    const inp = tc.input as any;
                    const repo = inp.repo || '';
                    const project = inp.project || '';
                    const startPoint = inp.startPoint || 'develop';
                    const branchName = inp.branchName as string | undefined;
                    expandedCalls.push({ name: 'devnexus_bb_list_repos', input: { project } });
                    expandedCalls.push({ name: 'devnexus_bb_get_branches', input: { repo, project, filter: startPoint } });
                    if (branchName) {
                        expandedCalls.push({ name: 'devnexus_bb_get_branches', input: { repo, project, filter: branchName } });
                    }
                }
                expandedCalls.push(tc);
            }

            const lines: string[] = [];
            for (let i = 0; i < expandedCalls.length; i++) {
                const tc = expandedCalls[i];
                const summary = describeDryRunStep(tc.name, tc.input as Record<string, any>);
                const isRead = READ_TOOLS.has(tc.name);
                const badge = isRead ? '🔍 **Query**' : '🚫 **Skipped (write)**';
                const parts = [
                    `**Step ${i + 1} — ${summary.title}** ${badge}`,
                    summary.details.map(d => `- ${d}`).join('\n'),
                ];
                if (isRead) {
                    try {
                        response.progress(`Querying ${tc.name.replace('devnexus_', '')}...`);
                        const result = await invokeToolDirect(tc.name, tc.input, token);
                        parts.push(`\n**Result:**\n${result}`);
                    } catch (err: any) {
                        parts.push(`\n**Query failed:** ${err.message}`);
                    }
                } else {
                    parts.push(`\n> Would call \`${tc.name}\` — not executed in dry run`);
                }
                lines.push(parts.join('\n'));
            }
            response.markdown(`**Dry Run** — reads executed, writes skipped:\n\n${lines.join('\n\n---\n\n')}`);
            return {};
        }

        // ── Step 3: Execute tools and collect results ──
        const allResults: string[] = [];
        let hasError = false;
        for (const tc of toolCalls) {
            const label = tc.name.replace('devnexus_', '').replace(/_/g, ' ');
            response.progress(`Calling ${label}...`);
            log.info(`[exec] ${tc.name} with ${JSON.stringify(tc.input)}`);
            try {
                const resultText = await invokeToolDirect(tc.name, tc.input, token);
                log.info(`[exec] ${tc.name} result: ${resultText.substring(0, 500)}`);

                // Check for credential errors from the tool itself
                if (resultText.includes('credentials not configured') || resultText.includes('Credentials not configured')) {
                    hasError = true;
                    response.markdown(`**Authentication required.** Run \`Ctrl+Shift+P\` → "DevNexus: Set Jira Credentials" or "DevNexus: Create Credentials File" first.\n\n` +
                        `Tool response: ${resultText}`);
                    return {};
                }

                allResults.push(resultText);
            } catch (err: any) {
                hasError = true;
                log.error(`[exec] ${tc.name} FAILED: ${err.message}`);
                response.markdown(`**Tool error** (${label}): ${err.message}\n\nCheck the **DevNexus** output channel for details.`);
                return {};
            }
        }

        if (allResults.length === 0) {
            response.markdown('No results returned from tools.');
            return {};
        }

        // ── Step 4: Ask model to format results nicely (NO tools option) ──
        log.info(`[format] Sending ${allResults.length} result(s) to model for formatting`);
        const profile = auth?.getUserProfile();
        const currentUser = profile?.username || auth?.getJiraUsername() || 'unknown';
        const displayName = profile?.displayName || currentUser;
        const email = profile?.email || '';
        log.info(`[format] User identity: ${currentUser} / ${displayName} / ${email}`);
        const formatPrompt = `You are DevNexus.
Current user identity:
- Username: ${currentUser}
- Display name: ${displayName}
- Email: ${email}
When the user says "I", "my", or "me", they mean ${displayName} (username ${currentUser}).

The user asked: "${request.prompt}"

The following tool(s) were executed and returned these results:

${allResults.join('\n\n---\n\n')}

IMPORTANT:
- The tools WERE successfully called. Present ALL the results above to the user. Do NOT say the tools are unavailable.
- Show ALL data returned — do NOT filter or omit any comments, issues, or results.
- Format in a clean, readable way. Use markdown tables or bullet lists. Include URLs where available. Be concise.`;

        const formatMessages = [
            ...historyMessages,
            vscode.LanguageModelChatMessage.User(formatPrompt),
        ];

        const formatInTokens = await Promise.resolve(model.countTokens(formatPrompt, token)).catch(() => Math.round(formatPrompt.length / 4));
        const formatResponse = await model.sendRequest(formatMessages, {}, token);
        let formatText = '';
        for await (const part of formatResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                formatText += part.value;
                response.markdown(part.value);
            }
        }
        const formatOutTokens = await Promise.resolve(model.countTokens(formatText, token)).catch(() => Math.round(formatText.length / 4));
        log.info(`[format] Tokens: in=${formatInTokens} out=${formatOutTokens}`);

        // ── Token usage summary ──────────────────────────────────
        const queryIn = planInTokens + formatInTokens;
        const queryOut = planOutTokens + formatOutTokens;
        sessionTokensIn += queryIn;
        sessionTokensOut += queryOut;
        sessionRequests++;
        const queryTotal = queryIn + queryOut;
        const sessionTotal = sessionTokensIn + sessionTokensOut;
        log.info(`[usage] query=${queryTotal} (in=${queryIn} out=${queryOut}) | session=${sessionTotal} (in=${sessionTokensIn} out=${sessionTokensOut}) requests=${sessionRequests}`);
        response.markdown(`\n\n---\n*Tokens — this query: **${queryTotal.toLocaleString()}** (↑${queryIn.toLocaleString()} in / ↓${queryOut.toLocaleString()} out) · session total: **${sessionTotal.toLocaleString()}** across ${sessionRequests} request${sessionRequests === 1 ? '' : 's'}*`);

        return {};
      } catch (err: any) {
        log.error(`[handler] UNCAUGHT ERROR: ${err.message}\n${err.stack}`);
        response.markdown(`**Error:** ${err.message}\n\nCheck the **DevNexus** output channel for details.`);
        return {};
      }
    };

    const participant = vscode.chat.createChatParticipant('devnexus.nexus', handler);
    participant.iconPath = new vscode.ThemeIcon('tools');
    context.subscriptions.push(participant);
}

// ── Human-readable dry-run descriptions ──────────────────────────────────────

function describeDryRunStep(toolName: string, input: Record<string, any>): { title: string; details: string[] } {
    const f = input.fields || {};
    switch (toolName) {
        case 'devnexus_jira_transition':
            return { title: `Transition ${input.issueKey} → **${input.transitionName}**`, details: [`Issue: \`${input.issueKey}\``, `New status: **${input.transitionName}**`] };
        case 'devnexus_jira_update_fields': {
            const changes: string[] = [];
            if (f.originalEstimate) { changes.push(`Original estimate: \`${f.originalEstimate}\``); }
            if (f.remainingEstimate) { changes.push(`Remaining estimate: \`${f.remainingEstimate}\``); }
            if (f.dueDate) { changes.push(`Due date: \`${f.dueDate}\``); }
            if (f.startDate) { changes.push(`Start date: \`${f.startDate}\``); }
            if (f.forecastDate) { changes.push(`Forecast date: \`${f.forecastDate}\``); }
            if (f.summary) { changes.push(`Summary: "${f.summary}"`); }
            if (f.assignee) { changes.push(`Assignee: \`${f.assignee}\``); }
            if (f.labels) { changes.push(`Labels: ${f.labels.join(', ')}`); }
            if (f.priority) { changes.push(`Priority: ${f.priority}`); }
            return { title: `Update fields on ${input.issueKey}`, details: [`Issue: \`${input.issueKey}\``, ...changes] };
        }
        case 'devnexus_jira_log_work':
            return { title: `Log work on ${input.issueKey}`, details: [`Issue: \`${input.issueKey}\``, `Time to log: \`${input.timeSpent}\``, ...(input.started ? [`Started: ${input.started}`] : ['Started: now'])] };
        case 'devnexus_jira_add_comment':
            return { title: `Add comment to ${input.issueKey}`, details: [`Issue: \`${input.issueKey}\``, `Comment: "${input.body}"`] };
        case 'devnexus_jira_review_complete':
            return { title: `Review complete — post comment on originating ticket`, details: [`Review ticket: \`${input.issueKey}\``, `Will check for FMS_*_REVIEW label`, `If found: posts "Independent review complete" on the "relates to" linked issue`] };
        case 'devnexus_jira_create_subtask':
            return { title: `Create subtask under ${input.parentKey}`, details: [`Parent: \`${input.parentKey}\``, `Summary: "${input.summary}"`, ...(input.labels ? [`Labels: ${input.labels.join(', ')}`] : []), ...(input.assignee ? [`Assignee: ${input.assignee}`] : [])] };
        case 'devnexus_jira_create_issue':
            return { title: `Create ${input.issueType} in ${input.projectKey}`, details: [`Project: \`${input.projectKey}\``, `Type: ${input.issueType}`, `Summary: "${input.summary}"`, ...(input.assignee ? [`Assignee: ${input.assignee}`] : [])] };
        case 'devnexus_jira_assign':
            return { title: `Assign ${input.issueKey} to ${input.assignee}`, details: [`Issue: \`${input.issueKey}\``, `Assignee: \`${input.assignee}\``] };
        case 'devnexus_bb_list_repos':
            return { title: `Verify repo exists in project \`${input.project || ''}\``, details: [`Project: \`${input.project || ''}\``] };
        case 'devnexus_bb_get_branches':
            return {
                title: `Check branch \`${input.filter || '(all)'}\` in \`${input.project || ''}/${input.repo}\``,
                details: [
                    `Repo: \`${input.project || ''}/${input.repo}\``,
                    input.filter ? `Filter: \`${input.filter}\`` : 'No filter — listing all branches',
                ],
            };
        case 'devnexus_bb_create_branch':
            return { title: `Create branch in \`${input.project || ''}/${input.repo || ''}\``, details: [`New branch: \`${input.branchName}\``, `From: \`${input.startPoint || 'develop'}\``, `Repo: \`${input.project || ''}/${input.repo || ''}\``] };
        case 'devnexus_bb_create_pr':
            return { title: `Create PR: ${input.fromBranch} → ${input.toBranch || 'develop'}`, details: [`Title: "${input.title}"`, `From: \`${input.fromBranch}\``, `To: \`${input.toBranch || 'develop'}\``, ...(input.reviewers?.length ? [`Reviewers: ${input.reviewers.join(', ')}`] : [])] };
        case 'devnexus_jira_search':
            return { title: `Search Jira`, details: [`JQL: \`${input.jql}\``, `Max results: ${input.maxResults || 20}`] };
        default:
            return { title: toolName.replace('devnexus_', '').replace(/_/g, ' '), details: Object.entries(input).map(([k, v]) => `${k}: \`${JSON.stringify(v)}\``) };
    }
}

// ── Convert VS Code chat history to LM messages ──────────────────────────────

function buildHistoryMessages(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[]): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];
    for (const turn of history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response
                .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                .map(p => p.value.value)
                .join('');
            if (text) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
    }
    return messages;
}

// ── Prompt that asks the model to pick tools as JSON (no tool_use protocol) ──

function buildPlanPrompt(userRequest: string): string {
    const toolList = TOOL_SCHEMAS.map(t => {
        const schema = JSON.stringify(t.inputSchema, null, 2);
        return `- **${t.name}**: ${t.description}\n  Input schema: ${schema}`;
    }).join('\n\n');

    return `You are a JSON-only tool-calling API. You have access to the following tools.
Your ONLY job is to decide which tool(s) to call, then output a JSON array.

RULES:
1. Output ONLY valid JSON — a JSON array of objects.
2. Each object has "name" (tool name from the list below) and "arguments" (matching the schema).
3. Do NOT output any explanation, markdown, or text.
4. Do NOT say "I can't" or "the tool is not available" — the tools ARE available, you just need to pick one.
5. If the user asks to list/search issues, use devnexus_jira_search.
6. For "my tickets" or "assigned to me", use JQL: assignee = currentUser()
7. Default project comes from the user's configuration.
8. If the user asks to "mark PR as needs work", use devnexus_bb_needs_work.
9. If the user asks for both comment + needs-work, output two tool calls in order: devnexus_bb_add_comment then devnexus_bb_needs_work.
10. If user asks for a blocker comment, call devnexus_bb_add_comment with severity = "BLOCKER".
11. If user asks for a normal comment, call devnexus_bb_add_comment with severity = "NORMAL" (or omit severity).
12. For "list worklogs" / "show time logged", use devnexus_jira_list_worklogs.
13. For "clone issue" / "copy issue", use devnexus_jira_clone_issue.
14. For "changelog" / "history of changes", use devnexus_jira_get_changelog.
15. For "search users" / "find user" / "who is", use devnexus_jira_search_users.
16. For "list comments on ticket", use devnexus_jira_list_comments.
17. For "check if PR can merge" / "merge check" / "is PR mergeable", use devnexus_bb_check_merge.
18. For "commits in PR", use devnexus_bb_get_pr_commits.
19. For "compare branches", use devnexus_bb_compare.
20. For "tasks on PR" / "PR tasks", use devnexus_bb_list_tasks. For "create task on PR", use devnexus_bb_create_task.
21. For "build status" / "CI status", use devnexus_bb_get_build_status.
22. For "browse repo" / "list files in repo", use devnexus_bb_browse.
23. For "get file from repo" / "read file", use devnexus_bb_get_file.
24. For "list tags" / "show tags", use devnexus_bb_list_tags.
25. For "active sprint", call devnexus_jira_get_boards first (projectKey from configured default), then devnexus_jira_get_sprints with state=active.
26. For "delete branch", use devnexus_bb_delete_branch. For "delete tag", use devnexus_bb_delete_tag.

SHORTHAND SYNTAX: If the request matches /<number>/<ops>, parse as PROJ-<number> and emit tool calls in order:
  p        → devnexus_jira_transition { issueKey, transitionName: "In Progress" }
  re       → devnexus_jira_transition { issueKey, transitionName: "In Review" }
  rs       → devnexus_jira_transition { issueKey, transitionName: "Resolved" }
  df       → devnexus_jira_transition { issueKey, transitionName: "In Drafts" }
  et-X     → devnexus_jira_update_fields { issueKey, fields: { originalEstimate: "X" } }
  rt-X     → devnexus_jira_update_fields { issueKey, fields: { remainingEstimate: "X" } }
  lt-X     → devnexus_jira_log_work { issueKey, timeSpent: "X" }
  tf-DDMM  → devnexus_jira_update_fields { issueKey, fields: { forecastDate: "YYYY-MM-DD" } }
  ts-DDMM  → devnexus_jira_update_fields { issueKey, fields: { startDate: "YYYY-MM-DD" } }
  td-DDMM  → devnexus_jira_update_fields { issueKey, fields: { dueDate: "YYYY-MM-DD" } }
  c-cp     → devnexus_jira_review_complete { issueKey }
  c-"text" → devnexus_jira_add_comment { issueKey, body: "text" }
Date rule: DDMM → DD=day MM=month, use current year; if that date has already passed today use next year. Format as YYYY-MM-DD.

AVAILABLE TOOLS:
${toolList}

USER REQUEST: ${userRequest}

Output the JSON array now:`;
}

// ── Parse tool calls from model's plain text response ──

function parseToolCalls(text: string): { name: string; input: object }[] {
    const results: { name: string; input: object }[] = [];

    function addItem(item: any): void {
        if (item && item.name && item.arguments) {
            results.push({
                name: resolveToolName(item.name),
                input: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments,
            });
        }
    }

    // Strip markdown fences anywhere in the text
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    // Strip XML wrappers
    cleaned = cleaned.replace(/<\/?tool_call>/g, '').trim();

    // Strategy 1: Try parsing the whole thing as JSON
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) { parsed.forEach(addItem); }
        else { addItem(parsed); }
        if (results.length > 0) { return results; }
    } catch { /* not pure JSON — continue */ }

    // Strategy 2: Find the outermost [...] in the text (greedy)
    const arrayMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
        try {
            const arr = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arr)) { arr.forEach(addItem); }
            if (results.length > 0) { return results; }
        } catch { /* continue */ }
    }

    // Strategy 3: Find individual {...} objects with "name" inside
    const objectPattern = /\{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*"arguments"\s*:\s*\{[^}]*\}[^{}]*\}/g;
    let match;
    while ((match = objectPattern.exec(cleaned)) !== null) {
        try {
            addItem(JSON.parse(match[0]));
        } catch { /* skip malformed */ }
    }

    return results;
}

function resolveToolName(name: string): string {
    const map: Record<string, string> = {
        'search_jira_issues': 'devnexus_jira_search',
        'search_jira': 'devnexus_jira_search',
        'jira_search': 'devnexus_jira_search',
        'get_jira_issue': 'devnexus_jira_get_issue',
        'jira_get_issue': 'devnexus_jira_get_issue',
        'create_jira_subtask': 'devnexus_jira_create_subtask',
        'jira_create_subtask': 'devnexus_jira_create_subtask',
        'create_subtask': 'devnexus_jira_create_subtask',
        'create_jira_issue': 'devnexus_jira_create_issue',
        'jira_create_issue': 'devnexus_jira_create_issue',
        'transition_jira_issue': 'devnexus_jira_transition',
        'jira_transition': 'devnexus_jira_transition',
        'add_jira_comment': 'devnexus_jira_add_comment',
        'jira_add_comment': 'devnexus_jira_add_comment',
        'update_jira_fields': 'devnexus_jira_update_fields',
        'jira_update_fields': 'devnexus_jira_update_fields',
        'log_work': 'devnexus_jira_log_work',
        'log_jira_work': 'devnexus_jira_log_work',
        'jira_log_work': 'devnexus_jira_log_work',
        'link_jira_issues': 'devnexus_jira_link_issues',
        'jira_link_issues': 'devnexus_jira_link_issues',
        'list_jira_subtasks': 'devnexus_jira_list_subtasks',
        'jira_list_subtasks': 'devnexus_jira_list_subtasks',
        'assign_jira_issue': 'devnexus_jira_assign',
        'jira_assign': 'devnexus_jira_assign',
        'list_pull_requests': 'devnexus_bb_list_prs',
        'list_prs': 'devnexus_bb_list_prs',
        'bb_list_prs': 'devnexus_bb_list_prs',
        'get_pull_request': 'devnexus_bb_get_pr',
        'get_pr': 'devnexus_bb_get_pr',
        'bb_get_pr': 'devnexus_bb_get_pr',
        'create_pull_request': 'devnexus_bb_create_pr',
        'create_pr': 'devnexus_bb_create_pr',
        'bb_create_pr': 'devnexus_bb_create_pr',
        'merge_pull_request': 'devnexus_bb_merge_pr',
        'merge_pr': 'devnexus_bb_merge_pr',
        'bb_merge_pr': 'devnexus_bb_merge_pr',
        'get_pr_changes': 'devnexus_bb_get_changes',
        'bb_get_changes': 'devnexus_bb_get_changes',
        'get_pr_diff': 'devnexus_bb_get_diff',
        'bb_get_diff': 'devnexus_bb_get_diff',
        'add_pr_comment': 'devnexus_bb_add_comment',
        'bb_add_comment': 'devnexus_bb_add_comment',
        'list_pr_comments': 'devnexus_bb_list_comments',
        'bb_list_comments': 'devnexus_bb_list_comments',
        'get_pr_comments': 'devnexus_bb_list_comments',
        'add_pr_reviewer': 'devnexus_bb_add_reviewer',
        'bb_add_reviewer': 'devnexus_bb_add_reviewer',
        'remove_pr_reviewer': 'devnexus_bb_remove_reviewer',
        'bb_remove_reviewer': 'devnexus_bb_remove_reviewer',
        'approve_pr': 'devnexus_bb_approve_pr',
        'bb_approve_pr': 'devnexus_bb_approve_pr',
        'decline_pr': 'devnexus_bb_decline_pr',
        'bb_decline_pr': 'devnexus_bb_decline_pr',
        'mark_pr_needs_work': 'devnexus_bb_needs_work',
        'needs_work_pr': 'devnexus_bb_needs_work',
        'bb_needs_work': 'devnexus_bb_needs_work',
        'set_pr_needs_work': 'devnexus_bb_needs_work',
        'create_branch': 'devnexus_bb_create_branch',
        'bb_create_branch': 'devnexus_bb_create_branch',
        // Extended Jira aliases
        'delete_jira_issue': 'devnexus_jira_delete_issue',
        'jira_delete_issue': 'devnexus_jira_delete_issue',
        'clone_jira_issue': 'devnexus_jira_clone_issue',
        'jira_clone_issue': 'devnexus_jira_clone_issue',
        'copy_issue': 'devnexus_jira_clone_issue',
        'bulk_create_issues': 'devnexus_jira_bulk_create',
        'jira_bulk_create': 'devnexus_jira_bulk_create',
        'list_jira_comments': 'devnexus_jira_list_comments',
        'jira_list_comments': 'devnexus_jira_list_comments',
        'update_jira_comment': 'devnexus_jira_update_comment',
        'delete_jira_comment': 'devnexus_jira_delete_comment',
        'list_jira_worklogs': 'devnexus_jira_list_worklogs',
        'jira_list_worklogs': 'devnexus_jira_list_worklogs',
        'update_jira_worklog': 'devnexus_jira_update_worklog',
        'delete_jira_worklog': 'devnexus_jira_delete_worklog',
        'delete_jira_link': 'devnexus_jira_delete_link',
        'list_link_types': 'devnexus_jira_list_link_types',
        'get_watchers': 'devnexus_jira_get_watchers',
        'jira_get_watchers': 'devnexus_jira_get_watchers',
        'watch_issue': 'devnexus_jira_watch_issue',
        'unwatch_issue': 'devnexus_jira_unwatch_issue',
        'vote_issue': 'devnexus_jira_vote_issue',
        'list_projects': 'devnexus_jira_list_projects',
        'jira_list_projects': 'devnexus_jira_list_projects',
        'get_project_versions': 'devnexus_jira_get_project_versions',
        'get_project_components': 'devnexus_jira_get_project_components',
        'get_issue_types': 'devnexus_jira_get_issue_types',
        'get_priorities': 'devnexus_jira_get_priorities',
        'get_fields': 'devnexus_jira_get_fields',
        'get_changelog': 'devnexus_jira_get_changelog',
        'jira_get_changelog': 'devnexus_jira_get_changelog',
        'create_version': 'devnexus_jira_create_version',
        'update_version': 'devnexus_jira_update_version',
        'search_users': 'devnexus_jira_search_users',
        'jira_search_users': 'devnexus_jira_search_users',
        'get_user': 'devnexus_jira_get_user',
        'get_boards': 'devnexus_jira_get_boards',
        'jira_get_boards': 'devnexus_jira_get_boards',
        'get_sprints': 'devnexus_jira_get_sprints',
        'jira_get_sprints': 'devnexus_jira_get_sprints',
        'get_sprint_issues': 'devnexus_jira_get_sprint_issues',
        'move_to_sprint': 'devnexus_jira_move_to_sprint',
        'get_epics': 'devnexus_jira_get_epics',
        // Extended Bitbucket aliases
        'delete_branch': 'devnexus_bb_delete_branch',
        'bb_delete_branch': 'devnexus_bb_delete_branch',
        'get_default_branch': 'devnexus_bb_get_default_branch',
        'set_default_branch': 'devnexus_bb_set_default_branch',
        'update_pr': 'devnexus_bb_update_pr',
        'bb_update_pr': 'devnexus_bb_update_pr',
        'reopen_pr': 'devnexus_bb_reopen_pr',
        'bb_reopen_pr': 'devnexus_bb_reopen_pr',
        'get_pr_commits': 'devnexus_bb_get_pr_commits',
        'bb_get_pr_commits': 'devnexus_bb_get_pr_commits',
        'get_commits': 'devnexus_bb_get_commits',
        'bb_get_commits': 'devnexus_bb_get_commits',
        'get_commit': 'devnexus_bb_get_commit',
        'list_tasks': 'devnexus_bb_list_tasks',
        'bb_list_tasks': 'devnexus_bb_list_tasks',
        'create_task': 'devnexus_bb_create_task',
        'bb_create_task': 'devnexus_bb_create_task',
        'resolve_task': 'devnexus_bb_resolve_task',
        'delete_task': 'devnexus_bb_delete_task',
        'update_pr_comment': 'devnexus_bb_update_comment',
        'bb_update_comment': 'devnexus_bb_update_comment',
        'delete_pr_comment': 'devnexus_bb_delete_comment',
        'bb_delete_comment': 'devnexus_bb_delete_comment',
        'reply_to_comment': 'devnexus_bb_reply_to_comment',
        'bb_reply_to_comment': 'devnexus_bb_reply_to_comment',
        'get_file': 'devnexus_bb_get_file',
        'bb_get_file': 'devnexus_bb_get_file',
        'browse_repo': 'devnexus_bb_browse',
        'bb_browse': 'devnexus_bb_browse',
        'compare_branches': 'devnexus_bb_compare',
        'bb_compare': 'devnexus_bb_compare',
        'list_tags': 'devnexus_bb_list_tags',
        'bb_list_tags': 'devnexus_bb_list_tags',
        'create_tag': 'devnexus_bb_create_tag',
        'delete_tag': 'devnexus_bb_delete_tag',
        'get_build_status': 'devnexus_bb_get_build_status',
        'set_build_status': 'devnexus_bb_set_build_status',
        'check_merge': 'devnexus_bb_check_merge',
        'bb_check_merge': 'devnexus_bb_check_merge',
    };
    if (name.startsWith('devnexus_')) { return name; }
    return map[name] || `devnexus_${name}`;
}
