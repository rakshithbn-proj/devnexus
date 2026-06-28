# Contributing to DevNexus

Thanks for your interest! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/rakshithbn-proj/devnexus.git
cd devnexus
npm install
```

Press **F5** in VS Code to launch an Extension Development Host with DevNexus loaded.

## Project Structure

```text
src/
  api/            # HTTP clients for Jira and Bitbucket
    jiraClient.ts
    bitbucketClient.ts
  auth/           # Credential management (SecretStorage + .devnexus-env)
    authManager.ts
  tools/          # LM tool registrations
    jiraTools.ts
    bitbucketTools.ts
    toolRegistry.ts
  participant/    # @nexus Copilot Chat handler
    chatHandler.ts
  views/          # Activity bar tree providers
    jiraTreeProvider.ts
    bbTreeProvider.ts
  extension.ts    # Entry point
```

## Adding a New Tool

1. **Add the API method** in `src/api/jiraClient.ts` or `bitbucketClient.ts`
2. **Register the tool handler** in `src/tools/jiraTools.ts` or `src/tools/bitbucketTools.ts` using the `reg<T>('devnexus_jira_your_tool', ...)` pattern
3. **Add the tool schema** to `TOOL_SCHEMAS` in `src/participant/chatHandler.ts`
4. **Add the manifest entry** in `package.json` under `contributes.languageModelTools`
5. **Add aliases** to `resolveToolName` in `chatHandler.ts`

## Guidelines

- No hardcoded endpoints, project keys, or usernames
- Tool names must follow the `devnexus_jira_*` / `devnexus_bb_*` convention
- All user-facing strings should be generic (no project-specific examples)
- Update `CHANGELOG.md` with your change

## Commit Style

```text
feat: add jira bulk transition tool
fix: handle empty bitbucket reviewer list
docs: update configuration guide
```
