# ⊘ No Distraction AI

A personal browser extension with an AI agent that finds, tests, and blocks distracting content on any website — using your own API key, running entirely locally.

> **Personal use only.** Not published to any extension store. Use responsibly and in accordance with the terms of service of any website you visit.

---

## Recommended Models

Two models that work well with this extension via [OpenRouter](https://openrouter.ai):

| Model | Cost | Best for |
|-------|------|----------|
| `qwen/qwen3-coder-next` | Very cheap | Strong at DOM inspection, structured JSON output, selector generation |

Set either in **Dashboard → API Settings → Model ID**.  
For harder tasks (complex SPAs, stubborn pages) try `anthropic/claude-3-5-sonnet` or `openai/gpt-4o-mini`.

---

## ⚠ Known Issues

### PIN Encryption & Email Recovery — Not Recommended
The PIN encryption and forgot-PIN email recovery features exist but have known issues and are **not recommended for use** at this time:
- EmailJS setup is non-trivial and error-prone
- Forgot PIN flow has edge cases that may lock you out
- PIN-encrypted API keys block the background auto-fix feature

**Recommendation:** Leave PIN mode off. Your API key is stored in Chrome's sandboxed extension storage which is isolated from other extensions and websites — this is safe enough for personal use.

---

## Features

- **AI agent chat** — describe what you want blocked in plain English; the agent inspects the live DOM, tests selectors, and saves only verified rules
- **Any LLM provider** — OpenRouter, Anthropic, OpenAI, or any OpenAI-compatible custom endpoint
- **JS blocking engine** — CSS injection + MutationObserver + 500ms polling catches dynamically loaded content as you scroll
- **Text-based blocking** — blocks elements by visible label text (e.g. "Promoted", "Sponsored") using a TreeWalker, not just CSS selectors
- **Auto-fix** — background service worker detects broken rules and silently re-runs the agent to fix them (1-hour threshold, 24-hour cooldown per rule)
- **Rule management** — agent can list, update, and delete existing rules mid-conversation
- **Per-site memory** — agent remembers what worked and failed on each site across sessions (20 messages)
- **Per-site chat history** — chat UI restores previous conversation when you reopen the popup (30 messages)
- **Deep inspection mode** — dashboard toggle that sends a richer prompt for stubborn sites
- **Dashboard** — full rule table, import/export JSON, model chips, provider switching

---

## Installation

1. Download or clone this repository
2. Open Chrome/Edge and go to `chrome://extensions`
3. Enable **Developer Mode** (toggle top-right)
4. Click **Load unpacked** → select the `no-distraction-ai` folder
5. Pin the extension to your toolbar

---

## Setup

### 1. Get an API key
- [OpenRouter](https://openrouter.ai) — supports many models including free ones
- [Anthropic](https://console.anthropic.com) — Claude models
- [OpenAI](https://platform.openai.com) — GPT models

### 2. Configure in Dashboard
Click the **⊞** icon in the popup to open Dashboard, then:
- Select your **Provider**
- Paste your **API key** → Save
- Set a **Model ID** (use the chips or type your own)

### 3. Start blocking
Navigate to any website, open the extension, and type what you want hidden:

```
"block the feed"
"hide suggested posts"
"remove the news sidebar"
"hide posts with the label Promoted"
```

The agent will inspect the page, test selectors, and save a rule. Refresh the page if the tab was already open when you installed the extension.

---

## How the Blocking Engine Works

```
Page load
  → CSS injected immediately (instant, survives SPA re-renders)
  → JS sweep runs at 0ms, 300ms, 800ms, 1.5s, 3s, 6s (waits for JS frameworks to render)
  → MutationObserver (RAF-based) catches every new DOM node added by scroll/navigation
  → 500ms polling interval as final fallback
  → 3s after load: silent probe checks all rules — reports broken ones to background
```

The background service worker waits 1 hour before auto-fixing a broken rule, and won't retry the same rule within 24 hours, to avoid unnecessary API calls.

---

## Agent Tools

The AI agent has access to these tools, one per turn:

| Tool | What it does |
|------|-------------|
| `inspect_page` | Snapshots the live DOM — tags, attributes, text, structure |
| `test_selectors` | Tests CSS selectors, returns match counts + sample elements |
| `save_rule` | Saves a verified rule to storage and activates it |
| `list_rules` | Lists all rules saved for the current site |
| `update_rule` | Updates an existing rule's selectors or text matching |
| `delete_rule` | Deletes a specific rule by ID |

---

## Text-Based Blocking

For content identified by a visible label rather than a stable CSS class, the engine uses text matching:

- Walks the DOM with `TreeWalker`
- Checks each element's **own** direct text (not descendant text — avoids false positives)
- When a match is found, climbs `parentSteps` levels up to hide the whole card
- Runs on every scroll event via MutationObserver

Tell the agent: `"hide posts with the Promoted label"` and it will use `textContains` with the right `parentSteps` for the current site's DOM structure.

---

## File Structure

```
no-distraction-ai/
├── manifest.json        Extension config (MV3)
├── background.js        Service worker — auto-fix logic, badge management
├── content.js           Injected into pages — blocking engine + DOM inspection tools
├── popup.html           Extension popup — chat UI + rules tab + PIN screen
├── popup.js             Agent loop — JSON tool calling, memory, chat history
├── dashboard.html       Settings page — API config, rule table, model selector
├── dashboard.js         Dashboard logic — CRUD, import/export, provider switching
├── crypto-utils.js      AES-256-GCM + PBKDF2 (used by PIN feature — not recommended)
└── icons/               16px, 48px, 128px extension icons
```

---

## Privacy

- No analytics, no telemetry, no external servers
- API keys stored only in `chrome.storage.local` (sandboxed per-extension)
- LLM calls go directly from your browser to your chosen API provider
- DOM snapshots sent to the LLM include only element structure, not page content or personal data

---

## License

MIT — personal use. See `LICENSE`.
