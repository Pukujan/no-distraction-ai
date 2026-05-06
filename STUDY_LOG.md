# No Distraction AI — Study Log

> Technical concepts learned and explored while building this extension.  
> Written as a reference for future projects.

---

## 1. Chrome Extension Architecture (Manifest V3)

### Key components

```
┌─────────────────────────────────────────────────────┐
│  Browser                                            │
│  ┌─────────────┐   ┌──────────────────────────┐    │
│  │ Service     │   │ Web Page                 │    │
│  │ Worker      │   │  ┌────────────────────┐  │    │
│  │ background  │◄──┼──│  Content Script    │  │    │
│  │ .js         │   │  │  content.js        │  │    │
│  └──────┬──────┘   │  └────────────────────┘  │    │
│         │          └──────────────────────────┘    │
│  ┌──────▼──────┐                                   │
│  │  Extension  │   ┌──────────────────────────┐    │
│  │  Storage    │   │  Popup / Dashboard       │    │
│  │  local      │◄──│  popup.html              │    │
│  │  session    │   │  dashboard.html          │    │
│  └─────────────┘   └──────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Key API differences between MV2 and MV3

| Feature | MV2 | MV3 |
|---------|-----|-----|
| Background | Persistent page | Service Worker (ephemeral) |
| Remote code | Allowed | Blocked |
| `chrome.tabs.executeScript` | Direct | Must use `chrome.scripting` |
| CSP | Relaxed | Strict |

### Service Worker lifecycle
- Terminates after ~30 seconds of inactivity
- Cannot hold state in variables across invocations — must use `chrome.storage`
- Cannot access DOM (no `document`)
- Wakes up in response to events (messages, alarms, etc.)

### Content script isolation
Content scripts run in an "isolated world" — same DOM, but separate JavaScript context. This means:
- Cannot access page's JavaScript variables or functions
- Page cannot access content script variables
- `chrome` APIs are available in content scripts
- `window.postMessage` is one way scripts can communicate across the boundary

### Message passing patterns

```javascript
// Content script → Background
chrome.runtime.sendMessage({ type: 'NDA_RULES_BROKEN', broken: [...] });

// Popup → Content script (requires knowing tab ID)
chrome.tabs.sendMessage(tabId, { type: 'NDA_PROBE', selectors: [...] }, response => {
  // response comes back here
});

// Background → Content script
chrome.tabs.sendMessage(tab.id, { type: 'NDA_UPDATE', rules: [...] });
```

**Key lesson:** `chrome.tabs.sendMessage` requires a content script to already be running in that tab. If the tab was open before the extension loaded, you get "Could not establish connection. Receiving end does not exist." — solved by calling `chrome.scripting.executeScript` to inject the script programmatically first.

---

## 2. DOM Manipulation at Scale

### Why CSS alone is insufficient for dynamic pages

Modern JavaScript frameworks (React, Vue, Angular) manage the DOM as a virtual representation. When state changes, they diff the virtual DOM and patch the real DOM. This means:

1. Elements you hid with CSS may be *unmounted and remounted* — losing inline styles
2. New elements are added outside the initial HTML, so CSS rules that were present at load time still apply, but elements added via JavaScript need the browser to recalculate styles
3. The CSS CSSOM is persistent but element-level `style` attributes may be reset

**The dual-layer solution:**
- CSS `<style>` injection handles the paint layer — fast, handled by browser engine before JS runs
- JS sweep handles the dynamic layer — catches anything added after initial parse

### MutationObserver

```javascript
const observer = new MutationObserver(callback);
observer.observe(target, {
  childList: true,   // watch for added/removed children
  subtree: true,     // watch all descendants
  attributes: false  // don't watch attribute changes (noisy)
});
```

**Debounce problem with infinite scroll:**
```
Scroll event → mutation → debounce(200ms) reset
Scroll event → mutation → debounce(200ms) reset
Scroll event → mutation → debounce(200ms) reset
→ callback never fires
```

**RAF solution:**
```javascript
let rafQueued = false;
new MutationObserver(() => {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    sweep();
  });
});
```
`requestAnimationFrame` fires once per paint frame (~16ms). No matter how many mutations happen between frames, only one sweep runs.

### TreeWalker for text node inspection

```javascript
const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
let node = walker.nextNode();
while (node) {
  // Get ONLY this element's own text (not descendant text)
  let ownText = '';
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) ownText += child.textContent;
  });
  // ...
  node = walker.nextNode();
}
```

**Why `textContent` is wrong for label matching:**  
`element.textContent` returns ALL text from ALL descendants concatenated. An article card containing the word "promoted" anywhere in its 500-word body would match `textContent.includes("Promoted")`. TreeWalker + own-text-only checking is precise.

---

## 3. Web Cryptography API

### AES-256-GCM encryption flow

```
User PIN (string)
    ↓ TextEncoder
Raw bytes
    ↓ crypto.subtle.importKey('raw', ..., 'PBKDF2')
PBKDF2 key material (not the actual key yet)
    ↓ crypto.subtle.deriveKey(PBKDF2, salt, iterations=200000, SHA-256)
AES-256-GCM key (256 bits)
    ↓ crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext)
Ciphertext
```

**What gets stored:**
```json
{
  "salt": [16 random bytes],
  "iv": [12 random bytes],
  "ct": [ciphertext bytes]
}
```

**What is NEVER stored:** the PIN, the derived key, or the plaintext API key.

### Why PBKDF2 with 200,000 iterations?
PBKDF2 (Password-Based Key Derivation Function 2) is designed to be slow on purpose — it makes brute-forcing a short PIN computationally expensive. 200,000 iterations is the current OWASP recommended minimum for SHA-256.

### Why AES-GCM over AES-CBC?
GCM (Galois/Counter Mode) provides **authenticated encryption** — it detects tampering. If someone modifies the stored ciphertext, decryption fails with an error rather than producing garbled plaintext silently. This means a wrong PIN produces a clean error, not garbage data.

### Key insight: the PIN is the key
There is no "master key" stored anywhere. The PIN IS the key — or more precisely, it's the source material that deterministically derives the encryption key via PBKDF2. Without the PIN, the key cannot be reconstructed. This is why forgetting the PIN means losing the API key.

---

## 4. AI Agent Architecture

### The agentic loop pattern

```
System prompt (context, tools, rules)
    ↓
User message
    ↓
┌─────────────────────────────────────┐
│  LLM turn                           │
│  Model outputs: action + args       │
│                 ↓                   │
│  Execute action (tool call)         │
│                 ↓                   │
│  Inject tool result as user message │
│                 ↓                   │
│  Next LLM turn...                   │
└─────────────────────────────────────┘
    ↓ (when action = "save" or "give_up")
Final result
```

### Why JSON-based over native tool calling APIs

Native tool calling:
- Anthropic uses `tools` array + `tool_use` content blocks
- OpenAI uses `tools` array + `tool_calls` in message
- These are different schemas
- Many OpenRouter models claim support but output plain text `<function=...>` tags instead

JSON-based tool calling:
- Prompt tells the model to output a JSON object with `{"action": "...", "args": ...}`
- We parse the JSON ourselves
- Works with any model that can output valid JSON — nearly all of them
- Single code path, no format branching

**Tradeoff:** models occasionally output malformed JSON or multiple JSON objects. Mitigated by:
1. A brace-depth parser that extracts the first complete JSON object
2. A correction injection if multiple JSON objects are detected
3. An explicit worked example in the system prompt labelling the wrong pattern "FORBIDDEN"

### Context injection strategy

The system prompt is rebuilt on every agent call and includes:

```
[base instructions]
[current rules for this site — IDs, names, selectors]
[site memory — last N exchanges on this domain]
[user message]
```

This gives the agent working memory across sessions without maintaining state in the LLM itself (which is stateless between API calls).

### Tool design principle: verification before saving

The `save_rule` action should only be called after `test_selectors` confirms matches > 0. The system prompt enforces this. The background auto-fix loop also re-verifies selectors before writing them to storage, even after the agent says to save.

---

## 5. Chrome Storage APIs

### `chrome.storage.local` vs `chrome.storage.session` vs `chrome.storage.sync`

| API | Persists | Size limit | Use case |
|-----|----------|------------|----------|
| `local` | Until extension removed | 10MB | Rules, config, memory |
| `session` | Until browser closes | 10MB | PIN attempt counters |
| `sync` | Syncs across devices via Google account | 100KB | Not used — privacy concern |

### Storage key design pattern used

Namespaced by feature and domain:

```
nda_rules           → all blocking rules (array)
nda_config          → provider, model, pinMode, etc.
nda_api_key         → plain API key (no PIN)
nda_api_key_enc     → encrypted API key blob (PIN mode)
nda_mem_github.com  → agent memory for github.com
nda_chat_github.com → chat history for github.com
nda_autofix_state   → {ruleId: {firstBrokenAt, lastFixAttempt}}
```

This avoids collisions between sites and makes per-domain clearing straightforward.

---

## 6. Provider-Agnostic API Design

### The two API formats

**Anthropic `/v1/messages`:**
```json
{
  "model": "claude-3-5-haiku-20241022",
  "max_tokens": 800,
  "system": "...",
  "messages": [{"role": "user", "content": "..."}]
}
```

**OpenAI-compatible `/v1/chat/completions`:**
```json
{
  "model": "gpt-4o-mini",
  "max_tokens": 800,
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ]
}
```

Key differences:
- Anthropic takes `system` as a top-level field; OpenAI puts it as the first message with `role: "system"`
- Response: Anthropic → `content[0].text`; OpenAI → `choices[0].message.content`
- OpenRouter uses the OpenAI-compatible format for all models

### What makes OpenRouter useful here
OpenRouter provides a single API endpoint that proxies to dozens of model providers. By supporting OpenRouter as a provider, the extension gains access to models from Anthropic, OpenAI, Google, Meta, Mistral, Qwen, and others — through a single API key. The free-tier models (`meta-llama/llama-3.1-8b-instruct:free`) are useful for testing without spending money.

---

## 7. Security Considerations

### Extension storage threat model

`chrome.storage.local` is:
- Sandboxed per extension — other extensions and websites cannot read it
- Stored on disk in the Chrome profile directory (unencrypted at the OS level)
- Accessible to anyone with physical access to the machine who can extract the Chrome profile

This is why the PIN encryption feature exists — even if someone extracts the raw Chrome profile data, the API key is AES-256 ciphertext without the PIN.

### Content Security Policy in MV3

MV3 enforces a strict CSP:
- No `eval()` or `new Function()` with string arguments
- No inline scripts in HTML (must use external `.js` files)
- No loading scripts from remote URLs

This is why all logic is in separate `.js` files and why dynamic code evaluation isn't used.

### The `host_permissions: ["<all_urls>"]` decision

The extension requests access to all URLs so it can inject the content script and probe selectors on any site. This is the broadest possible permission. For personal use this is fine; it would be a significant concern for a publicly published extension.

---

## 8. Lessons Learned

### On building agentic systems

1. **Models don't follow format rules from the first turn.** You need an explicit worked example showing both correct and incorrect behaviour, with the wrong pattern labelled "FORBIDDEN." Abstract instructions like "output only JSON" are ignored.

2. **Tool results should be injected as the next user message.** This keeps the message history clean and works across all provider formats without special handling.

3. **Give the agent its current state.** Injecting the list of existing rules into the system prompt before each agent run removes an entire class of bugs (duplicating instead of updating rules).

4. **Max turns is a safety net, not a target.** Most successful runs finish in 3-5 turns. Raising MAX_TURNS from 10 to 14 helped for stubborn sites without meaningfully increasing cost.

5. **Memory across sessions is more valuable than longer context within a session.** 20 messages of "selector X failed last week" is more useful than a 100k token context window with the same session.

### On browser extension development

1. **Content scripts don't run in tabs that were already open.** Always test "open tab first, then install extension" — this is the common user scenario and it will fail if you only test fresh tabs.

2. **MV3 service workers are unreliable for stateful operations.** Store everything in `chrome.storage`, assume the worker can terminate at any moment.

3. **Event delegation beats per-element listeners.** Re-rendering a list and re-attaching listeners is error-prone. One `addEventListener` on the parent container handles all children forever.

4. **CSS and JS blocking are complementary, not alternatives.** CSS handles first-paint; JS handles dynamic content. Use both.

### On security implementation

1. **Never store the encryption key.** The PIN IS the key (via PBKDF2). There is no way to recover the key without the PIN — by design.

2. **AES-GCM provides authentication.** Wrong PIN → decryption throws an error. You don't need separate MAC verification.

3. **Salt and IV must be unique per encryption.** Both are randomly generated for each `encrypt()` call. Reusing either would weaken the security.

4. **PBKDF2 iteration count matters for short PINs.** A 4-digit PIN has only 10,000 possible values. 200,000 PBKDF2 iterations means ~200,000 hash operations per guess, making brute-force slow even for short PINs.
