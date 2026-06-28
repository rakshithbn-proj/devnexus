# DevNexus Configuration Guide

DevNexus reads all server and project defaults from VS Code settings at runtime. Nothing is hardcoded, so the same extension package can be used across teams and environments.

## Available Settings

| Setting | Required | Example | Notes |
| --- | --- | --- | --- |
| `devnexus.jira.baseUrl` | Yes for Jira features | `https://jira.example.com` | Base URL for Jira Server or Data Center. |
| `devnexus.jira.defaultProject` | Recommended | `PROJ` | Used when the user omits a project key. |
| `devnexus.bitbucket.baseUrl` | Yes for Bitbucket features | `https://bitbucket.example.com` | Base URL for Bitbucket Server or Data Center. |
| `devnexus.bitbucket.project` | Recommended | `PLATFORM` | Default Bitbucket project for repository-scoped actions. |
| `devnexus.bitbucket.repo` | Recommended | `backend-service` | Default repository slug for PR and branch operations. |

## Basic settings.json example

```json
{
  "devnexus.jira.baseUrl": "https://jira.example.com",
  "devnexus.jira.defaultProject": "PROJ",
  "devnexus.bitbucket.baseUrl": "https://bitbucket.example.com",
  "devnexus.bitbucket.project": "PLATFORM",
  "devnexus.bitbucket.repo": "backend-service"
}
```

## Setup patterns

### 1. Single Jira + single Bitbucket instance

Use one shared server for everything:

```json
{
  "devnexus.jira.baseUrl": "https://jira.company.local",
  "devnexus.jira.defaultProject": "OPS",
  "devnexus.bitbucket.baseUrl": "https://bitbucket.company.local",
  "devnexus.bitbucket.project": "OPS",
  "devnexus.bitbucket.repo": "platform-tools"
}
```

### 2. Shared servers, multiple projects

Set the URLs once and leave the defaults blank if you frequently switch projects:

```json
{
  "devnexus.jira.baseUrl": "https://jira.company.local",
  "devnexus.jira.defaultProject": "",
  "devnexus.bitbucket.baseUrl": "https://bitbucket.company.local",
  "devnexus.bitbucket.project": "",
  "devnexus.bitbucket.repo": ""
}
```

In this mode, `@nexus` will ask for missing project or repository details when needed.

### 3. Monorepo team defaults

Point DevNexus at the Jira project and repository you use most often:

```json
{
  "devnexus.jira.baseUrl": "https://jira.example.com",
  "devnexus.jira.defaultProject": "APP",
  "devnexus.bitbucket.baseUrl": "https://bitbucket.example.com",
  "devnexus.bitbucket.project": "APP",
  "devnexus.bitbucket.repo": "app-monorepo"
}
```

This setup works well for prompts such as `@nexus list my tickets` or `@nexus create branch feature/app-123`.

## Workspace vs user settings

- **User settings** are best when you use the same servers across projects.
- **Workspace settings** are better when a repository belongs to a specific Jira project or Bitbucket repo.

Example `.vscode/settings.json`:

```json
{
  "devnexus.jira.defaultProject": "PROJ",
  "devnexus.bitbucket.project": "PROJ",
  "devnexus.bitbucket.repo": "service-api"
}
```

## Runtime behavior

DevNexus reads configuration when it builds prompts and when it creates Jira or Bitbucket clients. That means:

- changing settings does not require reinstalling the extension
- prompt guidance stays aligned with the current environment
- missing URLs are surfaced with clear warnings before network calls are attempted

## Common mistakes

### Jira URL missing

If `devnexus.jira.baseUrl` is empty, Jira actions are blocked and DevNexus shows:

> DevNexus: Jira URL not configured. Open Settings and set devnexus.jira.baseUrl.

### Bitbucket URL missing

If `devnexus.bitbucket.baseUrl` is empty, Bitbucket actions are blocked and DevNexus shows:

> DevNexus: Bitbucket URL not configured. Open Settings and set devnexus.bitbucket.baseUrl.

### Defaults set for the wrong repo

If a branch or PR action targets the wrong repository, verify:

- `devnexus.bitbucket.project`
- `devnexus.bitbucket.repo`

## Related docs

- [README.md](../README.md)
- [docs/credentials.md](credentials.md)
- [docs/jira-tools.md](jira-tools.md)
- [docs/bitbucket-tools.md](bitbucket-tools.md)
