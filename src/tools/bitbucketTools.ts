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
            return `- **PR #${pr.id}** — ${pr.title} [${pr.state}]\n  ${pr.fromRef.displayId} → ${pr.toRef.displayId} | Author: ${pr.author.user.displayName} | Reviewers: ${reviewers}`;
        });
        return `Pull Requests (${prs.length}):\n${lines.join('\n')}`;
    });

    // ── Get PR ──────────────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_get_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.getPR(input.prId);
        const reviewers = pr.reviewers.map((r: any) => `${r.user.displayName} (${r.status})`).join(', ') || 'none';
        return [
            `**PR #${pr.id}** — ${pr.title}`,
            `State: ${pr.state}`,
            `Branch: ${pr.fromRef.displayId} → ${pr.toRef.displayId}`,
            `Author: ${pr.author.user.displayName}`,
            `Reviewers: ${reviewers}`,
            `Description: ${pr.description || '(none)'}`,
            `URL: ${client.getPRUrl(pr.id)}`,
        ].join('\n');
    });

    // ── Create PR ───────────────────────────────────────────────
    reg<{ title: string; description?: string; fromBranch: string; toBranch?: string; reviewers?: string[] }>('devnexus_bb_create_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.createPR(input);
        const reviewerNames = pr.reviewers.map((r: any) => r.user.displayName).join(', ') || 'none';
        return `Created **PR #${pr.id}** — "${pr.title}"\n${pr.fromRef.displayId} → ${pr.toRef.displayId} | Reviewers: ${reviewerNames}\nURL: ${client.getPRUrl(pr.id)}`;
    });

    // ── Merge PR ────────────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_merge_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const pr = await client.mergePR(input.prId);
        return `Merged **PR #${input.prId}** — "${pr.title}"`;
    });

    // ── Get Changes ─────────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_get_changes', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const changes = await client.getChanges(input.prId);
        const lines = changes.map((c: any) => `- \`${c.type}\` ${c.path.toString}`);
        return `Changed files in PR #${input.prId} (${changes.length}):\n${lines.join('\n')}`;
    });

    // ── Get Diff ────────────────────────────────────────────────
    reg<{ prId: number; filePath: string; contextLines?: number }>('devnexus_bb_get_diff', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const diff = await client.getDiff(input.prId, input.filePath, input.contextLines || 5);
        return `Diff for \`${input.filePath}\` in PR #${input.prId}:\n\`\`\`diff\n${diff}\n\`\`\``;
    });

    // ── List Comments ─────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_list_comments', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const comments = await client.getComments(input.prId);
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
    reg<{ prId: number; text: string; filePath?: string; line?: number; lineType?: string; severity?: 'NORMAL' | 'BLOCKER' }>('devnexus_bb_add_comment', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const anchor = input.filePath && input.line ? { path: input.filePath, line: input.line, lineType: input.lineType } : undefined;
        await client.addComment(input.prId, input.text, anchor, input.severity);
        const location = anchor ? ` on ${anchor.path}:${anchor.line}` : '';
        const sev = input.severity === 'BLOCKER' ? ' as BLOCKER' : '';
        return `Comment posted on PR #${input.prId}${location}${sev}`;
    });

    // ── Add Reviewer ────────────────────────────────────────────
    reg<{ prId: number; username: string }>('devnexus_bb_add_reviewer', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.addReviewer(input.prId, input.username);
        return `Added ${input.username} as reviewer on PR #${input.prId}`;
    });

    // ── Remove Reviewer ─────────────────────────────────────────
    reg<{ prId: number; username: string }>('devnexus_bb_remove_reviewer', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.removeReviewer(input.prId, input.username);
        return `Removed ${input.username} from PR #${input.prId}`;
    });

    // ── Approve PR ──────────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_approve_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.approvePR(input.prId);
        return `Approved PR #${input.prId}`;
    });

    // ── Decline PR ──────────────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_decline_pr', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.declinePR(input.prId);
        return `Declined PR #${input.prId}`;
    });

    // ── Mark PR Needs Work ─────────────────────────────────────
    reg<{ prId: number }>('devnexus_bb_needs_work', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        await client.needsWorkPR(input.prId);
        return `Marked PR #${input.prId} as needs work`;
    });

    // ── Create Branch ───────────────────────────────────────────
    reg<{ branchName: string; startPoint?: string }>('devnexus_bb_create_branch', async (input) => {
        const client = await getClient();
        if (!client) { return 'Bitbucket token not configured.'; }
        const result = await client.createBranch(input.branchName, input.startPoint || 'develop');
        return `Created branch \`${result.displayId}\` from ${input.startPoint || 'develop'}`;
    });
}
