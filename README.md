# DevNexus - Jira & Bitbucket MCP Server

> Natural-language DevOps operations across Jira Server and Bitbucket Server, powered by the Model Context Protocol.

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![GitHub Repo stars](https://img.shields.io/github/stars/rakshithbn-proj/devnexus?style=social)

DevNexus is a standalone **MCP server** that exposes Jira Server and Bitbucket Server operations as tools for AI assistants. Connect it to VS Code Copilot, Claude Desktop, or any MCP-compatible client and interact with your DevOps toolchain in natural language.

## Tools

**45 Jira tools** — get issues (all fields: description, reporter, components, links, time tracking, custom fields, and more), create/clone issues and subtasks, search with JQL, transition status, add/update/delete comments, update fields, log work, link issues, manage sprints/boards/epics, versions, components, watchers, votes, and changelog.

**40 Bitbucket tools** � list/get/create/merge/decline PRs, review actions (approve, needs-work, reopen), inline comments, diffs, PR tasks, reviewers, branches, tags, build statuses, file browsing, compare refs, commit history, and merge checks.

## Requirements

- **Node.js** 20+
- Access to a **Jira Server** instance (with a Personal Access Token)
- Access to a **Bitbucket Server** instance (with a Personal Access Token)
- An MCP-compatible client: VS Code with GitHub Copilot, Claude Desktop, or similar

## Quick Start

### 1. Install

#### VS Code (recommended)

`Ctrl+Shift+P` → **MCP: Add Server** → **stdio**, then enter:

| Field | Value |
|---|---|
| Command | `npx` |
| Arguments | `-y devnexus-mcp` |

No global install needed — VS Code runs it via `npx` on demand.

#### Global install (all clients)

```bash
npm install -g devnexus-mcp
```

VS Code is configured automatically during install. Reload VS Code (`Ctrl+Shift+P` → **Developer: Reload Window**) to activate.

### 2. Configure credentials

On first run the server creates a template at `~/.devnexus/config.json`. You can also create it manually:

```json
{
  "jira": {
    "url": "https://jira.example.com",
    "user": "your.name@company.com",
    "pat": "your-jira-personal-access-token",
    "defaultProject": "PROJ",
    "startDateFieldId": "customfield_XXXXX",
    "forecastDateFieldId": "customfield_XXXXX"
  },
  "bitbucket": {
    "url": "https://bitbucket.example.com",
    "project": "PROJ",
    "repo": "your-default-repo",
    "pat": "your-bitbucket-personal-access-token"
  }
}
```

> Credentials are stored only in this local file � nothing is sent anywhere except your own Jira/Bitbucket servers.

### 3. Wire up your MCP client

**VS Code** — use **MCP: Add Server** with `npx` / `-y devnexus-mcp` as shown above, or run `npm install -g devnexus-mcp` for automatic setup.

**Claude Desktop** — add to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "devnexus": {
      "command": "npx",
      "args": ["-y", "devnexus-mcp"]
    }
  }
}
```

### 4. Start using it

Ask your AI assistant naturally � no special syntax required:

- `list open pull requests`
- `get issue PROJ-123`
- `create a subtask under PROJ-123 for API validation`
- `approve PR 42`
- `transition PROJ-123 to In Progress`

## Configuration reference

All settings live in `~/.devnexus/config.json`.

| Field | Description |
| --- | --- |
| `jira.url` | Base URL of your Jira Server, e.g. `https://jira.example.com` |
| `jira.user` | Your Jira username or email |
| `jira.pat` | Jira Personal Access Token |
| `jira.defaultProject` | Default project key when none is specified |
| `jira.startDateFieldId` | Custom field ID for start date (optional) |
| `jira.forecastDateFieldId` | Custom field ID for forecast date (optional) |
| `bitbucket.url` | Base URL of your Bitbucket Server |
| `bitbucket.project` | Default Bitbucket project key |
| `bitbucket.repo` | Default repository slug |
| `bitbucket.pat` | Bitbucket Personal Access Token |

## Example prompts

### Jira

- `get issue PROJ-123`
- `create a bug in PROJ titled "Login fails after token refresh"`
- `create a subtask under PROJ-123 called "Add integration test"`
- `search for issues assigned to me in PROJ`
- `transition PROJ-123 to In Progress`
- `add a comment to PROJ-123 saying the fix is ready for review`
- `update PROJ-123 priority to High`
- `log 2h on PROJ-123`
- `link PROJ-123 blocks PROJ-456`
- `show the active sprint for PROJ`
- `list epics in PROJ`
- `show changelog for PROJ-123`

### Bitbucket

- `list open pull requests`
- `show PR 42`
- `create a PR from feature/auth-refresh to develop`
- `merge PR 42`
- `show the diff for src/auth/token.ts in PR 42`
- `add a comment on PR 42 at src/auth/token.ts line 88`
- `approve PR 42`
- `mark PR 42 as needs work`
- `create branch feature/proj-123-api-cleanup from develop`
- `check if PR 42 can merge`
- `compare develop with main`

## Troubleshooting

### Config file not found

The server prints the template path on first run. Fill in `~/.devnexus/config.json` and restart.

### Authentication errors

Verify your PATs are valid and have not expired. Jira PATs require at least read scope; Bitbucket PATs require repository read and pull-request read/write.

### MCP client can't connect

Ensure `devnexus` is on your PATH after global install. Run `devnexus` in a terminal — if it starts, the install worked. If not, try `npm install -g devnexus-mcp` again.

## Building from source

See [BUILD.md](BUILD.md) for full build instructions and development workflow.

## Contributing

Issues and pull requests are welcome at https://github.com/rakshithbn-proj/devnexus. Please keep all examples generic � no internal endpoints, project keys, or credentials.

## License

DevNexus is released under the [MIT License](LICENSE).
