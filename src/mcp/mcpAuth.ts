import * as fs from 'fs';
import * as path from 'path';
import { JiraClient, JiraCredentials } from '../api/jiraClient';
import { BitbucketClient, BitbucketConfig } from '../api/bitbucketClient';

export interface McpConfig {
    jiraBaseUrl: string;
    jiraUser: string;
    jiraPat: string;
    bbBaseUrl: string;
    bbProject: string;
    bbRepo: string;
    bbPat: string;
    jiraStartDateFieldId: string;
    jiraForecastDateFieldId: string;
    jiraDefaultProject: string;
}

const CONFIG_DIR  = path.join(process.env.USERPROFILE || process.env.HOME || '', '.devnexus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const CONFIG_TEMPLATE = {
    jira: {
        url:                 'https://jira.example.com',
        user:                'your.name@company.com',
        pat:                 'your-jira-personal-access-token',
        defaultProject:      'PROJ',
        startDateFieldId:    'customfield_56601',
        forecastDateFieldId: 'customfield_56806',
    },
    bitbucket: {
        url:     'https://bitbucket.example.com',
        project: 'PROJ',
        repo:    '',
        pat:     'your-bitbucket-personal-access-token',
    },
};

function createTemplate(): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG_TEMPLATE, null, 2), 'utf-8');
}

export function loadMcpConfig(): McpConfig {
    if (!fs.existsSync(CONFIG_FILE)) {
        createTemplate();
        throw new Error(
            `DevNexus MCP: config file not found.\n` +
            `A template has been created at: ${CONFIG_FILE}\n` +
            `Fill in your credentials and URLs, then restart the MCP server.`
        );
    }

    let raw: typeof CONFIG_TEMPLATE;
    try {
        raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
        throw new Error(`DevNexus MCP: failed to parse ${CONFIG_FILE}: ${e}`);
    }

    const cfg: McpConfig = {
        jiraBaseUrl:             raw.jira?.url                 ?? '',
        jiraUser:                raw.jira?.user                ?? '',
        jiraPat:                 raw.jira?.pat                 ?? '',
        jiraDefaultProject:      raw.jira?.defaultProject      ?? '',
        jiraStartDateFieldId:    raw.jira?.startDateFieldId    ?? 'customfield_56601',
        jiraForecastDateFieldId: raw.jira?.forecastDateFieldId ?? 'customfield_56806',
        bbBaseUrl:               raw.bitbucket?.url            ?? '',
        bbProject:               raw.bitbucket?.project        ?? '',
        bbRepo:                  raw.bitbucket?.repo           ?? '',
        bbPat:                   raw.bitbucket?.pat            ?? '',
    };

    const missing: string[] = [];
    if (!cfg.jiraBaseUrl) { missing.push('jira.url'); }
    if (!cfg.jiraUser)    { missing.push('jira.user'); }
    if (!cfg.jiraPat)     { missing.push('jira.pat'); }
    if (!cfg.bbBaseUrl)   { missing.push('bitbucket.url'); }
    if (!cfg.bbPat)       { missing.push('bitbucket.pat'); }

    if (missing.length > 0) {
        throw new Error(
            `DevNexus MCP: incomplete config in ${CONFIG_FILE}\n` +
            `Missing or empty fields: ${missing.join(', ')}`
        );
    }

    return cfg;
}

export function createClients(cfg: McpConfig): { jira: JiraClient; bb: BitbucketClient } {
    const jiraCreds: JiraCredentials = { username: cfg.jiraUser, pat: cfg.jiraPat };
    const jira = new JiraClient(cfg.jiraBaseUrl, jiraCreds);

    const bbCfg: BitbucketConfig = {
        baseUrl: cfg.bbBaseUrl,
        project: cfg.bbProject,
        repo: cfg.bbRepo,
    };
    const bb = new BitbucketClient(bbCfg, cfg.bbPat);

    return { jira, bb };
}
