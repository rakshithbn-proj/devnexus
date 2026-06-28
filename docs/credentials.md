# DevNexus Credentials and Security Model

DevNexus is designed to avoid storing Jira or Bitbucket credentials in your repository.

## Storage priority

When DevNexus needs credentials, it checks sources in this order:

1. **VS Code SecretStorage**
2. **Process environment variables**
3. **`~/.devnexus-env` bootstrap file**

If credentials are found in environment variables or `.devnexus-env`, DevNexus copies them into SecretStorage for future use.

## SecretStorage

SecretStorage is the preferred location because:

- credentials are managed by VS Code rather than project files
- secrets persist across restarts
- workspace collaborators do not see your PATs

Credential keys used by DevNexus:

- `devnexus.jira.username`
- `devnexus.jira.pat`
- `devnexus.bitbucket.pat`

## Environment variables

You can provide credentials before launching VS Code:

```powershell
$env:JIRA_USER = 'your-jira-username'
$env:JIRA_PAT = 'your_jira_pat'
$env:BITBUCKET_PAT = 'your_bitbucket_pat'
code .
```

This is useful for ephemeral sessions or managed developer workstations.

## .devnexus-env bootstrap file

Create the file in your home directory, not inside the repository:

```env
# DevNexus credentials
# Values are imported into VS Code SecretStorage on first startup.
# You can delete this file after first successful authentication.
#
# Jira Server (set devnexus.jira.baseUrl in VS Code Settings first)
JIRA_USER=your-jira-username
JIRA_PAT=your_jira_personal_access_token_here
#
# Bitbucket Server (set devnexus.bitbucket.baseUrl in VS Code Settings first)
BITBUCKET_PAT=your_bitbucket_personal_access_token_here
```

After the first successful authentication, remove the file if your workflow does not require it anymore.

## Revoking credentials

To rotate or revoke access:

1. Revoke the PATs in Jira or Bitbucket Server
2. Run the DevNexus credential commands again with new values
3. Remove stale environment variables or delete `~/.devnexus-env`
4. Restart VS Code if needed

## Troubleshooting

### Jira credentials exist but requests still fail

Check both of these:

- `devnexus.jira.baseUrl` points to the correct server
- the Jira PAT is valid for the user in `JIRA_USER`

### Bitbucket token saved but PR tools fail

Verify:

- `devnexus.bitbucket.baseUrl` is set
- `devnexus.bitbucket.project` and `devnexus.bitbucket.repo` match the target repo
- the PAT has permission to read or modify pull requests

### I want to remove everything stored by DevNexus

Clear the extension's SecretStorage entries from VS Code, delete `~/.devnexus-env` if it exists, unset any related environment variables, and reload VS Code.
