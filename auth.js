import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { OAuth2Client } from 'google-auth-library';
import {
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
} from 'opencode-antigravity-auth/dist/src/constants.js';

// ─── OAuth client setup ───────────────────────────────────────────────────────
// Credentials come from the opencode-antigravity-auth package (installed via npm).
// Override via config.json if needed: { "CLIENT_ID": "...", "CLIENT_SECRET": "...", "REDIRECT_URI": "..." }
const REDIRECT_URI = 'http://localhost:57936/oauth-callback';

async function loadConfig() {
    try {
        const configPath = path.resolve(process.cwd(), 'config.json');
        const data = await fs.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch {
        // Default: use credentials from opencode-antigravity-auth npm package
        return {
            CLIENT_ID: ANTIGRAVITY_CLIENT_ID,
            CLIENT_SECRET: ANTIGRAVITY_CLIENT_SECRET,
            REDIRECT_URI,
        };
    }
}

const config = await loadConfig();
const oauth2Client = new OAuth2Client(config.CLIENT_ID, config.CLIENT_SECRET, config.REDIRECT_URI);

// ─── Token management ─────────────────────────────────────────────────────────
// Loads all tokens from keys.json. Auto-refreshes any that expire within 5 minutes.
export async function getValidTokens() {
    const keysPath = path.resolve(process.cwd(), 'keys.json');
    let rawKeys;
    try {
        rawKeys = await fs.readFile(keysPath, 'utf8');
    } catch {
        return [];
    }

    let parsed = [];
    try {
        parsed = JSON.parse(rawKeys);
    } catch {
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

        // Auto-refresh if expired or less than 5 minutes remaining
        if (account.refresh_token && account.expiry_date) {
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
