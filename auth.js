import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { OAuth2Client } from 'google-auth-library';

// OAuth credentials are stored in config.json (gitignored).
// Copy config.example.json → config.json and fill in your values if needed.
// The opencode-antigravity-auth package provides defaults for Antigravity IDE users.

async function loadConfig() {
    try {
        const configPath = path.resolve(process.cwd(), 'config.json');
        const data = await fs.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch {
        // Default: credentials from opencode-antigravity-auth package
        return {
            CLIENT_ID: process.env.ANTIGRAVITY_CLIENT_ID || '',
            CLIENT_SECRET: process.env.ANTIGRAVITY_CLIENT_SECRET || '',
            REDIRECT_URI: 'http://localhost:57936/oauth-callback'
        };
    }
}

const config = await (async () => {
    return await loadConfig();
})();

const oauth2Client = new OAuth2Client(config.CLIENT_ID, config.CLIENT_SECRET, config.REDIRECT_URI);

// Loads all tokens from keys.json. Auto-refreshes any that expire within 5 minutes.
export async function getValidTokens() {
    const keysPath = path.resolve(process.cwd(), 'keys.json');
    let rawKeys;
    try {
        rawKeys = await fs.readFile(keysPath, 'utf8');
    } catch (e) {
        return [];
    }

    let parsed = [];
    try {
        parsed = JSON.parse(rawKeys);
    } catch (e) {
        return [];
    }

    let updated = false;

    for (let i = 0; i < parsed.length; i++) {
        let account = parsed[i];

        // Backward compatibility: convert plain string tokens to objects
        if (typeof account === 'string') {
            account = { access_token: account, refresh_token: null, expiry_date: null };
            parsed[i] = account;
            updated = true;
        }

        // Token validity check
        if (account.refresh_token && account.expiry_date) {
            // Refresh if expired or less than 5 minutes remaining
            if (Date.now() > account.expiry_date - 5 * 60000) {
                try {
                    oauth2Client.setCredentials({ refresh_token: account.refresh_token });
                    const { credentials } = await oauth2Client.refreshAccessToken();
                    account.access_token = credentials.access_token;
                    account.expiry_date = credentials.expiry_date;
                    if (credentials.refresh_token) {
                        account.refresh_token = credentials.refresh_token;
                    }
                    updated = true;
                    console.log(chalk.green(`\n[Auth] Token-${i + 1} auto-refreshed successfully.`));
                } catch (e) {
                    console.log(chalk.red(`\n[Auth Error] Token-${i + 1} auto-refresh failed: ${e.message}`));
                }
            }
        }
    }

    if (updated) {
        await fs.writeFile(keysPath, JSON.stringify(parsed, null, 2));
    }

    // Return plain access_token strings for backward compatibility
    return parsed.map(p => p.access_token).filter(k => k && k.length > 10);
}
