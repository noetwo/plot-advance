import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { beginPostReplyRun, cancelPostReply, finishPostReplyRun, postReplyShouldStop } from '../src/core/post-reply.js';
import { abortCtl, isGenerating, stopGeneration } from '../src/core/generation.js';
import { runFixByTargets, fixCallTransport } from '../src/modes/fix/selection.js';
import { captureFixContext } from '../src/modes/fix/capture.js';
import { runAutoFix } from '../src/modes/fix/staging.js';
import { fixEffMaxTokens } from '../src/prompts/helpers.js';
import { setHostForTests } from '../src/st/host.js';
import { callDirect, getLastFinishReason } from '../src/transport/direct.js';

const hostContext = {
    chat: [{ mes: '原文。', is_user: false, is_system: false, swipe_id: 0, swipe_info: [{}] }],
    chatId: 'chat',
    groupId: '',
    chatMetadata: {},
    extensionSettings: { plotAdvance: {} },
    name1: '用户',
    name2: '角色',
    substituteParams: (text) => text,
    saveChat: async () => {},
    saveMetadataDebounced: () => {},
};

setHostForTests({
    SillyTavern: { getContext: () => hostContext },
    globals: {},
    fetch: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'previous', message: { content: 'seed' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
});
after(() => setHostForTests(null));

const FIX_MESSAGES = [{ role: 'system', content: '校正' }, { role: 'user', content: '目标' }];
const sendSettings = (mode, stream, sendTemperature) => ({
    mode, stream, sendTemperature, endpoint: 'https://mock/v1', model: 'gemini-3-test',
    apiKey: 'test-key', profileId: 'profile', maxTokens: 1024, fixMaxTokens: 8192, temperature: 0.4,
    directRawUrl: false,
});

function frozenFixContext() {
    return Object.freeze({
        targetIdx: 0,
        originalReply: '原文。',
        targetProse: '原文。',
        cardBlock: '',
        contextBlock: '',
        worldBlock: '',
        summaryBlock: '',
        extraKeep: [],
        thinkProtected: 0,
        scope: { active: false },
        scopeDecision: null,
        pieceDecision: null,
        pieceTable: null,
        customJoin: null,
        captured: Object.freeze({ chatId: '::chat', targetIdx: 0, swipeId: 0, fingerprint: 'seed', prose: '原文。', bodyProse: '原文。' }),
        activeMode: 'auto',
        customTemplateText: '',
        autoPromptVersion: 'light',
        autoPromptFlavor: 'deepseek',
        wiBefore: '',
        wiAfter: '',
        manualScopeMissed: '',
    });
}

function assistantElement() {
    const content = {
        textContent: '',
        innerHTML: '',
        style: {},
        classList: { add() {}, remove() {} },
    };
    return { content, element: { querySelector: (selector) => selector === '.pad-content' ? content : null } };
}

function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

function transportHarness({ hold = false, failure } = {}) {
    const calls = [];
    function capture(kind, args, stream) {
        const direct = kind.startsWith('direct');
        const signal = args[direct ? 3 : 4];
        const body = direct ? args[2] : { messages: args[1], max_tokens: args[2], ...args[3] };
        const call = { kind, args, body, signal, stream, updates: [] };
        calls.push(call);
        if (failure) return Promise.reject(failure);
        if (hold) {
            return new Promise((resolve, reject) => {
                if (signal.aborted) { reject(abortError()); return; }
                signal.addEventListener('abort', () => reject(abortError()), { once: true });
            });
        }
        return null;
    }
    const transport = {
        resolveEndpointUrl: () => 'https://mock/v1/chat/completions',
        async callDirect(...args) {
            const pending = capture('direct', args, false);
            return pending || 'AB';
        },
        async streamDirect(...args) {
            const pending = capture('directStream', args, true);
            if (pending) return pending;
            const call = calls.at(-1);
            for (const delta of ['A', 'B']) { args.at(-1)(delta); call.updates.push(delta); }
            return 'AB';
        },
        async callProfile(...args) {
            const pending = capture('profile', args, false);
            return pending || 'AB';
        },
        async callProfileStream(...args) {
            const pending = capture('profileStream', args, true);
            if (pending) return pending;
            const call = calls.at(-1);
            for (const full of ['A', 'AB']) { args.at(-1)(full); call.updates.push(full); }
            return 'AB';
        },
    };
    return { calls, transport };
}

async function withFakeTimers(run) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const active = new Map();
    const delays = [];
    let sequence = 0;
    globalThis.setTimeout = (fn, delay) => {
        const id = ++sequence;
        delays.push(delay);
        active.set(id, fn);
        return id;
    };
    globalThis.clearTimeout = (id) => { active.delete(id); };
    try {
        return await run({ active, delays });
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
}

function assertRequest(call, settings, stream) {
    assert.equal(call.kind, settings.mode + (stream ? 'Stream' : ''));
    assert.equal(call.stream, stream);
    assert.equal(call.signal instanceof AbortSignal, true);
    assert.equal(call.signal.aborted, false);
    assert.deepEqual(call.body, {
        ...(settings.mode === 'direct' ? { model: settings.model } : {}),
        messages: FIX_MESSAGES,
        max_tokens: 8192,
        ...(settings.sendTemperature ? { temperature: 0.4 } : {}),
    });
    if (settings.mode === 'direct') assert.deepEqual(call.args.slice(0, 2), ['https://mock/v1/chat/completions', 'test-key']);
    else assert.equal(call.args[0], 'profile');
}

test('captureFixContext 返回冻结的单轮上下文并覆盖旧捕获槽字段', async () => {
    const settings = {
        fixA_pieceMode: 'bare',
        fixA_pieceAsked: true,
        fixA_pieceJoin: true,
        fixA_scopeTag: '',
        fixA_scopeManual: false,
        fixA_keepTags: '',
        fixA_dropTags: '',
        fixA_includeCard: false,
        fixA_includeContext: false,
        fixA_includeWorld: false,
        fixA_includeSummary: false,
        fixA_contextDepth: 0,
        fixA_protectThink: true,
        fixA_promptVersion: 'light',
        fixA_promptFlavor: 'deepseek',
        fixA_task: 'fix',
    };
    hostContext.extensionSettings.plotAdvance = settings;
    hostContext.chatMetadata = {};
    const context = await captureFixContext(settings, { mode: 'auto', targetId: 0 });
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.captured), true);
    assert.equal(context.targetIdx, 0);
    assert.equal(context.originalReply, '原文。');
    assert.equal(context.targetProse, '原文。');
    assert.deepEqual(context.extraKeep, []);
    assert.equal(context.activeMode, 'auto');
    assert.equal(context.customTemplateText, '');
    assert.equal(context.wiBefore, '');
    assert.equal(context.wiAfter, '');
    assert.deepEqual(Object.keys(context).sort(), [
        'activeMode', 'autoPromptFlavor', 'autoPromptVersion', 'captured', 'cardBlock', 'contextBlock',
        'customJoin', 'customTemplateText', 'extraKeep', 'manualScopeMissed', 'originalReply', 'pieceDecision',
        'pieceTable', 'scope', 'scopeDecision', 'summaryBlock', 'targetIdx', 'targetProse', 'thinkProtected',
        'wiAfter', 'wiBefore', 'worldBlock',
    ]);
});
test('发送入口参数矩阵：runFixByTargets / runAutoFix', async () => {
    await callDirect('https://seed/v1/chat/completions', '', { model: 'seed', messages: [], max_tokens: 1 }, new AbortController().signal, {
        directViaBackend: false, extraIncludeBody: '', extraExcludeBody: '', extraIncludeHeaders: '',
    });
    assert.equal(getLastFinishReason(), 'previous');

    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const temperature of [false, true]) {

        const settings = sendSettings(mode, stream, temperature);
        hostContext.extensionSettings.plotAdvance = settings;
        hostContext.chatMetadata = {};

        const manual = transportHarness();
        const { content, element } = assistantElement();
        const manualTimers = await withFakeTimers(async ({ active, delays }) => {
            await runFixByTargets({
                settings,
                ctx: hostContext,
                messages: FIX_MESSAGES,
                directive: '目标',
                fixContext: frozenFixContext(),
                assistantEl: element,
                showTyping: () => () => {},
                transport: manual.transport,
                renderFixCard: (_assistant, target, _entry, finalText) => { target.textContent = finalText; return 'ok'; },
            });
            return { active, delays };
        });
        assert.equal(manual.calls.length, 1);
        assertRequest(manual.calls[0], settings, stream);
        if (stream) assert.deepEqual(content.textContent, 'AB');
        assert.equal(content.textContent, 'AB');
        assert.deepEqual(manualTimers.delays, [240000]);
        assert.equal(manualTimers.active.size, 0);
        assert.equal(abortCtl, null);
        assert.equal(isGenerating, false);

        const automatic = transportHarness();
        const autoTimers = await withFakeTimers(async ({ active, delays }) => {
            await runAutoFix(hostContext, settings, 0, '::chat', {
                messages: FIX_MESSAGES,
                directive: '目标',
                fixContext: frozenFixContext(),
                transport: automatic.transport,
            });
            return { active, delays };
        });
        assert.equal(automatic.calls.length, 1);
        assertRequest(automatic.calls[0], settings, false);
        assert.deepEqual(autoTimers.delays, [240000]);
        assert.equal(autoTimers.active.size, 0);
        assert.equal(getLastFinishReason(), 'previous');
    }
});

test('校正传输保留回调异常的拒绝语义', async () => {
    for (const mode of ['direct', 'profile']) {
        const settings = sendSettings(mode, true, false);
        const h = transportHarness();
        const updates = [];
        await assert.rejects(fixCallTransport(settings, FIX_MESSAGES, new AbortController().signal, (text) => {
            updates.push(text);
            throw new Error('callback');
        }, 8192, h.transport), /callback/);
        assert.deepEqual(updates, ['A']);
        assert.equal(h.calls.length, 1);
    }
});

test('校正请求分派保留参数、取消信号和累计回调；无回调时强制非流式', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true])
        for (const live of [false, true]) for (const sendTemperature of [false, true]) {
            const settings = sendSettings(mode, stream, sendTemperature);
            const h = transportHarness();
            const signal = new AbortController().signal;
            const updates = [];
            assert.equal(await fixCallTransport(settings, FIX_MESSAGES, signal, live ? (text) => updates.push(text) : undefined, 8192, h.transport), 'AB');
            assert.equal(h.calls.length, 1);
            const call = h.calls[0];
            assert.equal(call.kind, mode + (stream && live ? 'Stream' : ''));
            assert.deepEqual(updates, stream && live ? ['A', 'AB'] : []);
            if (mode === 'direct') {
                assert.equal(call.args[0], 'https://mock/v1/chat/completions');
                assert.equal(call.args[1], 'test-key');
                assert.equal(call.args[2].messages, FIX_MESSAGES);
                assert.deepEqual(call.args[2], {
                    model: 'gemini-3-test', messages: FIX_MESSAGES, max_tokens: 8192, ...(sendTemperature ? { temperature: 0.4 } : {}),
                });
                assert.equal(call.args[3], signal);
            } else {
                assert.equal(call.args[0], 'profile');
                assert.equal(call.args[1], FIX_MESSAGES);
                assert.equal(call.args[2], 8192);
                assert.deepEqual(call.args[3], sendTemperature ? { temperature: 0.4 } : {});
                assert.equal(call.args[4], signal);
            }
        }
});

test('校正入口假计时器：240 秒超时、停止键、后台中断和异常均释放控制器', async () => {
    for (const mode of ['direct', 'profile']) for (const entry of ['runFixByTargets', 'runAutoFix'])
        for (const action of ['timeout', 'cancel', 'failure']) {
            const settings = sendSettings(mode, true, true);
            const h = transportHarness({ hold: action !== 'failure', failure: action === 'failure' ? new Error('transport failed') : undefined });
            const { content, element } = assistantElement();
            await withFakeTimers(async ({ active, delays }) => {
                const options = {
                    messages: FIX_MESSAGES,
                    directive: '目标',
                    fixContext: frozenFixContext(),
                    transport: h.transport,
                };
                const pending = entry === 'runAutoFix'
                    ? runAutoFix(hostContext, settings, 0, '::chat', options)
                    : runFixByTargets({ ...options, settings, ctx: hostContext, assistantEl: element, showTyping: () => () => {}, renderFixCard: () => 'ok' });
                for (let i = 0; i < 40 && !h.calls.length; i += 1) await Promise.resolve();
                assert.equal(h.calls.length, 1);
                const signal = h.calls[0].signal;
                assert.deepEqual(delays, [240000]);
                if (action === 'timeout') [...active.values()][0]();
                if (action === 'cancel') {
                    if (entry === 'runAutoFix') cancelPostReply();
                    else stopGeneration();
                }
                if (entry === 'runAutoFix') await assert.rejects(pending, action === 'failure' ? /transport failed/ : { name: 'AbortError' });
                else {
                    await pending;
                    assert.equal(content.textContent, action === 'failure' ? '校正失败：transport failed' : '(已停止)');
                }
                assert.equal(signal.aborted, action !== 'failure');
                assert.equal(active.size, 0);
                assert.equal(abortCtl, null);
                assert.equal(isGenerating, false);
                if (entry === 'runAutoFix' && action === 'cancel') assert.equal(postReplyShouldStop(), true);
            });
            if (entry === 'runAutoFix' && action === 'cancel') {
                const resetRun = {};
                beginPostReplyRun(resetRun);
                finishPostReplyRun(resetRun);
            }
        }
});

test('fixEffMaxTokens：专属配置、通用配置与 4096 地板取最大值', () => {
    assert.equal(fixEffMaxTokens({ maxTokens: 1024, fixMaxTokens: '' }), 4096);
    assert.equal(fixEffMaxTokens({ maxTokens: 6144, fixMaxTokens: 4096 }), 6144);
    assert.equal(fixEffMaxTokens({ maxTokens: 1024, fixMaxTokens: 8192 }), 8192);
    assert.equal(fixEffMaxTokens({ maxTokens: 'bad', fixMaxTokens: '12288' }), 12288);
});
