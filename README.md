# DevNexus — Jira & Bitbucket for Copilot Chat

> Chain natural-language DevOps workflows across Jira and Bitbucket with `@nexus` in GitHub Copilot Chat.

![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-DevNexus-0098FF?logo=visualstudiocode)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![GitHub Repo stars](https://img.shields.io/github/stars/rakshithbn-proj/devnexus?style=social)

DevNexus is a VS Code extension that brings Jira Server and Bitbucket Server operations into GitHub Copilot Chat. Ask `@nexus` to create subtasks, transition tickets, log work, inspect pull requests, comment on code, and chain multi-step workflows without leaving the editor.

## Features

- `@nexus` Copilot Chat participant for Jira and Bitbucket workflows
- 11 Jira tools for issue lookup, creation, search, assignment, comments, links, estimates, and work logging
- 14 Bitbucket tools for PR triage, review actions, comments, diffs, reviewers, and branch creation
- Activity bar views for **My Jira Issues** and **Pull Requests**
- Runtime configuration for any Jira Server and Bitbucket Server instance
- Secure credential storage in VS Code SecretStorage
- Optional `.devnexus-env` bootstrap file for first-run setup
- Multi-step workflow handling such as “comment on this PR, mark it needs work, and create a Jira subtask”

## Requirements

- VS Code **1.95+**
- An active **GitHub Copilot** subscription with Chat enabled
- Access to a Jira Server instance
- Access to a Bitbucket Server instance

## Quick Start

1. **Install DevNexus** from the VS Code Marketplace.
2. **Configure settings** for your Jira and Bitbucket server URLs in VS Code Settings.
3. **Set credentials** using the `DevNexus: Set Jira Credentials` and `DevNexus: Set Bitbucket Token` commands, or create a `.devnexus-env` bootstrap file.
4. Open **GitHub Copilot Chat** and start with prompts such as:
   - `@nexus get issue PROJ-123`
   - `@nexus create a subtask under PROJ-123 for API validation`
   - `@nexus list open pull requests`

## Configuration

Configure DevNexus from **Settings** (`Ctrl+,`) or your `settings.json`.

| Setting | Description |
| --- | --- |
| `devnexus.jira.baseUrl` | Base URL for your Jira Server, for example `https://jira.example.com`. |
| `devnexus.jira.defaultProject` | Default Jira project key used when the user does not specify one. |
| `devnexus.bitbucket.baseUrl` | Base URL for your Bitbucket Server, for example `https://bitbucket.example.com`. |
| `devnexus.bitbucket.project` | Default Bitbucket project key. |
| `devnexus.bitbucket.repo` | Default Bitbucket repository slug. |

Example `settings.json`:

```json
{
  "devnexus.jira.baseUrl": "https://jira.example.com",
  "devnexus.jira.defaultProject": "PROJ",
  "devnexus.bitbucket.baseUrl": "https://bitbucket.example.com",
  "devnexus.bitbucket.project": "PLATFORM",
  "devnexus.bitbucket.repo": "backend-service"
}
```

See [docs/configuration.md](docs/configuration.md) for environment-specific setup examples.

## Credentials

DevNexus stores credentials in **VS Code SecretStorage**, not in workspace files. You can provide credentials in three ways:

1. Run `DevNexus: Set Jira Credentials`
2. Run `DevNexus: Set Bitbucket Token`
3. Create a `.devnexus-env` file in your home directory and let DevNexus import it on first startup

Supported bootstrap variables:

```env
JIRA_USER=your-jira-username
JIRA_PAT=your_jira_personal_access_token_here
BITBUCKET_PAT=your_bitbucket_personal_access_token_here
```

After a successful import, the values are copied into SecretStorage and the file can be deleted. Full details are in [docs/credentials.md](docs/credentials.md).

## Jira Commands

Example prompts you can use with `@nexus`:

- `@nexus get issue PROJ-123`
- `@nexus create a bug in YOUR-PROJECT titled "Login fails after token refresh"`
- `@nexus create a subtask under PROJ-123 called "Add integration test" with label my-label`
- `@nexus search Jira for issues assigned to me in YOUR-PROJECT`
- `@nexus transition PROJ-123 to In Progress`
- `@nexus add a comment to PROJ-123 saying the fix is ready for review`
- `@nexus update PROJ-123 labels to my-label and priority to High`
- `@nexus log 2h on PROJ-123`
- `@nexus link PROJ-123 blocks PROJ-456`
- `@nexus list subtasks under PROJ-123`
- `@nexus assign PROJ-123 to me`

See [docs/jira-tools.md](docs/jira-tools.md) for every Jira tool schema and usage pattern.

## Bitbucket Commands

Example prompts you can use with `@nexus`:

- `@nexus list open pull requests`
- `@nexus show PR 42`
- `@nexus create a PR from feature/auth-refresh to develop`
- `@nexus merge PR 42`
- `@nexus show changed files in PR 42`
- `@nexus show the diff for src/auth/token.ts in PR 42`
- `@nexus add a blocker comment on PR 42 for src/auth/token.ts line 88`
- `@nexus list comments on PR 42`
- `@nexus add alex as reviewer on PR 42`
- `@nexus remove sam from PR 42 reviewers`
- `@nexus approve PR 42`
- `@nexus mark PR 42 as needs work`
- `@nexus create branch feature/proj-123-api-cleanup from develop`

See [docs/bitbucket-tools.md](docs/bitbucket-tools.md) for the full Bitbucket reference.

## Troubleshooting

### No language model available

Make sure GitHub Copilot Chat is installed, enabled, and signed in. DevNexus requires an available Copilot chat model.

### Authentication errors

Run the credential commands again or recreate your `.devnexus-env` file. Confirm that your Jira PAT and Bitbucket PAT are valid for the target servers.

### “Jira URL not configured” or “Bitbucket URL not configured”

Open VS Code Settings and set:

- `devnexus.jira.baseUrl`
- `devnexus.bitbucket.baseUrl`

If you rely on default project or repo values, also set `devnexus.jira.defaultProject`, `devnexus.bitbucket.project`, and `devnexus.bitbucket.repo`.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), review the tool conventions, and keep all examples generic.

## License

DevNexus is released under the [MIT License](LICENSE).
