// No Distraction AI – Content Script
(function () {
  'use strict';

  const BLOCKED = 'data-nda';
  let cssEl = null;
  const observers = [];
  const intervals = [];

  function host() { return location.hostname.replace(/^www\./, ''); }

  function matchesSite(pattern) {
    const h = host();
    return pattern.split(',').map(s => s.trim().replace(/^www\./, ''))
      .some(s => h === s || h.endsWith('.' + s));
  }

  function hide(el, steps) {
    if (!el) return;
    let t = el;
    for (let i = 0; i < (steps || 0); i++) {
      if (!t.parentElement) return;
      t = t.parentElement;
    }
    if (t.hasAttribute(BLOCKED)) return;
    t.setAttribute(BLOCKED, '1');
    t.style.setProperty('display',    'none',   'important');
    t.style.setProperty('visibility', 'hidden', 'important');
    t.style.setProperty('height',     '0',      'important');
    t.style.setProperty('min-height', '0',      'important');
    t.style.setProperty('overflow',   'hidden', 'important');
    t.style.setProperty('margin',     '0',      'important');
    t.style.setProperty('padding',    '0',      'important');
    t.style.setProperty('border',     'none',   'important');
  }

  function makeSweep(jr, steps) {
    return function sweep() {
      (jr.selectors || []).forEach(sel => {
        if (!sel) return;
        try { document.querySelectorAll(sel).forEach(el => hide(el, steps)); } catch (_) {}
      });
      if (jr.textContains && jr.textContains.length) {
        const roots = jr.textScope
          ? Array.from(document.querySelectorAll(jr.textScope))
          : (document.body ? [document.body] : []);

        roots.forEach(root => {
          // Walk the DOM tree to find elements whose OWN visible text
          // (not including descendants) matches one of the target strings.
          // This prevents false-positives from post body text.
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = walker.nextNode();
          while (node) {
            // Skip already-blocked subtrees
            if (node.hasAttribute(BLOCKED)) { node = walker.nextNode(); continue; }

            // Get only this element's own text (direct text node children)
            let ownText = '';
            node.childNodes.forEach(child => {
              if (child.nodeType === Node.TEXT_NODE) ownText += child.textContent;
            });
            ownText = ownText.trim();

            if (ownText && jr.textContains.some(t => ownText.includes(t))) {
              hide(node, steps); // climbs parentSteps levels up from the label element
            }
            node = walker.nextNode();
          }
        });
      }
      (jr.attrContains || []).forEach(({ attr, value, scope }) => {
        try {
          const base = scope ? (document.querySelector(scope) || document) : document;
          base.querySelectorAll('[' + attr + ']').forEach(el => {
            if (!el.hasAttribute(BLOCKED) && (el.getAttribute(attr) || '').includes(value))
              hide(el, steps);
          });
        } catch (_) {}
      });
    };
  }

  function injectCSS(active) {
    const lines = [];
    active.forEach(r => {
      if (r.selector) lines.push(`${r.selector}{display:none!important}`);
      if (r.jsRule && r.jsRule.selectors)
        r.jsRule.selectors.forEach(s => { if (s) lines.push(`${s}{display:none!important}`); });
    });
    if (!cssEl || !document.getElementById('nda-css')) {
      cssEl = document.createElement('style');
      cssEl.id = 'nda-css';
      (document.head || document.documentElement).appendChild(cssEl);
    }
    cssEl.textContent = lines.join('\n');
  }

  function apply(allRules) {
    observers.forEach(o => o.disconnect());
    intervals.forEach(i => clearInterval(i));
    observers.length = 0;
    intervals.length = 0;

    const active = allRules.filter(r => r.enabled && matchesSite(r.site));
    injectCSS(active);
    if (!active.length) return;

    const sweeps = active.map(r => {
      const jr = r.jsRule || { selectors: r.selector ? [r.selector] : [], parentSteps: 0 };
      return makeSweep(jr, jr.parentSteps || 0);
    });

    function runAll() { sweeps.forEach(s => s()); }
    runAll();
    [300, 800, 1500, 3000, 6000].forEach(d => setTimeout(runAll, d));

    let rafQueued = false;
    const obs = new MutationObserver(() => {
      if (rafQueued) return;
      rafQueued = true;
      requestAnimationFrame(() => { rafQueued = false; runAll(); });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    observers.push(obs);
    intervals.push(setInterval(runAll, 500));
  }

  function load() {
    chrome.storage.local.get('nda_rules', d => {
      const rules = d.nda_rules || [];
      apply(rules);
      // After a short delay (let React render), probe rules silently
      // and report broken ones to the background service worker
      setTimeout(() => probeAndReport(rules), 3000);
    });
  }

  // ── Silent probe — check which rules match 0 elements ──
  function probeAndReport(allRules) {
    const active = allRules.filter(r => r.enabled && matchesSite(r.site));
    if (!active.length) return;

    const results = active.map(r => {
      const jr = r.jsRule || { selectors: r.selector ? [r.selector] : [] };
      const selectors = jr.selectors || [];
      let totalMatches = 0;
      selectors.forEach(sel => {
        if (!sel) return;
        try { totalMatches += document.querySelectorAll(sel).length; } catch (_) {}
      });
      return { id: r.id, name: r.name, matches: totalMatches, site: r.site };
    });

    const broken = results.filter(r => r.matches === 0);
    if (broken.length > 0) {
      chrome.runtime.sendMessage({ type: 'NDA_RULES_BROKEN', broken, host: host() }).catch(() => {});
    }
  }

  // ── DOM inspection tools for agent ───────────────────
  function describeEl(el, depth) {
    const tag   = el.tagName.toLowerCase();
    const attrs = [];
    if (el.id) attrs.push(`id="${el.id}"`);
    if (el.getAttribute('role')) attrs.push(`role="${el.getAttribute('role')}"`);
    if (el.getAttribute('aria-label')) attrs.push(`aria-label="${el.getAttribute('aria-label').slice(0,60)}"`);
    for (const a of el.attributes) {
      if (a.name.startsWith('data-') && a.value)
        attrs.push(`${a.name}="${a.value.slice(0,80)}"`);
    }
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).slice(0,5).join(' ');
      if (cls) attrs.push(`class="${cls}"`);
    }
    const text = (el.innerText || '').trim().replace(/\s+/g,' ').slice(0,80);
    const attrStr = attrs.length ? ' '+attrs.join(' ') : '';
    let out = `<${tag}${attrStr}>${text ? ` "${text}"` : ''} (${el.children.length} children)`;
    if (depth > 0 && el.children.length > 0) {
      Array.from(el.children).slice(0, 4).forEach(child => {
        out += '\n  ' + describeEl(child, depth-1).replace(/\n/g,'\n  ');
      });
    }
    return out;
  }

  function getSnapshot(selector) {
    try {
      if (selector) {
        const els = Array.from(document.querySelectorAll(selector)).slice(0, 5);
        if (!els.length) return `No elements found matching "${selector}"`;
        return `${document.querySelectorAll(selector).length} elements matching "${selector}":\n\n`
          + els.map(el => describeEl(el, 3)).join('\n---\n');
      }
      const body = document.body;
      if (!body) return 'No body element yet';
      return `Page body — ${body.children.length} direct children:\n\n`
        + Array.from(body.children).slice(0,20).map(el => describeEl(el, 2)).join('\n---\n');
    } catch (e) { return `Error: ${e.message}`; }
  }

  function probeSelectors(selectors, parentSteps) {
    const steps = parentSteps || 0;
    return (selectors || []).map(sel => {
      if (!sel) return { selector: sel, count: 0, error: 'empty' };
      try {
        const els = Array.from(document.querySelectorAll(sel));
        const sample = els[0] ? describeEl(els[0], 1) : null;
        let parentSample = null;
        if (steps > 0 && els[0]) {
          let t = els[0];
          for (let i = 0; i < steps; i++) t = t.parentElement || t;
          parentSample = describeEl(t, 0);
        }
        return { selector: sel, count: els.length, sample, parentSample };
      } catch (e) { return { selector: sel, count: 0, error: e.message }; }
    });
  }

  // ── Message listener ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'NDA_PING')     { sendResponse({ ok: true }); return true; }
    if (msg.type === 'NDA_UPDATE')   { apply(msg.rules); return; }
    if (msg.type === 'NDA_RELOAD')   { load(); return; }
    if (msg.type === 'NDA_SNAPSHOT') { sendResponse({ result: getSnapshot(msg.selector || '') }); return true; }
    if (msg.type === 'NDA_PROBE')    { sendResponse({ result: probeSelectors(msg.selectors, msg.parentSteps) }); return true; }
  });

  // ── Boot ─────────────────────────────────────────────
  load();
  document.addEventListener('DOMContentLoaded', load);
  window.addEventListener('load', load);
  window.addEventListener('load', () => setTimeout(load, 2000));

  // Re-attach CSS if SPA navigation removes <head>
  let spaCheck;
  new MutationObserver(() => {
    clearTimeout(spaCheck);
    spaCheck = setTimeout(() => {
      if (cssEl && cssEl.textContent && !document.getElementById('nda-css'))
        (document.head || document.documentElement).appendChild(cssEl);
    }, 600);
  }).observe(document.documentElement, { childList: true, subtree: false });

})();
