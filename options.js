const $ = (id) => document.getElementById(id);
const show = (text, ok) => {
  $('msg').textContent = text;
  $('msg').className = ok ? 'ok' : 'err';
};
const SAVED = '•••••••• saved — paste to replace';

chrome.storage.local
  .get({ apiKey: '', model: 'claude-haiku-5-5', auto: false, rules: '', blocked: '', authError: false, lastError: null })
  .then((s) => {
    if (s.apiKey) {
      $('apiKey').placeholder = SAVED;
      if (s.authError) show('Anthropic rejected the saved key. Paste a new one.', false);
      else show(s.lastError ? `Key saved. Last error: ${s.lastError}` : 'Key saved.', !s.lastError);
    }
    $('model').value = s.model;
    $('auto').checked = s.auto;
    $('rules').value = s.rules;
    $('blocked').value = s.blocked;
  });

function showUsage({ usd = 0, calls = 0 } = {}) {
  if (calls) $('usage').textContent = `$${usd.toFixed(4)} over ${calls} call${calls === 1 ? '' : 's'} (estimated from token counts).`;
}
chrome.storage.local.get('usage').then(({ usage }) => showUsage(usage));
chrome.storage.onChanged.addListener((c, area) => area === 'local' && c.usage && showUsage(c.usage.newValue));

// API key: saves on paste, after a free check against the models list.
async function saveKey() {
  const key = $('apiKey').value.trim();
  if (!key) return;
  show('Checking…', true);
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (res.status === 401) throw new Error('Anthropic rejected this key.');
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}.`);
    await chrome.storage.local.set({ apiKey: key });
    $('apiKey').value = '';
    $('apiKey').placeholder = SAVED;
    navigator.clipboard.writeText('').catch(() => {}); // don't leave the key on the clipboard
    show('Key saved. Click the toolbar icon or press ⌥⇧G to sort this window.', true);
  } catch (err) {
    show(err.message === 'Failed to fetch' ? "Couldn't reach Anthropic." : err.message, false);
  }
}
$('apiKey').addEventListener('paste', () => setTimeout(saveKey, 0));
$('apiKey').addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());

// Everything else saves as you type.
$('model').addEventListener('change', () => chrome.storage.local.set({ model: $('model').value }));
$('auto').addEventListener('change', () => chrome.storage.local.set({ auto: $('auto').checked }));
let typing;
for (const id of ['rules', 'blocked']) {
  $(id).addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => chrome.storage.local.set({ [id]: $(id).value }), 400);
  });
}
