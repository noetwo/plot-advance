import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateChatNamespace, migrateGlobalNamespace } from '../src/core/namespace-migration.js';

const STORAGE_KEY_PAIRS = [
    ['so.settings.tab', 'pad.settings.tab'],
    ['so-fixhub-cache-v1', 'pad-fixhub-cache-v1'],
    ['so-fixhub-author-v1', 'pad-fixhub-author-v1'],
    ['so.fixsel.mode', 'pad.fixsel.mode'],
    ['so.fixsel.debug', 'pad.fixsel.debug'],
];

function fakeStorage(entries = []) {
    const values = new Map(entries);
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); },
        values,
    };
}

test('全局迁移搬走旧设置、删除旧键，新设置是独立副本', () => {
    const legacy = { endpoint: 'https://example.test', nested: { value: 1 } };
    const extensionSettings = { storyOracle: legacy };

    assert.deepEqual(migrateGlobalNamespace({ extensionSettings, storage: null }), { changed: true, movedLegacySettings: true });
    assert.equal(extensionSettings.storyOracle, undefined);
    const { _namespaceMigrated, ...moved } = extensionSettings.plotAdvance;
    assert.equal(_namespaceMigrated, 1);
    assert.deepEqual(moved, legacy);
});

test('两者都已启用时首次迁移：原版缓存的旧设置对象与新设置隔离', () => {
    const legacy = { model: 'shared-model', nested: { value: 1 } };
    const extensionSettings = { storyOracle: legacy };
    const originalCachedSettings = extensionSettings.storyOracle;   // 原版 bindControls 先于我们缓存

    migrateGlobalNamespace({ extensionSettings, storage: null });
    originalCachedSettings.model = 'edited-in-original';
    originalCachedSettings.nested.value = 2;

    assert.equal(extensionSettings.plotAdvance.model, 'shared-model');
    assert.equal(extensionSettings.plotAdvance.nested.value, 1);
});

test('全局迁移标记使第二次调用彻底无操作', () => {
    const extensionSettings = { storyOracle: { old: true }, regex: [] };
    const storage = fakeStorage([['so.settings.tab', 'first']]);
    migrateGlobalNamespace({ extensionSettings, storage });

    const rebuiltLegacy = { rebuilt: true };
    const rebuiltRegex = { id: 'so-seq-pulse-hide' };
    extensionSettings.storyOracle = rebuiltLegacy;
    extensionSettings.regex.push(rebuiltRegex);
    storage.setItem('so.settings.tab', 'second');

    assert.deepEqual(migrateGlobalNamespace({ extensionSettings, storage }), { changed: false, movedLegacySettings: false });
    assert.strictEqual(extensionSettings.storyOracle, rebuiltLegacy);
    assert.strictEqual(extensionSettings.regex[0], rebuiltRegex);
    assert.equal(storage.getItem('so.settings.tab'), 'second');
    assert.equal(storage.getItem('pad.settings.tab'), 'first');
});

test('设置已迁移过时，另一个浏览器的 localStorage 仍迁移一次', () => {
    const extensionSettings = { plotAdvance: { _namespaceMigrated: 1 } };
    const secondBrowser = fakeStorage([['so.fixsel.mode', 'tap']]);

    assert.deepEqual(migrateGlobalNamespace({ extensionSettings, storage: secondBrowser }), { changed: false, movedLegacySettings: false });
    assert.equal(secondBrowser.getItem('so.fixsel.mode'), null);
    assert.equal(secondBrowser.getItem('pad.fixsel.mode'), 'tap');

    secondBrowser.setItem('so.fixsel.mode', 'drag');   // 原版之后在这个浏览器里写回自己的键
    migrateGlobalNamespace({ extensionSettings, storage: secondBrowser });
    assert.equal(secondBrowser.getItem('so.fixsel.mode'), 'drag');
    assert.equal(secondBrowser.getItem('pad.fixsel.mode'), 'tap');
});

test('已有新设置不会被旧设置覆盖或触发旧键删除', () => {
    const current = { endpoint: 'new' };
    const legacy = { endpoint: 'old' };
    const extensionSettings = { plotAdvance: current, storyOracle: legacy };

    assert.deepEqual(migrateGlobalNamespace({ extensionSettings }), { changed: true, movedLegacySettings: false });
    assert.strictEqual(extensionSettings.plotAdvance, current);
    assert.strictEqual(extensionSettings.storyOracle, legacy);
    assert.equal(current.endpoint, 'new');
    assert.equal(current._namespaceMigrated, 1);
});

test('正则迁移只移除指定的共享清理脚本', () => {
    const keepBefore = { id: 'keep-before', script: 'a' };
    const keepAfter = { id: 'keep-after', script: 'b' };
    const regex = [
        keepBefore,
        { id: 'so-seq-pulse-hide', script: 'remove 1' },
        keepAfter,
        { id: 'so-seq-pulse-hide', script: 'remove 2' },
    ];
    const extensionSettings = { regex };

    migrateGlobalNamespace({ extensionSettings });
    assert.strictEqual(extensionSettings.regex, regex);
    assert.deepEqual(regex, [keepBefore, keepAfter]);
});

test('localStorage 五组键迁移、保留已有新值并删除所有旧键', () => {
    const entries = [];
    for (let i = 0; i < STORAGE_KEY_PAIRS.length; i += 1) {
        entries.push([STORAGE_KEY_PAIRS[i][0], `old-${i}`]);
    }
    entries.push(['pad.fixsel.mode', 'existing-new-value']);
    const storage = fakeStorage(entries);

    migrateGlobalNamespace({ extensionSettings: {}, storage });

    for (let i = 0; i < STORAGE_KEY_PAIRS.length; i += 1) {
        const [oldKey, newKey] = STORAGE_KEY_PAIRS[i];
        assert.equal(storage.getItem(oldKey), null);
        assert.equal(storage.getItem(newKey), newKey === 'pad.fixsel.mode' ? 'existing-new-value' : `old-${i}`);
    }
});

test('localStorage 缺失或抛错不影响设置迁移', () => {
    const withoutStorage = {};
    assert.doesNotThrow(() => migrateGlobalNamespace({ extensionSettings: withoutStorage, storage: null }));
    assert.equal(withoutStorage.plotAdvance._namespaceMigrated, 1);

    const throwingStorage = {
        getItem() { throw new Error('storage denied'); },
        setItem() { throw new Error('storage denied'); },
        removeItem() { throw new Error('storage denied'); },
    };
    const withThrowingStorage = {};
    assert.doesNotThrow(() => migrateGlobalNamespace({ extensionSettings: withThrowingStorage, storage: throwingStorage }));
    assert.equal(withThrowingStorage.plotAdvance._namespaceMigrated, 1);
});

test('聊天迁移移动全部自有键和动态 convo 键，保留旧协议键与未知键', () => {
    const suffixes = [
        'path', 'summary', 'diagwi', 'wisel', 'fixcfg', 'builder', 'lbapply',
        'mvuedSchema', 'mvuedAsList', 'mvuedTrainer', 'saveHealth', 'lwbSummary', 'applied',
        'convo', 'convo_advisor', 'convo_builder-npc',
    ];
    const references = new Map();
    const chatMetadata = {};
    for (const suffix of suffixes) {
        const value = { suffix };
        references.set(suffix, value);
        chatMetadata[`storyOracle_${suffix}`] = value;
    }
    const untouchedSuffixes = ['plan', 'seq', 'arc', 'nbeat', 'unknown'];
    for (const suffix of untouchedSuffixes) chatMetadata[`storyOracle_${suffix}`] = `keep-${suffix}`;

    assert.equal(migrateChatNamespace(chatMetadata), true);
    assert.equal(chatMetadata.plotAdvance_migrated, 1);
    for (const suffix of suffixes) {
        assert.equal(Object.hasOwn(chatMetadata, `storyOracle_${suffix}`), false);
        assert.deepEqual(chatMetadata[`plotAdvance_${suffix}`], references.get(suffix));
    }
    for (const suffix of untouchedSuffixes) {
        assert.equal(chatMetadata[`storyOracle_${suffix}`], `keep-${suffix}`);
        assert.equal(Object.hasOwn(chatMetadata, `plotAdvance_${suffix}`), false);
    }

    references.get('convo').suffix = 'edited-in-original';   // 原版手里的旧引用继续被改
    assert.equal(chatMetadata.plotAdvance_convo.suffix, 'convo');
});

test('聊天迁移第二次调用无操作，null 元数据直接返回 false', () => {
    const moved = ['original-content'];
    const chatMetadata = { storyOracle_summary: moved };

    assert.equal(migrateChatNamespace(chatMetadata), true);
    assert.deepEqual(chatMetadata.plotAdvance_summary, ['original-content']);
    chatMetadata.storyOracle_summary = ['rebuilt-content'];
    assert.equal(migrateChatNamespace(chatMetadata), false);
    assert.deepEqual(chatMetadata.storyOracle_summary, ['rebuilt-content']);
    assert.deepEqual(chatMetadata.plotAdvance_summary, ['original-content']);
    assert.equal(migrateChatNamespace(null), false);
});
