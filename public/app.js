/* ============================================================
   Antigravity CLI Dashboard — app.js
   Pure JS SPA. No frameworks. Connects to local Express API.
   ============================================================ */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  port: location.port || 6012,
  accounts: [],
  models: [],
  serverOnline: false,
  loginUrl: null,
  pollInterval: null,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const el = (tag, cls, html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; e.innerHTML = html; return e; };

// ── Navigation ────────────────────────────────────────────────────────────────
const pages = { dashboard: 'Dashboard', accounts: 'Accounts', models: 'Models', tester: 'API Tester', settings: 'Settings' };
const subtitles = {
  dashboard: 'Overview of your Antigravity CLI server',
  accounts: 'Manage your connected Google accounts',
  models: 'Available AI models and quota status',
  tester: 'Send requests and test the API',
  settings: 'Endpoints, IDE integration, and configuration',
};

function navigate(page) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  $$('.page-content').forEach(p => p.classList.toggle('hidden', p.id !== `page-${page}`));
  $('#page-title').textContent = pages[page] || page;
  $('#page-subtitle').textContent = subtitles[page] || '';
  localStorage.setItem('ag_page', page);
  if (page === 'models') renderModels();
  if (page === 'settings') renderSettings();
}

$$('.nav-item').forEach(n => n.addEventListener('click', e => { e.preventDefault(); navigate(n.dataset.page); }));

// ── API calls ─────────────────────────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const r = await fetch(`${location.origin}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
  return r.json();
};

// ── Init & polling ────────────────────────────────────────────────────────────
async function init() {
  try {
    const status = await api('/api/status');
    state.serverOnline = true;
    state.port = status.port;
    updateServerPill(true, status.uptime_ms);
    $('#stat-uptime').textContent = formatUptime(status.uptime_ms);
    $('#stat-endpoint').textContent = `localhost:${status.port}`;
    $('#qs-endpoint').textContent = `http://localhost:${status.port}/v1`;
  } catch {
    state.serverOnline = false;
    updateServerPill(false);
  }

  await Promise.all([fetchAccounts(), fetchModels()]);

  const savedPage = localStorage.getItem('ag_page') || 'dashboard';
  navigate(savedPage);

  // Poll every 30 seconds
  clearInterval(state.pollInterval);
  state.pollInterval = setInterval(refreshAll, 30000);
}

async function fetchAccounts() {
  try {
    const data = await api('/api/accounts');
    state.accounts = data.accounts || [];
    renderDashboardAccounts();
    renderAccountsPage();
    const activeCount = state.accounts.filter(a => a.status === 'active').length;
    $('#stat-accounts').textContent = activeCount;
    $('#nav-accounts-badge').textContent = state.accounts.length;
  } catch (e) {
    console.error('Accounts fetch failed', e);
  }
}

async function fetchModels() {
  try {
    const data = await api('/api/models');
    // Filter out internal/tab models with no real display names
    const raw = data.models || [];
    state.models = raw.filter(m =>
      m.display_name &&
      !m.display_name.startsWith('tab_') &&
      !m.display_name.startsWith('chat_')
    );
    $('#stat-models').textContent = state.models.length;
    renderModels();
    populateTesterModelSelect();
  } catch (e) {
    state.models = [];
  }
}

async function refreshAll() {
  await init();
  toast('Refreshed', 'info');
}

// ── Server pill ───────────────────────────────────────────────────────────────
function updateServerPill(online, uptime_ms) {
  const pill = $('#server-pill');
  pill.classList.toggle('offline', !online);
  const txt = online ? `Server Online` : 'Server Offline';
  $('#server-status-text').textContent = txt;
}

// ── Dashboard: account health ─────────────────────────────────────────────────
function renderDashboardAccounts() {
  const wrap = $('#dash-accounts-list');
  if (state.accounts.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🔐</div><div class="empty-title">No accounts connected</div><p class="empty-body">Click "Add Account" to connect your Google One AI Premium account.</p></div>`;
    return;
  }
  wrap.innerHTML = '';
  state.accounts.forEach((acc, i) => {
    const item = el('div', 'account-item');
    const initial = (acc.email || `A${i + 1}`)[0].toUpperCase();
    const badgeHtml = statusBadge(acc.status, acc.models);
    const quotaHtml = acc.models?.length > 0
      ? acc.models.slice(0, 2).map(m => `<div class="quota-bar-wrap" title="${m.id}">
          ${quotaBar(m.quota_remaining_pct)}
          <span class="quota-label ${quotaColor(m.quota_remaining_pct)}">${m.quota_remaining_pct != null ? m.quota_remaining_pct + '%' : '—'}</span>
        </div>`).join('')
      : '';

    item.innerHTML = `
      <div class="account-avatar">${initial}</div>
      <div class="account-info">
        <div class="account-email">${acc.email || `Account ${i + 1}`}</div>
        <div class="account-sub">Expires in ${acc.auth_expires_in_min != null ? acc.auth_expires_in_min + ' min' : '—'}</div>
        ${quotaHtml}
      </div>
      <div class="account-actions">${badgeHtml}</div>`;
    wrap.appendChild(item);
  });
}

// ── Accounts page ─────────────────────────────────────────────────────────────
function renderAccountsPage() {
  const wrap = $('#accounts-list');
  if (state.accounts.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🔐</div><div class="empty-title">No accounts connected</div><p class="empty-body">Click "Connect Google Account" above to get started.</p></div>`;
    return;
  }

  const tableWrap = el('div', 'accounts-table-wrap');
  const table = el('table', 'accounts-table');
  table.innerHTML = `<thead><tr>
    <th>Account</th>
    <th>Status</th>
    <th>Auth Expires</th>
    <th>Claude</th>
    <th>Gemini</th>
    <th>Models</th>
    <th></th>
  </tr></thead>`;
  const tbody = el('tbody');

  state.accounts.forEach((acc, i) => {
    const tr = el('tr');
    const initial = (acc.email || `A${i + 1}`)[0].toUpperCase();

    // Best quota for Claude and Gemini
    const claudeModel = acc.models?.find(m => m.id?.includes('claude'));
    const geminiModel = acc.models?.find(m => m.id?.includes('gemini'));

    tr.innerHTML = `
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="account-avatar" style="width:32px;height:32px;font-size:12px">${initial}</div>
          <div>
            <div style="font-weight:600;font-size:13px">${acc.email || `Account ${i + 1}`}</div>
            <div style="font-size:11.5px;color:#9ca3af">Index: ${i}</div>
          </div>
        </div>
      </td>
      <td>${statusBadge(acc.status, acc.models)}</td>
      <td><span style="font-size:13px">${acc.auth_expires_in_min != null ? acc.auth_expires_in_min + ' min' : '—'}</span></td>
      <td>${claudeModel ? quotaBarMini(claudeModel.quota_remaining_pct) : '<span style="color:#9ca3af;font-size:12px">—</span>'}</td>
      <td>${geminiModel ? quotaBarMini(geminiModel.quota_remaining_pct) : '<span style="color:#9ca3af;font-size:12px">—</span>'}</td>
      <td><span class="badge badge-neutral">${(acc.models || []).length}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="removeAccount(${i})">Remove</button></td>`;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.innerHTML = '';
  wrap.appendChild(tableWrap);
}

async function removeAccount(index) {
  if (!confirm(`Remove account ${index}? This cannot be undone.`)) return;
  try {
    await api(`/api/accounts/${index}`, { method: 'DELETE' });
    toast('Account removed', 'success');
    await fetchAccounts();
  } catch (e) {
    toast('Failed to remove account: ' + e.message, 'error');
  }
}

// ── Models page ───────────────────────────────────────────────────────────────
function renderModels() {
  const wrap = $('#models-list');
  if (!state.models.length) {
    wrap.innerHTML = `<div class="empty-state spinner-wrap"><div class="spinner"></div><span>Loading models…</span></div>`;
    return;
  }
  $('#models-count-badge').textContent = `${state.models.length} model${state.models.length !== 1 ? 's' : ''}`;

  const grid = el('div', 'models-grid');
  state.models.forEach(m => {
    const exhausted = m.exhausted || m.quota_remaining_pct === 0;
    const card = el('div', `model-card${exhausted ? ' exhausted' : ''}`);

    const typeLabel = m.id?.includes('claude') ? '<span class="badge badge-violet">Claude</span>'
      : m.id?.includes('gemini') ? '<span class="badge badge-blue">Gemini</span>'
        : '<span class="badge badge-neutral">Other</span>';
    const betaBadge = m.beta ? '<span class="badge badge-amber">BETA</span>' : '';
    const exBadge = exhausted ? '<span class="badge badge-red">Exhausted</span>' : '<span class="badge badge-green">Available</span>';
    const resetTxt = m.quota_reset_time ? `Resets ${new Date(m.quota_reset_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';

    card.innerHTML = `
      <div class="model-card-header">
        <div>
          <div class="model-name">${m.id || m.display_name}</div>
          ${m.display_name && m.display_name !== m.id ? `<div class="model-display-name">${m.display_name}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${typeLabel}${betaBadge}</div>
      </div>
      ${m.quota_remaining_pct != null ? `
        <div class="model-quota">
          <div class="quota-bar-label"><span>Quota</span><span>${m.quota_remaining_pct}%</span></div>
          ${quotaBar(m.quota_remaining_pct)}
          ${resetTxt ? `<div class="model-reset">${resetTxt}</div>` : ''}
        </div>` : ''}
      <div style="display:flex;gap:6px;margin-top:4px">${exBadge}</div>`;
    grid.appendChild(card);
  });
  wrap.innerHTML = '';
  wrap.appendChild(grid);
}

function populateTesterModelSelect() {
  const sel = $('#tester-model');
  if (!sel || !state.models.length) return;
  const current = sel.value;
  sel.innerHTML = '';

  // Sort: non-exhausted first, then by name
  const sorted = [...state.models].sort((a, b) => {
    if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
    return (a.display_name || a.id).localeCompare(b.display_name || b.id);
  });

  sorted.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const label = m.display_name && m.display_name !== m.id
      ? `${m.display_name}  (${m.id})`
      : m.id;
    opt.textContent = m.exhausted ? `⚠ ${label} — exhausted` : label;
    opt.disabled = !!m.exhausted;
    if (m.id === current) opt.selected = true;
    sel.appendChild(opt);
  });

  // Auto-select first non-exhausted if current selection is gone/exhausted
  const firstGood = sorted.find(m => !m.exhausted);
  if (firstGood && (!current || sorted.find(m => m.id === current)?.exhausted)) {
    sel.value = firstGood.id;
  }
}

// ── API Tester ────────────────────────────────────────────────────────────────
async function sendTestRequest() {
  const model = $('#tester-model').value;
  const prompt = $('#tester-prompt').value.trim();
  const system = $('#tester-system').value.trim();
  const temp = parseFloat($('#tester-temp').value) || 0.7;
  const stream = $('#tester-stream').checked;

  if (!prompt) { toast('Please enter a message', 'error'); return; }

  const output = $('#tester-output');
  const sendBtn = $('#tester-send');
  const badge = $('#tester-status-badge');
  const meta = $('#tester-meta');

  output.textContent = '';
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="spinner-inline"></span> Sending…';
  badge.className = 'badge badge-amber'; badge.textContent = 'Sending…';
  meta.style.display = 'none';

  const started = Date.now();
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  try {
    if (stream) {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, temperature: temp })
      });

      if (!res.ok) throw new Error(await res.text());

      badge.className = 'badge badge-green'; badge.textContent = 'Streaming…';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('data: '); buf = parts.pop();
        for (let part of parts) {
          part = part.trim();
          if (!part || part === '[DONE]') continue;
          try {
            const j = JSON.parse(part);
            const delta = j.choices?.[0]?.delta;
            if (delta?.content) { fullText += delta.content; output.textContent = fullText; }
            if (delta?.reasoning_content) { /* skip thoughts */ }
          } catch { }
        }
      }
    } else {
      const data = await api('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model, messages, stream: false, temperature: temp })
      });
      const content = data.choices?.[0]?.message?.content || '';
      output.textContent = content;
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    badge.className = 'badge badge-green'; badge.textContent = 'Success';
    meta.style.display = 'flex';
    $('#tester-meta-model').textContent = `Model: ${model}`;
    $('#tester-meta-time').textContent = `${elapsed}s`;
    toast('Request completed', 'success');
  } catch (e) {
    output.textContent = `Error: ${e.message}`;
    badge.className = 'badge badge-red'; badge.textContent = 'Error';
    toast('Request failed: ' + e.message, 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Request`;
  }
}

function clearResponse() {
  $('#tester-output').innerHTML = '<span class="response-placeholder">Response will appear here…</span>';
  $('#tester-status-badge').className = 'badge';
  $('#tester-status-badge').textContent = '';
  $('#tester-meta').style.display = 'none';
}

// Toggle label for stream checkbox
$('#tester-stream')?.addEventListener('change', function () {
  $('#tester-stream-label').textContent = this.checked ? 'On' : 'Off';
});

// ── Settings page ─────────────────────────────────────────────────────────────
function renderSettings() {
  const port = state.port;
  const base = `http://localhost:${port}`;

  // Endpoints
  const epList = $('#endpoints-list');
  const endpoints = [
    { method: 'GET', url: `${base}/v1/models`, desc: 'List available models (OpenAI-compatible)' },
    { method: 'POST', url: `${base}/v1/chat/completions`, desc: 'Chat completions (streaming + non-streaming)' },
    { method: 'POST', url: `${base}/v1/messages`, desc: 'Anthropic Claude Code CLI compatibility' },
    { method: 'POST', url: `${base}/v1/responses`, desc: 'OpenAI Codex compatibility' },
    { method: 'GET', url: `${base}/api/accounts`, desc: 'Dashboard: list accounts with quota' },
    { method: 'GET', url: `${base}/health`, desc: 'Health check' },
  ];
  epList.innerHTML = '';
  endpoints.forEach(ep => {
    const item = el('div', 'endpoint-item');
    item.innerHTML = `
      <div class="endpoint-method">${ep.method}</div>
      <div class="endpoint-url-row">
        <div class="endpoint-url">${ep.url}</div>
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${ep.url}').then(()=>toast('Copied!','success'))">Copy</button>
      </div>
      <div class="endpoint-desc">${ep.desc}</div>`;
    epList.appendChild(item);
  });

  // IDE snippets
  $('#cursor-config').textContent =
    `Model Name : gemini-3.1-pro-high
Base URL   : ${base}/v1
API Key    : anything-for-you-bro`;

  $('#vscode-config').textContent =
    `{
  "title": "Antigravity",
  "provider": "openai",
  "model": "gemini-3.1-pro-high",
  "apiBase": "${base}/v1",
  "apiKey": "anything-for-you-bro"
}`;

  $('#python-config').textContent =
    `from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key="anything not vaildated"
)

response = client.chat.completions.create(
    model="gemini-3.1-pro-high",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")`;

  $('#claude-config').textContent =
    `export ANTHROPIC_BASE_URL="${base}/v1"
export ANTHROPIC_API_KEY="anything-not-validated"
claude`;
}

function showIdeTab(ide) {
  $$('.ide-tab').forEach(t => t.classList.toggle('active', t.dataset.ide === ide));
  $$('.ide-content').forEach(c => c.classList.toggle('hidden', c.id !== `ide-${ide}`));
}

function copyCode(id) {
  const text = $(`#${id}`).textContent;
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard', 'success'));
}

// ── Login flow ────────────────────────────────────────────────────────────────
async function triggerLogin() {
  try {
    const data = await api('/api/login', { method: 'POST' });
    state.loginUrl = data.url;
    $('#login-overlay').classList.remove('hidden');
  } catch (e) {
    toast('Failed to start login: ' + e.message, 'error');
  }
}

function openLoginUrl() {
  if (!state.loginUrl) return;
  window.open(state.loginUrl, '_blank');
  $('#login-open-btn').textContent = 'Opened in new tab';
  $('#login-open-btn').disabled = true;
  $('#login-waiting').style.display = 'block';
  // Poll for new account every 3 seconds
  const poll = setInterval(async () => {
    try {
      const data = await api('/api/accounts');
      if ((data.accounts || []).length > state.accounts.length) {
        clearInterval(poll);
        state.accounts = data.accounts;
        closeLoginModal();
        await fetchAccounts();
        toast('Account connected!', 'success');
      }
    } catch { }
  }, 3000);
  // Stop polling after 5 minutes
  setTimeout(() => clearInterval(poll), 300000);
}

function closeLoginModal() {
  $('#login-overlay').classList.add('hidden');
  $('#login-open-btn').disabled = false;
  $('#login-open-btn').textContent = 'Open Sign-In Page';
  $('#login-waiting').style.display = 'none';
  state.loginUrl = null;
}

// ── Toast system ──────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const t = el('div', `toast toast-${type}`, `<span>${icons[type]}</span> ${msg}`);
  $('#toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Quota helpers ─────────────────────────────────────────────────────────────
function quotaBar(pct) {
  if (pct == null) return '<div class="quota-bar"><div class="quota-bar-fill" style="width:0%"></div></div>';
  const cls = pct > 50 ? 'good' : pct > 20 ? 'warning' : 'danger';
  return `<div class="quota-bar"><div class="quota-bar-fill ${cls}" style="width:${pct}%"></div></div>`;
}

function quotaBarMini(pct) {
  if (pct == null) return '<span style="color:#9ca3af;font-size:12px">—</span>';
  const cls = pct > 50 ? 'good' : pct > 20 ? 'warning' : 'danger';
  return `<div class="quota-bar-wrap" style="min-width:100px">${quotaBar(pct)}<span class="quota-label ${quotaColor(pct)}">${pct}%</span></div>`;
}

function quotaColor(pct) {
  if (pct == null) return '';
  return pct > 50 ? 'text-green' : pct > 20 ? 'text-amber' : 'text-red';
}

function statusBadge(status, models) {
  const exhausted = models?.length > 0 && models.every(m => m.exhausted);
  if (exhausted) return '<span class="badge badge-red">Exhausted</span>';
  if (status === 'active') return '<span class="badge badge-green">Active</span>';
  if (status === 'expired') return '<span class="badge badge-red">Expired</span>';
  return '<span class="badge badge-amber">Unknown</span>';
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function formatUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const testerVisible = !$('#page-tester').classList.contains('hidden');
    if (testerVisible) sendTestRequest();
  }
  // Press Escape to close modal
  if (e.key === 'Escape') closeLoginModal();
});

// Close modal when clicking overlay
$('#login-overlay')?.addEventListener('click', e => { if (e.target === $('#login-overlay')) closeLoginModal(); });

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
