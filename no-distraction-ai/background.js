// No Distraction AI – Background Service Worker
// Handles auto-fix: silent probe results come in, timing guards decide if/when to call LLM

const SK  = 'nda_rules';
const AK  = 'nda_api_key';
const AKE = 'nda_api_key_enc';
const CFG = 'nda_config';

// Timing guards stored in local storage
const FIX_STATE_KEY = 'nda_autofix_state';
// { [ruleId]: { firstBrokenAt, lastFixAttempt } }

const BROKEN_THRESHOLD_MS  = 60 * 60 * 1000;      // 1 hour before auto-fix triggers
const FIX_COOLDOWN_MS      = 24 * 60 * 60 * 1000;  // 24 hours between fix attempts per rule

chrome.runtime.onInstalled.addListener(async () => {
  const d = await chrome.storage.local.get(SK);
  if (!d[SK]) await chrome.storage.local.set({ [SK]: [] });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    return;
  }

  if (msg.type === 'NDA_RULES_BROKEN') {
    handleBrokenRules(msg.broken, msg.host, sender.tab);
    return;
  }
});

// ── Handle broken rule report from content script ─────
async function handleBrokenRules(broken, host, tab) {
  const now     = Date.now();
  const data    = await chrome.storage.local.get([SK, AK, AKE, CFG, FIX_STATE_KEY]);
  const rules   = data[SK]   || [];
  const config  = data[CFG]  || {};
  let   state   = data[FIX_STATE_KEY] || {};

  // Update first-broken timestamps for each broken rule
  broken.forEach(b => {
    if (!state[b.id]) state[b.id] = { firstBrokenAt: now, lastFixAttempt: 0 };
  });

  // Clear state for rules that are no longer broken
  const brokenIds = new Set(broken.map(b => b.id));
  Object.keys(state).forEach(id => {
    if (!brokenIds.has(id)) delete state[id];
  });

  await chrome.storage.local.set({ [FIX_STATE_KEY]: state });

  // Decide which rules to auto-fix
  const toFix = broken.filter(b => {
    const s = state[b.id];
    if (!s) return false;
    const brokenLongEnough = (now - s.firstBrokenAt) >= BROKEN_THRESHOLD_MS;
    const cooldownExpired  = (now - s.lastFixAttempt) >= FIX_COOLDOWN_MS;
    return brokenLongEnough && cooldownExpired;
  });

  if (!toFix.length) {
    // Rules broken but not long enough yet — set badge to warn
    if (broken.length > 0) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e8a030' });
    }
    return;
  }

  // Get API key (handle PIN mode — can't decrypt without PIN in background)
  let apiKey = data[AK] || '';
  if (!apiKey && data[AKE]) {
    // Key is PIN-encrypted — can't auto-fix without user unlocking
    // Just show warning badge
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85555' });
    return;
  }
  if (!apiKey) return;

  // Mark fix attempts
  toFix.forEach(b => { state[b.id].lastFixAttempt = now; });
  await chrome.storage.local.set({ [FIX_STATE_KEY]: state });

  // Set badge to show auto-fix in progress
  chrome.action.setBadgeText({ text: '…' });
  chrome.action.setBadgeBackgroundColor({ color: '#6699ff' });

  // Run auto-fix for each broken rule
  for (const brokenRule of toFix) {
    const rule = rules.find(r => r.id === brokenRule.id);
    if (!rule) continue;
    try {
      const newSelectors = await autoFixRule(rule, host, tab, apiKey, config);
      if (newSelectors && newSelectors.length > 0) {
        // Update rule with new selectors
        const updatedRules = rules.map(r => {
          if (r.id !== rule.id) return r;
          return {
            ...r,
            jsRule: { ...r.jsRule, selectors: newSelectors }
          };
        });
        await chrome.storage.local.set({ [SK]: updatedRules });
        // Push updated rules to the tab
        chrome.tabs.sendMessage(tab.id, { type: 'NDA_UPDATE', rules: updatedRules }).catch(() => {});
        // Clear broken state for this rule
        delete state[rule.id];
        await chrome.storage.local.set({ [FIX_STATE_KEY]: state });
      }
    } catch (e) {
      console.error('Auto-fix failed for rule', rule.name, e);
    }
  }

  // Update badge
  const remainingBroken = Object.keys(state).length;
  if (remainingBroken > 0) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85555' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Auto-fix a single rule using JSON-based agent loop ─
async function autoFixRule(rule, host, tab, apiKey, config) {
  const provider = config.provider || 'openrouter';
  const model    = config.model    || defaultModel(provider);

  const system = `You are a browser content-blocking agent. A blocking rule for "${host}" has stopped working — its selectors matched 0 elements on the page. Your job is to find new working selectors.

Rule that broke: "${rule.name}" — ${rule.desc || ''}
Old selectors that no longer work: ${JSON.stringify((rule.jsRule||{}).selectors||[])}

On each turn respond with ONLY a JSON object — no explanation, no markdown:

To inspect the page:
{"action":"inspect","selector":"optional css selector to focus on"}

To test selectors:
{"action":"test","selectors":["sel1","sel2"],"parentSteps":0}

To save new selectors (only after confirming matches > 0):
{"action":"save","selectors":["working-sel1","working-sel2"],"parentSteps":0}

To give up:
{"action":"give_up","reason":"why"}

PREFER data attributes over class names. For LinkedIn use data-urn*="activity:", data-urn*="ugcPost:", [data-view-name] — these are far more stable than class names.
Max 6 turns.`;

  const messages = [{ role:'user', content:`Fix the broken selectors for rule: ${rule.name}` }];
  const MAX_TURNS = 6;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const raw = await llmCall(provider, model, apiKey, system, messages);
    messages.push({ role:'assistant', content: raw });

    let parsed;
    try {
      const clean = raw.replace(/^```json?\s*/i,'').replace(/\s*```$/,'').trim();
      parsed = JSON.parse(clean);
    } catch (_) {
      // Try to extract JSON from text
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) break;
      try { parsed = JSON.parse(match[0]); } catch (_) { break; }
    }

    if (!parsed) break;

    if (parsed.action === 'inspect') {
      const result = await messageTab(tab, 'NDA_SNAPSHOT', { selector: parsed.selector || '' });
      messages.push({ role:'user', content: result || 'No result' });

    } else if (parsed.action === 'test') {
      const result = await messageTab(tab, 'NDA_PROBE', {
        selectors: parsed.selectors || [],
        parentSteps: parsed.parentSteps || 0
      });
      const summary = (result || []).map(r =>
        r.error ? `"${r.selector}" → ERROR: ${r.error}`
                : `"${r.selector}" → ${r.count} match${r.count!==1?'es':''}`
      ).join('\n');
      messages.push({ role:'user', content: summary || 'No results' });

    } else if (parsed.action === 'save') {
      // Verify before saving
      const verifyResult = await messageTab(tab, 'NDA_PROBE', {
        selectors: parsed.selectors || [],
        parentSteps: parsed.parentSteps || 0
      });
      const totalMatches = (verifyResult || []).reduce((sum, r) => sum + (r.count||0), 0);
      if (totalMatches > 0) {
        return parsed.selectors;
      } else {
        messages.push({ role:'user', content: 'Verification failed — still 0 matches. Try different selectors.' });
      }

    } else if (parsed.action === 'give_up') {
      break;
    }
  }

  return null; // Could not fix
}

// ── Tab messaging helper ──────────────────────────────
function messageTab(tab, type, data) {
  return new Promise(resolve => {
    if (!tab?.id) { resolve(null); return; }
    chrome.tabs.sendMessage(tab.id, { type, ...data }, res => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res?.result || null);
    });
  });
}

// ── LLM call (no tools — plain JSON response) ─────────
async function llmCall(provider, model, apiKey, system, messages) {
  try {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model, max_tokens:600, system, messages })
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return d.content?.[0]?.text?.trim() || '';
    } else {
      const base = provider==='custom' ? '' : provider==='openai'
        ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1';
      const r = await fetch(`${base}/chat/completions`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
        body: JSON.stringify({
          model, max_tokens:600,
          messages:[{ role:'system', content:system }, ...messages]
        })
      });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      return d.choices?.[0]?.message?.content?.trim() || '';
    }
  } catch (e) {
    return `{"action":"give_up","reason":"API error: ${e.message}"}`;
  }
}

function defaultModel(p) {
  return p==='anthropic' ? 'claude-3-haiku-20240307'
       : p==='openai'    ? 'gpt-4o-mini'
       : 'anthropic/claude-3-haiku';
}
