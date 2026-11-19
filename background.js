// Auto Tab Groups — sorts tabs into Chrome tab groups with Claude.
// Classic (non-module) service worker; plain fetch to the Messages API keeps the extension build-free.

const API = 'https://api.anthropic.com/v1';
const API_HEADERS = (key) => ({
  'x-api-key': key,
  'anthropic-version': '2026-10-21',
  'content-type': 'application/json',
  'anthropic-dangerous-direct-browser-access': 'true', // the key is the user's own, stored on their machine
});
const PRICES = { 'claude-haiku-5-5': { in: 0.1, out: 0.5 }, 'claude-sonnet-5-5': { in: 2, out: 10 } }; // $ per 1M tokens
const DEFAULTS = { apiKey: '', model: 'claude-haiku-5-5', auto: false, rules: '', blocked: '' };
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const PROTECTED = /^(My PRs|To review)( \(\d+\))?$/; // groups owned by the PR Tabs extension: never touched
const AUTO_DELAY_MS = 4000; // wait for a quiet moment before placing new tabs
const MAX_TABS = 150;
const MAX_LEFTOVERS = 20;
const STARTUP_GRACE_MS = 20000; // tabs restored at browser start aren't "new"

const settings = () => chrome.storage.local.get(DEFAULTS);

// ---------- serial queue: one sort at a time, state updates in order ----------

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.error('[Auto Tab Groups]', e)));

// ---------- tabs → prompt ----------

const parseUrl = (tab) => {
  try {
    return new URL(tab.url || tab.pendingUrl || '');
  } catch {
    return null;
  }
};

const blockedList = (text) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*?\./, '').replace(/[/:].*$/, ''))
    .filter(Boolean);

// Only ordinary web pages are ever sent: no chrome://, file://, extension pages, pinned tabs or blocked domains.
function sendable(tab, blocked) {
  if (tab.pinned || tab.incognito) return false;
  const u = parseUrl(tab);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
  const host = u.hostname.toLowerCase();
  return !blocked.some((d) => host === d || host.endsWith(`.${d}`));
}

// Title plus host and path. Query strings and fragments stay on your machine.
function describe(tab) {
  const u = parseUrl(tab);
  return { title: (tab.title || '').slice(0, 120), url: (u.hostname.replace(/^www\./, '') + u.pathname).slice(0, 100) };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['existing', 'name', 'color', 'tabs'],
        properties: {
          existing: { type: 'string', description: 'Id of an existing group (e.g. "G2"), or "" to create a new group' },
          name: { type: 'string', description: 'Name of the new group (ignored for existing groups)' },
          color: { type: 'string', enum: COLORS },
          tabs: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tabs to put in this group' },
        },
      },
    },
  },
};

function systemPrompt(rules) {
  return [
    'You sort browser tabs into Chrome tab groups.',
    '- Put each tab into the group it fits best: an existing group (give its id) or a new group (existing = "").',
    '- A new group needs at least 2 tabs. Leave a tab out if nothing fits; never force it.',
    '- Group by what the person is doing (a project, trip, topic or task), not merely by website, unless the site is the task itself (like email).',
    '- Prefer existing groups over new ones. Create at most 6 new groups.',
    '- New group names: 1-2 words, Title Case, no emoji. Pick colours that differ from the existing groups where possible.',
    '- Use each tab number at most once.',
    rules.trim() ? `\nThe user's own rules take priority over the above:\n${rules.trim()}` : '',
  ].join('\n');
}

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

async function askClaude(cfg, existingGroups, tabs) {
  let res;
  try {
    res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: API_HEADERS(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: systemPrompt(cfg.rules),
        messages: [{ role: 'user', content: JSON.stringify({ existing_groups: existingGroups, tabs }) }],
      }),
    });
  } catch {
    throw fail("Couldn't reach Anthropic (offline?)");
  }
  if (res.status === 401) throw fail('Anthropic rejected the API key', { auth: true });
  if (res.status === 429 || res.status === 529) throw fail('Claude is busy or rate-limited; try again in a minute');
  if (!res.ok) {
    const msg = await res.json().then((b) => b.error?.message).catch(() => null);
    throw fail(msg || `Anthropic API returned ${res.status}`);
  }
  const body = await res.json();
  await recordUsage(cfg.model, body.usage);
  if (body.stop_reason === 'refusal') throw fail('Claude declined to sort these tabs');
  if (body.stop_reason === 'max_tokens') throw fail('The answer was cut off; try with fewer tabs');
  const text = body.content?.find((b) => b.type === 'text')?.text;
  if (!text) throw fail('Empty answer from Claude');
  return JSON.parse(text);
}

async function recordUsage(model, u) {
  if (!u) return;
  const p = PRICES[model] ?? PRICES['claude-haiku-5-5'];
  const cost = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out) / 1e6;
  const { usage = { usd: 0, calls: 0 } } = await chrome.storage.local.get('usage');
  await chrome.storage.local.set({ usage: { usd: usage.usd + cost, calls: usage.calls + 1 } });
}

// ---------- grouping ----------

const movingByUs = new Set(); // tab ids we're grouping, so their groupId change isn't read as a manual move

async function group(opts) {
  opts.tabIds.forEach((id) => movingByUs.add(id));
  try {
    return await chrome.tabs.group(opts);
  } finally {
    setTimeout(() => opts.tabIds.forEach((id) => movingByUs.delete(id)), 2000);
  }
}

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30) || 'Tabs';

// Asks Claude about `candidates` (ungrouped tabs in one window) and applies the answer. Returns the ids it grouped.
async function sortWindow(windowId, candidates, cfg) {
  const blocked = blockedList(cfg.blocked);
  const windowTabs = await chrome.tabs.query({ windowId });
  const groups = (await chrome.tabGroups.query({ windowId })).filter((g) => !PROTECTED.test(g.title || ''));
  const groupIds = {};
  const existing = groups.map((g, i) => {
    groupIds[`G${i + 1}`] = g.id;
    const samples = windowTabs.filter((t) => t.groupId === g.id && sendable(t, blocked)).slice(0, 5);
    return { id: `G${i + 1}`, name: g.title || '(untitled)', color: g.color, sample_tabs: samples.map((t) => (t.title || '').slice(0, 80)) };
  });

  const list = candidates.slice(0, MAX_TABS);
  const result = await askClaude(cfg, existing, list.map((t, i) => ({ n: i + 1, ...describe(t) })));

  // Tabs may have moved or closed during the call: only touch ones that are still ungrouped here.
  const now = new Map((await chrome.tabs.query({ windowId })).map((t) => [t.id, t]));
  const used = new Set();
  const placed = new Set();
  for (const g of result.groups ?? []) {
    const tabIds = (g.tabs ?? [])
      .map((n) => list[n - 1]?.id)
      .filter((id) => id != null && !used.has(id) && now.get(id)?.groupId === -1 && !now.get(id).pinned);
    tabIds.forEach((id) => used.add(id));
    if (g.existing) {
      const gid = groupIds[g.existing];
      if (gid == null || !tabIds.length || !(await chrome.tabGroups.get(gid).catch(() => null))) continue;
      await group({ groupId: gid, tabIds });
    } else {
      if (tabIds.length < 2) continue;
      const gid = await group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: cleanName(g.name), color: COLORS.includes(g.color) ? g.color : 'grey' });
    }
    tabIds.forEach((id) => placed.add(id));
  }
  return placed;
}

// ---------- manual: toolbar click or ⌥⇧G sorts every ungrouped tab in the window ----------

async function sortNow(windowId) {
  const cfg = await settings();
  const { authError } = await chrome.storage.local.get('authError');
  if (!cfg.apiKey || authError) return chrome.runtime.openOptionsPage();
  const blocked = blockedList(cfg.blocked);
  const tabs = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId === -1 && sendable(t, blocked));
  if (!tabs.length) return flash('–', 'No ungrouped tabs to sort');
  setBadge('…', '#57606a', 'Sorting…');
  try {
    const placed = await sortWindow(windowId, tabs, cfg);
    await chrome.storage.local.set({ lastError: null });
    await forget([...placed]);
    flash(placed.size ? '✓' : '–', placed.size ? `Grouped ${placed.size} tabs` : 'Nothing worth grouping');
  } catch (e) {
    showError(e);
  }
}

// ---------- automatic: place new tabs once they've loaded and you've moved on ----------

let timer = null;
function scheduleAuto() {
  clearTimeout(timer);
  timer = setTimeout(() => serial(autoPlace), AUTO_DELAY_MS);
}

async function autoPlace() {
  const cfg = await settings();
  if (!cfg.auto || !cfg.apiKey) return;
  const s = await chrome.storage.session.get({ pending: {}, leftovers: [], startupAt: 0 });
  if (!Object.keys(s.pending).length) return;
  const blocked = blockedList(cfg.blocked);
  const all = await chrome.tabs.query({ windowType: 'normal' });
  const byId = new Map(all.map((t) => [t.id, t]));

  const ready = [];
  for (const [id, createdAt] of Object.entries(s.pending)) {
    const t = byId.get(+id);
    const restored = s.startupAt && createdAt - s.startupAt < STARTUP_GRACE_MS;
    if (!t || t.groupId !== -1 || restored || Date.now() - createdAt > 3600e3) {
      delete s.pending[id];
      continue;
    }
    // Wait until it has loaded a real page and you're no longer looking at it.
    if (t.status === 'complete' && !t.active && t.title && sendable(t, blocked)) ready.push(t);
  }

  // Tabs we left ungrouped earlier get another chance: a new tab may be their missing partner.
  const leftovers = s.leftovers
    .map((id) => byId.get(id))
    .filter((t) => t && t.groupId === -1 && !t.active && !ready.includes(t) && sendable(t, blocked));
  const windows = new Map();
  for (const t of ready) windows.set(t.windowId, [...(windows.get(t.windowId) ?? []), t]);
  for (const t of leftovers) if (windows.has(t.windowId)) windows.get(t.windowId).push(t);

  let left = new Set(s.leftovers);
  for (const [windowId, tabs] of windows) {
    let placed = new Set();
    try {
      placed = await sortWindow(windowId, tabs, cfg);
      await chrome.storage.local.set({ lastError: null });
      clearBadge();
    } catch (e) {
      showError(e);
      if (e.auth) break;
    }
    for (const t of tabs) {
      delete s.pending[t.id];
      if (placed.has(t.id)) left.delete(t.id);
      else left.add(t.id);
    }
  }
  s.leftovers = [...left].slice(-MAX_LEFTOVERS);
  await chrome.storage.session.set({ pending: s.pending, leftovers: s.leftovers });
}

// Drop tabs from auto-placement: closed, or moved into/out of a group by you (or by Chrome).
async function forget(ids) {
  const s = await chrome.storage.session.get({ pending: {}, leftovers: [] });
  ids.forEach((id) => delete s.pending[id]);
  s.leftovers = s.leftovers.filter((id) => !ids.includes(id));
  await chrome.storage.session.set(s);
}

// ---------- badge ----------

function setBadge(text, color, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: `Auto Tab Groups: ${title}` });
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'Sort tabs into groups (⌥⇧G)' });
}
function flash(text, title) {
  setBadge(text, '#1a7f37', title);
  setTimeout(clearBadge, 4000);
}
function showError(e) {
  setBadge('!', '#cf222e', `${e.message}${e.auth ? ' — click to fix' : ''}`);
  chrome.storage.local.set({ lastError: e.message, authError: !!e.auth });
}

// ---------- events ----------

chrome.action.onClicked.addListener((tab) => serial(() => sortNow(tab.windowId)));

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.pinned || tab.groupId !== -1 || tab.incognito) return;
  serial(async () => {
    const { pending = {} } = await chrome.storage.session.get('pending');
    pending[tab.id] = Date.now();
    await chrome.storage.session.set({ pending });
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.groupId !== undefined && !movingByUs.has(tabId)) serial(() => forget([tabId]));
  if (info.status === 'complete') scheduleAuto();
});

chrome.tabs.onActivated.addListener(scheduleAuto);
chrome.tabs.onRemoved.addListener((tabId) => serial(() => forget([tabId])));

chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ startupAt: Date.now() }));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.apiKey) {
    chrome.storage.local.set({ authError: false, lastError: null });
    clearBadge();
  }
});
