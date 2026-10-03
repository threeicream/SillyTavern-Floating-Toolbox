// Rules describe an entry, never the code or HTML of a third-party script.
export const OWN = '[data-ftb-owned]';
export const HIDDEN = 'data-ftb-hidden';
const NATIVE = '#top-settings-holder, #form_sheld, #left-nav-panel, #right-nav-panel, #extensions_settings, #extensions_settings2, .mes, .popup, dialog, [role="dialog"], #toast-container';
const ACTION = 'button, a, [role="button"], [onclick], [tabindex], .interactable, .menu_button, div, span, i, img';
export const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

export function labelOf(el) {
    return cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || el.innerText || el.textContent || el.getAttribute('alt'));
}

function query(root, selector) {
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
}

function selectorFor(el, root) {
    const escape = el.ownerDocument.defaultView.CSS.escape;
    const unique = selector => query(root, selector).length === 1;
    if (el.localName === 'iframe' && el.id.startsWith('TH-script--')) {
        const scriptId = el.id.replace(/^TH-script--.+--/, '');
        const selector = `iframe[id$="--${escape(scriptId)}"]`;
        if (unique(selector)) return selector;
    }
    if (el.id) {
        const selector = `#${escape(el.id)}`;
        if (unique(selector)) return selector;
    }
    const tag = el.localName;
    for (const attr of ['data-testid', 'data-id', 'data-action', 'aria-label', 'title', 'name']) {
        const value = el.getAttribute(attr);
        if (value) {
            const selector = `${tag}[${attr}="${escape(value)}"]`;
            if (unique(selector)) return selector;
        }
    }
    const classes = [...el.classList].filter(c => !/^(ftb-|active$|hidden$|open$|selected$|hover$|focus$)/.test(c));
    if (classes.length) {
        const selector = tag + classes.slice(0, 5).map(c => `.${escape(c)}`).join('');
        if (unique(selector)) return selector;
    }
    // Scoped selectors avoid positional nth-child rules that silently drift.
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (!parent.id || parent === el.ownerDocument.body) continue;
        const selector = `#${escape(parent.id)} ${tag}` + classes.slice(0, 3).map(c => `.${escape(c)}`).join('');
        const label = labelOf(el);
        if (label && query(root, selector).filter(node => labelOf(node) === label).length === 1) return selector;
    }
    if (labelOf(el)) return tag; // Label narrows this selector below.
    return null;
}

export function makeLocator(el, path = []) {
    const root = el.getRootNode();
    const selector = selectorFor(el, root);
    if (!selector) throw new Error('这个入口没有稳定名称或标识。请选中带名称的按钮，或在规则编辑中填写选择器。');
    const nodes = query(root, selector);
    const label = nodes.length === 1 ? '' : labelOf(el);
    if (nodes.filter(n => !label || labelOf(n) === label).length !== 1) throw new Error('入口特征不唯一，请选中更具体的按钮。');
    const identity = { tag: el.localName };
    for (const attr of ['aria-label', 'title', 'data-action', 'data-testid']) {
        if (el.getAttribute(attr)) identity[attr] = el.getAttribute(attr);
    }
    return { path: structuredClone(path), selector, label, identity };
}

export function resolveRoot(doc, path) {
    if (path !== undefined && !Array.isArray(path)) return null;
    let root = doc;
    for (const step of path || []) {
        if (!step || !['frame', 'shadow'].includes(step.kind) || typeof step.selector !== 'string') return null;
        const hosts = query(root, step.selector);
        if (hosts.length !== 1) return null;
        try { root = step.kind === 'frame' ? hosts[0].contentDocument : hosts[0].shadowRoot; }
        catch { return null; }
        if (!root) return null;
    }
    return root;
}

export function resolveLocator(doc, locator) {
    if (!locator?.selector) return { node: null, status: 'invalid' };
    const root = resolveRoot(doc, locator.path);
    if (!root) return { node: null, status: 'missing' };
    const matches = query(root, locator.selector).filter(node => {
        if (node.closest(OWN)) return false;
        if (locator.label && labelOf(node) !== locator.label) return false;
        return Object.entries(locator.identity || {}).every(([key, value]) => key === 'tag' ? node.localName === value : node.getAttribute(key) === value);
    });
    if (matches.length !== 1) return { node: null, status: matches.length ? 'ambiguous' : 'missing' };
    return { node: matches[0], status: 'ok' };
}

export function locatorKey(locator) {
    return JSON.stringify([locator.path || [], locator.selector, locator.label || '', locator.identity || {}]);
}

export function accessibleRoots(doc) {
    const roots = [];
    const seen = new Set();
    function walk(root, path, depth) {
        if (!root || depth > 5 || seen.has(root)) return;
        seen.add(root);
        roots.push({ root, path });
        for (const frame of query(root, 'iframe')) {
            if (frame.closest(OWN)) continue;
            try {
                if (!isVisible(frame)) continue;
                const child = frame.contentDocument;
                if (!child?.body) continue;
                const loc = makeLocator(frame);
                walk(child, [...path, { kind: 'frame', selector: loc.selector }], depth + 1);
            } catch { /* Cross-origin/opaque frames stay untouched. */ }
        }
        for (const host of query(root, '*')) {
            if (!host.shadowRoot || host.closest(OWN)) continue;
            try {
                const loc = makeLocator(host);
                walk(host.shadowRoot, [...path, { kind: 'shadow', selector: loc.selector }], depth + 1);
            } catch { /* A host without a stable locator cannot be persisted. */ }
        }
    }
    walk(doc, [], 0);
    return roots;
}

export function isVisible(el, includeHidden = false, includeOffscreen = false) {
    if (!el?.isConnected) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if ((!includeHidden && el.hasAttribute(HIDDEN)) || style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    const viewport = el.ownerDocument.defaultView;
    if (!includeOffscreen && (rect.bottom < 0 || rect.right < 0 || rect.top > viewport.innerHeight || rect.left > viewport.innerWidth)) return false;
    let win = el.ownerDocument.defaultView;
    try {
        while (win.frameElement) {
            const frame = win.frameElement;
            const css = frame.ownerDocument.defaultView.getComputedStyle(frame);
            const frameRect = frame.getBoundingClientRect();
            const parent = frame.ownerDocument.defaultView;
            if (css.display === 'none' || css.visibility === 'hidden' || frameRect.width < 3 || frameRect.height < 3) return false;
            if (!includeOffscreen && (frameRect.bottom < 0 || frameRect.top > parent.innerHeight || frameRect.right < 0 || frameRect.left > parent.innerWidth)) return false;
            win = frame.ownerDocument.defaultView;
        }
    } catch { return false; }
    return true;
}

export function pickAction(el) {
    if (!el?.closest || el.closest(OWN)) return null;
    const action = el.closest('button, a, [role="button"], [onclick], .interactable, .menu_button');
    if (action) return action;
    let result = el;
    for (let parent = el.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
        const rect = parent.getBoundingClientRect();
        if (rect.width > 400 || rect.height > 130 || parent.closest(OWN)) break;
        if (['pointer', 'grab'].includes(parent.ownerDocument.defaultView.getComputedStyle(parent).cursor)) result = parent;
        else break;
    }
    return result;
}

export function safeEntry(node) {
    return node && !node.matches('html, body, iframe, input, textarea, select, script, style')
        && !node.closest(`${OWN}, ${NATIVE}`) && !node.querySelector(OWN);
}

function floatingHost(el) {
    let node = el;
    // A static button can float with its Shadow DOM host. Cross that boundary
    // when checking ancestors, just as ordinary children inherit a fixed host.
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement || node.getRootNode().host) {
        const css = node.ownerDocument.defaultView.getComputedStyle(node);
        if (['fixed', 'absolute'].includes(css.position)) {
            const rect = node.getBoundingClientRect();
            if (rect.width <= 440 && rect.height <= 160 && rect.width >= 10 && rect.height >= 10) return node;
            return null;
        }
    }
    // Some script widgets live in their own floating same-origin iframe.
    try {
        const frame = el.ownerDocument.defaultView.frameElement;
        if (frame) {
            const css = frame.ownerDocument.defaultView.getComputedStyle(frame);
            const rect = frame.getBoundingClientRect();
            if (['fixed', 'absolute'].includes(css.position) && rect.width <= 440 && rect.height <= 160) return frame;
        }
    } catch { /* No frame access. */ }
    return null;
}

export function discoverDom(doc, roots = accessibleRoots(doc), cache = null) {
    const found = [];
    const seen = new Set();
    for (const { root, path } of roots) {
        let positioned = cache?.get(root);
        if (!positioned) {
            positioned = new Set();
            for (const node of query(root, '[style]')) {
                if (['fixed', 'absolute'].includes(node.style.position)) positioned.add(node);
            }
            // Query floating-container selectors, without reading each ordinary
            // chat or manager node's computed style and layout.
            const sheets = root.nodeType === 9 ? [...root.styleSheets] : query(root, 'style, link').map(node => node.sheet).filter(Boolean);
            sheets.push(...(root.adoptedStyleSheets || []));
            const seenSheets = new Set();
            const selectors = new Set();
            const readRules = rules => {
                for (const rule of rules) {
                    if (['fixed', 'absolute'].includes(rule.style?.position) && rule.selectorText) selectors.add(rule.selectorText);
                    if (rule.cssRules) readRules(rule.cssRules);
                    if (rule.styleSheet) readSheet(rule.styleSheet);
                }
            };
            const readSheet = sheet => {
                if (seenSheets.has(sheet)) return;
                seenSheets.add(sheet);
                try { readRules(sheet.cssRules); } catch { /* Opaque external sheet: manual selection remains available. */ }
            };
            sheets.forEach(readSheet);
            // Combine queries; one unsupported vendor selector must not block all.
            const probe = (root.ownerDocument || root).createElement('div');
            const usable = [...selectors].filter(selector => {
                try { probe.matches(selector); return true; } catch { return false; }
            });
            if (usable.length) for (const node of query(root, usable.join(','))) positioned.add(node);
            let frame;
            try { frame = root.nodeType === 9 ? root.defaultView.frameElement : root.host; } catch { /* Opaque frame. */ }
            if (frame && floatingHost(frame) === frame) positioned.add(root.body || root);
            cache?.set(root, positioned);
        }
        const actions = new Set();
        for (const container of positioned) {
            const host = container.nodeType === 1 ? container : root.host;
            if (!host || host.closest(`${OWN}, ${NATIVE}`) || !isVisible(host)) continue;
            const rect = host.getBoundingClientRect();
            if (rect.width > 440 || rect.height > 160) continue;
            if (container.nodeType === 1 && container.matches(ACTION)) actions.add(container);
            for (const node of query(container, ACTION)) actions.add(node);
        }
        for (const el of actions) {
            if (el.closest(`${OWN}, ${NATIVE}`) || el.hasAttribute(HIDDEN) || !isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width > 400 || rect.height > 130) continue;
            const css = el.ownerDocument.defaultView.getComputedStyle(el);
            const clickable = el.matches('button, a, [role="button"], [onclick], .interactable, .menu_button') || ['pointer', 'grab'].includes(css.cursor);
            if (!clickable || !floatingHost(el)) continue;
            const action = pickAction(el);
            if (seen.has(action) || !safeEntry(action)) continue;
            seen.add(action);
            try {
                const locator = makeLocator(action, path);
                found.push({ kind: 'dom', locator, node: action, name: labelOf(action) || action.id || '未命名悬浮入口', key: locatorKey(locator), source: path.some(p => p.kind === 'frame') ? '脚本页面入口' : '页面悬浮入口' });
            } catch { /* Manual selection explains a missing stable identity. */ }
        }
    }
    return found;
}

export function helperEntries(win) {
    try {
        const helper = win.TavernHelper;
        if (typeof helper?.getAllEnabledScriptButtons !== 'function') return [];
        return Object.entries(helper.getAllEnabledScriptButtons()).flatMap(([scriptId, buttons]) => buttons.map(button => ({
            kind: 'helper', scriptId, buttonId: button.button_id, name: cleanText(button.button_name), fullName: String(button.button_name).trim(),
            key: `helper:${button.button_id}`, source: '酒馆助手登记按钮',
        })));
    } catch { return []; }
}

export function helperNodes(doc, entry) {
    const group = doc.getElementById(`script_container_${entry.scriptId}`);
    if (!group) return [];
    return query(group, '.qr--button').filter(node => node.textContent.trim() === entry.fullName);
}

export function normalizeSettings(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const seenIds = new Set();
    const rules = Array.isArray(input.rules) ? input.rules.filter(r => {
        if (!r || typeof r.id !== 'string' || !r.id || seenIds.has(r.id)) return false;
        const valid = r.kind === 'helper' ? typeof r.buttonId === 'string' && typeof r.scriptId === 'string'
            : r.kind === 'dom' && typeof r.locator?.selector === 'string' && (r.locator.path === undefined || Array.isArray(r.locator.path) && r.locator.path.every(step => step && ['frame', 'shadow'].includes(step.kind) && typeof step.selector === 'string'));
        if (valid) seenIds.add(r.id);
        return valid;
    }).map(r => ({ ...r, name: cleanText(r.name) || '未命名入口', enabled: r.enabled !== false,
        size: { width: Number.isFinite(r.size?.width) ? Math.min(440, Math.max(0, r.size.width)) : 0, height: Number.isFinite(r.size?.height) ? Math.min(160, Math.max(0, r.size.height)) : 0 },
    })) : [];
    return { version: 1, enabled: input.enabled !== false, rules, ignored: Array.isArray(input.ignored) ? input.ignored.filter(key => typeof key === 'string') : [], autoClose: input.autoClose !== false };
}
