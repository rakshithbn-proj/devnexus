import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BitbucketClient } from '../api/bitbucketClient';
import { ok } from './toolHelpers';

type Srv = InstanceType<typeof McpServer>;

export function registerBbTools(server: Srv, client: BitbucketClient): void {

    // ── List PRs ─────────────────────────────────────────────────
    server.tool('devnexus_bb_list_prs', 'List pull requests. Filter by state and role.',
        {
            state: z.enum(['OPEN', 'MERGED', 'DECLINED']).optional().describe('PR state (default OPEN)'),
            filter: z.enum(['all', 'mine', 'reviewing']).optional().describe('Role filter (default all)'),
            limit: z.number().optional().describe('Max results (default 25)'),
        },
        async ({ state, filter, limit }) => {
            let prs;
            if (filter === 'mine') {
                prs = await client.getMyPRs(limit || 25);
            } else if (filter === 'reviewing') {
                prs = await client.getPRsToReview(limit || 25);
            } else {
                prs = await client.listPRs(state || 'OPEN', limit || 25);
            }
            if (prs.length === 0) { return ok('No pull requests found.'); }
            const lines = prs.map((pr: any) => {
                const reviewers = pr.reviewers.map((r: any) => `${r.user.displayName} (${r.status})`).join(', ') || 'none';
                const repoLabel = pr.repository ? ` [${pr.repository.project?.key ?? ''}/${pr.repository.slug}]` : '';
                return `- **PR #${pr.id}**${repoLabel} — ${pr.title} [${pr.state}]\n  ${pr.fromRef.displayId} → ${pr.toRef.displayId} | Author: ${pr.author.user.displayName} | Reviewers: ${reviewers}`;
            });
            return ok(`Pull Requests (${prs.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Get PR ────────────────────────────────────────────────────
    server.tool('devnexus_bb_get_pr', 'Get full details of a pull request.',
        {
            prId: z.number().describe('Pull request ID'),
            repo: z.string().optional().describe('Repo slug (defaults to configured repo)'),
            project: z.string().optional().describe('Project key (default project)'),
        },
        async ({ prId, repo, project }) => {
            const pr = await client.getPR(prId, repo, project);
            const reviewers = pr.reviewers.map((r: any) => `${r.user.displayName} (${r.status})`).join(', ') || 'none';
            return ok([
                `**PR #${pr.id}** — ${pr.title}`,
                `State: ${pr.state}`,
                `Branch: ${pr.fromRef.displayId} → ${pr.toRef.displayId}`,
                `Author: ${pr.author.user.displayName}`,
                `Reviewers: ${reviewers}`,
                `Description: ${pr.description || '(none)'}`,
                `URL: ${client.getPRUrl(pr.id, repo, project)}`,
            ].join('\n'));
        }
    );

    // ── Create PR ─────────────────────────────────────────────────
    server.tool('devnexus_bb_create_pr', 'Create a pull request from source to target branch.',
        {
            title: z.string().describe('PR title'),
            description: z.string().optional().describe('PR description'),
            fromBranch: z.string().describe('Source branch'),
            toBranch: z.string().optional().describe('Target branch (default develop)'),
            reviewers: z.array(z.string()).optional().describe('Reviewer usernames'),
            repo: z.string().optional().describe('Repo slug (defaults to configured repo)'),
            project: z.string().optional().describe('Project key (default project)'),
        },
        async (input) => {
            const pr = await client.createPR(input);
            const reviewerNames = pr.reviewers.map((r: any) => r.user.displayName).join(', ') || 'none';
            return ok(`Created **PR #${pr.id}** — "${pr.title}"\n${pr.fromRef.displayId} → ${pr.toRef.displayId} | Reviewers: ${reviewerNames}\nURL: ${client.getPRUrl(pr.id, input.repo, input.project)}`);
        }
    );

    // ── Merge PR ──────────────────────────────────────────────────
    server.tool('devnexus_bb_merge_pr', 'Merge a pull request.',
        {
            prId: z.number().describe('Pull request ID'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, repo, project }) => {
            const pr = await client.mergePR(prId, repo, project);
            return ok(`Merged **PR #${prId}** — "${pr.title}"`);
        }
    );

    // ── Get Changes ───────────────────────────────────────────────
    server.tool('devnexus_bb_get_changes', 'List changed files in a PR with change type (ADD/MODIFY/DELETE).',
        {
            prId: z.number().describe('Pull request ID'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, repo, project }) => {
            const changes = await client.getChanges(prId, repo, project);
            const lines = changes.map((c: any) => `- \`${c.type}\` ${c.path.toString}`);
            return ok(`Changed files in PR #${prId} (${changes.length}):\n${lines.join('\n')}`);
        }
    );

    // ── Get Diff ──────────────────────────────────────────────────
    server.tool('devnexus_bb_get_diff', 'Get diff of a specific file in a PR.',
        {
            prId: z.number().describe('Pull request ID'),
            filePath: z.string().describe('File path in repo'),
            contextLines: z.number().optional().describe('Context lines (default 5)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, filePath, contextLines, repo, project }) => {
            const diff = await client.getDiff(prId, filePath, contextLines || 5, repo, project);
            return ok(`Diff for \`${filePath}\` in PR #${prId}:\n\`\`\`diff\n${diff}\n\`\`\``);
        }
    );

    // ── List Comments ─────────────────────────────────────────────
    server.tool('devnexus_bb_list_comments', 'List all comments on a pull request.',
        {
            prId: z.number().describe('Pull request ID'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, repo, project }) => {
            const comments = await client.getComments(prId, repo, project);
            if (comments.length === 0) { return ok(`No comments found on PR #${prId}.`); }
            const lines = comments.map((c: any) => {
                const date = new Date(c.createdDate).toISOString().replace('T', ' ').substring(0, 16);
                const indent = c.depth ? '  '.repeat(c.depth) + '↳ ' : '';
                return `${indent}- **${c.author.displayName}** ${date}: ${c.text}`;
            });
            return ok(`All comments on PR #${prId} (${comments.length}):\n\n${lines.join('\n\n')}`);
        }
    );

    // ── Add Comment ───────────────────────────────────────────────
    server.tool('devnexus_bb_add_comment', 'Add a general or inline comment on a PR.',
        {
            prId: z.number().describe('Pull request ID'),
            text: z.string().describe('Comment text'),
            filePath: z.string().optional().describe('File path for inline comment'),
            line: z.number().optional().describe('Line number for inline comment'),
            lineType: z.enum(['ADDED', 'REMOVED', 'CONTEXT']).optional(),
            severity: z.enum(['NORMAL', 'BLOCKER']).optional(),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, text, filePath, line, lineType, severity, repo, project }) => {
            const anchor = filePath && line ? { path: filePath, line, lineType } : undefined;
            await client.addComment(prId, text, anchor, severity, repo, project);
            const location = anchor ? ` on ${anchor.path}:${anchor.line}` : '';
            return ok(`Comment posted on PR #${prId}${location}${severity === 'BLOCKER' ? ' as BLOCKER' : ''}`);
        }
    );

    // ── Add / Remove Reviewer ─────────────────────────────────────
    server.tool('devnexus_bb_add_reviewer', 'Add a reviewer to a pull request.',
        {
            prId: z.number().describe('Pull request ID'),
            username: z.string().describe('Reviewer username'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, username, repo, project }) => {
            await client.addReviewer(prId, username, repo, project);
            return ok(`Added ${username} as reviewer on PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_remove_reviewer', 'Remove a reviewer from a pull request.',
        {
            prId: z.number().describe('Pull request ID'),
            username: z.string().describe('Reviewer username to remove'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, username, repo, project }) => {
            await client.removeReviewer(prId, username, repo, project);
            return ok(`Removed ${username} from PR #${prId}`);
        }
    );

    // ── Approve / Decline / Needs Work ───────────────────────────
    server.tool('devnexus_bb_approve_pr', 'Approve a pull request.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            await client.approvePR(prId, repo, project);
            return ok(`Approved PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_decline_pr', 'Decline a pull request.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            await client.declinePR(prId, repo, project);
            return ok(`Declined PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_needs_work', 'Mark a pull request as needs work.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            await client.needsWorkPR(prId, repo, project);
            return ok(`Marked PR #${prId} as needs work`);
        }
    );

    // ── Branches ──────────────────────────────────────────────────
    server.tool('devnexus_bb_list_repos', 'List all repositories in a Bitbucket project.',
        { project: z.string().optional().describe('Bitbucket project key') },
        async ({ project }) => {
            const repos = await client.listRepos(project);
            if (repos.length === 0) { return ok(`No repos found.`); }
            const lines = repos.map((r: any) => `- \`${r.slug}\` — ${r.name}`);
            return ok(`Repos (${repos.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_get_branches', 'List branches in a Bitbucket repo.',
        {
            repo: z.string().describe('Repo slug'),
            project: z.string().optional().describe('Bitbucket project key'),
            filter: z.string().optional().describe('Filter branches by name (partial match)'),
        },
        async ({ repo, project, filter }) => {
            const branches = await client.getBranches(repo, project, filter);
            if (branches.length === 0) { return ok(`No branches found.`); }
            return ok(`Branches in **${project || ''}/${repo}** (${branches.length}):\n${branches.map((b: any) => `- \`${b.displayId}\``).join('\n')}`);
        }
    );

    server.tool('devnexus_bb_create_branch', 'Create a new branch in the repository.',
        {
            branchName: z.string().describe('New branch name'),
            startPoint: z.string().optional().describe('Base branch or commit (default "develop")'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ branchName, startPoint, repo, project }) => {
            const result = await client.createBranch(branchName, startPoint || 'develop', repo, project);
            return ok(`Created branch \`${result.displayId}\` from \`${startPoint || 'develop'}\``);
        }
    );

    server.tool('devnexus_bb_delete_branch', 'Delete a branch from a Bitbucket repository.',
        {
            branchName: z.string().describe('Branch name to delete'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ branchName, repo, project }) => {
            await client.deleteBranch(branchName, repo, project);
            return ok(`Deleted branch \`${branchName}\``);
        }
    );

    server.tool('devnexus_bb_get_default_branch', 'Get the default branch of the repository.',
        { repo: z.string().optional(), project: z.string().optional() },
        async ({ repo, project }) => {
            const branch = await client.getDefaultBranch(repo, project);
            return ok(`Default branch: \`${branch.displayId}\` (latest commit: ${branch.latestCommit?.substring(0, 8)})`);
        }
    );

    server.tool('devnexus_bb_set_default_branch', 'Set the default branch of the repository.',
        {
            branchName: z.string().describe('Branch name to set as default'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ branchName, repo, project }) => {
            await client.setDefaultBranch(branchName, repo, project);
            return ok(`Default branch set to \`${branchName}\``);
        }
    );

    // ── PR Lifecycle ──────────────────────────────────────────────
    server.tool('devnexus_bb_update_pr', 'Update a pull request title, description, or target branch.',
        {
            prId: z.number().describe('Pull request ID'),
            title: z.string().optional(),
            description: z.string().optional(),
            targetBranch: z.string().optional(),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, title, description, targetBranch, repo, project }) => {
            const pr = await client.updatePR(prId, { title, description, targetBranch }, repo, project);
            return ok(`Updated **PR #${pr.id}** — "${pr.title}"`);
        }
    );

    server.tool('devnexus_bb_reopen_pr', 'Reopen a declined pull request.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            const pr = await client.reopenPR(prId, repo, project);
            return ok(`Reopened **PR #${pr.id}** — "${pr.title}"`);
        }
    );

    server.tool('devnexus_bb_check_merge', 'Check whether a pull request is mergeable.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            const result = await client.checkMerge(prId, repo, project);
            if (result.canMerge) { return ok(`PR #${prId} **can be merged** ✅`); }
            const vetoes = result.vetoes.map((v: any) => `- **${v.summaryMessage}**: ${v.detailedMessage}`).join('\n');
            return ok(`PR #${prId} **cannot be merged** ❌\n\nBlocking reasons:\n${vetoes}`);
        }
    );

    // ── Commits ───────────────────────────────────────────────────
    server.tool('devnexus_bb_get_pr_commits', 'List all commits included in a pull request.',
        {
            prId: z.number(),
            limit: z.number().optional().describe('Max results (default 100)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, limit, repo, project }) => {
            const commits = await client.getPRCommits(prId, limit || 100, repo, project);
            if (!commits.length) { return ok(`No commits in PR #${prId}.`); }
            const lines = commits.map((c: any) => {
                const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
                return `- \`${c.displayId}\` [${date}] **${c.author.name}**: ${c.message.split('\n')[0].substring(0, 80)}`;
            });
            return ok(`Commits in PR #${prId} (${commits.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_get_commits', 'Get commit history for a branch or file path.',
        {
            until: z.string().optional().describe('Branch name'),
            limit: z.number().optional().describe('Max results (default 25)'),
            path: z.string().optional().describe('Filter commits touching a specific file path'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ until, limit, path, repo, project }) => {
            const commits = await client.getCommits(until, limit || 25, path, repo, project);
            if (!commits.length) { return ok('No commits found.'); }
            const lines = commits.map((c: any) => {
                const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
                return `- \`${c.displayId}\` [${date}] **${c.author.name}**: ${c.message.split('\n')[0].substring(0, 80)}`;
            });
            return ok(`Commits (${commits.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_get_commit', 'Get details of a single commit by its SHA.',
        {
            commitId: z.string().describe('Full or abbreviated commit SHA'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ commitId, repo, project }) => {
            const c = await client.getCommit(commitId, repo, project);
            const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
            return ok([
                `Commit \`${c.displayId}\``,
                `Author: **${c.author.name}** <${c.author.emailAddress}>`,
                `Date: ${date}`,
                `Message:\n${c.message}`,
            ].join('\n'));
        }
    );

    // ── Tasks ─────────────────────────────────────────────────────
    server.tool('devnexus_bb_list_tasks', 'List all tasks (to-do items) on a pull request.',
        { prId: z.number(), repo: z.string().optional(), project: z.string().optional() },
        async ({ prId, repo, project }) => {
            const tasks = await client.listTasks(prId, repo, project);
            if (!tasks.length) { return ok(`No tasks on PR #${prId}.`); }
            const lines = tasks.map((t: any) => {
                const state = t.state === 'RESOLVED' ? '✓' : '○';
                return `${state} **#${t.id}** (${t.state}) by ${t.author.displayName}: ${t.text}`;
            });
            return ok(`Tasks on PR #${prId} (${tasks.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_create_task', 'Create a task (to-do item) on a pull request.',
        {
            prId: z.number(),
            text: z.string().describe('Task text/description'),
            commentId: z.number().optional().describe('Anchor the task to a specific comment ID'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, text, commentId, repo, project }) => {
            const task = await client.createTask(prId, text, commentId, repo, project);
            return ok(`Created task **#${task.id}** on PR #${prId}: "${text}"`);
        }
    );

    server.tool('devnexus_bb_resolve_task', 'Mark a pull request task as resolved.',
        {
            prId: z.number().describe('Pull request ID (needed to fetch task version)'),
            taskId: z.number().describe('Task ID (from list_tasks)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, taskId, repo, project }) => {
            const tasks = await client.listTasks(prId, repo, project);
            const task = tasks.find((t: any) => t.id === taskId);
            if (!task) { return ok(`Task #${taskId} not found on PR #${prId}.`); }
            await client.resolveTask(taskId, task.version);
            return ok(`Resolved task **#${taskId}** on PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_delete_task', 'Delete a task from a pull request.',
        {
            prId: z.number(),
            taskId: z.number().describe('Task ID to delete'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, taskId, repo, project }) => {
            const tasks = await client.listTasks(prId, repo, project);
            const task = tasks.find((t: any) => t.id === taskId);
            if (!task) { return ok(`Task #${taskId} not found on PR #${prId}.`); }
            await client.deleteTask(taskId, task.version);
            return ok(`Deleted task **#${taskId}** from PR #${prId}`);
        }
    );

    // ── Comment CRUD ──────────────────────────────────────────────
    server.tool('devnexus_bb_update_comment', 'Update the text of an existing comment on a pull request.',
        {
            prId: z.number(),
            commentId: z.number().describe('Comment ID to update'),
            text: z.string().describe('New comment text'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, commentId, text, repo, project }) => {
            const comments = await client.getComments(prId, repo, project);
            const comment = comments.find((c: any) => c.id === commentId);
            const version = comment?.version ?? 0;
            await client.updateComment(prId, commentId, text, version, repo, project);
            return ok(`Updated comment #${commentId} on PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_delete_comment', 'Delete a comment from a pull request.',
        {
            prId: z.number(),
            commentId: z.number().describe('Comment ID to delete'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, commentId, repo, project }) => {
            const comments = await client.getComments(prId, repo, project);
            const comment = comments.find((c: any) => c.id === commentId);
            const version = comment?.version ?? 0;
            await client.deleteComment(prId, commentId, version, repo, project);
            return ok(`Deleted comment #${commentId} from PR #${prId}`);
        }
    );

    server.tool('devnexus_bb_reply_to_comment', 'Reply to an existing comment on a pull request.',
        {
            prId: z.number(),
            parentCommentId: z.number().describe('Parent comment ID to reply to'),
            text: z.string().describe('Reply text'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ prId, parentCommentId, text, repo, project }) => {
            const comment = await client.replyToComment(prId, parentCommentId, text, repo, project);
            return ok(`Posted reply #${comment.id} to comment #${parentCommentId} on PR #${prId}`);
        }
    );

    // ── File Browsing ─────────────────────────────────────────────
    server.tool('devnexus_bb_get_file', 'Get the raw content of a file from the repository.',
        {
            path: z.string().describe('File path within the repo, e.g. "src/main.py"'),
            branch: z.string().optional().describe('Branch name (default: repo default branch)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ path, branch, repo, project }) => {
            const content = await client.getFile(path, branch, repo, project);
            const lines = content.split('\n').length;
            const preview = content.length > 4000 ? content.substring(0, 4000) + '\n... (truncated)' : content;
            return ok(`File \`${path}\`${branch ? ` @ ${branch}` : ''} (${lines} lines):\n\`\`\`\n${preview}\n\`\`\``);
        }
    );

    server.tool('devnexus_bb_browse', 'Browse the file tree of a repository at a specific path and branch.',
        {
            path: z.string().optional().describe('Directory path to browse (omit for root)'),
            branch: z.string().optional(),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ path, branch, repo, project }) => {
            const items = await client.browse(path || '', branch, repo, project);
            if (!items.length) { return ok(`No files found at \`${path || '/'}\`.`); }
            const dirs = items.filter((i: any) => i.type === 'DIRECTORY').map((i: any) => `📁 ${i.name}/`);
            const files = items.filter((i: any) => i.type !== 'DIRECTORY').map((i: any) => `📄 ${i.name}`);
            return ok(`Contents of \`${path || '/'}\`${branch ? ` @ ${branch}` : ''} (${items.length} items):\n${[...dirs, ...files].join('\n')}`);
        }
    );

    server.tool('devnexus_bb_compare', 'Compare two branches — shows commits and file changes between them.',
        {
            from: z.string().describe('Source branch name'),
            to: z.string().describe('Target branch name'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ from, to, repo, project }) => {
            const { changes, commits } = await client.compare(from, to, repo, project);
            const changeLines = changes.slice(0, 50).map((c: any) => `- \`${c.type}\` ${c.path.toString}`);
            const commitLines = commits.slice(0, 20).map((c: any) => `- \`${c.displayId}\` ${c.message.split('\n')[0].substring(0, 70)}`);
            return ok(`Comparing \`${from}\` → \`${to}\`:\n\n**${commits.length} commit(s):**\n${commitLines.join('\n')}\n\n**${changes.length} file change(s):**\n${changeLines.join('\n')}`);
        }
    );

    // ── Tags ──────────────────────────────────────────────────────
    server.tool('devnexus_bb_list_tags', 'List all tags in the repository.',
        {
            filter: z.string().optional().describe('Filter tags by name (partial match)'),
            limit: z.number().optional().describe('Max results (default 100)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ filter, limit, repo, project }) => {
            const tags = await client.listTags(filter, limit || 100, repo, project);
            if (!tags.length) { return ok('No tags found.'); }
            const lines = tags.map((t: any) => `- \`${t.displayId}\` (${t.latestCommit?.substring(0, 8)})`);
            return ok(`Tags (${tags.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_create_tag', 'Create a new tag pointing to a commit.',
        {
            name: z.string().describe('Tag name'),
            commitId: z.string().describe('Commit SHA to tag'),
            message: z.string().optional().describe('Annotated tag message (optional)'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ name, commitId, message, repo, project }) => {
            const tag = await client.createTag(name, commitId, message, repo, project);
            return ok(`Created tag \`${tag.displayId}\` at commit ${commitId.substring(0, 8)}`);
        }
    );

    server.tool('devnexus_bb_delete_tag', 'Delete a tag from the repository.',
        {
            name: z.string().describe('Tag name to delete'),
            repo: z.string().optional(),
            project: z.string().optional(),
        },
        async ({ name, repo, project }) => {
            await client.deleteTag(name, repo, project);
            return ok(`Deleted tag \`${name}\``);
        }
    );

    // ── Build Status ──────────────────────────────────────────────
    server.tool('devnexus_bb_get_build_status', 'Get CI/CD build statuses reported for a specific commit.',
        { commitId: z.string().describe('Full commit SHA') },
        async ({ commitId }) => {
            const statuses = await client.getBuildStatus(commitId);
            if (!statuses.length) { return ok(`No build statuses for commit ${commitId.substring(0, 8)}.`); }
            const lines = statuses.map((s: any) => {
                const icon = s.state === 'SUCCESSFUL' ? '✅' : s.state === 'FAILED' ? '❌' : '🔄';
                return `${icon} **${s.key}**: ${s.state}${s.description ? ` — ${s.description}` : ''}`;
            });
            return ok(`Build status for \`${commitId.substring(0, 8)}\` (${statuses.length}):\n${lines.join('\n')}`);
        }
    );

    server.tool('devnexus_bb_set_build_status', 'Report a CI/CD build status for a commit.',
        {
            commitId: z.string().describe('Full commit SHA'),
            state: z.enum(['SUCCESSFUL', 'FAILED', 'INPROGRESS']).describe('Build state'),
            key: z.string().describe('Unique key for this build, e.g. "ci-pipeline"'),
            url: z.string().describe('URL to the build details page'),
            name: z.string().optional().describe('Human-readable build name'),
            description: z.string().optional().describe('Build status description'),
        },
        async ({ commitId, ...params }) => {
            await client.setBuildStatus(commitId, params);
            return ok(`Set build status \`${params.state}\` for key "${params.key}" on commit ${commitId.substring(0, 8)}`);
        }
    );
}
