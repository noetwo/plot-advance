import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchBuilderRequest } from '../src/modes/builder/request.js';
import { filterBookEntries, serializeEntrySel } from '../src/modes/lorebook/selection.js';

const sendSettings = (mode, stream, sendTemperature) => ({
    mode, stream, sendTemperature, endpoint: 'https://mock/v1', model: 'gemini-3-test',
    apiKey: 'test-key', profileId: 'profile', maxTokens: 1024, bldMaxTokens: 20000, temperature: 0.4,
});

function requestHarness() {
    const calls = [];
    const capture = (kind, args) => {
        const direct = kind.startsWith('direct');
        const call = {
            kind,
            args,
            body: direct ? args[2] : { messages: args[1], max_tokens: args[2], ...args[3] },
            signal: args[direct ? 3 : 4],
        };
        calls.push(call);
        return call;
    };
    const transport = {
        resolveEndpointUrl: () => 'https://mock/v1/chat/completions',
        callDirect: async (...args) => { capture('direct', args); return 'AB'; },
        callProfile: async (...args) => { capture('profile', args); return 'AB'; },
        streamDirect: async (...args) => {
            capture('directStream', args);
            args.at(-1)('A');
            args.at(-1)('B');
            return 'AB';
        },
        callProfileStream: async (...args) => {
            capture('profileStream', args);
            args.at(-1)('A');
            args.at(-1)('AB');
            return 'AB';
        },
    };
    return { calls, transport };
}

function assertCaptured(calls, settings, expectedMessages, stream, signal) {
    assert.equal(calls.length, expectedMessages.length);
    calls.forEach((call, index) => {
        assert.equal(call.kind, settings.mode + (stream ? 'Stream' : ''));
        assert.deepEqual(structuredClone(call.body), {
            ...(settings.mode === 'direct' ? { model: settings.model } : {}),
            messages: expectedMessages[index],
            max_tokens: 20000,
            ...(settings.sendTemperature ? { temperature: 0.4 } : {}),
        });
        assert.equal(call.signal, signal);
        assert.equal(call.signal.aborted, false);
        if (settings.mode === 'direct') {
            assert.deepEqual(call.args.slice(0, 2), ['https://mock/v1/chat/completions', 'test-key']);
        } else {
            assert.equal(call.args[0], 'profile');
        }
    });
}

test('runForge / runCondenseDepth 请求参数矩阵保持直连、配置文件、温度、流式与取消信号', async () => {
    const forgeMessages = [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }];
    const depthMessages = ['甲', '乙', '丙'].map((text) => [
        { role: 'system', content: 'bld.condenseSect' },
        { role: 'user', content: 'bld.condenseSectAsk:' + JSON.stringify({ full: '原稿', names: text, text }) },
    ]);
    depthMessages.push([
        { role: 'system', content: 'bld.condenseOps' },
        { role: 'user', content: 'bld.condenseOpsAsk:{"draft":"合稿"}' },
    ]);

    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const sendTemperature of [false, true]) {
        const settings = sendSettings(mode, stream, sendTemperature);

        const forge = requestHarness();
        const forgeSignal = new AbortController().signal;
        const forgeUpdates = [];
        await dispatchBuilderRequest(settings, forgeMessages, 20000, forgeSignal, (text, cumulative) => {
            forgeUpdates.push([text, cumulative]);
        }, { transport: forge.transport });
        assertCaptured(forge.calls, settings, [forgeMessages], stream, forgeSignal);
        assert.deepEqual(forgeUpdates, stream
            ? (mode === 'direct' ? [['A', false], ['B', false]] : [['A', true], ['AB', true]])
            : []);

        const depth = requestHarness();
        const depthSignal = new AbortController().signal;
        for (const messages of depthMessages) {
            await dispatchBuilderRequest(settings, messages, 20000, depthSignal, null, {
                stream: true,
                transport: depth.transport,
            });
        }
        assertCaptured(depth.calls, settings, depthMessages, true, depthSignal);
        assert.equal(new Set(depth.calls.map((call) => call.signal)).size, 1);
    }
});

test('世界书条目序列化固定值：null、空 Set、乱序与字符串 uid', () => {
    const input = { all: null, empty: new Set(), mixed: new Set([8, '3', 1]), invalid: ['9'] };
    assert.deepEqual(serializeEntrySel(null), {});
    assert.deepEqual(serializeEntrySel(input), { empty: [], mixed: [1, '3', 8] });
});

test('四个条目列表共用筛选，保持分组显隐且不改选择状态', () => {
    const selectors = ['#pad-bld-entry-list', '#pad-lb-entries-list', '#pad-diag-entries-list', '#pad-wic-entries-list'];
    const lists = Object.fromEntries(selectors.map((selector) => {
        const rows = [
            { dataset: { book: 'A', hay: 'alice 12' }, style: {}, checked: true },
            { dataset: { book: 'B', hay: 'bob 24' }, style: {}, checked: false },
        ];
        const heads = ['A', 'B', 'Empty'].map((book) => ({ dataset: { book, hay: book.toLowerCase() }, style: {} }));
        return [selector, { rows, heads, querySelectorAll: (query) => query === '.pad-lb-ent' ? rows : heads }];
    }));
    const root = { querySelector: (selector) => lists[selector] };

    for (const selector of selectors) {
        const { rows, heads } = lists[selector];
        let refreshed = 0;
        const filter = (query) => filterBookEntries(selector, query, () => refreshed++, root);
        filter(' ALICE ');
        assert.deepEqual(rows.map((row) => row.style.display), ['', 'none']);
        assert.deepEqual(heads.map((head) => head.style.display), ['', 'none', 'none']);
        filter('empty');
        assert.deepEqual(rows.map((row) => row.style.display), ['none', 'none']);
        assert.deepEqual(heads.map((head) => head.style.display), ['none', 'none', '']);
        filter('不存在');
        assert.ok([...rows, ...heads].every((element) => element.style.display === 'none'));
        filter('');
        assert.ok([...rows, ...heads].every((element) => element.style.display === ''));
        assert.deepEqual(rows.map((row) => row.checked), [true, false]);
        assert.equal(refreshed, 4);
    }
    filterBookEntries('#missing', 'x', () => assert.fail('列表不存在时不刷新按钮'), root);
});
