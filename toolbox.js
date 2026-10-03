import { OWN, HIDDEN, cleanText, labelOf, makeLocator, locatorKey, accessibleRoots, resolveLocator, discoverDom, helperEntries, helperNodes, isVisible, pickAction, safeEntry, normalizeSettings } from './dom.js';

// Preserve dimensions: script iframe auto-resizers must not collapse and remount a launcher.
const HIDE_CSS = `[${HIDDEN}="true"], [${HIDDEN}="true"] * { visibility: hidden !important; pointer-events: none !important; } [data-ftb-pick="true"] { outline: 3px solid #f1cf78 !important; outline-offset: 4px !important; }`;
const el = (doc, tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

export class FloatingToolbox {
    constructor({ document: doc = document, settings = {}, save = () => {}, context = () => ({}) } = {}) {
        this.doc = doc;
        this.win = doc.defaultView;
        this.settings = normalizeSettings(settings);
        this.save = save;
        this.context = context;
        this.hiddenNodes = new Set();
        this.boundRoots = new Map();
        this.discoveryCache = new Map();
        this.discoveryDirty = true;
        this.nextDiscoveryRefresh = 0;
        this.active = new Map();
        this.candidates = [];
        this.statuses = new Map();
        this.open = false;
        this.view = 'tools';
        this.picking = false;
        this.destroyed = false;
        this.renderKey = '';
        this.message = '';
    }

    start() {
        if (this.host) return this;
        this.host = el(this.doc, 'div', 'ftb-host');
        this.host.dataset.ftbOwned = 'true';
        this.launcher = el(this.doc, 'button', 'ftb-launcher');
        this.launcher.type = 'button';
        this.launcher.setAttribute('aria-label', '打开悬浮入口工具箱');
        this.launcher.setAttribute('aria-controls', 'ftb-panel');
        this.launcher.append(el(this.doc, 'span', 'ftb-launcher-icon', '▦'), el(this.doc, 'span', '', '工具箱'));
        this.badge = el(this.doc, 'span', 'ftb-badge');
        this.launcher.append(this.badge);
        this.panel = el(this.doc, 'section', 'ftb-panel');
        this.panel.id = 'ftb-panel';
        this.panel.setAttribute('aria-label', '悬浮入口工具箱');
        this.panel.hidden = true;
        this.host.append(this.launcher, this.panel);
        this.doc.body.append(this.host);
        this._bindDrag();
        this.launcher.addEventListener('click', () => {
            if (this.suppressClick) { this.suppressClick = false; return; }
            this.setOpen(!this.open);
        });
        this.outside = event => { if (this.open && !event.composedPath().includes(this.host)) this.setOpen(false); };
        this.escape = event => { if (event.key === 'Escape') { this.stopPicker(); this.setOpen(false); } };
        this.resize = () => { this._placeLauncher(); this._placePanel(); };
        this.doc.addEventListener('pointerdown', this.outside);
        this.doc.addEventListener('keydown', this.escape);
        this.win.addEventListener('resize', this.resize);
        this._mountSettings();
        this._placeLauncher();
        this.scan();
        // Low-rate fallback catches stylesheets, late helper registration, and iframe navigation.
        this.interval = this.win.setInterval(() => this.queueScan(false), 3000);
        return this;
    }

    _button(text, callback, className = 'ftb-button') {
        const button = el(this.doc, 'button', className, text);
        button.type = 'button';
        button.addEventListener('click', callback);
        return button;
    }

    _mountSettings() {
        const target = this.doc.getElementById('extensions_settings2') || this.doc.getElementById('extensions_settings');
        if (!target || this.settingNode?.isConnected) return;
        this.settingNode = el(this.doc, 'details', 'ftb-settings');
        this.settingNode.dataset.ftbOwned = 'true';
        this.settingNode.append(el(this.doc, 'summary', '', '悬浮入口工具箱'));
        const actions = el(this.doc, 'div', 'ftb-actions');
        actions.append(this._button('打开收纳管理', () => { this.view = 'manage'; this.setOpen(true); }));
        actions.append(this._button('恢复全部原入口', () => this.restoreAll()));
        this.settingNode.append(actions, el(this.doc, 'p', '', '新增入口可以自动发现或点选添加，收纳规则保存在酒馆设置中。'));
        target.append(this.settingNode);
    }

    _persist() {
        try { this.save(structuredClone(this.settings)); }
        catch { this.notify('设置保存失败，当前操作仅在本页生效。请检查酒馆连接。'); }
    }

    queueScan(refreshDiscovery = true) {
        if (refreshDiscovery) this.discoveryDirty = true;
        if (this.destroyed || this.timer || this.picking) return;
        this.timer = this.win.setTimeout(() => { this.timer = null; this.scan({ refreshDiscovery: false }); }, 250);
    }

    _observe(roots) {
        const existing = new Set(roots.map(item => item.root));
        for (const [root, binding] of this.boundRoots) {
            if (existing.has(root)) continue;
            binding.observer.disconnect();
            binding.style.remove();
            this.boundRoots.delete(root);
            this.discoveryCache.delete(root);
        }
        for (const item of roots) {
            if (this.boundRoots.has(item.root)) continue;
            const root = item.root;
            const doc = root.nodeType === 9 ? root : root.ownerDocument;
            const style = el(doc, 'style');
            style.dataset.ftbOwned = 'true';
            style.textContent = HIDE_CSS;
            (root.nodeType === 9 ? root.head || root.body : root).append(style);
            const observer = new doc.defaultView.MutationObserver(records => {
                if (this.picking) return;
                if (records.some(record => {
                    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                    if (target?.closest(`${OWN}, .mes`)) return false;
                    if (record.type === 'childList') {
                        if (target?.matches('style')) return true;
                        return [...record.addedNodes, ...record.removedNodes].some(n => n.nodeType === 1 && !n.matches(OWN));
                    }
                    return true;
                })) this.queueScan();
            });
            observer.observe(root.nodeType === 9 ? root.documentElement : root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'id', 'title', 'aria-label', 'hidden', 'src', 'href', 'disabled'] });
            this.boundRoots.set(root, { observer, style });
        }
    }

    _restoreNodes() {
        for (const node of this.hiddenNodes) node.removeAttribute(HIDDEN);
        this.hiddenNodes.clear();
    }

    scan({ refreshDiscovery = true } = {}) {
        if (this.destroyed || this.picking) return;
        this._mountSettings();
        this._restoreNodes();
        const roots = accessibleRoots(this.doc);
        this._observe(roots);
        if (refreshDiscovery || this.discoveryDirty || Date.now() >= this.nextDiscoveryRefresh) {
            this.discoveryCache.clear();
            this.discoveryDirty = false;
            this.nextDiscoveryRefresh = Date.now() + 30000;
        }
        const helpers = helperEntries(this.win);
        const helperById = new Map(helpers.map(entry => [entry.buttonId, entry]));
        this.active.clear();
        this.statuses.clear();
        const savedKeys = new Set(this.settings.rules.map(rule => rule.kind === 'dom' ? locatorKey(rule.locator) : `helper:${rule.buttonId}`));
        for (const rule of this.settings.rules) {
            if (!this.settings.enabled || !rule.enabled) { this.statuses.set(rule.id, 'paused'); continue; }
            let node = null;
            let nodes = [];
            let entry = null;
            if (rule.kind === 'helper') {
                entry = helperById.get(rule.buttonId);
                if (!entry || entry.scriptId !== rule.scriptId) { this.statuses.set(rule.id, 'missing'); continue; }
                nodes = helperNodes(this.doc, entry);
                node = nodes[0] || null;
            } else {
                const match = resolveLocator(this.doc, rule.locator);
                if (match.status !== 'ok') { this.statuses.set(rule.id, match.status); continue; }
                node = match.node;
                if (!safeEntry(node)) { this.statuses.set(rule.id, 'invalid'); continue; }
                if (node.closest(`${OWN}, .popup, dialog, [role="dialog"]`)) { this.statuses.set(rule.id, 'panel'); continue; }
                // A collected launcher can still work when its original script
                // leaves it outside a narrower viewport after resizing.
                if (!isVisible(node, false, true)) { this.statuses.set(rule.id, 'missing'); continue; }
                const rect = node.getBoundingClientRect();
                // A launcher that turns into its own large panel must remain visible.
                const controls = node.querySelectorAll('button, [role="button"], input, textarea, select').length;
                if (rect.width > Math.max(440, (rule.size?.width || 0) * 1.8) || rect.height > Math.max(160, (rule.size?.height || 0) * 1.8)
                    || controls > Math.max(1, rule.controls || 0)) {
                    this.statuses.set(rule.id, 'panel'); continue;
                }
            }
            this.active.set(rule.id, { rule, node, entry });
            this.statuses.set(rule.id, 'ok');
            for (const target of rule.kind === 'helper' ? nodes : node ? [node] : []) {
                target.setAttribute(HIDDEN, 'true'); this.hiddenNodes.add(target);
            }
        }
        const ignored = new Set(this.settings.ignored);
        this.candidates = [...discoverDom(this.doc, roots, this.discoveryCache), ...helpers].filter(entry => !savedKeys.has(entry.key) && !ignored.has(entry.key));
        const unique = new Map(this.candidates.map(entry => [entry.key, entry]));
        this.candidates = [...unique.values()];
        const badgeText = this.candidates.length ? `+${this.candidates.length}` : '';
        const badgeChanged = this.badge.textContent !== badgeText;
        this.badge.textContent = badgeText;
        this.badge.hidden = !this.candidates.length;
        if (badgeChanged) this._placeLauncher();
        const key = JSON.stringify([this.view, this.settings, [...this.statuses], this.candidates.map(c => [c.key, c.name]), this.message]);
        if (key !== this.renderKey) { this.renderKey = key; this.render(); }
    }

    setOpen(open) {
        this.open = open;
        this.panel.hidden = !open;
        this.launcher.setAttribute('aria-expanded', String(open));
        if (open) { this.scan({ refreshDiscovery: false }); this.render(); this._placePanel(); }
    }

    notify(message) {
        this.message = message;
        if (this.messageTimer) this.win.clearTimeout(this.messageTimer);
        this.render();
        this.messageTimer = this.win.setTimeout(() => { this.message = ''; this.render(); }, 6000);
    }

    accept(candidate, { name = candidate.name, icon = '◆' } = {}) {
        const key = candidate.key;
        if (this.settings.rules.some(rule => (rule.kind === 'dom' ? locatorKey(rule.locator) : `helper:${rule.buttonId}`) === key)) return;
        const id = this.win.crypto.randomUUID?.() || `ftb-${Date.now().toString(36)}-${[...this.win.crypto.getRandomValues(new Uint32Array(2))].map(n => n.toString(36)).join('')}`;
        const rule = { id, kind: candidate.kind, name: cleanText(name) || candidate.name, icon: cleanText(icon).slice(0, 4) || '◆', enabled: true };
        if (candidate.kind === 'dom') {
            rule.locator = structuredClone(candidate.locator);
            const rect = candidate.node?.getBoundingClientRect();
            rule.size = rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : undefined;
            rule.controls = candidate.node?.querySelectorAll('button, [role="button"], input, textarea, select').length || 0;
        } else {
            rule.scriptId = candidate.scriptId;
            rule.buttonId = candidate.buttonId;
        }
        this.settings.rules.push(rule);
        this.settings.enabled = true;
        this._persist();
        this.scan();
        return rule;
    }

    async trigger(id) {
        const active = this.active.get(id);
        if (!active) { this.scan(); this.notify('这个入口当前不存在，请检查当前角色或预设。'); return; }
        try {
            if (active.rule.kind === 'helper') {
                const entries = helperEntries(this.win);
                if (!entries.some(e => e.buttonId === active.rule.buttonId && e.scriptId === active.rule.scriptId)) throw new Error('脚本按钮已经停用');
                const source = this.context()?.eventSource;
                if (typeof source?.emit !== 'function') throw new Error('当前酒馆未提供脚本按钮事件接口');
                if (this.settings.autoClose) this.setOpen(false);
                await source.emit(active.rule.buttonId);
            } else {
                const match = resolveLocator(this.doc, active.rule.locator);
                if (match.node !== active.node || match.status !== 'ok') throw new Error('入口已经变化，请重新点选');
                active.node.removeAttribute(HIDDEN);
                this.hiddenNodes.delete(active.node);
                if (typeof active.node.click !== 'function') throw new Error('该入口不支持普通点击');
                if (this.settings.autoClose) this.setOpen(false);
                active.node.click();
            }
            this.queueScan();
        } catch (error) {
            active.rule.enabled = false;
            this._persist();
            this.scan();
            this.view = 'manage';
            this.setOpen(true);
            this.notify(`原入口已恢复：${cleanText(error.message)}`);
        }
    }

    restoreAll() {
        this.settings.enabled = false;
        this._restoreNodes();
        this._persist();
        this.view = 'manage';
        this.scan();
        this.notify('已恢复全部原入口。规则仍保留，可以重新启用收纳。');
    }

    render() {
        if (!this.panel || this.destroyed) return;
        const focused = this.doc.activeElement;
        if (focused && this.panel.contains(focused) && focused.matches('input, textarea')) return;
        this.panel.replaceChildren();
        const header = el(this.doc, 'div', 'ftb-header');
        header.append(el(this.doc, 'strong', '', '悬浮入口工具箱'), this._button('×', () => this.setOpen(false), 'ftb-close'));
        this.panel.append(header);
        const nav = el(this.doc, 'div', 'ftb-tabs');
        for (const [view, text] of [['tools', '我的工具'], ['manage', `收纳管理${this.candidates.length ? ` · ${this.candidates.length}` : ''}`]]) {
            const button = this._button(text, () => { this.view = view; this.render(); this._placePanel(); });
            button.classList.toggle('ftb-selected', this.view === view);
            nav.append(button);
        }
        this.panel.append(nav);
        if (this.message) {
            const message = el(this.doc, 'div', 'ftb-notice', this.message);
            message.setAttribute('role', 'status');
            this.panel.append(message);
        }
        if (this.view === 'manage' && this.pending) this._renderPending(this.panel);
        const content = el(this.doc, 'div', 'ftb-content');
        this.panel.append(content);
        if (this.view === 'tools') this._renderTools(content);
        else this._renderManage(content);
        this._placePanel();
    }

    _renderTools(content) {
        const grid = el(this.doc, 'div', 'ftb-grid');
        for (const rule of this.settings.rules) {
            if (!this.active.has(rule.id)) continue;
            const button = this._button('', () => this.trigger(rule.id), 'ftb-tool');
            button.dataset.ruleId = rule.id;
            button.append(el(this.doc, 'span', 'ftb-tool-icon', rule.icon || '◆'), el(this.doc, 'span', '', rule.name));
            grid.append(button);
        }
        content.append(grid);
        if (!grid.childElementCount) content.append(el(this.doc, 'p', 'ftb-empty', this.settings.enabled ? '还没有可用工具。进入收纳管理，确认发现的入口或点选添加。' : '收纳已暂停，原入口已恢复。可在收纳管理中重新启用。'));
        if (this.candidates.length) content.append(this._button(`发现 ${this.candidates.length} 个新入口 · 查看`, () => { this.view = 'manage'; this.render(); }));
    }

    _renderManage(content) {
        const actions = el(this.doc, 'div', 'ftb-actions');
        actions.append(this._button('＋ 点选添加', () => this.startPicker()), this._button('重新扫描', () => { this.scan(); this.render(); }));
        content.append(actions);
        const toggles = el(this.doc, 'div', 'ftb-options');
        const checkbox = (label, key) => {
            const wrapper = el(this.doc, 'label');
            const input = el(this.doc, 'input');
            input.type = 'checkbox'; input.checked = this.settings[key];
            input.addEventListener('change', () => { this.settings[key] = input.checked; this._persist(); this.scan(); });
            wrapper.append(input, this.doc.createTextNode(label)); return wrapper;
        };
        toggles.append(checkbox('启用收纳', 'enabled'), checkbox('选中工具后自动收起', 'autoClose'));
        content.append(toggles);
        content.append(el(this.doc, 'h4', '', '已保存的入口'));
        if (!this.settings.rules.length) content.append(el(this.doc, 'p', 'ftb-muted', '确认后才隐藏原入口；角色或预设暂时没有的入口会自动等待。'));
        const statusText = { ok: '可用', paused: '保留原入口', missing: '当前未出现', ambiguous: '匹配不唯一，原入口保留', invalid: '规则无效', panel: '面板打开中，保持可见' };
        this.settings.rules.forEach((rule, index) => {
            const row = el(this.doc, 'div', 'ftb-rule');
            row.append(el(this.doc, 'strong', '', `${rule.icon || '◆'} ${rule.name}`), el(this.doc, 'small', 'ftb-muted', statusText[this.statuses.get(rule.id)] || '等待扫描'));
            const buttons = el(this.doc, 'div', 'ftb-actions');
            buttons.append(this._button(rule.enabled ? '留在外面' : '重新收纳', () => { rule.enabled = !rule.enabled; this._persist(); this.scan(); }));
            buttons.append(this._button('编辑', () => this._editRule(row, rule)));
            const up = this._button('↑', () => { [this.settings.rules[index - 1], this.settings.rules[index]] = [rule, this.settings.rules[index - 1]]; this._persist(); this.scan(); }); up.disabled = index === 0; up.setAttribute('aria-label', `上移${rule.name}`);
            const down = this._button('↓', () => { [this.settings.rules[index + 1], this.settings.rules[index]] = [rule, this.settings.rules[index + 1]]; this._persist(); this.scan(); }); down.disabled = index === this.settings.rules.length - 1; down.setAttribute('aria-label', `下移${rule.name}`);
            buttons.append(up, down, this._button('移除', () => { this.settings.rules = this.settings.rules.filter(r => r !== rule); this._persist(); this.scan(); }));
            row.append(buttons); content.append(row);
        });
        content.append(el(this.doc, 'h4', '', `发现的入口 · ${this.candidates.length}`));
        if (!this.candidates.length) content.append(el(this.doc, 'p', 'ftb-muted', '没有新候选。未识别到的悬浮球可以通过点选添加。'));
        for (const candidate of this.candidates.slice(0, 60)) {
            const row = el(this.doc, 'div', 'ftb-candidate');
            row.append(el(this.doc, 'strong', '', candidate.name), el(this.doc, 'small', 'ftb-muted', candidate.source));
            const actions = el(this.doc, 'div', 'ftb-actions');
            actions.append(this._button('收纳…', () => { this.pending = candidate; this.render(); }));
            if (candidate.node) actions.append(this._button('定位', () => this._highlight(candidate.node)));
            actions.append(this._button('忽略', () => { this.settings.ignored.push(candidate.key); this._persist(); this.scan(); }));
            row.append(actions); content.append(row);
        }
        const footer = el(this.doc, 'div', 'ftb-actions ftb-footer');
        footer.append(this._button('恢复全部原入口', () => this.restoreAll()), this._button('重置忽略列表', () => { this.settings.ignored = []; this._persist(); this.scan(); }));
        footer.append(this._button('导出规则', () => this.exportRules()), this._button('导入规则', () => this.importRules()));
        content.append(footer);
    }

    _renderPending(target) {
        const box = el(this.doc, 'div', 'ftb-pending');
        box.append(el(this.doc, 'strong', '', '确认收纳入口'));
        const name = el(this.doc, 'input'); name.value = this.pending.name; name.placeholder = '入口名称'; name.setAttribute('aria-label', '新入口名称');
        const icon = el(this.doc, 'input'); icon.value = '◆'; icon.maxLength = 4; icon.setAttribute('aria-label', '新入口图标');
        box.append(name, icon);
        const actions = el(this.doc, 'div', 'ftb-actions');
        actions.append(this._button('保存收纳', () => { const candidate = this.pending; this.pending = null; this.accept(candidate, { name: name.value, icon: icon.value }); this.render(); }));
        actions.append(this._button('取消', () => { this.pending = null; this.render(); }));
        box.append(actions); target.append(box);
    }

    _editRule(row, rule) {
        const editor = el(this.doc, 'div', 'ftb-editor');
        const name = el(this.doc, 'input'); name.value = rule.name; name.setAttribute('aria-label', '入口名称');
        const icon = el(this.doc, 'input'); icon.value = rule.icon || '◆'; icon.maxLength = 4; icon.setAttribute('aria-label', '入口图标');
        editor.append(name, icon);
        let selector, label;
        if (rule.kind === 'dom') {
            const advanced = el(this.doc, 'details'); advanced.append(el(this.doc, 'summary', '', '高级：识别规则'));
            selector = el(this.doc, 'input'); selector.value = rule.locator.selector; selector.setAttribute('aria-label', '入口CSS选择器');
            label = el(this.doc, 'input'); label.value = rule.locator.label || ''; label.setAttribute('aria-label', '匹配文字');
            advanced.append(selector, label, el(this.doc, 'small', 'ftb-muted', '匹配必须唯一；同名入口可通过脚本容器或按钮ID区分。'));
            editor.append(advanced);
        }
        editor.append(this._button('保存', () => {
            rule.name = cleanText(name.value) || rule.name;
            rule.icon = cleanText(icon.value).slice(0, 4) || '◆';
            if (selector && (selector.value.trim() !== rule.locator.selector || label.value.trim() !== rule.locator.label)) {
                const locator = { ...rule.locator, selector: selector.value.trim(), label: label.value.trim(), identity: {} };
                const match = resolveLocator(this.doc, locator);
                if (match.node && safeEntry(match.node)) locator.identity = makeLocator(match.node, locator.path).identity;
                rule.locator = locator;
            }
            name.blur(); this._persist(); this.scan(); this.render();
        }), this._button('取消', () => { name.blur(); this.render(); }));
        row.querySelector('.ftb-editor')?.remove(); row.append(editor);
    }

    _highlight(node) {
        node.setAttribute('data-ftb-pick', 'true');
        this.win.setTimeout(() => node.removeAttribute('data-ftb-pick'), 1800);
    }

    startPicker() {
        if (this.picking) return;
        this.setOpen(false);
        this._restoreNodes();
        this.picking = true;
        this.pickerBanner = el(this.doc, 'div', 'ftb-pick-banner', '点选要收纳的悬浮球或按钮');
        this.pickerBanner.dataset.ftbOwned = 'true';
        this.pickerBanner.append(this._button('取消 / Esc', () => this.stopPicker()));
        this.doc.body.append(this.pickerBanner);
        this.pickerBindings = [];
        for (const { root, path } of accessibleRoots(this.doc)) {
            const stopDown = event => { if (!event.composedPath().some(n => n?.matches?.(OWN))) { event.preventDefault(); event.stopImmediatePropagation(); } };
            const move = event => {
                const node = pickAction(event.composedPath().find(n => n?.nodeType === 1));
                if (node === this.pickHovered) return;
                this.pickHovered?.removeAttribute('data-ftb-pick');
                this.pickHovered = node;
                node?.setAttribute('data-ftb-pick', 'true');
            };
            const choose = event => {
                if (event.composedPath().some(n => n?.matches?.(OWN))) return;
                event.preventDefault(); event.stopImmediatePropagation();
                const node = pickAction(event.composedPath().find(n => n?.nodeType === 1));
                if (!safeEntry(node)) {
                    this.pickerBanner.firstChild.textContent = '请选择悬浮入口，酒馆原生控件和完整弹窗不收纳。'; return;
                }
                try {
                    const locator = makeLocator(node, path);
                    this.pending = { kind: 'dom', locator, node, name: labelOf(node) || node.id || '新入口', key: locatorKey(locator), source: '手动点选' };
                    this.stopPicker(); this.view = 'manage'; this.setOpen(true);
                } catch (error) { this.pickerBanner.firstChild.textContent = cleanText(error.message); }
            };
            root.addEventListener('pointerdown', stopDown, true);
            root.addEventListener('click', choose, true);
            root.addEventListener('pointermove', move, true);
            root.addEventListener('keydown', this.escape, true);
            this.pickerBindings.push({ root, stopDown, choose, move });
        }
    }

    stopPicker() {
        if (!this.picking) return;
        this.picking = false;
        for (const { root, stopDown, choose, move } of this.pickerBindings || []) {
            root.removeEventListener('pointerdown', stopDown, true);
            root.removeEventListener('click', choose, true);
            root.removeEventListener('pointermove', move, true);
            root.removeEventListener('keydown', this.escape, true);
        }
        this.pickHovered?.removeAttribute('data-ftb-pick');
        this.pickHovered = null;
        this.pickerBanner?.remove();
        this.pickerBindings = [];
        this.scan();
    }

    _positionKey() { return `floating-toolbox-position:${this.win.innerWidth < 650 ? 'compact' : 'wide'}`; }
    _loadPosition() {
        try { return JSON.parse(this.win.localStorage.getItem(this._positionKey())) || { x: .94, y: .78 }; }
        catch { return { x: .94, y: .78 }; }
    }
    _placeLauncher(position = this._loadPosition()) {
        const width = this.launcher.offsetWidth || 122;
        const height = this.launcher.offsetHeight || 48;
        const x = Math.max(8, Math.min(this.win.innerWidth - width - 8, position.x * this.win.innerWidth));
        const y = Math.max(8, Math.min(this.win.innerHeight - height - 8, position.y * this.win.innerHeight));
        this.launcher.style.left = `${x}px`; this.launcher.style.top = `${y}px`;
    }
    _placePanel() {
        if (!this.open) return;
        const rect = this.launcher.getBoundingClientRect();
        const width = this.panel.offsetWidth;
        const height = this.panel.offsetHeight;
        const left = Math.max(8, Math.min(this.win.innerWidth - width - 8, rect.right - width));
        const above = rect.top - height - 10;
        const top = above >= 8 ? above : Math.min(this.win.innerHeight - height - 8, rect.bottom + 10);
        this.panel.style.left = `${left}px`; this.panel.style.top = `${Math.max(8, top)}px`;
    }
    _bindDrag() {
        let drag;
        this.launcher.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const rect = this.launcher.getBoundingClientRect();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
            this.launcher.setPointerCapture(event.pointerId);
        });
        this.launcher.addEventListener('pointermove', event => {
            if (!drag || drag.id !== event.pointerId) return;
            const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
            if (Math.hypot(dx, dy) < 6 && !drag.moved) return;
            drag.moved = true;
            this._placeLauncher({ x: (drag.left + dx) / this.win.innerWidth, y: (drag.top + dy) / this.win.innerHeight });
            this._placePanel();
        });
        const end = event => {
            if (!drag || drag.id !== event.pointerId) return;
            if (drag.moved) {
                this.suppressClick = true;
                this.win.setTimeout(() => { this.suppressClick = false; }, 400);
                const rect = this.launcher.getBoundingClientRect();
                try { this.win.localStorage.setItem(this._positionKey(), JSON.stringify({ x: rect.left / this.win.innerWidth, y: rect.top / this.win.innerHeight })); } catch { /* Position is optional. */ }
            }
            drag = null;
        };
        this.launcher.addEventListener('pointerup', end);
        this.launcher.addEventListener('pointercancel', end);
    }

    exportRules() {
        const blob = new this.win.Blob([JSON.stringify(this.settings, null, 2)], { type: 'application/json' });
        const url = this.win.URL.createObjectURL(blob);
        const link = el(this.doc, 'a'); link.href = url; link.download = 'floating-toolbox-rules.json'; link.click();
        this.win.setTimeout(() => this.win.URL.revokeObjectURL(url), 1000);
    }

    importRules() {
        const input = el(this.doc, 'input'); input.type = 'file'; input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            try {
                const file = input.files?.[0]; if (!file) return;
                if (file.size > 512000) throw new Error('规则文件过大');
                const raw = JSON.parse(await file.text());
                if (raw.version !== 1 || !Array.isArray(raw.rules)) throw new Error('不是有效的工具箱规则文件');
                const imported = normalizeSettings(raw);
                if (imported.rules.length !== raw.rules.length) throw new Error('规则格式不完整');
                this._restoreNodes(); this.settings = imported; this._persist(); this.scan(); this.render();
                this.notify('规则已导入。无法唯一匹配的入口会保留原样。');
            } catch (error) { this.notify(`导入失败：${cleanText(error.message)}`); }
        });
        input.click();
    }

    destroy() {
        if (this.destroyed) return;
        this.stopPicker();
        this.destroyed = true;
        this.win.clearTimeout(this.timer);
        this.win.clearTimeout(this.messageTimer);
        this.win.clearInterval(this.interval);
        this._restoreNodes();
        for (const { observer, style } of this.boundRoots.values()) { observer.disconnect(); style.remove(); }
        this.boundRoots.clear();
        this.doc.removeEventListener('pointerdown', this.outside);
        this.doc.removeEventListener('keydown', this.escape);
        this.win.removeEventListener('resize', this.resize);
        this.host?.remove(); this.settingNode?.remove();
    }
}
