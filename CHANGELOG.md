# Changelog

## [1.0.2] — 2026-06-28

### Fixed
- Jira REST calls now strip trailing slashes from `devnexus.jira.baseUrl`, fixing `404 null for uri` when the configured URL ends with `/` (e.g. `https://jira.example.com/` previously produced `https://jira.example.com//rest/api/2/search`)
- Same trailing-slash normalization applied to `devnexus.bitbucket.baseUrl`

### Changed
- `devnexus.bitbucket.repo` is now **optional**. Leave it blank to access every repository in the configured project — every Bitbucket tool accepts an optional `repo` argument that overrides (or supplies) the slug per call
- "My open PRs" / "PRs to review" use Bitbucket's `/dashboard/pull-requests` endpoint when no default repo is set, so they list PRs across all repos in the project

### Added
- `devnexus_bb_list_repos` tool — lists every repository in the configured project
- Tree view now has a "Repositories" section that expands to show each repo's open PRs

## [1.0.1] — 2026-06-28

### Fixed
- `.devnexus-env` is now also read from the open workspace folder (previously only from `%USERPROFILE%`/`$HOME`), so credentials placed alongside the project are picked up
- Strip surrounding single/double quotes from values in `.devnexus-env` (e.g. `JIRA_PAT="abc"` is now parsed as `abc`)
- Ignore template placeholder values (`your_jira_personal_access_token_here`, etc.) instead of persisting them to SecretStorage as fake credentials
- Clearer error messages distinguishing missing credentials from missing `devnexus.jira.baseUrl` / `devnexus.bitbucket.baseUrl` settings
- `DevNexus: Create Credentials File` now writes to the workspace folder when one is open

### Added
- `DevNexus Auth` output channel logs which source (`SecretStorage` / `process.env` / `.devnexus-env`) supplied credentials, making misconfiguration easier to diagnose

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
