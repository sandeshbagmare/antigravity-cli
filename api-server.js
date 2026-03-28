import express from 'express';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { OAuth2Client } from 'google-auth-library';
import {
    ANTIGRAVITY_SYSTEM_INSTRUCTION,
    ANTIGRAVITY_DEFAULT_PROJECT_ID,
    getAntigravityHeaders
} from 'opencode-antigravity-auth/dist/src/constants.js';
import { getValidTokens } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_CODE_BASE   = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_PROJECT_ID = ANTIGRAVITY_DEFAULT_PROJECT_ID || 'rising-fact-p41fc';
const KEYS_PATH          = path.resolve(process.cwd(), 'keys.json');

// Load OAuth credentials from config.json (same source as auth.js)
const _oauthConfig = await (async () => {
    try {
        const data = await fs.readFile(path.resolve(process.cwd(), 'config.json'), 'utf8');
        return JSON.parse(data);
    } catch {
        // Credentials loaded from opencode-antigravity-auth package at runtime
        // Copy config.example.json → config.json and fill in your values if needed
        return {
            CLIENT_ID: process.env.ANTIGRAVITY_CLIENT_ID || '',
            CLIENT_SECRET: process.env.ANTIGRAVITY_CLIENT_SECRET || '',
            REDIRECT_URI: 'http://localhost:57936/oauth-callback'
        };
    }
})();
const _CLIENT_ID     = _oauthConfig.CLIENT_ID;
const _CLIENT_SECRET = _oauthConfig.CLIENT_SECRET;
const _REDIRECT_URI  = _oauthConfig.REDIRECT_URI || 'http://localhost:57936/oauth-callback';

// ─── Static fallback model list ──────────────────────────────────────────────
const FALLBACK_MODELS = [
    { id: 'claude-opus-4-6-thinking', object: 'model', created: 1700000000, owned_by: 'antigravity' },
    { id: 'claude-sonnet-4-6',        object: 'model', created: 1700000000, owned_by: 'antigravity' },
    { id: 'gemini-3.1-pro-high',      object: 'model', created: 1700000000, owned_by: 'antigravity' },
    { id: 'gemini-3.1-pro-low',       object: 'model', created: 1700000000, owned_by: 'antigravity' },
    { id: 'gemini-3-flash-agent',     object: 'model', created: 1700000000, owned_by: 'antigravity' },
    { id: 'gpt-oss-120b-medium',      object: 'model', created: 1700000000, owned_by: 'antigravity' },
];

// ─── Load raw keys (full objects with refresh tokens) ────────────────────────
async function loadRawKeys() {
    try {
        const data = await fs.readFile(KEYS_PATH, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

async function saveRawKeys(keys) {
    await fs.writeFile(KEYS_PATH, JSON.stringify(keys, null, 2));
}

// ─── Fetch live models + quota for a single token ────────────────────────────
export async function fetchLiveModels(token) {
    try {
        const res = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...getAntigravityHeaders() },
            body: JSON.stringify({ project: DEFAULT_PROJECT_ID })
        });
        if (!res.ok) return null;
        const data = await res.json();
        const modelsObj = data.models || {};
        const now = Math.floor(Date.now() / 1000);
        const liveModels = Object.entries(modelsObj)
            .filter(([, entry]) => !entry.disabled)
            .map(([name, entry]) => ({
                // IMPORTANT: `name` (the map KEY) is what the API expects in the `model:` field
                // e.g. "gemini-3.1-pro-high", "claude-opus-4-6-thinking"
                id: name,
                internal_id: entry.model || name,   // e.g. MODEL_PLACEHOLDER_M37 (for reference only)
                object: 'model',
                created: now,
                owned_by: 'antigravity',
                display_name: entry.displayName || name,
                quota_remaining_pct: entry.quotaInfo ? Math.round(Number(entry.quotaInfo.remainingFraction || 0) * 100) : null,
                quota_reset_time: entry.quotaInfo?.resetTime || null,
                exhausted: entry.quotaInfo ? Number(entry.quotaInfo.remainingFraction || 0) <= 0.05 : false,
                beta: !!entry.beta,
            }));
        return liveModels.length > 0 ? liveModels : null;
    } catch { return null; }
}

// ─── Get full account info for UI ────────────────────────────────────────────
async function getAccountInfo(rawKey, index) {
    const token = rawKey.access_token;
    const info = {
        index,
        email: rawKey.email || null,
        status: 'unknown',        // active | expired | no_subscription
        auth_expires_in_min: null,
        models: [],
        has_claude: false,
        has_gemini: false,
    };

    // Check token validity
    try {
        const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
        if (r.ok) {
            const d = await r.json();
            info.auth_expires_in_min = Math.floor(parseInt(d.expires_in || 0) / 60);
            info.email = d.email || info.email;
            info.status = 'active';
        } else {
            info.status = 'expired';
            return info;
        }
    } catch { info.status = 'expired'; return info; }

    // Fetch quota/models
    const liveModels = await fetchLiveModels(token);
    if (liveModels) {
        info.models = liveModels;
        info.has_claude = liveModels.some(m => m.id.includes('claude'));
        info.has_gemini = liveModels.some(m => m.id.includes('gemini'));
    } else {
        info.status = 'active'; // token valid but no subscription quota endpoint
    }

    return info;
}

// ─── Soft quota check ─────────────────────────────────────────────────────────
async function softQuotaCheck(token, apiModel) {
    try {
        const qRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...getAntigravityHeaders() },
            body: JSON.stringify({ project: DEFAULT_PROJECT_ID })
        });
        if (!qRes.ok) return;
        const qData = await qRes.json();
        for (const [mName, entry] of Object.entries(qData.models || {})) {
            if ((mName.includes(apiModel) || apiModel.includes(mName)) && entry?.quotaInfo) {
                const rf = Number(entry.quotaInfo.remainingFraction || 0);
                if (rf <= 0.05) throw new Error(`Soft Quota Exceeded: Only ${Math.round(rf * 100)}% remaining.`);
            }
        }
    } catch (e) { if (e.message.includes('Soft Quota')) throw e; }
}

// ─── SSE stream parser helper ─────────────────────────────────────────────────
async function streamAntigravity({ token, apiModel, conversationParts, systemPrompt, temperature, maxOutputTokens, onChunk }) {
    const isApiKey = token?.startsWith('AIza');
    let url, headers, body;

    if (isApiKey) {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:streamGenerateContent?alt=sse&key=${token}`;
        headers = { 'Content-Type': 'application/json' };
        body = { contents: conversationParts, generationConfig: { temperature, maxOutputTokens } };
    } else {
        url = `${CLOUD_CODE_BASE}/v1internal:streamGenerateContent?alt=sse`;
        headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...getAntigravityHeaders() };
        body = {
            project: DEFAULT_PROJECT_ID, model: apiModel,
            request: {
                contents: conversationParts,
                systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
                generationConfig: { temperature, maxOutputTokens }
            }
        };
        if (apiModel.includes('thinking') || apiModel.includes('gemini-3')) {
            if (apiModel.includes('claude') || apiModel.includes('sonnet'))
                body.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: 1024 };
            else {
                const level = apiModel.includes('low') ? 'low' : apiModel.includes('high') ? 'high' : 'medium';
                body.request.generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
            }
        }
    }

    const fetchRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!fetchRes.ok) throw new Error(`${fetchRes.status} - ${await fetchRes.text()}`);

    const reader = fetchRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('data: ');
        buffer = blocks.pop();
        for (let block of blocks) {
            block = block.trim();
            if (!block || block === '[DONE]') continue;
            try {
                const parsed = JSON.parse(block.split('\n')[0]);
                if (parsed.error) throw new Error(`API Error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                const candidate = parsed.response?.candidates?.[0] || parsed.candidates?.[0] || parsed[0]?.candidates?.[0];
                if (candidate?.content?.parts) {
                    for (const part of candidate.content.parts) {
                        let textChunk = '', isThought = false;
                        if (typeof part.thought === 'string') { isThought = true; textChunk = part.thought; }
                        else if (part.text) { textChunk = part.text; isThought = part.thought === true || part.isThought === true; }
                        if (textChunk) { fullText += textChunk; await onChunk(textChunk, isThought, part); }
                    }
                }
            } catch (e) { if (e.message?.includes('API Error')) throw e; }
        }
    }
    return fullText;
}

// =============================================================================
export async function startApiServer(port) {
    const app = express();
    const serverStart = Date.now();
    app.use(express.json({ limit: '50mb' }));

    // ─── CORS ────────────────────────────────────────────────────────────────
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    // ─── Serve frontend UI ───────────────────────────────────────────────────
    app.use(express.static(path.join(__dirname, 'public')));

    let currentKeyIndex = 0;
    const getKeys = () => getValidTokens();

    // =========================================================================
    // DASHBOARD API ENDPOINTS
    // =========================================================================

    // GET /api/status — server info
    app.get('/api/status', async (req, res) => {
        const keys = await getKeys();
        res.json({ status: 'ok', port, uptime_ms: Date.now() - serverStart, accounts: keys.length, version: '2.0.0' });
    });

    // GET /api/accounts — full account info with quota
    app.get('/api/accounts', async (req, res) => {
        const rawKeys = await loadRawKeys();
        const results = await Promise.all(rawKeys.map((k, i) => getAccountInfo(k, i)));
        res.json({ accounts: results });
    });

    // POST /api/login — start OAuth, return the URL for the UI to open
    app.post('/api/login', async (req, res) => {
        try {
            const oauthApp = express();
            const oauth2Client = new OAuth2Client(_CLIENT_ID, _CLIENT_SECRET, _REDIRECT_URI);

            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: [
                    'https://www.googleapis.com/auth/cloud-platform',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/cclog',
                    'https://www.googleapis.com/auth/experimentsandconfigs'
                ],
                prompt: 'consent'
            });

            // Start a temporary OAuth callback server on 57936
            const oauthServer = oauthApp.listen(57936, () => {});
            oauthApp.get('/oauth-callback', async (cbReq, cbRes) => {
                try {
                    const code = cbReq.query.code;
                    if (!code) throw new Error('No authorization code');
                    const { tokens } = await oauth2Client.getToken(code);

                    const rawKeys = await loadRawKeys();
                    const existingIndex = rawKeys.findIndex(k => k.refresh_token && k.refresh_token === tokens.refresh_token);
                    if (existingIndex > -1) rawKeys[existingIndex] = { ...rawKeys[existingIndex], ...tokens };
                    else rawKeys.push({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expiry_date: tokens.expiry_date });
                    await saveRawKeys(rawKeys);

                    cbRes.send(`<html><body style="font-family:Inter,sans-serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0"><div style="text-align:center;background:white;padding:48px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)"><div style="font-size:48px">✅</div><h2 style="color:#16a34a;margin:16px 0 8px">Account Connected!</h2><p style="color:#64748b">You can close this tab and return to the dashboard.</p></div></body></html>`);
                    console.log(chalk.green('\n[Auth] New account connected via UI.'));
                    oauthServer.close();
                } catch (err) {
                    cbRes.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
                    oauthServer.close();
                }
            });

            res.json({ url: authUrl });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /api/accounts/:index — remove an account
    app.delete('/api/accounts/:index', async (req, res) => {
        try {
            const idx = parseInt(req.params.index, 10);
            const rawKeys = await loadRawKeys();
            if (idx < 0 || idx >= rawKeys.length) return res.status(404).json({ error: 'Account not found' });
            rawKeys.splice(idx, 1);
            await saveRawKeys(rawKeys);
            res.json({ success: true, accounts_remaining: rawKeys.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/models — live model list (also available as /v1/models)
    app.get('/api/models', async (req, res) => {
        const keys = await getKeys();
        let models = null;
        if (keys.length > 0) models = await fetchLiveModels(keys[currentKeyIndex] || keys[0]);
        if (!models) models = FALLBACK_MODELS.map(m => ({ ...m, quota_remaining_pct: null, exhausted: false }));
        else console.log(chalk.green(`[Models] Fetched ${models.length} live models`));
        res.json({ models });
    });

    // =========================================================================
    // OPENAI-COMPATIBLE API ENDPOINTS
    // =========================================================================

    // GET /v1/models
    app.get('/v1/models', async (req, res) => {
        const keys = await getKeys();
        let models = null;
        if (keys.length > 0) models = await fetchLiveModels(keys[currentKeyIndex] || keys[0]);
        if (!models) models = FALLBACK_MODELS;
        res.json({ object: 'list', data: models });
    });

    // ── POST /v1/chat/completions ─────────────────────────────────────────────
    app.post('/v1/chat/completions', async (req, res) => {
        try {
            const keys = await getKeys();
            if (keys.length === 0) return res.status(401).json({ error: "No auth tokens. Run 'node index.js login' or use the UI." });

            const { messages = [], stream = false, temperature = 0.7, max_tokens = 8192 } = req.body;
            const apiModel = (req.body.model || 'gemini-3.1-pro-high').replace(/^antigravity-/i, '');
            const systemMsg = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');

            let parts = [];
            for (const msg of messages) {
                if (msg.role === 'system') continue;
                const text = typeof msg.content === 'string' ? msg.content :
                    Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
                if (text) parts.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
            }
            // Merge consecutive same-role
            const merged = [];
            for (const p of parts) {
                if (merged.length && merged[merged.length-1].role === p.role)
                    merged[merged.length-1].parts[0].text += '\n' + p.parts[0].text;
                else merged.push(p);
            }
            if (merged.length === 0) return res.status(400).json({ error: 'No valid messages.' });

            if (stream) { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); }

            let success = false, retries = 0;
            while (!success && retries < keys.length) {
                try {
                    if (!keys[currentKeyIndex].startsWith('AIza') && keys.length > 1)
                        await softQuotaCheck(keys[currentKeyIndex], apiModel);
                    console.log(chalk.cyan(`[Chat] Model=${apiModel}, Acct=${currentKeyIndex+1}/${keys.length}, Stream=${stream}`));

                    const fullText = await streamAntigravity({
                        token: keys[currentKeyIndex], apiModel,
                        conversationParts: merged,
                        systemPrompt: systemMsg || ANTIGRAVITY_SYSTEM_INSTRUCTION,
                        temperature, maxOutputTokens: max_tokens,
                        onChunk: async (text, isThought) => {
                            if (!stream) return;
                            const delta = isThought ? { reasoning_content: text } : { content: text };
                            res.write(`data: ${JSON.stringify({ id:'chatcmpl-'+Date.now(), object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:apiModel, choices:[{delta, index:0, finish_reason:null}] })}\n\n`);
                        }
                    });

                    if (!fullText.trim()) throw new Error('Empty response');
                    if (stream) { res.write('data: [DONE]\n\n'); res.end(); }
                    else res.json({ id:'chatcmpl-'+Date.now(), object:'chat.completion', created:Math.floor(Date.now()/1000), model:apiModel, choices:[{index:0, message:{role:'assistant',content:fullText}, finish_reason:'stop'}], usage:{prompt_tokens:0, completion_tokens:0, total_tokens:0} });
                    success = true;
                    console.log(chalk.green(`[Chat] Done. Model=${apiModel}`));
                } catch (err) {
                    console.error(chalk.yellow(`[Chat Error] Acct-${currentKeyIndex+1}: `) + chalk.gray(err.message));
                    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
                    retries++;
                }
            }
            if (!success && !res.headersSent) res.status(500).json({ error: 'All tokens exhausted.' });
            else if (!success) res.end();
        } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
    });

    // ── POST /v1/messages (Anthropic Claude Code compatibility) ───────────────
    app.post('/v1/messages', async (req, res) => {
        try {
            const keys = await getKeys();
            if (keys.length === 0) return res.status(401).json({ type:'error', error:{type:'authentication_error', message:"No auth tokens."} });

            const { messages=[], system='', tools, stream=false, max_tokens=8192, temperature=0.7 } = req.body;
            let apiModel = (req.body.model || 'claude-opus-4-6-thinking').replace(/^antigravity-/i, '');

            // Tools translation
            let geminiTools;
            if (tools?.length) {
                const cleanSchema = (obj, isMap=false) => {
                    if (!obj || typeof obj !== 'object') return obj;
                    if (Array.isArray(obj)) return obj.map(x => cleanSchema(x));
                    const allowed = ['type','description','properties','required','items','enum'];
                    const out = {};
                    for (const [k,v] of Object.entries(obj)) {
                        if (isMap) out[k] = cleanSchema(v);
                        else if (allowed.includes(k)) {
                            if (k==='type') out[k] = Array.isArray(v) ? (v.find(t=>t!=='null')||'STRING').toUpperCase() : v.toUpperCase();
                            else if (k==='properties') out[k] = cleanSchema(v, true);
                            else out[k] = cleanSchema(v);
                        }
                    }
                    if (!isMap) { if (out.properties && !out.type) out.type='OBJECT'; if (!out.type && !out.properties && !out.items) out.type='STRING'; }
                    return out;
                };
                geminiTools = [{ functionDeclarations: tools.map(t => ({ name:t.name, description:t.description||'', parameters: t.input_schema ? cleanSchema(t.input_schema) : {type:'OBJECT',properties:{}} })) }];
            }

            let parts = [], toolIdToName = {};
            for (const msg of messages) {
                let p = [];
                if (typeof msg.content === 'string') p.push({text: msg.content});
                else if (Array.isArray(msg.content)) {
                    for (const b of msg.content) {
                        if (b.type==='text') p.push({text:b.text});
                        else if (b.type==='tool_use') { toolIdToName[b.id]=b.name; p.push({functionCall:{id:b.id,name:b.name,args:b.input}}); }
                        else if (b.type==='tool_result') { const fn=toolIdToName[b.tool_use_id]||'unknown'; p.push({functionResponse:{id:b.tool_use_id,name:fn,response:{content:typeof b.content==='string'?b.content:JSON.stringify(b.content)}}}); }
                    }
                }
                const role = (msg.role==='assistant'||msg.role==='model') ? 'model' : 'user';
                if (p.length) parts.push({role, parts:p});
            }
            // Merge consecutive same-role
            const merged = [];
            for (const p of parts) {
                if (merged.length && merged[merged.length-1].role===p.role) merged[merged.length-1].parts.push(...p.parts);
                else merged.push(p);
            }
            if (merged.length === 0) return res.status(400).json({type:'error', error:{type:'invalid_request_error', message:'No prompt.'}});

            let sysPrompt = typeof system==='string' ? system : system.filter(b=>b.type==='text').map(b=>b.text).join('\n');

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive');
                res.write(`event: message_start\ndata: ${JSON.stringify({type:'message_start',message:{id:'msg_'+Date.now(),type:'message',role:'assistant',content:[],model:apiModel,stop_reason:null,usage:{input_tokens:0,output_tokens:0}}})}\n\n`);
            }

            let success=false, retries=0, hasTriedFallback=false;
            while (!success && retries < keys.length) {
                try {
                    if (!keys[currentKeyIndex].startsWith('AIza') && keys.length>1) await softQuotaCheck(keys[currentKeyIndex], apiModel);
                    const fetchRes = await fetch(`${CLOUD_CODE_BASE}/v1internal:streamGenerateContent?alt=sse`, {
                        method:'POST',
                        headers:{'Authorization':`Bearer ${keys[currentKeyIndex]}`,'Content-Type':'application/json',...getAntigravityHeaders()},
                        body: JSON.stringify({project:DEFAULT_PROJECT_ID, model:apiModel, request:{contents:merged, tools:geminiTools, systemInstruction:sysPrompt?{parts:[{text:sysPrompt}]}:undefined, generationConfig:{temperature, maxOutputTokens:max_tokens, thinkingConfig:{includeThoughts:true,thinkingBudget:1024}}}})
                    });
                    if (!fetchRes.ok) throw new Error(`${fetchRes.status} - ${await fetchRes.text()}`);

                    const reader=fetchRes.body.getReader(), dec=new TextDecoder();
                    let fullText='', buf='', hasText=false, bi=0, stopReason='end_turn', tools_collected=[], inThought=false;

                    while (true) {
                        const {done,value} = await reader.read(); if(done)break;
                        buf += dec.decode(value,{stream:true});
                        const blocks = buf.split('data: '); buf=blocks.pop();
                        for (let blk of blocks) {
                            blk=blk.trim(); if(!blk||blk==='[DONE]') continue;
                            try {
                                const p=JSON.parse(blk.split('\n')[0]);
                                if(p.error) throw new Error(`API Error: ${p.error.message}`);
                                const cand=p.response?.candidates?.[0]||p.candidates?.[0];
                                if(cand?.content?.parts) for(const part of cand.content.parts) {
                                    let chunk='', isThought=false;
                                    if(typeof part.thought==='string'){isThought=true;chunk=part.thought;}
                                    else if(part.text){chunk=part.text; isThought=part.thought===true||part.isThought===true;}
                                    if(chunk){
                                        let fmt='';
                                        if(isThought&&!inThought){inThought=true;fmt='<think>\n'+chunk;}
                                        else if(!isThought&&inThought){inThought=false;fmt='\n</think>\n\n'+chunk;}
                                        else fmt=chunk;
                                        fullText+=fmt;
                                        if(stream){
                                            if(!hasText){res.write(`event: content_block_start\ndata: ${JSON.stringify({type:'content_block_start',index:bi,content_block:{type:'text',text:''}})}\n\n`);hasText=true;}
                                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({type:'content_block_delta',index:bi,delta:{type:'text_delta',text:fmt}})}\n\n`);
                                        }
                                    } else if(part.functionCall) {
                                        const fn=part.functionCall.name, args=part.functionCall.args||{}, tid=part.functionCall.id||('toolu_'+Date.now());
                                        tools_collected.push({type:'tool_use',id:tid,name:fn,input:args});
                                        if(stream){
                                            if(hasText){if(inThought){fullText+='\n</think>\n\n';res.write(`event: content_block_delta\ndata: ${JSON.stringify({type:'content_block_delta',index:bi,delta:{type:'text_delta',text:'\n</think>\n\n'}})}\n\n`);inThought=false;}res.write(`event: content_block_stop\ndata: ${JSON.stringify({type:'content_block_stop',index:bi})}\n\n`);bi++;hasText=false;}
                                            res.write(`event: content_block_start\ndata: ${JSON.stringify({type:'content_block_start',index:bi,content_block:{type:'tool_use',id:tid,name:fn,input:{}}})}\n\n`);
                                            res.write(`event: content_block_delta\ndata: ${JSON.stringify({type:'content_block_delta',index:bi,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}})}\n\n`);
                                            res.write(`event: content_block_stop\ndata: ${JSON.stringify({type:'content_block_stop',index:bi})}\n\n`);
                                            bi++; stopReason='tool_use';
                                        }
                                    }
                                }
                            } catch(e){if(e.message?.includes('API Error'))throw e;}
                        }
                    }
                    if(inThought){fullText+='\n</think>\n\n';if(stream&&hasText)res.write(`event: content_block_delta\ndata: ${JSON.stringify({type:'content_block_delta',index:bi,delta:{type:'text_delta',text:'\n</think>\n\n'}})}\n\n`);}
                    if(!fullText.trim()&&tools_collected.length===0) throw new Error('Empty response');

                    if(stream){
                        if(hasText)res.write(`event: content_block_stop\ndata: ${JSON.stringify({type:'content_block_stop',index:bi})}\n\n`);
                        res.write(`event: message_delta\ndata: ${JSON.stringify({type:'message_delta',delta:{stop_reason:stopReason},usage:{output_tokens:fullText.length}})}\n\n`);
                        res.write(`event: message_stop\ndata: ${JSON.stringify({type:'message_stop'})}\n\n`);
                        res.end();
                    } else {
                        const content=fullText?[{type:'text',text:fullText}]:[];
                        content.push(...tools_collected);
                        res.json({id:'msg_'+Date.now(),type:'message',role:'assistant',content,model:apiModel,stop_reason:stopReason,usage:{input_tokens:0,output_tokens:fullText.length}});
                    }
                    success=true; console.log(chalk.green(`[Messages] Done.`));
                } catch(err) {
                    console.error(chalk.yellow(`[Messages Error] Acct-${currentKeyIndex+1}: `)+chalk.gray(err.message));
                    currentKeyIndex=(currentKeyIndex+1)%keys.length; retries++;
                    if(retries>=keys.length&&!hasTriedFallback&&(apiModel.includes('claude-opus')||apiModel.includes('claude-sonnet'))){
                        console.log(chalk.magenta('[Fallback] Switching to gemini-3.1-pro-high'));
                        apiModel='gemini-3.1-pro-high'; retries=0; hasTriedFallback=true;
                    }
                }
            }
            if(!success&&!res.headersSent) res.status(500).json({error:{message:'All tokens exhausted.'}});
        } catch(e){if(!res.headersSent)res.status(500).json({error:{message:e.message}});}
    });

    // ── POST /v1/responses (OpenAI Codex) ────────────────────────────────────
    app.post('/v1/responses', async (req, res) => {
        try {
            const keys = await getKeys();
            if (keys.length === 0) return res.status(401).json({ error: { message: "No auth tokens." } });

            const { input='', instructions='', stream=false, max_output_tokens=8192, temperature=0.7 } = req.body;
            let apiModel = (req.body.model||'claude-opus-4-6-thinking').replace(/^antigravity-/i,'');

            let parts=[], sysPrompt=instructions||'';
            if(typeof input==='string') parts.push({role:'user',parts:[{text:input}]});
            else if(Array.isArray(input)) for(const item of input){
                if(typeof item==='string') parts.push({role:'user',parts:[{text:item}]});
                else if(item.role&&item.content){
                    let txt='';
                    if(typeof item.content==='string') txt=item.content;
                    else if(Array.isArray(item.content)) txt=item.content.filter(b=>b.type==='input_text'||b.type==='text').map(b=>b.text).join('\n');
                    if(item.role==='system') sysPrompt=txt||sysPrompt;
                    else if(txt) parts.push({role:(item.role==='assistant'||item.role==='model')?'model':'user',parts:[{text:txt}]});
                }
            }
            const merged=[];
            for(const p of parts){if(merged.length&&merged[merged.length-1].role===p.role)merged[merged.length-1].parts[0].text+='\n'+p.parts[0].text;else merged.push(p);}
            if(merged.length===0) return res.status(400).json({error:{message:'No valid input.'}});

            if(stream){
                res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');
                const rid='resp_'+Date.now();
                res.write(`event: response.created\ndata: ${JSON.stringify({type:'response.created',response:{id:rid,object:'response',status:'in_progress',output:[]}})}\n\n`);
                res.write(`event: response.output_item.added\ndata: ${JSON.stringify({type:'response.output_item.added',output_index:0,item:{type:'message',role:'assistant',content:[]}})}\n\n`);
                res.write(`event: response.content_part.added\ndata: ${JSON.stringify({type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:''}})}\n\n`);
            }

            let success=false,retries=0,hasTriedFallback=false;
            while(!success&&retries<keys.length){
                try{
                    if(!keys[currentKeyIndex].startsWith('AIza')&&keys.length>1) await softQuotaCheck(keys[currentKeyIndex],apiModel);
                    const fetchRes=await fetch(`${CLOUD_CODE_BASE}/v1internal:streamGenerateContent?alt=sse`,{method:'POST',headers:{'Authorization':`Bearer ${keys[currentKeyIndex]}`,'Content-Type':'application/json',...getAntigravityHeaders()},body:JSON.stringify({project:DEFAULT_PROJECT_ID,model:apiModel,request:{contents:merged,systemInstruction:sysPrompt?{parts:[{text:sysPrompt}]}:undefined,generationConfig:{temperature,maxOutputTokens:max_output_tokens,thinkingConfig:{includeThoughts:true,thinkingBudget:1024}}}})});
                    if(!fetchRes.ok)throw new Error(`${fetchRes.status} - ${await fetchRes.text()}`);
                    const reader=fetchRes.body.getReader(),dec=new TextDecoder();
                    let fullText='',buf='';
                    while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const blocks=buf.split('data: ');buf=blocks.pop();for(let blk of blocks){blk=blk.trim();if(!blk||blk==='[DONE]')continue;try{const p=JSON.parse(blk.split('\n')[0]);if(p.error)throw new Error(`API Error: ${p.error.message}`);const cand=p.response?.candidates?.[0]||p.candidates?.[0];if(cand?.content?.parts)for(const part of cand.content.parts){const isThought=typeof part.thought==='string'||part.thought===true||part.isThought===true;const txt=part.text&&!isThought?part.text:'';if(txt){fullText+=txt;if(stream)res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',output_index:0,content_index:0,delta:txt})}\n\n`);}}}catch(e){if(e.message?.includes('API Error'))throw e;}}}
                    if(!fullText.trim())throw new Error('Empty response');
                    if(stream){res.write(`event: response.output_text.done\ndata: ${JSON.stringify({type:'response.output_text.done',output_index:0,content_index:0,text:fullText})}\n\n`);res.write(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:{id:'resp_'+Date.now(),object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:fullText}]}],usage:{input_tokens:0,output_tokens:fullText.length,total_tokens:fullText.length}}})}\n\n`);res.end();}
                    else res.json({id:'resp_'+Date.now(),object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:fullText}]}],usage:{input_tokens:0,output_tokens:fullText.length,total_tokens:fullText.length}});
                    success=true;
                }catch(err){
                    console.error(chalk.yellow(`[Responses Error] Acct-${currentKeyIndex+1}: `)+chalk.gray(err.message));
                    currentKeyIndex=(currentKeyIndex+1)%keys.length;retries++;
                    if(retries>=keys.length&&!hasTriedFallback&&(apiModel.includes('claude-opus')||apiModel.includes('claude-sonnet'))){apiModel='gemini-3.1-pro-high';retries=0;hasTriedFallback=true;}
                }
            }
            if(!success&&!res.headersSent)res.status(500).json({error:{message:'All tokens exhausted.'}});
        }catch(e){if(!res.headersSent)res.status(500).json({error:{message:e.message}});}
    });

    // ─── Health ───────────────────────────────────────────────────────────────
    app.get('/health', (req, res) => res.json({ status: 'ok', server: 'antigravity-cli', version: '2.0.0', port }));

    // ─── Start ────────────────────────────────────────────────────────────────
    app.listen(port, () => {
        console.log('\n' + chalk.bgWhite.black.bold('  🌐 ANTIGRAVITY CLI  ') + chalk.bgGreen.white.bold(' ONLINE '));
        console.log(chalk.white(`\n  UI       : ${chalk.cyan.underline(`http://localhost:${port}`)}`));
        console.log(chalk.white(`  Models   : ${chalk.cyan.underline(`http://localhost:${port}/v1/models`)}`));
        console.log(chalk.white(`  Chat     : ${chalk.cyan.underline(`http://localhost:${port}/v1/chat/completions`)}`));
        console.log(chalk.white(`  Health   : ${chalk.cyan.underline(`http://localhost:${port}/health`)}`));
        console.log(chalk.gray('\n  Open the UI in your browser to manage accounts and test models.\n'));
    });
}
