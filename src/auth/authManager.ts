import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const JIRA_USER_KEY = 'devnexus.jira.username';
const JIRA_PAT_KEY = 'devnexus.jira.pat';
const BB_PAT_KEY = 'devnexus.bitbucket.pat';
const ENV_FILE_NAME = '.devnexus-env';

export interface JiraCredentials {
    username: string;
    pat: string;
}

export interface UserProfile {
    username: string;
    displayName: string;
    email: string;
}

export class AuthManager {
    private secrets: vscode.SecretStorage;
    private jiraUsername: string | undefined;
    private userProfile: UserProfile | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.secrets = context.secrets;
    }

    private getEnvFilePath(): string {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        return path.join(home, ENV_FILE_NAME);
    }

    private readEnvFile(): Record<string, string> {
        const envPath = this.getEnvFilePath();
        const vars: Record<string, string> = {};
        try {
            if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf-8');
                for (const line of content.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) { continue; }
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx > 0) {
                        const key = trimmed.substring(0, eqIdx).trim();
                        const value = trimmed.substring(eqIdx + 1).trim();
                        vars[key] = value;
                    }
                }
            }
        } catch {
            // ignore read errors
        }
        return vars;
    }

    async setJiraCredentials(): Promise<boolean> {
        const username = await vscode.window.showInputBox({
            prompt: 'Jira username',
            placeHolder: 'your-username',
            value: this.jiraUsername,
            ignoreFocusOut: true,
        });
        if (!username) { return false; }

        const pat = await vscode.window.showInputBox({
            prompt: 'Jira Personal Access Token (PAT)',
            password: true,
            ignoreFocusOut: true,
        });
        if (!pat) { return false; }

        await this.secrets.store(JIRA_USER_KEY, username);
        await this.secrets.store(JIRA_PAT_KEY, pat);
        this.jiraUsername = username;
        await vscode.commands.executeCommand('setContext', 'devnexus.jiraAuthenticated', true);
        vscode.window.showInformationMessage(`DevNexus: Jira PAT saved for ${username} (persists across restarts)`);
        return true;
    }

    async getJiraCredentials(): Promise<JiraCredentials | undefined> {
        let username = await this.secrets.get(JIRA_USER_KEY);
        let pat = await this.secrets.get(JIRA_PAT_KEY);

        if (!username || !pat) {
            username = username || process.env.JIRA_USER;
            pat = pat || process.env.JIRA_PAT;
        }

        if (!username || !pat) {
            const envFile = this.readEnvFile();
            username = username || envFile.JIRA_USER;
            pat = pat || envFile.JIRA_PAT;
        }

        if (!username || !pat) { return undefined; }

        const storedUser = await this.secrets.get(JIRA_USER_KEY);
        if (!storedUser) {
            await this.secrets.store(JIRA_USER_KEY, username);
            await this.secrets.store(JIRA_PAT_KEY, pat);
        }

        this.jiraUsername = username;
        return { username, pat };
    }

    getJiraUsername(): string | undefined {
        return this.jiraUsername;
    }

    getUserProfile(): UserProfile | undefined {
        return this.userProfile;
    }

    private async fetchUserProfile(creds: JiraCredentials): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('devnexus.jira');
            const baseUrl = config.get<string>('baseUrl', '');
            if (!baseUrl.trim()) { return; }
            const resp = await fetch(`${baseUrl}/rest/api/2/myself`, {
                headers: {
                    'Authorization': `Bearer ${creds.pat}`,
                    'Content-Type': 'application/json',
                },
            });
            if (resp.ok) {
                const data = await resp.json() as { name: string; displayName: string; emailAddress: string };
                this.userProfile = {
                    username: data.name,
                    displayName: data.displayName,
                    email: data.emailAddress || '',
                };
            }
        } catch {
            // non-fatal — profile just won't be available
        }
    }

    async isJiraAuthenticated(): Promise<boolean> {
        const creds = await this.getJiraCredentials();
        return creds !== undefined;
    }

    async setBitbucketToken(): Promise<boolean> {
        const pat = await vscode.window.showInputBox({
            prompt: 'Bitbucket Personal Access Token (PAT)',
            password: true,
            ignoreFocusOut: true,
        });
        if (!pat) { return false; }

        await this.secrets.store(BB_PAT_KEY, pat);
        await vscode.commands.executeCommand('setContext', 'devnexus.bbAuthenticated', true);
        vscode.window.showInformationMessage('DevNexus: Bitbucket PAT saved (persists across restarts)');
        return true;
    }

    async getBitbucketToken(): Promise<string | undefined> {
        let pat = await this.secrets.get(BB_PAT_KEY);

        if (!pat) { pat = process.env.BITBUCKET_PAT; }

        if (!pat) {
            const envFile = this.readEnvFile();
            pat = envFile.BITBUCKET_PAT;
        }

        if (!pat) { return undefined; }

        const stored = await this.secrets.get(BB_PAT_KEY);
        if (!stored) {
            await this.secrets.store(BB_PAT_KEY, pat);
        }

        return pat;
    }

    async isBitbucketAuthenticated(): Promise<boolean> {
        const token = await this.getBitbucketToken();
        return token !== undefined;
    }

    async createEnvFile(): Promise<void> {
        const envPath = this.getEnvFilePath();
        if (fs.existsSync(envPath)) {
            vscode.window.showInformationMessage(`${ENV_FILE_NAME} already exists at ${envPath}`);
            const doc = await vscode.workspace.openTextDocument(envPath);
            await vscode.window.showTextDocument(doc);
            return;
        }

        const template = [
            '# DevNexus credentials',
            '# Values are imported into VS Code SecretStorage on first startup.',
            '# You can delete this file after first successful authentication.',
            '#',
            '# Jira Server (set devnexus.jira.baseUrl in VS Code Settings first)',
            'JIRA_USER=your-jira-username',
            'JIRA_PAT=your_jira_personal_access_token_here',
            '#',
            '# Bitbucket Server (set devnexus.bitbucket.baseUrl in VS Code Settings first)',
            'BITBUCKET_PAT=your_bitbucket_personal_access_token_here',
            '',
        ].join('\n');

        fs.writeFileSync(envPath, template, 'utf-8');
        vscode.window.showInformationMessage(`Created ${envPath} — edit it with your PATs, then reload VS Code`);
        const doc = await vscode.workspace.openTextDocument(envPath);
        await vscode.window.showTextDocument(doc);
    }

    async initializeContextFlags(): Promise<void> {
        const jiraOk = await this.isJiraAuthenticated();
        const bbOk = await this.isBitbucketAuthenticated();
        await vscode.commands.executeCommand('setContext', 'devnexus.jiraAuthenticated', jiraOk);
        await vscode.commands.executeCommand('setContext', 'devnexus.bbAuthenticated', bbOk);
        if (jiraOk) {
            const creds = await this.getJiraCredentials();
            if (creds) {
                this.jiraUsername = creds.username;
                await this.fetchUserProfile(creds);
            }
        }
    }
}
