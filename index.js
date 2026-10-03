import { FloatingToolbox } from './toolbox.js';

const KEY = 'floating_entry_toolbox';
let instance;
let bootTimer;

export function onEnable() {
    if (instance) return;
    // The activate hook can arrive after an early script execution scheduled a retry.
    // Retry now so a background tab's throttled timeout does not delay initialization.
    clearTimeout(bootTimer); bootTimer = null;
    const boot = () => {
        bootTimer = null;
        let context;
        try { context = globalThis.SillyTavern?.getContext?.(); }
        catch { bootTimer = setTimeout(boot, 750); return; }
        if (!document.body || !context?.extensionSettings || !document.getElementById('extensions_settings')) {
            bootTimer = setTimeout(boot, 750); return;
        }
        const settings = context.extensionSettings[KEY] || {};
        instance = new FloatingToolbox({
            settings,
            context: () => globalThis.SillyTavern.getContext(),
            save: value => {
                const current = globalThis.SillyTavern.getContext();
                current.extensionSettings[KEY] = value;
                current.saveSettingsDebounced();
            },
        }).start();
    };
    boot();
}

export function onDisable() {
    clearTimeout(bootTimer); bootTimer = null;
    instance?.destroy(); instance = null;
}

onEnable();
