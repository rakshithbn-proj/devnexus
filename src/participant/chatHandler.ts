import * as vscode from 'vscode';
import { invokeToolDirect } from '../tools/toolRegistry';
import { AuthManager } from '../auth/authManager';


function buildSystemPrompt(): string {
    const jiraConfig = vscode.workspace.getConfiguration('devnexus.jira');
    const bbConfig = vscode.workspace.getConfiguration('devnexus.bitbucket');
    const jiraUrl = jiraConfig.get<string>('baseUrl', '');
    const defaultProject = jiraConfig.get<string>('defaultProject', '');
    const bbUrl = bbConfig.get<string>('baseUrl', '');
    const bbProject = bbConfig.get<string>('project', '');
    const bbRepo = bbConfig.get<string>('repo', '');
    const projectLine = defaultProject
        ? `- Default Jira project: ${defaultProject}`
        : '- Default Jira project: not set — ask the user for the project key if needed';
    const endpointsLine = (jiraUrl || bbUrl)
        ? `- Configured endpoints: Jira: ${jiraUrl || '(not set)'} | Bitbucket: ${bbUrl || '(not set)'}${bbProject ? ` (project ${bbProject}` : ''}${bbRepo ? `, repo ${bbRepo}` : ''}${(bbProject || bbRepo) ? ')' : ''}`
        : '- Endpoints: not yet configured';
    return `You are DevNexus, a DevOps assistant. You execute Jira and Bitbucket operations using the tools provided.

IMPORTANT: You MUST use the tools to fulfill requests. Never output raw JSON or pseudo-tool-calls as text.

Key conventions:
${projectLine}
${endpointsLine}
- "assign to me" / "assign to myself" → assignee = "self"
- Creating subtasks: inherit fix versions from parent if not specified
- Cross-tool: fetch PR changes first, then create subtask referencing changed files
- Logging work: use devnexus_jira_log_work for any request to "log hours", "log work", "record time spent"
- Setting time estimates: use devnexus_jira_update_fields with originalEstimate / remainingEstimate fields
- "start the progress" → transition to "In Progress"; "mark it resolved" / "resolve" / "mark as resolved" → transition to "Resolved" (NOT "Done")
- Workflow sequences: execute all steps (transition, update fields, log work, add comment) without asking for confirmation

Be concise. Show created issue keys, URLs, and key fields.`;
}

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
                projectKey: { type: 'string', description: 'Project key, e.g. YOUR-PROJECT' },
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
                labels: { type: 'array', items: { type: 'string' }, description: 'Labels (e.g. my-label)' },
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
                jql: { type: 'string', description: 'JQL query, e.g. "project = YOUR-PROJECT AND assignee = currentUser() AND status != Done"' },
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
        description: 'Update fields on a Jira issue (summary, description, labels, fixVersions, assignee, priority, originalEstimate, remainingEstimate).',
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
                        remainingEstimate: { type: 'string', description: 'Remaining time estimate, e.g. "2h", "30m"' }
                    }
                }
            },
            required: ['issueKey', 'fields']
        }
    },
    {
        name: 'devnexus_jira_log_work',
        description: 'Log time spent working on a Jira issue (adds a worklog entry). Use this whenever the user says to log hours, log work, or record time.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'Issue key, e.g. PROJ-123' },
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
        description: 'Get full details of a pull request.',
        inputSchema: {
            type: 'object',
            properties: {
                prId: { type: 'number', description: 'Pull request ID' }
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
                reviewers: { type: 'array', items: { type: 'string' }, description: 'Reviewer usernames' }
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
                prId: { type: 'number', description: 'Pull request ID' }
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
                prId: { type: 'number', description: 'Pull request ID' }
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
                contextLines: { type: 'number', description: 'Context lines (default 5)' }
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
                severity: { type: 'string', enum: ['NORMAL', 'BLOCKER'], description: 'Comment severity (use BLOCKER for blocking comments)' }
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
                prId: { type: 'number', description: 'Pull request ID' }
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
                username: { type: 'string', description: 'Reviewer username' }
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
                username: { type: 'string', description: 'Username to remove' }
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
                prId: { type: 'number', description: 'Pull request ID' }
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
                prId: { type: 'number', description: 'Pull request ID' }
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
                prId: { type: 'number', description: 'Pull request ID' }
            },
            required: ['prId']
        }
    },
    {
        name: 'devnexus_bb_create_branch',
        description: 'Create a new branch in the repo.',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string', description: 'New branch name' },
                startPoint: { type: 'string', description: 'Base branch (default develop)' }
            },
            required: ['branchName']
        }
    },
];

const log = vscode.window.createOutputChannel('DevNexus', { log: true });

export function registerChatParticipant(context: vscode.ExtensionContext, auth?: AuthManager): void {
    context.subscriptions.push(log);
    log.info('[init] DevNexus chat participant registered');

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      try {
        log.info(`[request] "${request.prompt}"`);

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
        const planPrompt = buildPlanPrompt(request.prompt);
        const planMessages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(planPrompt),
        ];

        response.progress('Thinking...');
        log.info(`[plan] Sending plan prompt (${planPrompt.length} chars)`);
        const planResponse = await model.sendRequest(planMessages, {}, token);
        let planText = '';
        for await (const part of planResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                planText += part.value;
            }
        }
        log.info(`[plan] Raw model response: ${planText.substring(0, 500)}`);

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
            vscode.LanguageModelChatMessage.User(formatPrompt),
        ];

        const formatResponse = await model.sendRequest(formatMessages, {}, token);
        for await (const part of formatResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                response.markdown(part.value);
            }
        }

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

// ── Prompt that asks the model to pick tools as JSON (no tool_use protocol) ──

function buildPlanPrompt(userRequest: string): string {
    const defaultProject = vscode.workspace.getConfiguration('devnexus.jira').get<string>('defaultProject', '');
    const projectRule = defaultProject
        ? `7. Default project is ${defaultProject}.`
        : `7. If the user mentions a project, use that key. Otherwise ask them.`;
    const toolList = TOOL_SCHEMAS.map(t => {
        const schema = JSON.stringify(t.inputSchema, null, 2);
        return `- **${t.name}**: ${t.description}\n  Input schema: ${schema}`;
    }).join('\n\n');

    return `${buildSystemPrompt()}

You are a JSON-only tool-calling API. You have access to the following tools.
Your ONLY job is to decide which tool(s) to call, then output a JSON array.

RULES:
1. Output ONLY valid JSON — a JSON array of objects.
2. Each object has "name" (tool name from the list below) and "arguments" (matching the schema).
3. Do NOT output any explanation, markdown, or text.
4. Do NOT say "I can't" or "the tool is not available" — the tools ARE available, you just need to pick one.
5. If the user asks to list/search issues, use devnexus_jira_search.
6. For "my tickets" or "assigned to me", use JQL: assignee = currentUser()
${projectRule}
8. If the user asks to "mark PR as needs work", use devnexus_bb_needs_work.
9. If the user asks for both comment + needs-work, output two tool calls in order: devnexus_bb_add_comment then devnexus_bb_needs_work.
10. If user asks for a blocker comment, call devnexus_bb_add_comment with severity = "BLOCKER".
11. If user asks for a normal comment, call devnexus_bb_add_comment with severity = "NORMAL" (or omit severity).

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
    };
        if (name.startsWith('devnexus_')) { return name; }
    if (name.startsWith('devops_')) { return name.replace('devops_', 'devnexus_'); }
    return map[name] || `devnexus_${name}`;
}
