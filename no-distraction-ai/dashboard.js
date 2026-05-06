// No Distraction AI – Dashboard Script
'use strict';

const SK  = 'nda_rules';
const AK  = 'nda_api_key';
const AKE = 'nda_api_key_enc';
const CFG = 'nda_config';
const RCV = 'nda_recovery';  // { email, publicKey, serviceId, templateId }
const VFY = 'nda_verify';    // { code, expires }

const MODEL_CHIPS = {
  openrouter: ['anthropic/claude-3-5-haiku','anthropic/claude-3.5-sonnet','openai/gpt-4o-mini','openai/gpt-4o','google/gemini-flash-1.5','qwen/qwen3-coder-30b-a3b-instruct','qwen/qwen3-coder-next','meta-llama/llama-3.1-8b-instruct:free'],
  openai:     ['gpt-4o-mini','gpt-4o','gpt-3.5-turbo'],
  anthropic:  ['claude-3-haiku-20240307','claude-3-5-sonnet-20241022','claude-3-opus-20240229'],
  custom:     []
};

const PRESETS = {
  'yt-shorts':  { name:'YouTube Shorts',        site:'youtube.com',       sel:'ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], a[href*="/shorts/"]', desc:'Hides Shorts shelf' },
  'yt-sidebar': { name:'YouTube Sidebar',       site:'youtube.com',       sel:'ytd-watch-next-secondary-results-renderer, ytd-compact-video-renderer', desc:'Hides sidebar recommendations' },
  'yt-home':    { name:'YouTube Home Feed',     site:'youtube.com',       sel:'ytd-browse[page-subtype="home"] ytd-rich-item-renderer', desc:'Hides homepage feed' },
  'li-feed':    { name:'LinkedIn Feed',         site:'linkedin.com',      sel:'.scaffold-finite-scroll__content .occludable-update, .feed-shared-update-v2', desc:'Hides feed posts' },
  'li-news':    { name:'LinkedIn News',         site:'linkedin.com',      sel:'.news-module, [data-view-name="news-module"]', desc:'Hides news panel' },
  'li-suggest': { name:'LinkedIn Suggestions',  site:'linkedin.com',      sel:'.pymk-hcard, [data-view-name="pymk-hcard"]', desc:'Hides people suggestions' },
  'tw-trend':   { name:'X/Twitter Trending',    site:'twitter.com,x.com', sel:'[aria-label="Timeline: Trending now"], [data-testid="trend"]', desc:'Hides trending topics' },
  'tw-follow':  { name:'X/Twitter Suggestions', site:'twitter.com,x.com', sel:'[aria-label="Who to follow"]', desc:'Hides follow suggestions' },
  'rd-promo':   { name:'Reddit Promoted',       site:'reddit.com',        sel:'[data-promoted="true"], shreddit-ad-post', desc:'Hides promoted posts' },
  'ig-explore': { name:'Instagram Explore',     site:'instagram.com',     sel:'article._aabd, ._aabd._aa8k', desc:'Hides explore grid' },
};

let rules    = [];
let config   = { provider:'openrouter', model:'', baseUrl:'', pinMode:false };
let recovery = { email:'', publicKey:'', serviceId:'', templateId:'' };
let filterMode = 'all';
let searchQ    = '';
let pendingDel = null;
let fpTimerId  = null;  // countdown interval for code expiry

// ── INIT ─────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get([SK, AK, AKE, CFG, RCV]);
  rules    = data[SK]  || [];
  config   = { provider:'openrouter', model:'', baseUrl:'', pinMode:false, ...(data[CFG]||{}) };
  recovery = { email:'', publicKey:'', serviceId:'', templateId:'', ...(data[RCV]||{}) };

  renderApiStatus(!!data[AK] || !!data[AKE]);
  renderPinUI(config.pinMode);
  populateProviderUI();
  populatePresets();
  renderStats();
  renderTable();
  bindEvents();
}

// ── PROVIDER ─────────────────────────────────────────
function populateProviderUI() {
  document.getElementById('provider-select').value = config.provider;
  document.getElementById('model-input').value     = config.model || '';
  document.getElementById('custom-url').value      = config.baseUrl || '';
  document.getElementById('extended-toggle').checked = config.extended || false;
  refreshChips(config.provider);
  document.getElementById('custom-url-field').style.display = config.provider === 'custom' ? 'flex' : 'none';
}

function refreshChips(p) {
  const wrap = document.getElementById('model-chips');
  wrap.innerHTML = (MODEL_CHIPS[p]||[]).map(m => `<button class="mchip" data-m="${m}">${m}</button>`).join('');
  wrap.querySelectorAll('[data-m]').forEach(b => {
    b.addEventListener('click', () => { document.getElementById('model-input').value = b.dataset.m; });
  });
}

// ── API STATUS ────────────────────────────────────────
function renderApiStatus(hasKey) {
  document.getElementById('api-dot').className = 'sdot '+(hasKey?'ok':'bad');
  document.getElementById('api-status-txt').textContent = hasKey ? 'Key set ('+config.provider+')' : 'No key';
  document.getElementById('api-key-status').innerHTML = hasKey
    ? '<span style="color:var(--green)">✓ Key saved</span>'
    : '<span style="color:var(--muted)">No key stored</span>';
}

// ── PIN UI ────────────────────────────────────────────
function renderPinUI(active) {
  document.getElementById('pin-master-toggle').checked = active;
  document.getElementById('pin-icon').textContent = active ? '🔐' : '🔓';
  const badge = document.getElementById('pin-badge');
  badge.textContent = active ? 'ON' : 'OFF';
  badge.className   = 'pin-badge'+(active?' on':'');
  document.getElementById('pin-enable-form').style.display  = active ? 'none'  : 'block';
  document.getElementById('pin-disable-form').style.display = active ? 'block' : 'none';

  // Reset forgot PIN flow
  setFpStep(0);
  document.getElementById('forgot-flow').style.display = 'none';

  // Pre-fill recovery email if already saved
  if (!active && recovery.email) {
    document.getElementById('rc-email').value    = recovery.email;
    document.getElementById('rc-pubkey').value   = recovery.publicKey  || '';
    document.getElementById('rc-service').value  = recovery.serviceId  || '';
    document.getElementById('rc-template').value = recovery.templateId || '';
  }
}

function setFpStep(n) {
  ['fp-s1','fp-s2','fp-s3'].forEach((id, i) => {
    document.getElementById(id).classList.toggle('on', i === n);
  });
  document.getElementById('fp-s1-err').textContent = '';
  document.getElementById('fp-s2-err').textContent = '';
  if (n !== 1) { clearInterval(fpTimerId); fpTimerId = null; }
}

// ── STATS ─────────────────────────────────────────────
function renderStats() {
  document.getElementById('st-total').textContent  = rules.length;
  document.getElementById('st-active').textContent = rules.filter(r=>r.enabled).length;
  document.getElementById('st-ai').textContent     = rules.filter(r=>r.ai).length;
  document.getElementById('st-sites').textContent  = new Set(rules.flatMap(r=>r.site.split(',').map(s=>s.trim()))).size;
  document.getElementById('total-count').textContent = rules.length+(rules.length===1?' rule':' rules');
}

// ── TABLE — event delegation ──────────────────────────
function renderTable() {
  let list = [...rules];
  if (filterMode==='active') list = list.filter(r=>r.enabled);
  if (filterMode==='ai')     list = list.filter(r=>r.ai);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    list = list.filter(r=>[r.name,r.site,r.desc||'',r.selector].some(s=>s.toLowerCase().includes(q)));
  }
  const body = document.getElementById('t-body');
  if (!list.length) {
    body.innerHTML = `<div class="t-empty"><div style="font-size:32px;opacity:.2">◻</div>${rules.length?'No rules match.':'No rules yet. Use AI Chat in the popup.'}</div>`;
    return;
  }
  body.innerHTML = list.map(r=>`
    <div class="t-row" data-id="${r.id}">
      <label class="t-tog">
        <input type="checkbox" ${r.enabled?'checked':''} data-toggle="${r.id}"/>
        <span class="ttt"></span>
      </label>
      <div class="t-name-cell">
        <div class="t-name">${esc(r.name)}</div>
        <div class="t-desc">${esc(r.desc||'—')}</div>
        <div class="t-sel">${esc(r.selector)}</div>
      </div>
      <div class="t-site">${esc(r.site)}</div>
      <div class="t-date">${fmtDate(r.created)}</div>
      <div class="t-tags">
        ${r.ai?'<span class="tag ai">✦ AI</span>':'<span class="tag">manual</span>'}
        ${r.jsRule?'<span class="tag" style="color:var(--blue);border-color:rgba(102,153,255,.25);background:rgba(102,153,255,.08)">JS</span>':''}
        <span class="tag ${r.enabled?'on':''}">${r.enabled?'on':'off'}</span>
      </div>
      <div class="t-acts">
        <button class="act del" data-del="${r.id}" title="Delete">✕</button>
      </div>
    </div>
  `).join('');
}

// Delegated listeners — fixes toggle bug
document.getElementById('t-body').addEventListener('change', async e => {
  const cb = e.target.closest('[data-toggle]');
  if (!cb) return;
  rules = rules.map(r=>r.id===cb.dataset.toggle ? {...r,enabled:cb.checked} : r);
  await saveRules(); renderStats();
  const row = cb.closest('.t-row');
  if (row) {
    const sp = row.querySelector('.tag:not(.ai)');
    if (sp) { sp.className='tag'+(cb.checked?' on':''); sp.textContent=cb.checked?'on':'off'; }
  }
});

document.getElementById('t-body').addEventListener('click', async e => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  const r = rules.find(x=>x.id===btn.dataset.del);
  pendingDel = btn.dataset.del;
  showModal(`Delete "<strong>${esc(r?.name||'')}</strong>"? Cannot be undone.`, 'DELETE');
});

// ── SAVE ─────────────────────────────────────────────
async function saveRules() {
  await chrome.storage.local.set({ [SK]:rules });
  const tabs = await chrome.tabs.query({});
  tabs.forEach(t=>chrome.tabs.sendMessage(t.id,{type:'NDA_UPDATE',rules}).catch(()=>{}));
}
async function saveConfig() { await chrome.storage.local.set({ [CFG]:config }); }

// ── BIND EVENTS ──────────────────────────────────────
function bindEvents() {

  // Provider
  document.getElementById('provider-select').addEventListener('change', async e => {
    config.provider = e.target.value;
    refreshChips(config.provider);
    document.getElementById('custom-url-field').style.display = config.provider==='custom'?'flex':'none';
    await saveConfig();
  });
  document.getElementById('model-input').addEventListener('change', async e => {
    config.model = e.target.value.trim(); await saveConfig();
  });
  document.getElementById('custom-url').addEventListener('change', async e => {
    config.baseUrl = e.target.value.trim().replace(/\/$/,''); await saveConfig();
  });

  // Extended mode toggle
  document.getElementById('extended-toggle').addEventListener('change', async e => {
    config.extended = e.target.checked; await saveConfig();
    toast(e.target.checked ? '✦ Extended mode ON' : 'Extended mode off');
  });

  // API key save
  document.getElementById('api-save-btn').addEventListener('click', async () => {
    const val = document.getElementById('api-key-input').value.trim();
    if (!val) { toast('Paste your API key first', 'bad'); return; }
    if (config.pinMode) { toast('Disable PIN mode first, then re-enter your key', 'bad'); return; }
    await chrome.storage.local.set({ [AK]:val });
    document.getElementById('api-key-input').value = '';
    renderApiStatus(true); toast('API key saved 🔒', 'ok');
  });

  document.getElementById('api-clear-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove([AK,AKE]);
    config.pinMode = false; await saveConfig();
    renderPinUI(false); renderApiStatus(false);
    toast('API key removed');
  });

  // PIN toggle — intercept, don't let it self-toggle
  document.getElementById('pin-master-toggle').addEventListener('change', e => {
    e.target.checked = config.pinMode; // snap back — forms control state
  });

  // ── ENABLE PIN ────────────────────────────────────
  document.getElementById('pin-enable-btn').addEventListener('click', async () => {
    const p1  = document.getElementById('pin-new').value;
    const p2  = document.getElementById('pin-confirm').value;
    const em  = document.getElementById('rc-email').value.trim();
    const pk  = document.getElementById('rc-pubkey').value.trim();
    const sid = document.getElementById('rc-service').value.trim();
    const tid = document.getElementById('rc-template').value.trim();
    const err = document.getElementById('pin-enable-err');
    err.textContent = '';

    if (!/^\d{4}$/.test(p1))   { err.textContent = 'PIN must be exactly 4 digits'; return; }
    if (p1 !== p2)              { err.textContent = 'PINs do not match'; return; }
    if (!em || !em.includes('@')){ err.textContent = 'Enter a valid recovery email'; return; }
    if (!pk || !sid || !tid)   { err.textContent = 'Fill in all three EmailJS fields'; return; }

    const data = await chrome.storage.local.get(AK);
    if (!data[AK]) { err.textContent = 'Save your API key first'; return; }

    try {
      const enc = await NdaCrypto.encrypt(data[AK], p1);
      await chrome.storage.local.set({
        [AKE]: enc,
        [RCV]: { email:em, publicKey:pk, serviceId:sid, templateId:tid }
      });
      await chrome.storage.local.remove(AK);
      config.pinMode = true; await saveConfig();
      recovery = { email:em, publicKey:pk, serviceId:sid, templateId:tid };
      document.getElementById('pin-new').value = '';
      document.getElementById('pin-confirm').value = '';
      renderPinUI(true); renderApiStatus(true);
      toast('PIN encryption enabled 🔐', 'ok');
    } catch(e) { err.textContent = 'Encryption error: '+e.message; }
  });

  // ── DISABLE PIN (requires current PIN) ────────────
  document.getElementById('pin-disable-btn').addEventListener('click', async () => {
    const pin = document.getElementById('pin-current').value;
    const err = document.getElementById('pin-disable-err');
    err.textContent = '';

    if (!/^\d{4}$/.test(pin)) { err.textContent = 'Enter your 4-digit PIN'; return; }

    const data = await chrome.storage.local.get(AKE);
    if (!data[AKE]) { err.textContent = 'No encrypted key found'; return; }

    try {
      await NdaCrypto.decrypt(data[AKE], pin); // verify only
      await chrome.storage.local.remove([AK,AKE]);
      config.pinMode = false; await saveConfig();
      document.getElementById('pin-current').value = '';
      renderPinUI(false); renderApiStatus(false);
      toast('PIN disabled. Re-enter your API key to continue.', 'ok');
    } catch {
      err.textContent = 'Wrong PIN — try again';
    }
  });

  // ── FORGOT PIN toggle ─────────────────────────────
  document.getElementById('forgot-toggle').addEventListener('click', () => {
    const flow = document.getElementById('forgot-flow');
    const open = flow.style.display !== 'none';
    flow.style.display = open ? 'none' : 'block';
    if (!open) setFpStep(0);
  });

  // ── FORGOT: STEP 1 — send code ───────────────────
  document.getElementById('fp-send-btn').addEventListener('click', async () => {
    const email = document.getElementById('fp-email').value.trim();
    const err   = document.getElementById('fp-s1-err');
    err.textContent = '';

    if (!email || !email.includes('@')) { err.textContent = 'Enter a valid email address'; return; }

    if (!recovery.email) { err.textContent = 'No recovery email on record — cannot verify'; return; }
    if (email.toLowerCase() !== recovery.email.toLowerCase()) {
      err.textContent = 'Email does not match your registered recovery email';
      return;
    }
    if (!recovery.publicKey || !recovery.serviceId || !recovery.templateId) {
      err.textContent = 'EmailJS settings missing — re-enable PIN to reconfigure'; return;
    }

    err.textContent = 'Sending…';
    const code    = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    await chrome.storage.local.set({ [VFY]: { code, expires } });

    const ok = await sendEmail(email, code);
    if (ok) {
      err.textContent = '';
      setFpStep(1);
      startCodeTimer(expires);
    } else {
      await chrome.storage.local.remove(VFY);
      err.textContent = 'Failed to send email. Check your EmailJS credentials in the enable form.';
    }
  });

  // ── FORGOT: STEP 2 — verify code ─────────────────
  document.getElementById('fp-verify-btn').addEventListener('click', async () => {
    const entered = document.getElementById('fp-code').value.trim();
    const err     = document.getElementById('fp-s2-err');
    err.textContent = '';

    const data = await chrome.storage.local.get(VFY);
    const vfy  = data[VFY];
    if (!vfy)                     { err.textContent = 'No code found — send a new one'; return; }
    if (Date.now() > vfy.expires) { err.textContent = 'Code expired — send a new one'; await chrome.storage.local.remove(VFY); return; }
    if (entered !== vfy.code)     { err.textContent = 'Incorrect code — try again'; return; }

    await chrome.storage.local.remove(VFY);
    clearInterval(fpTimerId); fpTimerId = null;
    setFpStep(2);
  });

  // Strip non-digits from code input
  document.getElementById('fp-code').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g,'').slice(0,6);
  });

  document.getElementById('fp-resend-btn').addEventListener('click', () => setFpStep(0));

  // ── FORGOT: STEP 3 — confirm deletion ────────────
  document.getElementById('fp-confirm-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove([AK,AKE]);
    config.pinMode = false; await saveConfig();
    renderPinUI(false); renderApiStatus(false);
    document.getElementById('forgot-flow').style.display = 'none';
    toast('PIN disabled. API key deleted. Re-enter your key.', 'ok');
  });

  document.getElementById('fp-cancel-btn').addEventListener('click', () => {
    setFpStep(0);
    document.getElementById('forgot-flow').style.display = 'none';
  });

  // ── FILTERS ──────────────────────────────────────
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');
      filterMode = btn.dataset.filter; renderTable();
    });
  });

  document.getElementById('search').addEventListener('input', e => {
    searchQ = e.target.value.trim(); renderTable();
  });

  // ── BULK ─────────────────────────────────────────
  document.getElementById('enable-all-btn').addEventListener('click', async () => {
    rules = rules.map(r=>({...r,enabled:true}));
    await saveRules(); renderStats(); renderTable();
    toast('All rules enabled', 'ok');
  });

  document.getElementById('delete-all-btn').addEventListener('click', () => {
    if (!rules.length) { toast('No rules'); return; }
    pendingDel = 'all';
    showModal(`Delete all <strong>${rules.length} rules</strong>? Cannot be undone.`, 'DELETE ALL');
  });

  // ── PRESETS ──────────────────────────────────────
  document.getElementById('presets').addEventListener('click', e => {
    const btn = e.target.closest('[data-p]');
    if (!btn) return;
    const p = PRESETS[btn.dataset.p]; if (!p) return;
    document.getElementById('m-name').value = p.name;
    document.getElementById('m-site').value = p.site;
    document.getElementById('m-sel').value  = p.sel;
    document.getElementById('m-desc').value = p.desc;
  });

  // ── ADD RULE ─────────────────────────────────────
  document.getElementById('add-rule-btn').addEventListener('click', async () => {
    const name = document.getElementById('m-name').value.trim();
    const site = document.getElementById('m-site').value.trim();
    const sel  = document.getElementById('m-sel').value.trim();
    const desc = document.getElementById('m-desc').value.trim();
    if (!name||!site||!sel) { toast('Name, site and selector required','bad'); return; }
    rules.push({ id:'m-'+Date.now(), name, site, selector:sel, desc, enabled:true, ai:false, created:Date.now() });
    await saveRules();
    ['m-name','m-site','m-sel','m-desc'].forEach(id=>document.getElementById(id).value='');
    renderStats(); renderTable(); toast('Rule added ✓','ok');
  });

  // ── MODAL ────────────────────────────────────────
  document.getElementById('modal-cancel').addEventListener('click', hideModal);
  document.getElementById('modal').addEventListener('click', e => { if(e.target===document.getElementById('modal')) hideModal(); });
  document.getElementById('modal-ok').addEventListener('click', async () => {
    if (pendingDel==='all') rules=[]; else rules=rules.filter(r=>r.id!==pendingDel);
    await saveRules(); renderStats(); renderTable(); hideModal(); toast('Deleted','ok');
  });

  // ── EXPORT / IMPORT ──────────────────────────────
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({rules,exported:new Date().toISOString()},null,2)],{type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download='no-distraction-ai-rules.json'; a.click();
    toast('Exported ↓','ok');
  });

  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = parsed.rules||(Array.isArray(parsed)?parsed:null);
      if (!imported) { toast('Invalid file','bad'); return; }
      const ids = new Set(rules.map(r=>r.id));
      const fresh = imported.filter(r=>!ids.has(r.id));
      rules=[...rules,...fresh];
      await saveRules(); renderStats(); renderTable();
      toast(`Imported ${fresh.length} rules ↑`,'ok');
    } catch { toast('Failed to read file','bad'); }
    e.target.value='';
  });
}

// ── PRESETS ──────────────────────────────────────────
function populatePresets() {
  document.getElementById('presets').innerHTML =
    Object.entries(PRESETS).map(([k,p])=>`<button class="preset" data-p="${k}">${p.name}</button>`).join('');
}

// ── CODE TIMER ────────────────────────────────────────
function startCodeTimer(expires) {
  clearInterval(fpTimerId);
  const el = document.getElementById('fp-timer');
  const tick = () => {
    const ms = Math.max(0, expires - Date.now());
    const m  = Math.floor(ms/60000);
    const s  = Math.floor((ms%60000)/1000).toString().padStart(2,'0');
    if (el) el.textContent = `${m}:${s}`;
    if (ms === 0) { clearInterval(fpTimerId); fpTimerId = null; }
  };
  tick();
  fpTimerId = setInterval(tick, 1000);
}

// ── EMAILJS SEND ──────────────────────────────────────
async function sendEmail(toEmail, code) {
  try {
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        service_id:      recovery.serviceId,
        template_id:     recovery.templateId,
        user_id:         recovery.publicKey,
        template_params: { to_email:toEmail, code, from_name:'No Distraction AI' }
      })
    });
    return r.ok;
  } catch { return false; }
}

// ── MODAL ────────────────────────────────────────────
function showModal(body, okLabel) {
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-ok').textContent = okLabel;
  document.getElementById('modal').classList.add('on');
}
function hideModal() {
  document.getElementById('modal').classList.remove('on');
  pendingDel = null;
}

// ── HELPERS ──────────────────────────────────────────
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(ts) { return ts?new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}):'—'; }

let tt;
function toast(msg,type='') {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast on'+(type?' '+type:'');
  clearTimeout(tt); tt=setTimeout(()=>el.className='toast',2600);
}

init();
