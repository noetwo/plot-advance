let hostForTests = null;

// 测试显式注入：
// { SillyTavern, importModule(specifier), fetch(input, init), storage, globals, getMvuZodSchema() }。
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
export function getHostGlobal(name) {
    if (hostForTests?.globals && Object.prototype.hasOwnProperty.call(hostForTests.globals, name)) {
        return hostForTests.globals[name];
    }
    return globalThis[name];
}
export function setHostGlobal(name, value) {
    if (hostForTests) {
        if (!hostForTests.globals) hostForTests.globals = {};
        hostForTests.globals[name] = value;
    } else {
        globalThis[name] = value;
    }
    return value;
}

export function hostFetch(input, init) {
    const fetchFn = hostForTests?.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
    return fetchFn.call(hostForTests || globalThis, input, init);
}

export function getHostStorage() {
    return hostForTests?.storage ?? globalThis.localStorage;
}

export function getMvuZodSchema() {
    if (typeof hostForTests?.getMvuZodSchema === 'function') return hostForTests.getMvuZodSchema();
    const root = globalThis.document?.getElementById?.('tavern_helper');
    const schema = root?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('variable_schemas')?.message;
    return schema?.__v_raw || schema || null;
}

export function importHostModule(specifier) {
    if (hostForTests?.importModule) return hostForTests.importModule(specifier);
    return import(specifier);
}
