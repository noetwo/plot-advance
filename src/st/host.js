let hostForTests = null;

// 测试显式注入：{ SillyTavern: { getContext() {} }, importModule(specifier) {} }。
// 传 null 恢复真实宿主。模块求值时不解析任何浏览器或酒馆全局。
export function setHostForTests(fake) {
    hostForTests = fake || null;
}

export function getHostContext() {
    const host = hostForTests?.SillyTavern ?? globalThis.SillyTavern;
    if (!host || typeof host.getContext !== 'function') {
        throw new Error('SillyTavern.getContext is unavailable');
    }
    return host.getContext();
}

export function importHostModule(specifier) {
    if (hostForTests?.importModule) return hostForTests.importModule(specifier);
    return import(specifier);
}
