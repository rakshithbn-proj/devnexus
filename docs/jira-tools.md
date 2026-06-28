# Jira Tools Reference

DevNexus exposes 11 Jira tools to the Copilot Chat participant `@nexus`. All of them can be referenced in prompts and are backed by concrete tool registrations in the extension manifest.

## Tool naming convention

- Manifest / runtime tool name: `devnexus_jira_*`
- Tool reference name: `nexus_jira_*`

## 1. Get issue

**Tool name:** `devnexus_jira_get_issue`

**Input schema**

```json
{
  "issueKey": "PROJ-123"
}
```

**Example prompts**

- `@nexus get issue PROJ-123`
- `@nexus show me PROJ-123`

## 2. Create issue

**Tool name:** `devnexus_jira_create_issue`

**Input schema**

```json
{
  "projectKey": "YOUR-PROJECT",
  "issueType": "Task",
  "summary": "Implement audit logging",
  "description": "Optional description",
  "labels": ["my-label"],
  "fixVersions": ["1.0.0"],
  "assignee": "self"
}
```

**Example prompts**

- `@nexus create a task in YOUR-PROJECT called Implement audit logging`
- `@nexus create a bug in YOUR-PROJECT and assign it to me`

## 3. Create subtask

**Tool name:** `devnexus_jira_create_subtask`

**Input schema**

```json
{
  "parentKey": "PROJ-123",
  "summary": "Add regression test",
  "description": "Optional description",
  "labels": ["my-label"],
  "fixVersions": ["1.0.0"],
  "assignee": "self"
}
```

If `fixVersions` is omitted, DevNexus inherits the parent issue's fix versions.

**Example prompts**

- `@nexus create a subtask under PROJ-123 for regression testing`
- `@nexus add a subtask under PROJ-123 and assign it to me`

## 4. Search issues

**Tool name:** `devnexus_jira_search`

**Input schema**

```json
{
  "jql": "project = YOUR-PROJECT AND assignee = currentUser() AND status != Done",
  "maxResults": 20
}
```

**Example prompts**

- `@nexus list my open tickets in YOUR-PROJECT`
- `@nexus search Jira for bugs with label my-label`

## 5. Transition issue

**Tool name:** `devnexus_jira_transition`

**Input schema**

```json
{
  "issueKey": "PROJ-123",
  "transitionName": "In Progress"
}
```

**Example prompts**

- `@nexus start the progress on PROJ-123`
- `@nexus mark PROJ-123 resolved`

## 6. Add comment

**Tool name:** `devnexus_jira_add_comment`

**Input schema**

```json
{
  "issueKey": "PROJ-123",
  "body": "Fix is ready for review."
}
```

**Example prompts**

- `@nexus comment on PROJ-123 that the patch is ready`
- `@nexus add a note to PROJ-123 with rollout details`

## 7. Update fields

**Tool name:** `devnexus_jira_update_fields`

**Input schema**

```json
{
  "issueKey": "PROJ-123",
  "fields": {
    "summary": "Optional new summary",
    "description": "Optional new description",
    "labels": ["my-label"],
    "fixVersions": ["1.0.1"],
    "assignee": "self",
    "priority": "High",
    "originalEstimate": "1d",
    "remainingEstimate": "2h"
  }
}
```

**Example prompts**

- `@nexus set PROJ-123 priority to High`
- `@nexus update PROJ-123 remaining estimate to 2h`

## 8. Log work

**Tool name:** `devnexus_jira_log_work`

**Input schema**

```json
{
  "issueKey": "PROJ-123",
  "timeSpent": "2h",
  "started": "2026-06-28T09:00:00.000+0000"
}
```

**Example prompts**

- `@nexus log 2h on PROJ-123`
- `@nexus record 45m of work for PROJ-123`

## 9. Link issues

**Tool name:** `devnexus_jira_link_issues`

**Input schema**

```json
{
  "linkType": "blocks",
  "inwardKey": "PROJ-456",
  "outwardKey": "PROJ-123"
}
```

**Example prompts**

- `@nexus link PROJ-123 blocks PROJ-456`
- `@nexus mark PROJ-789 as related to PROJ-123`

## 10. List subtasks

**Tool name:** `devnexus_jira_list_subtasks`

**Input schema**

```json
{
  "parentKey": "PROJ-123"
}
```

**Example prompts**

- `@nexus list subtasks for PROJ-123`
- `@nexus show child tasks under PROJ-123`

## 11. Assign issue

**Tool name:** `devnexus_jira_assign`

**Input schema**

```json
{
  "issueKey": "PROJ-123",
  "assignee": "self"
}
```

**Example prompts**

- `@nexus assign PROJ-123 to me`
- `@nexus assign PROJ-123 to alex`

## Notes

- `self` resolves to the Jira username stored in DevNexus credentials.
- Project defaults come from `devnexus.jira.defaultProject`.
- Time logging and estimate updates are separate tools on purpose.
