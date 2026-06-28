import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const JIRA_USER_KEY = 'devnexus.jira.username';
const JIRA_PAT_KEY = 'devnexus.jira.pat';
const BB_PAT_KEY = 'devnexus.bitbucket.pat';
const ENV_FILE_NAME = '.devnexus-env';

// Values from the bootstrap template that must NOT be treated as real credentials.
const PLACEHOLDER_VALUES = new Set([
    'your-jira-username',
    'your_jira_personal_access_token_here',
    'your_bitbucket_personal_access_token_here',
]);

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
    private log: vscode.OutputChannel;

    constructor(private context: vscode.ExtensionContext) {
        this.secrets = context.secrets;
        this.log = vscode.window.createOutputChannel('DevNexus Auth');
        context.subscriptions.push(this.log);
    }

    private getEnvFilePaths(): string[] {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const paths: string[] = [];
        if (home) { paths.push(path.join(home, ENV_FILE_NAME)); }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            paths.push(path.join(folder.uri.fsPath, ENV_FILE_NAME));
        }
        return paths;
    }

    private sanitizeValue(raw: string): string {
        let v = raw.trim();
        // Strip surrounding single or double quotes.
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.substring(1, v.length - 1);
        }
        return v;
    }

    private isPlaceholder(value: string): boolean {
        return !value || PLACEHOLDER_VALUES.has(value);
    }

    private readEnvFile(): Record<string, string> {
        const vars: Record<string, string> = {};
        for (const envPath of this.getEnvFilePaths()) {
            try {
                if (!fs.existsSync(envPath)) { continue; }
                const content = fs.readFileSync(envPath, 'utf-8');
                for (const line of content.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) { continue; }
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx > 0) {
                        const key = trimmed.substring(0, eqIdx).trim();
                        const value = this.sanitizeValue(trimmed.substring(eqIdx + 1));
                        if (this.isPlaceholder(value)) { continue; }
                        // First file wins so home overrides workspace; existing entries are kept.
                        if (!(key in vars)) { vars[key] = value; }
                    }
                }
                this.log.appendLine(`[env] loaded ${envPath}`);
            } catch (err: any) {
                this.log.appendLine(`[env] failed to read ${envPath}: ${err.message}`);
            }
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
        const secretUser = await this.secrets.get(JIRA_USER_KEY);
        const secretPat = await this.secrets.get(JIRA_PAT_KEY);
        let username = secretUser && !this.isPlaceholder(secretUser) ? secretUser : undefined;
        let pat = secretPat && !this.isPlaceholder(secretPat) ? secretPat : undefined;
        let source = username && pat ? 'secretStorage' : '';

        if (!username || !pat) {
            const envUser = process.env.JIRA_USER && !this.isPlaceholder(process.env.JIRA_USER) ? process.env.JIRA_USER : undefined;
            const envPat = process.env.JIRA_PAT && !this.isPlaceholder(process.env.JIRA_PAT) ? process.env.JIRA_PAT : undefined;
            username = username || envUser;
            pat = pat || envPat;
            if (username && pat && !source) { source = 'process.env'; }
        }

        if (!username || !pat) {
            const envFile = this.readEnvFile();
            username = username || envFile.JIRA_USER;
            pat = pat || envFile.JIRA_PAT;
            if (username && pat && !source) { source = `${ENV_FILE_NAME}`; }
        }

        if (!username || !pat) {
            this.log.appendLine('[jira] no credentials found in SecretStorage, process.env, or env file');
            return undefined;
        }

        this.log.appendLine(`[jira] credentials loaded from ${source} (user=${username})`);

        // Persist to SecretStorage only if values came from env (not already stored).
        if (!secretUser || !secretPat || this.isPlaceholder(secretUser) || this.isPlaceholder(secretPat)) {
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
            const baseUrl = config.get<string>('baseUrl', '').replace(/\/+$/, '');
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
        const secretPat = await this.secrets.get(BB_PAT_KEY);
        let pat = secretPat && !this.isPlaceholder(secretPat) ? secretPat : undefined;
        let source = pat ? 'secretStorage' : '';

        if (!pat) {
            const envPat = process.env.BITBUCKET_PAT && !this.isPlaceholder(process.env.BITBUCKET_PAT) ? process.env.BITBUCKET_PAT : undefined;
            pat = pat || envPat;
            if (pat && !source) { source = 'process.env'; }
        }

        if (!pat) {
            const envFile = this.readEnvFile();
            pat = pat || envFile.BITBUCKET_PAT;
            if (pat && !source) { source = ENV_FILE_NAME; }
        }

        if (!pat) {
            this.log.appendLine('[bb] no token found in SecretStorage, process.env, or env file');
            return undefined;
        }

        this.log.appendLine(`[bb] token loaded from ${source}`);

        if (!secretPat || this.isPlaceholder(secretPat)) {
            await this.secrets.store(BB_PAT_KEY, pat);
        }

        return pat;
    }

    async isBitbucketAuthenticated(): Promise<boolean> {
        const token = await this.getBitbucketToken();
        return token !== undefined;
    }

    async createEnvFile(): Promise<void> {
        // Prefer workspace folder if one is open; fall back to user home.
        const folder = vscode.workspace.workspaceFolders?.[0];
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const envPath = folder
            ? path.join(folder.uri.fsPath, ENV_FILE_NAME)
            : path.join(home, ENV_FILE_NAME);

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
        this.log.appendLine(`[init] jiraAuthenticated=${jiraOk} bbAuthenticated=${bbOk}`);
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
