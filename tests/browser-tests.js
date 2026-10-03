import { FloatingToolbox } from '../toolbox.js';
import { makeLocator, resolveLocator, discoverDom, HIDDEN } from '../dom.js';

const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const test = async (name, callback) => {
    try { await callback(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    document.getElementById('results').textContent = results.map(r => `${r.passed ? '✓' : '✗'} ${r.name}${r.error ? `：${r.error}` : ''}`).join('\n');
};

const ball = (id, name, left = 20) => {
    const node = document.createElement('button');
    node.id = id; node.title = name; node.textContent = name;
    node.className = 'fixture-ball'; node.style.cssText = `top:20px;left:${left}px`;
    document.body.append(node); return node;
};

let saved;
let clicks = 0;
const original = ball('fixture-magic', '魔法大典', 20);
original.addEventListener('click', () => { clicks++; });
let helperMap = { 'script-preset-A': [{ button_id: 'script-preset-A_100', button_name: '同名预设入口' }], 'script-character-B': [{ button_id: 'script-character-B_100', button_name: '同名预设入口' }] };
window.TavernHelper = { getAllEnabledScriptButtons: () => structuredClone(helperMap) };
const emitted = [];
const context = () => ({ eventSource: { emit: async id => { emitted.push(id); } } });
const app = new FloatingToolbox({ save: value => { saved = value; }, context }).start();
window.fixtureApp = app;
const candidateFor = node => app.candidates.find(candidate => candidate.kind === 'dom' && resolveLocator(document, candidate.locator).node === node);
const clickScan = () => [...document.querySelectorAll('.ftb-panel button')].find(button => button.textContent === '扫描新入口').click();

await test('启动和打开工具箱不搜索新入口', () => {
    assert(app.candidates.length === 0 && !app.hasScanned, '启动时搜索了新入口');
    app.setOpen(true);
    assert(app.candidates.length === 0 && !app.hasScanned, '打开工具箱时搜索了新入口');
    assert(!original.hasAttribute(HIDDEN), '未经确认就隐藏入口');
});
await test('点击扫描按钮只搜索一次，原生控件不进入候选', () => {
    const originalQuery = document.querySelectorAll; let discoveryQueries = 0;
    document.querySelectorAll = function(selector) {
        if (selector === '[style]') discoveryQueries++;
        return originalQuery.call(this, selector);
    };
    try {
        clickScan();
        assert(candidateFor(original), '未发现悬浮球');
        assert(!candidateFor(document.getElementById('native-fixture')), '误收原生控件');
        assert(discoveryQueries === 1, `单次点击搜索了${discoveryQueries}次`);
        app.setOpen(false); app.setOpen(true);
        assert(discoveryQueries === 1, '再次打开时重新搜索页面');
        assert(app.candidates.every(candidate => !('node' in candidate)), '候选快照仍保存第三方DOM引用');
    } finally { document.querySelectorAll = originalQuery; }
});

const originalRule = app.accept(candidateFor(original), { icon: '📖' });
await test('确认后隐藏原球，设置保留稳定规则', () => {
    assert(getComputedStyle(original).visibility === 'hidden', '未隐藏原入口');
    assert(saved.rules[0].locator.selector === '#fixture-magic', '规则未保存');
});
await test('工具选项触发原事件并自动收起', async () => {
    app.setOpen(true);
    await app.trigger(originalRule.id);
    assert(clicks === 1 && !app.open, '原事件或自动收起不正确');
    app.scan();
});
await test('新增入口和空闲等待不触发扫描，下一次点击才更新结果', async () => {
    ball('fixture-late-script', '新预设脚本', 100);
    await wait(3400);
    assert(!candidateFor(document.getElementById('fixture-late-script')), 'DOM变化或定时器触发了新入口扫描');
    app.setOpen(true);
    assert(!candidateFor(document.getElementById('fixture-late-script')), '打开工具箱搜索了新入口');
    clickScan();
    assert(candidateFor(document.getElementById('fixture-late-script')), '手动扫描未发现新入口');
});
await test('按钮重建后，点击工具直接绑定当前事件', async () => {
    original.remove();
    const replacement = ball('fixture-magic', '魔法大典', 20);
    replacement.addEventListener('click', () => { clicks += 10; });
    await app.trigger(originalRule.id);
    assert(clicks === 11, '仍然触发旧按钮');
    assert(getComputedStyle(replacement).visibility === 'hidden', '未收纳重建入口');
});
await test('重复标识匹配失败时，恢复原入口', () => {
    const duplicate = ball('fixture-magic', '魔法大典', 180);
    app.scan();
    assert(app.statuses.get(originalRule.id) === 'ambiguous', '未识别重复入口');
    assert([...document.querySelectorAll('#fixture-magic')].every(n => !n.hasAttribute(HIDDEN)), '歧义入口未恢复');
    duplicate.remove(); app.scan();
});
await test('原脚本入口在窄屏下移出视口，已收纳工具仍可使用', async () => {
    const node = document.getElementById('fixture-magic'); node.style.left = '4000px'; app.scan();
    assert(app.active.has(originalRule.id), '视口外的已收纳入口失效');
    const before = clicks; await app.trigger(originalRule.id);
    assert(clicks === before + 10, '视口外的入口未触发原事件');
    node.style.left = '20px'; app.scan();
});
await test('切换预设使入口消失时，保留规则但不显示选项', () => {
    const node = document.getElementById('fixture-magic'); node.remove(); app.scan();
    assert(!app.active.has(originalRule.id), '消失入口仍可用');
    assert(app.settings.rules.some(r => r.id === originalRule.id), '规则被误删');
    ball('fixture-magic', '魔法大典', 20); app.scan();
    assert(app.active.has(originalRule.id), '入口回来后未匹配');
});
await test('同名脚本按钮按脚本ID独立触发', async () => {
    const helper = app.candidates.find(c => c.kind === 'helper' && c.scriptId === 'script-preset-A');
    const rule = app.accept(helper);
    await app.trigger(rule.id);
    assert(emitted.length === 1 && emitted[0] === 'script-preset-A_100', '触发了错误脚本');
    delete helperMap['script-preset-A']; app.scan();
    assert(!app.active.has(rule.id), '停用预设仍显示入口');
});
await test('同一脚本重复显示同一登记按钮时，全部原入口被收纳', () => {
    const group = document.createElement('div'); group.id = 'script_container_script-character-B';
    for (let i = 0; i < 2; i++) {
        const button = document.createElement('button'); button.className = 'qr--button'; button.textContent = '同名预设入口'; group.append(button);
    }
    document.body.append(group); app.scan();
    const rule = app.accept(app.candidates.find(c => c.kind === 'helper' && c.scriptId === 'script-character-B'));
    assert([...group.children].every(n => n.hasAttribute(HIDDEN)), '重复显示的原按钮未全部收纳');
    assert(app.active.has(rule.id), '登记按钮不可用'); group.remove(); app.scan();
});
await test('同源iframe按钮可发现、收纳并触发', async () => {
    const frame = document.createElement('iframe'); frame.id = 'fixture-frame';
    frame.style.cssText = 'position:fixed;top:110px;left:20px;width:100px;height:80px;border:0';
    frame.srcdoc = '<style>body{margin:0}button{width:70px;height:50px;cursor:pointer}</style><button id="frame-entry" title="框架入口">框架入口</button>';
    document.body.append(frame); await new Promise(resolve => { frame.onload = resolve; });
    let frameClicks = 0;
    const entry = frame.contentDocument.getElementById('frame-entry'); entry.onclick = () => { frameClicks++; };
    app.scan();
    const candidate = candidateFor(entry);
    assert(candidate && candidate.locator.path.length === 1, '未发现同源框架入口');
    const rule = app.accept(candidate); await app.trigger(rule.id); app.scan();
    assert(frameClicks === 1, '框架入口未触发');
    assert(!frame.hasAttribute(HIDDEN), '整框架被隐藏');
    frame.remove(); app.scan();
});
await test('开放Shadow DOM中的入口可绑定', () => {
    const host = document.createElement('div'); host.id = 'fixture-shadow'; document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="shadow-entry" title="影子入口" style="position:fixed;top:110px;left:140px;width:60px;height:60px;cursor:pointer">影子入口</button>';
    app.scan(); const entry = root.querySelector('button'); const candidate = candidateFor(entry);
    assert(candidate && candidate.locator.path[0].kind === 'shadow', '未发现影子入口');
    const rule = app.accept(candidate);
    assert(resolveLocator(document, rule.locator).node === entry && entry.hasAttribute(HIDDEN), '影子入口匹配失败');
    host.remove(); app.scan();
});
await test('点选添加不会执行原按钮，支持命名后保存', () => {
    const entry = document.getElementById('fixture-late-script'); let accidental = 0; entry.onclick = () => { accidental++; };
    app.startPicker(); entry.click();
    assert(accidental === 0 && app.pending?.node === entry, '点选执行了原功能');
    assert(!app.picking, '点选模式未退出');
    const candidate = app.pending; app.pending = null;
    const rule = app.accept(candidate, { name: '我的新入口', icon: '⚔' });
    assert(rule.name === '我的新入口', '名称没有保存');
});
await test('入口变为大面板时保持面板可见', () => {
    const entry = document.getElementById('fixture-magic');
    entry.style.width = '600px'; entry.style.height = '300px'; app.scan();
    assert(!entry.hasAttribute(HIDDEN) && app.statuses.get(originalRule.id) === 'panel', '大面板被隐藏');
    entry.style.width = ''; entry.style.height = ''; app.scan();
});
await test('导入或编辑的危险容器规则不会隐藏整页', () => {
    app.settings.rules.push({ id: 'bad-container', kind: 'dom', name: '无效容器', enabled: true, locator: { path: [], selector: 'body', identity: { tag: 'body' } } });
    app.scan(); assert(!document.body.hasAttribute(HIDDEN), '页面整体被隐藏');
    assert(app.statuses.get('bad-container') === 'invalid', '无效规则未拒绝');
    app.settings.rules = app.settings.rules.filter(r => r.id !== 'bad-container'); app.scan();
});
await test('高级编辑可重新绑定已变化的入口属性', () => {
    const entry = document.getElementById('fixture-magic'); entry.title = '更新后的魔法大典'; app.scan();
    assert(!app.active.has(originalRule.id) && !entry.hasAttribute(HIDDEN), '属性变化未保留原入口');
    app.view = 'manage'; app.setOpen(true);
    const row = [...document.querySelectorAll('.ftb-rule')].find(n => n.querySelector('strong').textContent.includes('魔法大典'));
    [...row.querySelectorAll('button')].find(n => n.textContent === '编辑').click();
    row.querySelector('[aria-label="入口CSS选择器"]').value = 'button#fixture-magic';
    [...row.querySelectorAll('.ftb-editor button')].find(n => n.textContent === '保存').click();
    assert(app.active.has(originalRule.id) && entry.hasAttribute(HIDDEN), '新规则仍被旧属性阻止');
});
await test('长管理列表不会对每个普通按钮读取布局', () => {
    const manager = document.createElement('div'); manager.style.cssText = 'position:fixed;width:900px;height:400px;top:200px;left:0';
    for (let i = 0; i < 1500; i++) {
        const button = document.createElement('button'); button.textContent = `普通列表${i}`; manager.append(button);
    }
    document.body.append(manager);
    const originalStyle = window.getComputedStyle; let reads = 0;
    try {
        window.getComputedStyle = function(...args) { reads++; return originalStyle.apply(this, args); };
        const candidates = discoverDom(document);
        assert(!candidates.some(c => c.name.startsWith('普通列表')), '普通列表进入悬浮候选');
        assert(reads < 200, `读取布局过多：${reads}`);
    } finally { window.getComputedStyle = originalStyle; manager.remove(); }
});
await test('样式变化不会搜索，下一次扫描重新读取样式', async () => {
    const entry = document.createElement('button'); entry.id = 'fixture-styled-late'; entry.textContent = '样式加载入口';
    document.body.append(entry); app.scan();
    assert(!candidateFor(entry), '普通按钮提前成为候选');
    const style = document.createElement('style');
    style.textContent = '#fixture-styled-late{position:fixed;top:170px;left:20px;width:80px;height:50px}';
    document.head.append(style); await wait(550);
    assert(!candidateFor(entry), '样式变化触发了后台扫描');
    app.scan(); assert(candidateFor(entry), '手动扫描未读取新样式');
    style.textContent = ''; await wait(550);
    assert(candidateFor(entry), '未点击扫描，候选快照却自动改变');
    app.scan(); assert(!candidateFor(entry), '手动扫描未移除过期候选');
    style.remove(); entry.remove(); app.scan();
});
await test('长候选列表中，确认名称和保存按钮始终可见', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ball(`long-list-${i}`, `长列表入口${i}`, 20 + i % 8 * 70));
    app.scan(); app.pending = candidateFor(nodes[20]);
    app.view = 'manage'; app.setOpen(true);
    const save = [...document.querySelectorAll('.ftb-pending button')].find(n => n.textContent === '保存收纳');
    const rect = save.getBoundingClientRect();
    assert(rect.top >= 0 && rect.bottom <= window.innerHeight, '保存按钮被滚动列表挡住');
    app.pending = null; nodes.forEach(n => n.remove()); app.scan();
});
await test('过期扫描结果不会保存或隐藏错误入口', () => {
    const entry = ball('fixture-expired', '过期入口'); app.scan();
    const candidate = candidateFor(entry); entry.remove();
    const count = app.settings.rules.length;
    assert(!app.accept(candidate) && app.settings.rules.length === count, '过期结果被保存');
    assert(!entry.hasAttribute(HIDDEN), '已移除的旧节点被隐藏'); app.scan();
});
await test('暂停收纳立即恢复原入口，重新启用仍使用旧规则', () => {
    app.restoreAll(); assert(!document.querySelector(`[${HIDDEN}]`), '恢复全部失败');
    app.settings.enabled = true; app.scan();
    assert(document.getElementById('fixture-magic').hasAttribute(HIDDEN), '恢复启用失败');
});
await test('重新加载设置后入口自动匹配', () => {
    const snapshot = structuredClone(app.settings);
    snapshot.rules.push({ id: 'invalid-frame-path', kind: 'dom', name: '无效旧规则', enabled: true, locator: { selector: '#fixture-magic', path: {} } });
    app.destroy();
    const restored = new FloatingToolbox({ settings: snapshot, context }).start();
    assert(restored.active.has(originalRule.id), '设置重新加载后未匹配');
    assert(!restored.settings.rules.some(r => r.id === 'invalid-frame-path'), '无效框架路径使设置失效');
    restored.destroy();
    assert(!document.querySelector(`[${HIDDEN}]`), '关闭插件没有恢复原入口');
    assert(!document.querySelector('.ftb-launcher'), '关闭插件没有清理界面');
});

window.fixtureResults = { total: results.length, passed: results.filter(r => r.passed).length, results };
document.title = `工具箱验证 ${window.fixtureResults.passed}/${results.length}`;
