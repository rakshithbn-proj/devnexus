import * as vscode from 'vscode';
import { BitbucketClient } from '../api/bitbucketClient';
import { registerToolHandler } from './toolRegistry';

export function registerBitbucketTools(context: vscode.ExtensionContext, getClient: () => Promise<BitbucketClient | undefined>): void {

    function reg<T>(name: string, fn: (input: T) => Promise<string>): void {
        registerToolHandler(name, (input, _token) => fn(input as T));
        context.subscriptions.push(vscode.lm.registerTool(name, {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<T>, _token) {
                const text = await fn(options.input);
                return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
            }
        }));
    }

    // ── List PRs ────────────────────────────────────────────────
    reg<{ state?: string; filter?: string; limit?: number }>('devnexus_bb_list_prs', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured. Run "DevNexus: Set Bitbucket Token" first.'; }
        let prs;
        if (input.filter === 'mine') {
            prs = await client.getMyPRs(input.limit || 25);
        } else if (input.filter === 'reviewing') {
            prs = await client.getPRsToReview(input.limit || 25);
        } else {
            prs = await client.listPRs(input.state || 'OPEN', input.limit || 25);
        }
        if (prs.length === 0) { return 'No pull requests found.'; }
        const lines = prs.map((pr: any) => {
            const reviewers = pr.reviewers.map((r: any) => `${r.user.displayName} (${r.status})`).join(', ') || 'none';
            const repoLabel = pr.repository ? ` [${pr.repository.project?.key ?? ''}/${pr.repository.slug}]` : '';
            return `- **PR #${pr.id}**${repoLabel} — ${pr.title} [${pr.state}]\n  ${pr.fromRef.displayId} → ${pr.toRef.displayId} | Author: ${pr.author.user.displayName} | Reviewers: ${reviewers}`;
        });
        return `Pull Requests (${prs.length}):\n${lines.join('\n')}`;
    });

    // ── Get PR ──────────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_get_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.getPR(input.prId, input.repo, input.project);
        const reviewers = pr.reviewers.map((r: any) => `${r.user.displayName} (${r.status})`).join(', ') || 'none';
        return [
            `**PR #${pr.id}** — ${pr.title}`,
            `State: ${pr.state}`,
            `Branch: ${pr.fromRef.displayId} → ${pr.toRef.displayId}`,
            `Author: ${pr.author.user.displayName}`,
            `Reviewers: ${reviewers}`,
            `Description: ${pr.description || '(none)'}`,
            `URL: ${client.getPRUrl(pr.id, input.repo, input.project)}`,
        ].join('\n');
    });

    // ── Create PR ───────────────────────────────────────────────
    reg<{ title: string; description?: string; fromBranch: string; toBranch?: string; reviewers?: string[]; repo?: string; project?: string }>('devnexus_bb_create_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.createPR(input);
        const reviewerNames = pr.reviewers.map((r: any) => r.user.displayName).join(', ') || 'none';
        return `Created **PR #${pr.id}** — "${pr.title}"\n${pr.fromRef.displayId} → ${pr.toRef.displayId} | Reviewers: ${reviewerNames}\nURL: ${client.getPRUrl(pr.id, input.repo, input.project)}`;
    });

    // ── Merge PR ────────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_merge_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.mergePR(input.prId, input.repo, input.project);
        return `Merged **PR #${input.prId}** — "${pr.title}"`;
    });

    // ── Get Changes ─────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_get_changes', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const changes = await client.getChanges(input.prId, input.repo, input.project);
        const lines = changes.map((c: any) => `- \`${c.type}\` ${c.path.toString}`);
        return `Changed files in PR #${input.prId} (${changes.length}):\n${lines.join('\n')}`;
    });

    // ── Get Diff ────────────────────────────────────────────────
    reg<{ prId: number; filePath: string; contextLines?: number; repo?: string; project?: string }>('devnexus_bb_get_diff', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const diff = await client.getDiff(input.prId, input.filePath, input.contextLines || 5, input.repo, input.project);
        return `Diff for \`${input.filePath}\` in PR #${input.prId}:\n\`\`\`diff\n${diff}\n\`\`\``;
    });

    // ── List Comments ─────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_list_comments', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const comments = await client.getComments(input.prId, input.repo, input.project);
        if (comments.length === 0) { return `No comments found on PR #${input.prId}.`; }
        const lines = comments.map((c: any) => {
            const date = new Date(c.createdDate).toISOString().replace('T', ' ').substring(0, 16);
            const indent = c.depth ? '  '.repeat(c.depth) + '↳ ' : '';
            const type = c.anchor ? `[inline: ${c.anchor.path}:${c.anchor.line}]` : '[general]';
            const label = c.depth ? 'Reply' : 'Comment';
            return `${indent}- **${c.author.displayName}** ${date} ${c.depth ? '' : type}\n${indent}  ${label}: ${c.text}`;
        });
        return `All comments on PR #${input.prId} (${comments.length} total, including replies):\n\n${lines.join('\n\n')}`;
    });

    // ── Add Comment ─────────────────────────────────────────────
    reg<{ prId: number; text: string; filePath?: string; line?: number; lineType?: string; severity?: 'NORMAL' | 'BLOCKER'; repo?: string; project?: string }>('devnexus_bb_add_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const anchor = input.filePath && input.line ? { path: input.filePath, line: input.line, lineType: input.lineType } : undefined;
        await client.addComment(input.prId, input.text, anchor, input.severity, input.repo, input.project);
        const location = anchor ? ` on ${anchor.path}:${anchor.line}` : '';
        const sev = input.severity === 'BLOCKER' ? ' as BLOCKER' : '';
        return `Comment posted on PR #${input.prId}${location}${sev}`;
    });

    // ── Add Reviewer ────────────────────────────────────────────
    reg<{ prId: number; username: string; repo?: string; project?: string }>('devnexus_bb_add_reviewer', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.addReviewer(input.prId, input.username, input.repo, input.project);
        return `Added ${input.username} as reviewer on PR #${input.prId}`;
    });

    // ── Remove Reviewer ─────────────────────────────────────────
    reg<{ prId: number; username: string; repo?: string; project?: string }>('devnexus_bb_remove_reviewer', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.removeReviewer(input.prId, input.username, input.repo, input.project);
        return `Removed ${input.username} from PR #${input.prId}`;
    });

    // ── Approve PR ──────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_approve_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.approvePR(input.prId, input.repo, input.project);
        return `Approved PR #${input.prId}`;
    });

    // ── Decline PR ──────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_decline_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.declinePR(input.prId, input.repo, input.project);
        return `Declined PR #${input.prId}`;
    });

    // ── Mark PR Needs Work ─────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_needs_work', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.needsWorkPR(input.prId, input.repo, input.project);
        return `Marked PR #${input.prId} as needs work`;
    });

    // ── List Repos ──────────────────────────────────────────
    reg<{ project?: string }>('devnexus_bb_list_repos', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const repos = await client.listRepos(input.project);
        if (repos.length === 0) { return `No repos found in project ${input.project || ''}.`; }
        const lines = repos.map(r => `- \`${r.slug}\` — ${r.name}${r.description ? ` (${r.description})` : ''}`);
        return `Repos in **${input.project || ''}** (${repos.length}):\n${lines.join('\n')}`;
    });

    // ── Get Branches ─────────────────────────────────────────
    reg<{ repo: string; project?: string; filter?: string }>('devnexus_bb_get_branches', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const branches = await client.getBranches(input.repo, input.project, input.filter);
        if (branches.length === 0) { return `No branches found${input.filter ? ` matching "${input.filter}"` : ''} in ${input.project || ''}/${input.repo}.`; }
        const lines = branches.map(b => `- \`${b.displayId}\``);
        return `Branches in **${input.project || ''}/${input.repo}**${input.filter ? ` (filter: "${input.filter}")` : ''} (${branches.length}):\n${lines.join('\n')}`;
    });

    // ── Create Branch ───────────────────────────────────────────
    reg<{ branchName: string; startPoint?: string; repo?: string; project?: string }>('devnexus_bb_create_branch', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const result = await client.createBranch(input.branchName, input.startPoint || 'develop', input.repo, input.project);
        const repoLabel = `${input.project || ''}/${input.repo || ''}`;
        return `Created branch \`${result.displayId}\` from \`${input.startPoint || 'develop'}\` in ${repoLabel}`;
    });

    // ── Delete Branch ────────────────────────────────────────────
    reg<{ branchName: string; repo?: string; project?: string }>('devnexus_bb_delete_branch', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.deleteBranch(input.branchName, input.repo, input.project);
        return `Deleted branch \`${input.branchName}\` from ${input.project || ''}/${input.repo || ''}`;
    });

    // ── Get / Set Default Branch ─────────────────────────────────
    reg<{ repo?: string; project?: string }>('devnexus_bb_get_default_branch', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const branch = await client.getDefaultBranch(input.repo, input.project);
        return `Default branch: \`${branch.displayId}\` (latest commit: ${branch.latestCommit?.substring(0, 8)})`;
    });

    reg<{ branchName: string; repo?: string; project?: string }>('devnexus_bb_set_default_branch', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.setDefaultBranch(input.branchName, input.repo, input.project);
        return `Default branch set to \`${input.branchName}\``;
    });

    // ── Update PR ────────────────────────────────────────────────
    reg<{ prId: number; title?: string; description?: string; targetBranch?: string; repo?: string; project?: string }>('devnexus_bb_update_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.updatePR(input.prId, {
            title: input.title,
            description: input.description,
            targetBranch: input.targetBranch,
        }, input.repo, input.project);
        return `Updated **PR #${pr.id}** — "${pr.title}"`;
    });

    // ── Reopen PR ────────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_reopen_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.reopenPR(input.prId, input.repo, input.project);
        return `Reopened **PR #${pr.id}** — "${pr.title}"`;
    });

    // ── Get PR Commits ───────────────────────────────────────────
    reg<{ prId: number; limit?: number; repo?: string; project?: string }>('devnexus_bb_get_pr_commits', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const commits = await client.getPRCommits(input.prId, input.limit || 100, input.repo, input.project);
        if (!commits.length) { return `No commits in PR #${input.prId}.`; }
        const lines = commits.map(c => {
            const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
            const msg = c.message.split('\n')[0].substring(0, 80);
            return `- \`${c.displayId}\` [${date}] **${c.author.name}**: ${msg}`;
        });
        return `Commits in PR #${input.prId} (${commits.length}):\n${lines.join('\n')}`;
    });

    // ── Get Commits (branch/file history) ────────────────────────
    reg<{ until?: string; limit?: number; path?: string; repo?: string; project?: string }>('devnexus_bb_get_commits', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const commits = await client.getCommits(input.until, input.limit || 25, input.path, input.repo, input.project);
        if (!commits.length) { return 'No commits found.'; }
        const lines = commits.map(c => {
            const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
            const msg = c.message.split('\n')[0].substring(0, 80);
            return `- \`${c.displayId}\` [${date}] **${c.author.name}**: ${msg}`;
        });
        const context = input.path ? ` for \`${input.path}\`` : input.until ? ` on \`${input.until}\`` : '';
        return `Commits${context} (${commits.length}):\n${lines.join('\n')}`;
    });

    // ── Get Single Commit ─────────────────────────────────────────
    reg<{ commitId: string; repo?: string; project?: string }>('devnexus_bb_get_commit', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const c = await client.getCommit(input.commitId, input.repo, input.project);
        const date = new Date(c.authorTimestamp).toISOString().replace('T', ' ').substring(0, 16);
        const parents = c.parents?.map((p: any) => p.displayId).join(', ') || 'none';
        return [
            `Commit \`${c.displayId}\``,
            `Author: **${c.author.name}** <${c.author.emailAddress}>`,
            `Date: ${date}`,
            `Parents: ${parents}`,
            `Message:\n${c.message}`,
        ].join('\n');
    });

    // ── List PR Tasks ─────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_list_tasks', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const tasks = await client.listTasks(input.prId, input.repo, input.project);
        if (!tasks.length) { return `No tasks on PR #${input.prId}.`; }
        const lines = tasks.map(t => {
            const state = t.state === 'RESOLVED' ? '✓' : '○';
            const anchor = t.anchor ? ` [comment #${t.anchor.id}]` : '';
            return `${state} **#${t.id}** (${t.state}) by ${t.author.displayName}${anchor}: ${t.text}`;
        });
        return `Tasks on PR #${input.prId} (${tasks.length}):\n${lines.join('\n')}`;
    });

    // ── Create PR Task ────────────────────────────────────────────
    reg<{ prId: number; text: string; commentId?: number; repo?: string; project?: string }>('devnexus_bb_create_task', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const task = await client.createTask(input.prId, input.text, input.commentId, input.repo, input.project);
        return `Created task **#${task.id}** on PR #${input.prId}: "${input.text}"`;
    });

    // ── Resolve PR Task ───────────────────────────────────────────
    reg<{ prId: number; taskId: number; repo?: string; project?: string }>('devnexus_bb_resolve_task', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const tasks = await client.listTasks(input.prId, input.repo, input.project);
        const task = tasks.find(t => t.id === input.taskId);
        if (!task) { return `Task #${input.taskId} not found on PR #${input.prId}.`; }
        await client.resolveTask(input.taskId, task.version);
        return `Resolved task **#${input.taskId}** on PR #${input.prId}`;
    });

    // ── Delete PR Task ────────────────────────────────────────────
    reg<{ prId: number; taskId: number; repo?: string; project?: string }>('devnexus_bb_delete_task', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const tasks = await client.listTasks(input.prId, input.repo, input.project);
        const task = tasks.find(t => t.id === input.taskId);
        if (!task) { return `Task #${input.taskId} not found on PR #${input.prId}.`; }
        await client.deleteTask(input.taskId, task.version);
        return `Deleted task **#${input.taskId}** from PR #${input.prId}`;
    });

    // ── Update / Delete / Reply Comment ──────────────────────────
    reg<{ prId: number; commentId: number; text: string; repo?: string; project?: string }>('devnexus_bb_update_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const comments = await client.getComments(input.prId, input.repo, input.project);
        const comment = comments.find(c => c.id === input.commentId);
        const version = comment?.version ?? 0;
        await client.updateComment(input.prId, input.commentId, input.text, version, input.repo, input.project);
        return `Updated comment #${input.commentId} on PR #${input.prId}`;
    });

    reg<{ prId: number; commentId: number; repo?: string; project?: string }>('devnexus_bb_delete_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const comments = await client.getComments(input.prId, input.repo, input.project);
        const comment = comments.find(c => c.id === input.commentId);
        const version = comment?.version ?? 0;
        await client.deleteComment(input.prId, input.commentId, version, input.repo, input.project);
        return `Deleted comment #${input.commentId} from PR #${input.prId}`;
    });

    reg<{ prId: number; parentCommentId: number; text: string; repo?: string; project?: string }>('devnexus_bb_reply_to_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const comment = await client.replyToComment(input.prId, input.parentCommentId, input.text, input.repo, input.project);
        return `Posted reply #${comment.id} to comment #${input.parentCommentId} on PR #${input.prId}`;
    });

    // ── File Browsing ────────────────────────────────────────────
    reg<{ path: string; branch?: string; repo?: string; project?: string }>('devnexus_bb_get_file', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const content = await client.getFile(input.path, input.branch, input.repo, input.project);
        const lines = content.split('\n').length;
        const preview = content.length > 4000 ? content.substring(0, 4000) + '\n... (truncated)' : content;
        return `File \`${input.path}\`${input.branch ? ` @ ${input.branch}` : ''} (${lines} lines):\n\`\`\`\n${preview}\n\`\`\``;
    });

    reg<{ path?: string; branch?: string; repo?: string; project?: string }>('devnexus_bb_browse', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const items = await client.browse(input.path || '', input.branch, input.repo, input.project);
        if (!items.length) { return `No files found at \`${input.path || '/'}\`.`; }
        const dirs = items.filter(i => i.type === 'DIRECTORY').map(i => `📁 ${i.name}/`);
        const files = items.filter(i => i.type !== 'DIRECTORY').map(i => `📄 ${i.name}${i.size ? ` (${i.size}b)` : ''}`);
        return `Contents of \`${input.path || '/'}\`${input.branch ? ` @ ${input.branch}` : ''} (${items.length} items):\n${[...dirs, ...files].join('\n')}`;
    });

    reg<{ from: string; to: string; repo?: string; project?: string }>('devnexus_bb_compare', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const { changes, commits } = await client.compare(input.from, input.to, input.repo, input.project);
        const changeLines = changes.slice(0, 50).map(c => `- \`${c.type}\` ${c.path.toString}`);
        const commitLines = commits.slice(0, 20).map(c => `- \`${c.displayId}\` ${c.message.split('\n')[0].substring(0, 70)}`);
        const changesSummary = changes.length > 50 ? `\n... and ${changes.length - 50} more` : '';
        return `Comparing \`${input.from}\` → \`${input.to}\`:\n\n**${commits.length} commit(s):**\n${commitLines.join('\n')}\n\n**${changes.length} file change(s):**\n${changeLines.join('\n')}${changesSummary}`;
    });

    // ── Tags ─────────────────────────────────────────────────────
    reg<{ filter?: string; limit?: number; repo?: string; project?: string }>('devnexus_bb_list_tags', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const tags = await client.listTags(input.filter, input.limit || 100, input.repo, input.project);
        if (!tags.length) { return 'No tags found.'; }
        const lines = tags.map(t => `- \`${t.displayId}\` (${t.latestCommit?.substring(0, 8)})`);
        return `Tags (${tags.length}):\n${lines.join('\n')}`;
    });

    reg<{ name: string; commitId: string; message?: string; repo?: string; project?: string }>('devnexus_bb_create_tag', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const tag = await client.createTag(input.name, input.commitId, input.message, input.repo, input.project);
        return `Created tag \`${tag.displayId}\` at commit ${input.commitId.substring(0, 8)}`;
    });

    reg<{ name: string; repo?: string; project?: string }>('devnexus_bb_delete_tag', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.deleteTag(input.name, input.repo, input.project);
        return `Deleted tag \`${input.name}\``;
    });

    // ── Build Status ─────────────────────────────────────────────
    reg<{ commitId: string }>('devnexus_bb_get_build_status', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const statuses = await client.getBuildStatus(input.commitId);
        if (!statuses.length) { return `No build statuses for commit ${input.commitId.substring(0, 8)}.`; }
        const lines = statuses.map(s => {
            const icon = s.state === 'SUCCESSFUL' ? '✅' : s.state === 'FAILED' ? '❌' : '🔄';
            return `${icon} **${s.key}**${s.name ? ` (${s.name})` : ''}: ${s.state}${s.description ? ` — ${s.description}` : ''}`;
        });
        return `Build status for \`${input.commitId.substring(0, 8)}\` (${statuses.length}):\n${lines.join('\n')}`;
    });

    reg<{ commitId: string; state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS'; key: string; url: string; name?: string; description?: string }>('devnexus_bb_set_build_status', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const { commitId, ...params } = input;
        await client.setBuildStatus(commitId, params);
        return `Set build status \`${params.state}\` for key "${params.key}" on commit ${commitId.substring(0, 8)}`;
    });

    // ── Merge Check ──────────────────────────────────────────────
    reg<{ prId: number; repo?: string; project?: string }>('devnexus_bb_check_merge', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const result = await client.checkMerge(input.prId, input.repo, input.project);
        if (result.canMerge) { return `PR #${input.prId} **can be merged** ✅`; }
        const vetoes = result.vetoes.map(v => `- **${v.summaryMessage}**: ${v.detailedMessage}`).join('\n');
        return `PR #${input.prId} **cannot be merged** ❌\n\nBlocking reasons:\n${vetoes}`;
    });
}
