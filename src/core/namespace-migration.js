const OLD_SETTINGS_KEY = 'storyOracle';
const NEW_SETTINGS_KEY = 'plotAdvance';
const MIGRATION_MARKER = '_namespaceMigrated';
const OLD_REGEX_ID = 'so-seq-pulse-hide';

const STORAGE_KEY_PAIRS = [
    ['so.settings.tab', 'pad.settings.tab'],
    ['so-fixhub-cache-v1', 'pad-fixhub-cache-v1'],
    ['so-fixhub-author-v1', 'pad-fixhub-author-v1'],
    ['so.fixsel.mode', 'pad.fixsel.mode'],
    ['so.fixsel.debug', 'pad.fixsel.debug'],
];
// localStorage 跟着浏览器走，不跟设置走：设置里的 _namespaceMigrated 是全局的，
// 第二台设备 / 第二个浏览器的旧键要靠这个本浏览器自己的标记来保证「只搬一次」。
const STORAGE_MARKER_KEY = 'pad.namespaceMigrated';

const CHAT_SUFFIXES = new Set([
    'path',
    'summary',
    'diagwi',
    'wisel',
    'fixcfg',
    'builder',
    'lbapply',
    'mvuedSchema',
    'mvuedAsList',
    'mvuedTrainer',
    'saveHealth',
    'lwbSummary',
    'applied',
]);

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function migrateStorage(storage) {
    if (!storage || typeof storage.getItem !== 'function'
        || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') return;

    try {
        if (storage.getItem(STORAGE_MARKER_KEY) !== null) return;
    } catch {
        return;   // localStorage can be unavailable even when the object itself exists.
    }

    for (const [oldKey, newKey] of STORAGE_KEY_PAIRS) {
        try {
            const oldValue = storage.getItem(oldKey);
            if (oldValue === null) continue;
            if (storage.getItem(newKey) === null) storage.setItem(newKey, oldValue);
            storage.removeItem(oldKey);
        } catch {
            // Same as above: skip this key, keep going.
        }
    }
    try { storage.setItem(STORAGE_MARKER_KEY, '1'); } catch { /* not persisted: retried on next load */ }
}

export function migrateGlobalNamespace({ extensionSettings, storage } = {}) {
    migrateStorage(storage);
    if (!isObject(extensionSettings)) return { changed: false, movedLegacySettings: false };

    const current = extensionSettings[NEW_SETTINGS_KEY];
    if (isObject(current) && current[MIGRATION_MARKER]) return { changed: false, movedLegacySettings: false };

    let target = current;
    let movedLegacySettings = false;
    if (!isObject(target)) {
        const legacy = extensionSettings[OLD_SETTINGS_KEY];
        if (isObject(legacy)) {
            // 必须深拷贝：原版若已同时启用，它在我们之前初始化，控件闭包里缓存着这个旧对象并会继续往里写；
            // 按引用挪过来，它的改动就会写进剧情推进的设置。
            target = structuredClone(legacy);
            extensionSettings[NEW_SETTINGS_KEY] = target;
            delete extensionSettings[OLD_SETTINGS_KEY];
            movedLegacySettings = true;
        } else {
            target = {};
            extensionSettings[NEW_SETTINGS_KEY] = target;
        }
    }

    target[MIGRATION_MARKER] = 1;

    if (Array.isArray(extensionSettings.regex)) {
        for (let i = extensionSettings.regex.length - 1; i >= 0; i -= 1) {
            if (extensionSettings.regex[i]?.id === OLD_REGEX_ID) extensionSettings.regex.splice(i, 1);
        }
    }
    return { changed: true, movedLegacySettings };
}

export function migrateChatNamespace(chatMetadata) {
    if (!isObject(chatMetadata) || chatMetadata.plotAdvance_migrated) return false;

    const oldPrefix = `${OLD_SETTINGS_KEY}_`;
    const newPrefix = `${NEW_SETTINGS_KEY}_`;
    for (const oldKey of Object.keys(chatMetadata)) {
        if (!oldKey.startsWith(oldPrefix)) continue;
        const suffix = oldKey.slice(oldPrefix.length);
        if (!CHAT_SUFFIXES.has(suffix) && !suffix.startsWith('convo')) continue;

        const newKey = newPrefix + suffix;
        // 深拷贝同上：原版可能正持有这份元数据值的引用。
        if (!Object.hasOwn(chatMetadata, newKey)) chatMetadata[newKey] = structuredClone(chatMetadata[oldKey]);
        delete chatMetadata[oldKey];
    }

    chatMetadata.plotAdvance_migrated = 1;
    return true;
}
