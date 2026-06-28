# Bitbucket Tools Reference

DevNexus exposes 12 Bitbucket tools through `@nexus` for repository and pull request workflows.

## Tool naming convention

- Manifest / runtime tool name: `devnexus_bb_*`
- Tool reference name: `nexus_bb_*`

## 1. List pull requests

**Tool name:** `devnexus_bb_list_prs`

```json
{
  "state": "OPEN",
  "filter": "all",
  "limit": 25
}
```

**Example prompts**

- `@nexus list open pull requests`
- `@nexus list PRs assigned to me for review`

## 2. Get pull request details

**Tool name:** `devnexus_bb_get_pr`

```json
{
  "prId": 42
}
```

**Example prompts**

- `@nexus show PR 42`
- `@nexus get pull request 42`

## 3. Create pull request

**Tool name:** `devnexus_bb_create_pr`

```json
{
  "title": "Add token refresh guard",
  "description": "Optional description",
  "fromBranch": "feature/proj-123-token-refresh",
  "toBranch": "develop",
  "reviewers": ["alex", "sam"]
}
```

**Example prompts**

- `@nexus create a PR from feature/proj-123-token-refresh to develop`
- `@nexus open a PR from bugfix/login-loop and add alex as reviewer`

## 4. Merge pull request

**Tool name:** `devnexus_bb_merge_pr`

```json
{
  "prId": 42
}
```

**Example prompts**

- `@nexus merge PR 42`

## 5. Get changed files

**Tool name:** `devnexus_bb_get_changes`

```json
{
  "prId": 42
}
```

**Example prompts**

- `@nexus list changed files in PR 42`

## 6. Get file diff

**Tool name:** `devnexus_bb_get_diff`

```json
{
  "prId": 42,
  "filePath": "src/auth/token.ts",
  "contextLines": 5
}
```

**Example prompts**

- `@nexus show the diff for src/auth/token.ts in PR 42`

## 7. Add comment

**Tool name:** `devnexus_bb_add_comment`

```json
{
  "prId": 42,
  "text": "Please guard against empty responses.",
  "filePath": "src/auth/token.ts",
  "line": 88,
  "lineType": "ADDED",
  "severity": "BLOCKER"
}
```

`filePath`, `line`, and `lineType` are optional for general comments.

**Example prompts**

- `@nexus add a blocker comment to PR 42 on src/auth/token.ts line 88`
- `@nexus comment on PR 42 that the release note is missing`

## 8. List comments

**Tool name:** `devnexus_bb_list_comments`

```json
{
  "prId": 42
}
```

**Example prompts**

- `@nexus list comments on PR 42`
- `@nexus show review discussion for PR 42`

## 9. Add reviewer

**Tool name:** `devnexus_bb_add_reviewer`

```json
{
  "prId": 42,
  "username": "alex"
}
```

**Example prompts**

- `@nexus add alex as reviewer on PR 42`

## 10. Remove reviewer

**Tool name:** `devnexus_bb_remove_reviewer`

```json
{
  "prId": 42,
  "username": "alex"
}
```

**Example prompts**

- `@nexus remove alex from PR 42 reviewers`

## 11. Approve / decline / needs work

**Tool names:**

- `devnexus_bb_approve_pr`
- `devnexus_bb_decline_pr`
- `devnexus_bb_needs_work`

```json
{
  "prId": 42
}
```

**Example prompts**

- `@nexus approve PR 42`
- `@nexus decline PR 42`
- `@nexus mark PR 42 as needs work`

## 12. Create branch

**Tool name:** `devnexus_bb_create_branch`

```json
{
  "branchName": "feature/proj-123-audit-log",
  "startPoint": "develop"
}
```

**Example prompts**

- `@nexus create branch feature/proj-123-audit-log from develop`

## Notes

- Default project and repo values come from `devnexus.bitbucket.project` and `devnexus.bitbucket.repo`.
- Bitbucket actions require `devnexus.bitbucket.baseUrl` and a valid PAT.
- General comments and inline comments share the same tool.
