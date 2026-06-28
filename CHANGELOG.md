# Changelog

## [1.0.0] — 2026-06-28

### Added
- `@nexus` Copilot Chat participant for natural language DevOps workflows
- **Jira tools**: get issue, create issue, create subtask, search (JQL), transition, add comment, update fields, log work, link issues, list subtasks, assign
- **Bitbucket tools**: list PRs, get PR, create PR, merge PR, get changed files, get diff, add comment, list comments, add/remove reviewer, approve, decline, mark needs work, create branch
- Activity bar with "My Jira Issues" and "Pull Requests" tree views
- Secure credential storage via VS Code SecretStorage
- Bootstrap via `.devnexus-env` file (auto-imported to SecretStorage on first run)
- Fully configurable — all endpoints and project settings via VS Code settings (`devnexus.*`)
- Published as open source under MIT license
