import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { serializeDiagSel } from '../src/core/chat-metadata.js';
import { runAutoDiagnose } from '../src/core/post-reply.js';
import { setHostForTests } from '../src/st/host.js';

const FIRST_REWRITE = '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/x","value":1}]</JSONPatch>\n</UpdateVariable>';
const SECOND_REWRITE = '<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>';
const DIAG_MESSAGES = [
    { role: 'system', content: '诊断' },
    { role: 'user', content: 'diag.askDerive' },
];

let calls = [];
let replies = [];
let mvuData = { stat_data: {}, schema: {} };
let zodSchema = null;

const clone = (value) => JSON.parse(JSON.stringify(value));
const mvu = {
    getMvuData: () => mvuData,
    isDuringExtraAnalysis: () => false,
    parseMessage: async (_text, data) => clone(data),
    replaceMvuData: async (data) => { mvuData = data; },
};

const context = {
    chat: [{ mes: '故事', is_user: false, is_system: false }],
    chatId: 'chat',
    groupId: '',
    chatMetadata: {},
    extensionSettings: { storyOracle: {} },
    substituteParams: (text) => text,
    saveChat: async () => {},
    saveMetadataDebounced: () => {},
    ConnectionManagerRequestService: {
        async sendRequest(profileId, messages, maxTokens, options, override) {
            calls.push({
                kind: 'profile',
                profileId,
                body: { messages: clone(messages), max_tokens: maxTokens, ...override },
                signal: options.signal,
                stream: options.stream,
            });
            return { content: replies.shift() ?? '' };
        },
    },
};

setHostForTests({
    SillyTavern: { getContext: () => context },
    globals: { Mvu: mvu },
    getMvuZodSchema: () => zodSchema,
    async importModule(specifier) {
        if (specifier === '/scripts/world-info.js') return { getSortedEntries: async () => [], world_info_depth: 4 };
        throw new Error(`Unexpected host module: ${specifier}`);
    },
    async fetch(url, init) {
        calls.push({
            kind: 'direct',
            url,
            body: JSON.parse(init.body),
            signal: init.signal,
        });
        return new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: replies.shift() ?? '' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
});

after(() => setHostForTests(null));

function sendSettings(mode, stream, sendTemperature, rewrite) {
    return {
        mode,
        stream,
        sendTemperature,
        endpoint: 'https://mock/v1',
        model: 'gemini-3-test',
        apiKey: 'test-key',
        profileId: 'profile',
        maxTokens: 1024,
        temperature: 0.4,
        contextDepth: 0,
        includeCard: false,
        worldInfoMode: 'off',
        diagnoseUsePreset: false,
        diagSchemaRetry: rewrite,
        directViaBackend: false,
        directRawUrl: false,
        extraIncludeBody: '',
        extraExcludeBody: '',
        extraIncludeHeaders: '',
        promptOverrides: {
            'diag.autoDerive': '',
            'diag.rules': '',
            'diag.stat': '',
            'diag.latestDerive': '',
            'diag.askDerive': 'diag.askDerive',
            'diag.schemaRetry': '重试',
        },
        diagnoseSystemPrompt: '诊断',
    };
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
        await run();
        return { active, delays };
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
}

function assertRequest(call, settings, messages) {
    assert.equal(call.kind, settings.mode);
    assert.equal(call.signal instanceof AbortSignal, true);
    assert.equal(call.signal.aborted, false);
    const expected = {
        ...(settings.mode === 'direct' ? { model: settings.model } : {}),
        messages,
        max_tokens: 4096,
        ...(settings.sendTemperature ? { temperature: 0.4 } : {}),
    };
    if (settings.mode === 'direct') {
        assert.equal(call.url, 'https://mock/v1/chat/completions');
        assert.equal(call.body.stream, false);
        const { stream: _stream, ...body } = call.body;
        assert.deepEqual(body, expected);
    } else {
        assert.equal(call.profileId, 'profile');
        assert.equal(call.stream, false);
        assert.deepEqual(call.body, expected);
    }
}

test('发送入口参数矩阵：自动诊断及被 schema 拒绝后的重写', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const temperature of [false, true]) {
        for (const rewrite of [false, true]) {
            const settings = sendSettings(mode, stream, temperature, rewrite);
            context.extensionSettings.storyOracle = settings;
            context.chatMetadata = {};
            calls = [];
            if (rewrite) {
                mvuData = { stat_data: { x: 0 }, schema: '没有用别管这个' };
                zodSchema = {
                    safeParse(value) {
                        return value?.stat_data?.x === 1
                            ? { success: false, error: { issues: [{ code: 'invalid_type', path: ['stat_data', 'x'], expected: 'number' }] } }
                            : { success: true, data: value };
                    },
                };
                replies = [FIRST_REWRITE, SECOND_REWRITE];
            } else {
                mvuData = { stat_data: {}, schema: {} };
                zodSchema = null;
                replies = ['AB'];
            }

            const { active, delays } = await withFakeTimers(() => runAutoDiagnose(context, settings, 0, '::chat'));
            const expectedMessages = rewrite
                ? [DIAG_MESSAGES, [...DIAG_MESSAGES, { role: 'assistant', content: FIRST_REWRITE }, { role: 'user', content: '重试' }]]
                : [DIAG_MESSAGES];
            assert.equal(calls.length, expectedMessages.length);
            calls.forEach((call, index) => assertRequest(call, settings, expectedMessages[index]));
            assert.deepEqual(delays, Array(expectedMessages.length).fill(240000));
            assert.equal(active.size, 0);
        }
    }
});

test('诊断条目序列化固定值：null、空 Set、乱序、字符串 uid 与非有限数', () => {
    const input = { all: null, empty: new Set(), mixed: new Set([8, '3', 1]), invalid: ['9'] };
    assert.deepEqual(serializeDiagSel(null), {});
    assert.deepEqual(serializeDiagSel({ ...input, numbers: new Set(['5', 'bad', 2, Infinity]) }), {
        empty: [], mixed: [1, 3, 8], numbers: [2, 5],
    });
});
