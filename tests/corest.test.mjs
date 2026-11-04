import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONN_PRESET_KEYS,
    connPresetIsCurrent,
    connPresetSnapshot,
    connPresetUpsert,
} from '../src/core/settings.js';
import {
    abortCtl,
    beginGeneration,
    clearLiveCondense,
    clearLiveForge,
    clearLiveGenerations,
    finishGeneration,
    isGenerating,
    liveCondense,
    liveForge,
    observeGenerationState,
    registerLiveCondense,
    registerLiveForge,
    stopGeneration,
} from '../src/core/generation.js';
import {
    beginPostReplyCall,
    beginPostReplyRun,
    cancelPostReply,
    finishPostReplyRun,
    isPostReplyBusy,
    postReplyShouldStop,
} from '../src/core/post-reply.js';
import {
    getHostContext,
    getHostGlobal,
    getHostStorage,
    getMvuZodSchema,
    hostFetch,
    importHostModule,
    setHostForTests,
    setHostGlobal,
} from '../src/st/host.js';

test('连接存档带上高级选项与生成参数；旧存档只比对已有的项', () => {
    assert.deepEqual(CONN_PRESET_KEYS, [
        'directViaBackend', 'extraIncludeBody', 'extraExcludeBody', 'extraIncludeHeaders',
        'temperature', 'maxTokens', 'stream', 'sendTemperature',
    ]);
    const s = {
        mode: 'direct', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', directRawUrl: false,
        directViaBackend: true, extraIncludeBody: 'a: 1', extraExcludeBody: '', extraIncludeHeaders: '',
        temperature: 1, maxTokens: 12288, stream: true, sendTemperature: false,
    };
    const list = connPresetUpsert([], { ...connPresetSnapshot(s), name: 'A' });
    assert.deepEqual(list[0], {
        name: 'A', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', rawUrl: false,
        directViaBackend: true, extraIncludeBody: 'a: 1', extraExcludeBody: '', extraIncludeHeaders: '',
        temperature: 1, maxTokens: 12288, stream: true, sendTemperature: false,
    });
    assert.equal(connPresetIsCurrent(list[0], s), true);
    for (const [key, value] of [['temperature', 0.7], ['stream', false], ['directViaBackend', false], ['extraIncludeBody', '']]) {
        assert.equal(connPresetIsCurrent(list[0], { ...s, [key]: value }), false, key);
    }
    assert.equal(connPresetIsCurrent({ ...list[0], temperature: null }, { ...s, temperature: Number.NaN }), true);
    const old = { name: 'B', endpoint: 'https://a/v1', apiKey: 'k', model: 'm', rawUrl: false };
    assert.equal(connPresetIsCurrent(old, { ...s, temperature: 0.2, stream: false }), true);
    assert.equal('temperature' in connPresetUpsert([], old)[0], false);
});

test('宿主接缝可由测试替换上下文、模块、fetch、storage 和外部全局', async () => {
    const storage = { getItem: (key) => `stored:${key}` };
    const fake = {
        SillyTavern: { getContext: () => ({ chatId: 'fake-chat' }) },
        importModule: async (specifier) => ({ specifier }),
        fetch: async (input, init) => ({ input, init }),
        storage,
        globals: { Mvu: { id: 'fake-mvu' } },
        getMvuZodSchema: () => ({ id: 'fake-schema' }),
    };
    setHostForTests(fake);
    try {
        assert.deepEqual(getHostContext(), { chatId: 'fake-chat' });
        assert.deepEqual(await importHostModule('/scripts/fake.js'), { specifier: '/scripts/fake.js' });
        assert.deepEqual(await hostFetch('/fake', { method: 'POST' }), { input: '/fake', init: { method: 'POST' } });
        assert.equal(getHostStorage(), storage);
        assert.deepEqual(getHostGlobal('Mvu'), { id: 'fake-mvu' });
        assert.deepEqual(getMvuZodSchema(), { id: 'fake-schema' });
        setHostGlobal('ExtraBridge', 7);
        assert.equal(getHostGlobal('ExtraBridge'), 7);
    } finally {
        setHostForTests(null);
    }
});
test('生成控制器统一开始、停止、收尾和后台保活槽', () => {
    const observed = [];
    observeGenerationState((active) => observed.push(active));
    const ctl = beginGeneration();
    try {
        assert.equal(isGenerating, true);
        assert.equal(abortCtl, ctl);
        assert.equal(ctl.signal.aborted, false);

        const forge = { id: 'forge' };
        const otherForge = { id: 'other' };
        const condense = { id: 'condense' };
        registerLiveForge(forge);
        registerLiveCondense(condense);
        assert.equal(liveForge, forge);
        assert.equal(liveCondense, condense);
        clearLiveForge(otherForge);
        assert.equal(liveForge, forge, '只清自己的收尾不得误清后来登记的运行');
        clearLiveForge(forge);
        assert.equal(liveForge, null);
        clearLiveCondense(condense);
        assert.equal(liveCondense, null);

        registerLiveForge(forge);
        registerLiveCondense(condense);
        clearLiveGenerations();
        assert.equal(liveForge, null);
        assert.equal(liveCondense, null);

        stopGeneration();
        assert.equal(ctl.signal.aborted, true);
    } finally {
        finishGeneration();
        observeGenerationState(null);
    }
    assert.equal(isGenerating, false);
    assert.equal(abortCtl, null);
    assert.deepEqual(observed, [false, true, false]);
});

test('回复后调用可由用户中断，并在轮次结束后释放取消状态', () => {
    const run = { messageId: 7, superseded: false, step: 'diag' };
    beginPostReplyRun(run);
    const call = beginPostReplyCall(60_000);
    try {
        assert.equal(isPostReplyBusy(), true);
        assert.equal(postReplyShouldStop(), false);
        assert.equal(call.signal.aborted, false);
        cancelPostReply();
        assert.equal(call.signal.aborted, true);
        assert.equal(postReplyShouldStop(), true);
    } finally {
        call.end();
        finishPostReplyRun(run);
    }
    assert.equal(isPostReplyBusy(), false);
    assert.equal(postReplyShouldStop(), false);
});

test('回复后调用超时会中止自己的 signal', async () => {
    const call = beginPostReplyCall(1);
    try {
        await new Promise((resolve) => call.signal.addEventListener('abort', resolve, { once: true }));
        assert.equal(call.signal.aborted, true);
    } finally {
        call.end();
    }
});
