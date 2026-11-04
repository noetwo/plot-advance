import assert from 'node:assert/strict';
import test from 'node:test';

import { soCallModel } from '../src/bootstrap.js';

const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }];

function settings(mode, stream, sendTemperature) {
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
    };
}

function harness(value) {
    const calls = [];
    const capture = (kind, args) => {
        calls.push({ kind, args });
        return 'AB';
    };
    return {
        calls,
        deps: {
            getSettings: () => value,
            resolveEndpointUrl: () => 'https://mock/v1/chat/completions',
            callDirect: async (...args) => capture('direct', args),
            streamDirect: async (...args) => {
                args.at(-1)('A');
                args.at(-1)('B');
                return capture('directStream', args);
            },
            callProfile: async (...args) => capture('profile', args),
            callProfileStream: async (...args) => {
                args.at(-1)('A');
                args.at(-1)('AB');
                return capture('profileStream', args);
            },
        },
    };
}

test('soCallModel 保留显式 null、无回调仍流式、token 原值及吞回调异常', async () => {
    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const sendTemperature of [false, true])
        for (const choice of [undefined, null, false, true]) for (const callback of ['none', 'collect', 'throw']) {
            const s = settings(mode, stream, sendTemperature);
            const h = harness(s);
            const updates = [];
            const signal = new AbortController().signal;
            const opts = { signal, stream: choice, maxTokens: 512 };
            if (callback !== 'none') opts.onDelta = (text) => {
                updates.push(text);
                if (callback === 'throw') throw new Error('callback');
            };

            assert.equal(await soCallModel(messages, opts, h.deps), 'AB');
            const useStream = choice === undefined ? stream : !!choice;
            assert.equal(h.calls.length, 1);
            assert.equal(h.calls[0].kind, mode + (useStream ? 'Stream' : ''));
            const args = h.calls[0].args;
            if (mode === 'direct') {
                assert.deepEqual(args.slice(0, 2), ['https://mock/v1/chat/completions', 'test-key']);
                assert.deepEqual(args[2], {
                    model: 'gemini-3-test',
                    messages,
                    max_tokens: 512,
                    ...(sendTemperature ? { temperature: 0.4 } : {}),
                });
                assert.equal(args[3], signal);
            } else {
                assert.equal(args[0], 'profile');
                assert.equal(args[1], messages);
                assert.equal(args[2], 512);
                assert.deepEqual(args[3], sendTemperature ? { temperature: 0.4 } : {});
                assert.equal(args[4], signal);
            }
            assert.deepEqual(updates, useStream && callback !== 'none' ? ['A', 'AB'] : []);
        }
});
