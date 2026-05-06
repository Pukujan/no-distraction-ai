// No Distraction AI – Popup (Agent Mode)
'use strict';

const SK           = 'nda_rules';
const AK           = 'nda_api_key';
const AKE          = 'nda_api_key_enc';
const CFG          = 'nda_config';
const SES_ATTEMPTS = 'nda_pin_attempts';
const SES_LOCKOUT  = 'nda_pin_lockout_until';
const MEM_PREFIX   = 'nda_mem_';
const CHAT_PREFIX  = 'nda_chat_';  // per-site chat UI history
const MAX_CHAT_MSGS = 30;
const MAX_MEM_MSGS = 20;
const MAX_ATTEMPTS     = 10;
const ATTEMPT_DELAY_MS = 5000;
const LOCKOUT_MS       = 5 * 60 * 1000;

let rules        = [];
let apiKey       = '';
let config       = {};
let currentTab   = null;
let currentHost  = '';
let encStored    = null;
let pinBuffer    = '';
let pinLocked    = false;
let cooldownId   = null;
let lockoutId    = null;
let agentRunning = false;
let domAccessible = null;

// ── MEMORY ────────────────────────────────────────────
function memKey() { return MEM_PREFIX + (currentHost || 'unknown'); }
async function loadMemory() {
  const d = await chrome.storage.local.get(memKey());
  return d[memKey()] || [];
}
async function saveMemory(msgs) {
  await chrome.storage.local.set({ [memKey()]: msgs.slice(-MAX_MEM_MSGS) });
}
async function appendMemory(role, content) {
  const msgs = await loadMemory();
  msgs.push({ role, content, ts: Date.now() });
  await saveMemory(msgs);
}
async function clearMemory() { await chrome.storage.local.remove(memKey()); }
async function updateMemCount() {
  const msgs = await loadMemory();
  const el = document.getElementById('mem-count');
  if (el) el.textContent = msgs.length;
}

// ── CHAT PERSISTENCE ─────────────────────────────────
function chatKey() { return CHAT_PREFIX + (currentHost || 'unknown'); }

async function loadChatHistory() {
  const d = await chrome.storage.local.get(chatKey());
  return d[chatKey()] || [];
}

async function saveChatMsg(role, html) {
  const d = await chrome.storage.local.get(chatKey());
  const msgs = d[chatKey()] || [];
  msgs.push({ role, html, ts: Date.now() });
  if (msgs.length > MAX_CHAT_MSGS) msgs.splice(0, msgs.length - MAX_CHAT_MSGS);
  await chrome.storage.local.set({ [chatKey()]: msgs });
}

async function clearChatHistory() {
  await chrome.storage.local.remove(chatKey());
}

async function restoreChatHistory() {
  const msgs = await loadChatHistory();
  const container = document.getElementById('chat-msgs');
  if (!msgs.length) return;
  // Remove welcome message before restoring
  container.innerHTML = '';
  msgs.forEach(m => {
    const d = document.createElement('div');
    d.className = `msg ${m.role}`;
    d.innerHTML = `<span class="msg-who">${m.role === 'user' ? 'you' : 'agent'}</span><div class="msg-bubble">${m.html}</div>`;
    container.appendChild(d);
  });
  container.scrollTop = 9999;
}

// ── BOOT ──────────────────────────────────────────────
async function boot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  try { currentHost = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  document.getElementById('site-host').textContent = currentHost || 'unknown';

  const data = await chrome.storage.local.get([SK, AK, AKE, CFG]);
  rules  = data[SK]  || [];
  config = { provider:'openrouter', model:'', baseUrl:'', pinMode:false, ...(data[CFG]||{}) };

  if (config.pinMode && data[AKE]) {
    encStored = data[AKE];
    await showPinScreen();
    return;
  }
  apiKey = data[AK] || '';
  finishInit();
}

function finishInit() {
  updateSiteBadge();
  renderRules();
  updateMemCount();
  restoreChatHistory(); // Restore saved chat messages for this site
  if (!apiKey) {
    document.getElementById('no-key-bar').style.display = 'flex';
    document.getElementById('send-btn').disabled = true;
    document.getElementById('chat-in').placeholder = 'Set API key in Dashboard first…';
  }
}

// ══════════════════════════════════════════════════════
//  PIN SCREEN
// ══════════════════════════════════════════════════════
async function showPinScreen() {
  document.getElementById('pin-screen').classList.remove('hidden');
  document.getElementById('main-ui').style.visibility = 'hidden';
  updateDots();
  const ses = await chrome.storage.session.get([SES_ATTEMPTS, SES_LOCKOUT]);
  const lockUntil = ses[SES_LOCKOUT] || 0;
  if (lockUntil > Date.now()) startLockoutCountdown(lockUntil);
  else setPinEnabled(true);
}
function updateDots() {
  for (let i = 0; i < 4; i++)
    document.getElementById('d'+i).className = 'pin-dot'+(i < pinBuffer.length ? ' filled' : '');
}
function setPinEnabled(on) {
  pinLocked = !on;
  document.getElementById('numpad').querySelectorAll('.num-btn').forEach(b => {
    b.disabled = !on; b.style.opacity = on?'':'.25'; b.style.cursor = on?'':'not-allowed';
  });
}
function pinAppend(n) {
  if (pinLocked || pinBuffer.length >= 4) return;
  pinBuffer += n; updateDots();
  if (pinBuffer.length === 4) setTimeout(tryUnlock, 80);
}
function pinDel() {
  if (pinLocked) return;
  pinBuffer = pinBuffer.slice(0,-1); updateDots(); clearPinErr();
}
async function tryUnlock() {
  if (!encStored) return;
  setPinEnabled(false);
  try {
    apiKey = await NdaCrypto.decrypt(encStored, pinBuffer);
    await chrome.storage.session.remove([SES_ATTEMPTS, SES_LOCKOUT]);
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('main-ui').style.visibility = 'visible';
    finishInit();
  } catch {
    pinBuffer = ''; updateDots(); shakeDots();
    const ses = await chrome.storage.session.get([SES_ATTEMPTS]);
    const attempts = (ses[SES_ATTEMPTS]||0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const until = Date.now() + LOCKOUT_MS;
      await chrome.storage.session.set({ [SES_ATTEMPTS]:attempts, [SES_LOCKOUT]:until });
      startLockoutCountdown(until);
    } else {
      await chrome.storage.session.set({ [SES_ATTEMPTS]:attempts });
      showPinErr(`Wrong PIN — ${MAX_ATTEMPTS-attempts} attempt${MAX_ATTEMPTS-attempts===1?'':'s'} left`);
      startCooldown();
    }
  }
}
function startCooldown() {
  let s = ATTEMPT_DELAY_MS/1000; setPinEnabled(false); showPinErr(`Wait ${s}s…`);
  clearInterval(cooldownId);
  cooldownId = setInterval(()=>{
    s--; if(s<=0){clearInterval(cooldownId);clearPinErr();setPinEnabled(true);}
    else showPinErr(`Wait ${s}s…`);
  }, 1000);
}
function startLockoutCountdown(until) {
  setPinEnabled(false); clearInterval(lockoutId);
  const tick = () => {
    const ms = Math.max(0, until-Date.now());
    if(!ms){clearInterval(lockoutId);setPinEnabled(true);clearPinErr();return;}
    showPinErr(`Locked — ${Math.floor(ms/60000)}:${Math.floor((ms%60000)/1000).toString().padStart(2,'0')}`);
  };
  tick(); lockoutId = setInterval(tick, 1000);
}
function showPinErr(m){ document.getElementById('pin-error').textContent=m; }
function clearPinErr(){ document.getElementById('pin-error').textContent=''; }
function shakeDots(){
  const el=document.getElementById('pin-dots');
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}
document.getElementById('numpad').addEventListener('click', e => {
  const btn=e.target.closest('[data-n]'); if(!btn) return;
  btn.dataset.n==='del' ? pinDel() : pinAppend(btn.dataset.n);
});
document.addEventListener('keydown', e => {
  if(document.getElementById('pin-screen').classList.contains('hidden')) return;
  if(e.key>='0'&&e.key<='9') pinAppend(e.key);
  if(e.key==='Backspace') pinDel();
});
document.getElementById('forgot-pin-btn').addEventListener('click', ()=>{
  chrome.runtime.sendMessage({type:'OPEN_DASHBOARD'}); window.close();
});

// ── TABS ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    document.getElementById('panel-'+t.dataset.tab).classList.add('on');
    if(t.dataset.tab==='rules') renderRules();
  });
});

function matchesSite(p) {
  const h=currentHost;
  return p.split(',').map(s=>s.trim().replace(/^www\./,'')).some(s=>h===s||h.endsWith('.'+s));
}
function updateSiteBadge() {
  const n=rules.filter(r=>r.enabled&&matchesSite(r.site)).length;
  const el=document.getElementById('site-badge');
  el.textContent=n+(n===1?' rule':' rules');
  el.className='site-badge'+(n>0?' has':'');
}
function renderRules() {
  const list=document.getElementById('rules-list');
  const all=[...rules.filter(r=>matchesSite(r.site)),...rules.filter(r=>!matchesSite(r.site))];
  if(!all.length){
    list.innerHTML=`<div class="empty-state"><div class="empty-icon">◻</div>No rules yet.<br>Use AI Chat to create one.</div>`;
    return;
  }
  list.innerHTML=all.map(r=>`
    <div class="rule-card ${matchesSite(r.site)?'':'other'}">
      <label class="tog-wrap"><input type="checkbox" ${r.enabled?'checked':''} data-toggle="${r.id}"/><span class="tog-track"></span></label>
      <div class="rule-info">
        <div class="rule-name">${esc(r.name)}</div>
        <div class="rule-meta">
          <span class="rule-site">${esc(r.site)}</span>
          ${r.ai?'<span class="rule-ai">✦ AI</span>':''}
        </div>
      </div>
      <button class="rule-del" data-del="${r.id}">✕</button>
    </div>`).join('');
}
document.getElementById('rules-list').addEventListener('change', async e => {
  const cb=e.target.closest('[data-toggle]'); if(!cb) return;
  rules=rules.map(r=>r.id===cb.dataset.toggle?{...r,enabled:cb.checked}:r);
  await saveRules(); updateSiteBadge();
});
document.getElementById('rules-list').addEventListener('click', async e => {
  const btn=e.target.closest('[data-del]'); if(!btn) return;
  rules=rules.filter(r=>r.id!==btn.dataset.del);
  await saveRules(); renderRules(); updateSiteBadge(); toast('Rule deleted');
});
async function saveRules() {
  await chrome.storage.local.set({ [SK]:rules });
  if(currentTab?.id)
    chrome.tabs.sendMessage(currentTab.id,{type:'NDA_UPDATE',rules}).catch(()=>{});
}
document.getElementById('btn-refresh').addEventListener('click', ()=>{
  if(currentTab?.id) chrome.tabs.sendMessage(currentTab.id,{type:'NDA_RELOAD'}).catch(()=>{});
  toast('Re-applied ↺','ok');
});
document.getElementById('btn-dash').addEventListener('click', ()=>{
  chrome.runtime.sendMessage({type:'OPEN_DASHBOARD'}); window.close();
});
document.getElementById('go-dash')?.addEventListener('click', ()=>{
  chrome.runtime.sendMessage({type:'OPEN_DASHBOARD'}); window.close();
});
document.getElementById('mem-clear-btn')?.addEventListener('click', async ()=>{
  await clearMemory();
  await clearChatHistory();
  await updateMemCount();
  document.getElementById('chat-msgs').innerHTML='';
  addMsg('ai', `Memory cleared for <strong>${esc(currentHost)}</strong>.`);
});

// ══════════════════════════════════════════════════════
//  DOM ACCESS CHECK
// ══════════════════════════════════════════════════════
async function checkDOMAccess() {
  if(!currentTab?.id){ domAccessible=false; return false; }
  return new Promise(resolve=>{
    chrome.tabs.sendMessage(currentTab.id,{type:'NDA_PING'},res=>{
      if(chrome.runtime.lastError||!res){
        chrome.scripting.executeScript(
          {target:{tabId:currentTab.id},files:['content.js']},
          ()=>{
            setTimeout(()=>{
              chrome.tabs.sendMessage(currentTab.id,{type:'NDA_PING'},res2=>{
                domAccessible=!chrome.runtime.lastError&&!!res2;
                resolve(domAccessible);
              });
            },500);
          }
        );
      } else { domAccessible=true; resolve(true); }
    });
  });
}

async function callPage(type, data) {
  if(!currentTab?.id) return {error:'DOM_NOT_ACCESSIBLE'};
  if(domAccessible===null) await checkDOMAccess();
  if(!domAccessible) return {error:'DOM_NOT_ACCESSIBLE'};
  return new Promise(resolve=>{
    chrome.tabs.sendMessage(currentTab.id,{type,...data},res=>{
      if(chrome.runtime.lastError){ domAccessible=false; resolve({error:'DOM_NOT_ACCESSIBLE'}); }
      else resolve(res||{error:'no response'});
    });
  });
}

// ══════════════════════════════════════════════════════
//  AGENT CHAT — JSON-based, works with any model
// ══════════════════════════════════════════════════════
const chatIn  = document.getElementById('chat-in');
const sendBtn = document.getElementById('send-btn');

chatIn.addEventListener('keydown', e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();startAgent();}
});
sendBtn.addEventListener('click', startAgent);
chatIn.addEventListener('input', ()=>{
  chatIn.style.height='auto';
  chatIn.style.height=Math.min(chatIn.scrollHeight,80)+'px';
});

// ── Message UI helpers ────────────────────────────────
function addMsg(role, html, cls='') {
  const d=document.createElement('div');
  d.className=`msg ${role} ${cls}`.trim();
  d.innerHTML=`<span class="msg-who">${role==='user'?'you':'agent'}</span><div class="msg-bubble">${html}</div>`;
  document.getElementById('chat-msgs').appendChild(d);
  document.getElementById('chat-msgs').scrollTop=9999;
  // Persist to chat history (don't await — fire and forget)
  if (role === 'user' || role === 'ai') saveChatMsg(role, html);
  return d;
}
function addStep(icon, text, status='') {
  const d=document.createElement('div');
  d.className='agent-step'+(status?' '+status:'');
  d.innerHTML=`<span class="step-icon">${icon}</span><span class="step-text">${esc(text)}</span>`;
  document.getElementById('chat-msgs').appendChild(d);
  document.getElementById('chat-msgs').scrollTop=9999;
  return d;
}
function updateStep(el, icon, text, status='') {
  if(!el) return;
  el.className='agent-step'+(status?' '+status:'');
  el.innerHTML=`<span class="step-icon">${icon}</span><span class="step-text">${esc(text)}</span>`;
}

// Persistent thinking bar — stays visible across all turns
let thinkBar = null;
function showThinking(text) {
  if(!thinkBar){
    thinkBar=document.createElement('div');
    thinkBar.className='think-bar';
    document.getElementById('chat-msgs').appendChild(thinkBar);
  }
  thinkBar.innerHTML=`<div class="typing"><span></span><span></span><span></span></div><span>${esc(text)}</span>`;
  document.getElementById('chat-msgs').scrollTop=9999;
}
function hideThinking() {
  if(thinkBar){ thinkBar.remove(); thinkBar=null; }
}

// ── Main agent loop ───────────────────────────────────
async function startAgent() {
  const text=chatIn.value.trim();
  if(!text||!apiKey||agentRunning) return;
  chatIn.value=''; chatIn.style.height='auto';
  agentRunning=true; sendBtn.disabled=true;

  addMsg('user', esc(text));
  await appendMemory('user', text);

  // Check DOM on first message
  if(domAccessible===null){
    const ok=await checkDOMAccess();
    if(!ok) addMsg('ai',
      '⚠ Page was open before extension loaded. ' +
      "I'll write rules from memory — <strong>refresh after saving</strong> to activate them."
    );
  }

  const provider=config.provider||'openrouter';
  const model=config.model||defaultModel(provider);
  const extended=config.extended||false;
  const memory=await loadMemory();

  // Build system prompt
  const siteRules = rules.filter(r => matchesSite(r.site));
  const rulesContext = siteRules.length
    ? `\nCURRENT RULES FOR THIS SITE (${siteRules.length} rule${siteRules.length===1?'':'s'}):\n`
      + siteRules.map(r => `- id:"${r.id}" name:"${r.name}" selectors:${JSON.stringify((r.jsRule||{}).selectors||[])} textContains:${JSON.stringify((r.jsRule||{}).textContains||[])} parentSteps:${(r.jsRule||{}).parentSteps||0}`).join('\n')
      + '\n'
    : '\nNo rules saved for this site yet.\n';

  const memSection = memory.length>1
    ? `\nMEMORY (last ${Math.min(memory.length-1,10)} exchanges on this site):\n`
      + memory.slice(0,-1).slice(-10).map(m=>`[${m.role}]: ${String(m.content).slice(0,200)}`).join('\n')
      + '\nUse memory to avoid selectors that previously failed and prefer ones that worked.\n'
    : '';

  const system = `You are a browser content-blocking agent on "${currentHost}".${rulesContext}${memSection}

CRITICAL FORMAT RULE: Every response must be EXACTLY ONE JSON object. No text before or after. No multiple JSON objects. No explanations. One JSON, that is all.

You work in a loop. Each turn you output ONE action, the system executes it and gives you the result, then you output your next ONE action. Do NOT chain multiple actions in one response.

Available actions (pick ONE per response):

{"action":"inspect","selector":"css selector or empty string for full page","message":"what you are looking for"}

{"action":"test","selectors":["sel1","sel2","sel3"],"parentSteps":0,"message":"why you are testing these"}

{"action":"save","name":"short rule name","description":"what this blocks","selectors":["sel1","sel2"],"parentSteps":0,"message":"done message for user"}

{"action":"reply","message":"message to user when no tool needed"}

{"action":"give_up","message":"reason — only after 8+ failed attempts"}

{"action":"list_rules","message":"why you want to see existing rules"}

{"action":"update_rule","id":"rule-id","selectors":["new-sel1","new-sel2"],"parentSteps":0,"textContains":[],"textScope":"","message":"what you changed and why"}

{"action":"delete_rule","id":"rule-id","message":"why you are deleting it"}

EXAMPLE of correct behaviour:
Turn 1 → you output: {"action":"inspect","selector":"","message":"scanning page structure"}
System gives you the DOM snapshot.
Turn 2 → you output: {"action":"test","selectors":["[role='feed'] > div","article"],"parentSteps":0,"message":"testing what I found"}
System gives you match counts.
Turn 3 → you output: {"action":"save","name":"LinkedIn Feed","description":"Hides feed posts","selectors":["[role='feed'] > div"],"parentSteps":0,"message":"Saved! Refresh to activate."}

WRONG — do NOT do this:
{"action":"inspect"...} {"action":"test"...}  ← TWO actions in one turn, FORBIDDEN

RULE MANAGEMENT — when user says "fix", "change", "update", "amend", or "delete" a rule:
1. First call list_rules to see what rules exist for this site
2. Identify the rule by name or description
3. Either update_rule with new selectors or delete_rule if removing it entirely
4. Do NOT create a new rule when asked to fix an existing one

TEXT-BASED BLOCKING — use this when CSS selectors fail for labeled content:
- LinkedIn "Promoted", Twitter "Promoted", Facebook "Sponsored" posts all have a visible text label
- The engine finds elements whose OWN text (not their children's text) matches the string
- Then climbs parentSteps levels up to hide the whole post card
- This runs every 500ms and on every DOM mutation — works continuously as user scrolls
- Use: {"action":"save","name":"LinkedIn Promoted Posts","selectors":[],"textContains":["Promoted"],"textScope":"[role='feed']","parentSteps":5,"description":"Hides promoted posts by text label"}
- parentSteps: for LinkedIn the "Promoted" label is ~4-6 levels inside the post card — try 5 first
- textScope: always scope it to narrow the search — "[role='feed']", "main", ".scaffold-layout__main"
- textContains is case-sensitive — "Promoted" not "promoted"
- COMBINE with selectors: if you also have CSS selectors that work, include both for maximum coverage
- This approach handles infinite scroll automatically — every new post that loads gets checked

MANDATORY WORKFLOW — follow this exactly:

STEP 1: Always start with {"action":"inspect","selector":"","message":"scanning page"} to see the real page structure.

STEP 2: Look at the data-* attributes and element tags in the result. Find patterns that identify feed content.

STEP 3: Test 3-5 selectors based on what you ACTUALLY saw in the DOM, not just known selectors.

STEP 4: If still 0 matches, inspect a specific section: {"action":"inspect","selector":"main","message":"looking at main content area"} or inspect "[role='main']", "div[class*='feed']", ".scaffold-layout" etc.

STEP 5: Keep trying. Try attribute selectors like [class*="feed"], [class*="update"], [class*="post"]. Try tag names like "article". Look at what tags actually exist.

STEP 6: Only save when you have matches. Only give up after 8+ failed attempts with genuine effort.
STEP 7: If all selectors fail, try a completely different approach — use parentSteps, or target a grandparent container.

CRITICAL RULES:
- NEVER give up after just 1-2 attempts — always inspect the real DOM first
- If DOM_NOT_ACCESSIBLE: immediately save using built-in knowledge, tell user to refresh
- parentSteps: 0=hide matched el, 1=parent, 2=grandparent
- PREFER data-* attributes and structural selectors over class names
- Always provide 3+ selectors as fallbacks
- When inspect shows you what's on the page, USE that information to write selectors

FINDING FEED ITEMS — think about these approaches:
- What tag wraps each post? (li, article, div?)
- Does each post have a data-urn, data-id, or data-entity-type attribute?
- Is there a [role="article"] or [role="listitem"]?
- What is the feed container? (ul, div with role="feed"?)
- Can you match the container and use > * to target children?
- Try: [data-urn], [data-id], article, li[class*="feed"], div[class*="update"]

KNOWN STARTING POINTS (try these, but INSPECT if they fail):
LinkedIn feed:       [data-urn*="activity:"], [data-urn*="ugcPost:"], .occludable-update, .feed-shared-update-v2, [data-view-name*="feed"]
LinkedIn news:       .news-module, [data-view-name="news-module"], aside .artdeco-card
LinkedIn suggestions:.pymk-hcard, [data-view-name="pymk-hcard"]
YouTube Shorts:      ytd-reel-shelf-renderer, a[href*="/shorts/"]
YouTube sidebar:     ytd-compact-video-renderer
Twitter trending:    [data-testid="trend"], [aria-label="Timeline: Trending now"]
Reddit promoted:     [data-promoted="true"], shreddit-ad-post

${extended ? `
DEEP INSPECTION MODE IS ON — use these advanced techniques:

1. SHADOW DOM — some sites hide content inside shadow roots. Try inspecting with selector "* /deep/ div" patterns and note any #shadow-root in the output.

2. SUBSTRING CLASS MATCHING — class names rotate but often keep meaningful substrings:
   [class*="feed"], [class*="update"], [class*="post"], [class*="card"], [class*="story"]
   [class*="promoted"], [class*="sponsored"], [class*="ad-"], [class*="recommendation"]

3. STRUCTURAL SELECTORS — target by position and tag, not identity:
   main > div > ul > li   (feed items as list items)
   [role="feed"] > div    (feed container children)
   [role="article"]       (semantic article elements)
   [role="listitem"]      (list items in a feed)

4. PARENT TRAVERSAL STRATEGY — if you find an inner element, climb up:
   Match a like/comment button, set parentSteps:2 or 3 to hide the whole post card

5. ATTRIBUTE PATTERNS — look for any data attribute that groups content:
   [data-entity-type], [data-content-type], [data-view-name]
   [data-finite-scroll-hotspot], [data-occludable-job-id]
   Any attribute whose value contains "post", "update", "activity", "feed"

6. COMBO SELECTORS — combine to be precise:
   div[data-urn]:not([data-urn*="profile"]):not([data-urn*="company"])
   li[class*="feed"]:not([class*="ad"])

7. INSPECT DEEPLY — when you inspect, also inspect sub-selectors:
   First inspect "" (page root), then inspect the container you found,
   then inspect a single item inside it to understand the full tree.

8. IF ALL ELSE FAILS — try hiding the feed scroll container entirely:
   .scaffold-finite-scroll, [data-finite-scroll-hotspot], .feed-container

Be thorough. Try at least 6 different selector strategies before concluding.
` : ''}`;

  // Message history from memory (user/assistant only)
  const historyMsgs = memory.slice(0,-1).slice(-(MAX_MEM_MSGS-1))
    .filter(m=>m.role==='user'||m.role==='assistant')
    .map(m=>({role:m.role, content:String(m.content)}));

  const messages = [...historyMsgs, {role:'user', content:text}];
  const MAX_TURNS = 14;

  showThinking('Agent thinking…');

  for(let turn=0; turn<MAX_TURNS; turn++){
    // Call LLM
    let raw;
    try { raw = await llmCall(provider, model, system, messages); }
    catch(e){
      hideThinking();
      addMsg('ai', `API error: ${esc(e.message)}`, 'err');
      break;
    }

    messages.push({role:'assistant', content:raw});
    await appendMemory('assistant', raw.slice(0,300));

    // Parse JSON response — extract first complete JSON object only
    let parsed = null;
    let parseWarning = false;

    // Strip markdown fences
    const cleanRaw = raw.replace(/^```json?\s*/i,'').replace(/\s*```$/,'').trim();

    // Try full parse first
    try { parsed = JSON.parse(cleanRaw); } catch(_) {}

    // If that fails, find first { ... } block
    if (!parsed) {
      // Find all JSON-like objects in the response
      const jsonMatches = [];
      let depth = 0, start = -1;
      for (let i = 0; i < cleanRaw.length; i++) {
        if (cleanRaw[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (cleanRaw[i] === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            jsonMatches.push(cleanRaw.slice(start, i+1));
            start = -1;
          }
        }
      }
      if (jsonMatches.length > 0) {
        try { parsed = JSON.parse(jsonMatches[0]); } catch(_) {}
        // If model sent multiple actions, warn it
        if (jsonMatches.length > 1) parseWarning = true;
      }
    }

    if (!parsed) {
      // Model returned unparseable text — show it and stop
      hideThinking();
      if (raw.trim()) addMsg('ai', esc(raw.slice(0, 400)));
      break;
    }

    // If model sent multiple JSON objects, send a correction and let it retry
    if (parseWarning) {
      messages.push({ role:'assistant', content: raw });
      messages.push({ role:'user', content: 'SYSTEM: You sent multiple JSON actions in one response. Only ONE action per response is allowed. I executed only your first action. Continue from where you left off with a single JSON action.' });
      // Still execute the first parsed action below
    }

    const msg = parsed.message || '';

    // ── Execute action ──────────────────────────────
    if(parsed.action === 'inspect'){
      updateStep(null,'',''); // keep thinking bar
      showThinking(`Inspecting page${parsed.selector ? ': '+parsed.selector : ''}…`);
      const step=addStep('🔍', `inspect(${parsed.selector||'page'})`);
      const res=await callPage('NDA_SNAPSHOT',{selector:parsed.selector||''});
      const result=res.result||res.error||'no response';
      updateStep(step,'🔍',`inspect(${parsed.selector||'page'}) → ${result.slice(0,80)}…`,'done');
      messages.push({role:'user', content:result});
      await appendMemory('user', `inspect result: ${result.slice(0,200)}`);

    } else if(parsed.action === 'test'){
      showThinking('Testing selectors…');
      const step=addStep('🧪',`test([${(parsed.selectors||[]).join(', ')}])`);
      const res=await callPage('NDA_PROBE',{selectors:parsed.selectors||[],parentSteps:parsed.parentSteps||0});
      let summary;
      if(res.error==='DOM_NOT_ACCESSIBLE'){
        summary='DOM_NOT_ACCESSIBLE';
      } else {
        summary=(res.result||[]).map(r=>
          r.error ? `"${r.selector}" → ERROR: ${r.error}`
                  : `"${r.selector}" → ${r.count} match${r.count!==1?'es':''}`
        ).join('\n');
      }
      const preview=summary.slice(0,100);
      updateStep(step,'🧪',`test → ${preview}${summary.length>100?'…':''}`, 'done');
      messages.push({role:'user', content:summary});
      await appendMemory('user', `test result: ${summary.slice(0,200)}`);

    } else if(parsed.action === 'save'){
      hideThinking();
      const step=addStep('💾',`saving rule: ${parsed.name||'AI Rule'}`);
      const rule={
        id:'ai-'+Date.now(),
        name:(parsed.name||'AI Rule').slice(0,50),
        site:currentHost||'unknown',
        desc:parsed.description||'',
        jsRule:{
          selectors:    parsed.selectors    || [],
          parentSteps:  parsed.parentSteps  || 0,
          pollInterval: 500,
          textContains: parsed.textContains || [],
          textScope:    parsed.textScope    || '',
          attrContains: parsed.attrContains || []
        },
        enabled:true, ai:true, created:Date.now()
      };
      rules.push(rule);
      await saveRules();
      updateSiteBadge();
      renderRules();
      updateStep(step,'✓',`saved: ${rule.name} (${rule.jsRule.selectors.length} selectors)`,'done');
      if(msg) addMsg('ai', esc(msg));
      await appendMemory('assistant', `saved rule: ${rule.name}`);
      await updateMemCount();
      break;

    } else if(parsed.action === 'reply'){
      hideThinking();
      addMsg('ai', esc(msg));
      await appendMemory('assistant', msg);
      // No tool call — agent is done or asking for input
      break;

    } else if(parsed.action === 'list_rules'){
      hideThinking();
      const siteRules = rules.filter(r => matchesSite(r.site));
      const step = addStep('📋', 'list_rules()', 'done');
      const ruleList = siteRules.length
        ? siteRules.map(r => `id:"${r.id}" | "${r.name}" | selectors:${JSON.stringify((r.jsRule||{}).selectors||[])} textContains:${JSON.stringify((r.jsRule||{}).textContains||[])} parentSteps:${(r.jsRule||{}).parentSteps||0}`).join('\n')
        : 'No rules for this site';
      messages.push({role:'user', content: ruleList});
      await appendMemory('user', `rules: ${ruleList.slice(0,300)}`);
      showThinking('Reviewing rules…');

    } else if(parsed.action === 'update_rule'){
      hideThinking();
      const targetId = parsed.id;
      const ruleIndex = rules.findIndex(r => r.id === targetId);
      if(ruleIndex === -1){
        const step = addStep('✗', `update_rule — id "${targetId}" not found`, 'done');
        messages.push({role:'user', content: `Rule id "${targetId}" not found. Use list_rules to get correct ids.`});
        showThinking('Retrying…');
      } else {
        const oldRule = rules[ruleIndex];
        const updatedRule = {
          ...oldRule,
          jsRule: {
            ...oldRule.jsRule,
            selectors:    parsed.selectors    ?? (oldRule.jsRule||{}).selectors    ?? [],
            parentSteps:  parsed.parentSteps  ?? (oldRule.jsRule||{}).parentSteps  ?? 0,
            textContains: parsed.textContains ?? (oldRule.jsRule||{}).textContains ?? [],
            textScope:    parsed.textScope    ?? (oldRule.jsRule||{}).textScope    ?? '',
            pollInterval: 500
          }
        };
        rules[ruleIndex] = updatedRule;
        await saveRules();
        updateSiteBadge();
        renderRules();
        const step = addStep('✓', `updated: ${oldRule.name}`, 'done');
        if(msg) addMsg('ai', esc(msg));
        await appendMemory('assistant', `updated rule: ${oldRule.name}`);
        await updateMemCount();
        break;
      }

    } else if(parsed.action === 'delete_rule'){
      hideThinking();
      const targetId = parsed.id;
      const target = rules.find(r => r.id === targetId);
      if(!target){
        addStep('✗', `delete_rule — id "${targetId}" not found`, 'done');
        messages.push({role:'user', content: `Rule id "${targetId}" not found. Use list_rules first.`});
        showThinking('Retrying…');
      } else {
        rules = rules.filter(r => r.id !== targetId);
        await saveRules();
        updateSiteBadge();
        renderRules();
        addStep('✓', `deleted: ${target.name}`, 'done');
        if(msg) addMsg('ai', esc(msg));
        await appendMemory('assistant', `deleted rule: ${target.name}`);
        await updateMemCount();
        break;
      }

    } else if(parsed.action === 'give_up'){
      hideThinking();
      addMsg('ai', esc(msg||"Couldn't find reliable selectors. Try describing what you see on the page."), 'err');
      break;
    }
  }

  hideThinking();
  await updateMemCount();
  agentRunning=false;
  sendBtn.disabled=!apiKey;
}

// ── LLM call — plain text response, no tool API ───────
async function llmCall(provider, model, system, messages) {
  if(provider==='anthropic'){
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model,max_tokens:800,system,messages})
    });
    if(!r.ok){const e=await r.json();throw new Error(e.error?.message||r.status);}
    return (await r.json()).content?.[0]?.text?.trim()||'';
  } else {
    const base=provider==='custom'?config.baseUrl
              :provider==='openai'?'https://api.openai.com/v1'
              :'https://openrouter.ai/api/v1';
    const r=await fetch(`${base}/chat/completions`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
      body:JSON.stringify({model,max_tokens:800,messages:[{role:'system',content:system},...messages]})
    });
    if(!r.ok){const e=await r.json();throw new Error(e.error?.message||r.status);}
    return (await r.json()).choices?.[0]?.message?.content?.trim()||'';
  }
}

function defaultModel(p){
  return p==='anthropic'?'claude-3-5-haiku-20241022':p==='openai'?'gpt-4o-mini':'anthropic/claude-3-5-haiku';
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

let tTimer;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast on'+(type?' '+type:'');
  clearTimeout(tTimer); tTimer=setTimeout(()=>el.className='toast',2200);
}

boot();
