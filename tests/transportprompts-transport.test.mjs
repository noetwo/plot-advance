import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { setHostForTests } from '../src/st/host.js';
import {
    callDirect,
    classifySseData,
    getLastFinishReason,
    resetLastFinishReason,
    streamDirect,
} from '../src/transport/direct.js';

const stRoot = process.env.SILLYTAVERN_ROOT || 'F:/SillyTavern/Luker';
const sseSource = fs.readFileSync(path.join(stRoot, 'public/scripts/sse-stream.js'), 'utf8');
const parserSource = sseSource.match(/class EventSourceStream\s*\{[\s\S]*?\r?\n\}/)?.[0];
assert.ok(parserSource, '酒馆源码应包含 EventSourceStream');
const EventSourceStream = vm.runInNewContext(parserSource + '\nEventSourceStream', {
    TextDecoderStream,
    TransformStream,
    MessageEvent,
});

const EMPTY_SETTINGS = Object.freeze({});

function installHost(response, context = {}) {
    setHostForTests({
        SillyTavern: { getContext: () => context },
        fetch: async () => response,
        importModule: async (specifier) => {
            assert.equal(specifier, '/scripts/sse-stream.js');
            return { default: EventSourceStream };
        },
        globals: {
            SillyTavern: { libs: {} },
            YuzukiMemory: null,
        },
    });
}

test.afterEach(() => {
    setHostForTests(null);
    resetLastFinishReason();
});

function chunked(text, size = 1) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) return controller.close();
            controller.enqueue(bytes.slice(offset, offset + size));
            offset += size;
        },
    }));
}

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;
const content = (text) => event({ choices: [{ delta: { content: text } }] });
const done = 'data: [DONE]\n\n';

async function readResponse(response, signal, settings = EMPTY_SETTINGS) {
    installHost(response);
    const deltas = [];
    const text = await streamDirect('mock', '', {}, signal, (delta) => deltas.push(delta), settings);
    return { text, deltas };
}

test('classifySseData 分类完成、坏数据、推理、错误和 finish_reason', () => {
    assert.deepEqual(classifySseData('[DONE]'), { done: true });
    assert.deepEqual(classifySseData('bad-json'), { skip: true });
    assert.deepEqual(classifySseData(JSON.stringify({ choices: [{ delta: { content: '答', reasoning_content: '想' }, finish_reason: 'length' }] })), {
        content: '答', reasoning: '想', error: '', finishReason: 'length',
    });
    assert.deepEqual(classifySseData(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'error' }], error: { message: 'provider failed' } })), {
        content: '', reasoning: '', error: 'provider failed', finishReason: 'error',
    });
});

test('多行 data、中文跨字节、三种换行及 finish_reason', async () => {
    const wire = ': keepalive\n\ndata: {"choices":[\ndata: {"delta":{"content":"你好🌙"}}]}\n\n'
        + 'data: invalid-json\n\n' + content('！')
        + event({ choices: [{ delta: {}, finish_reason: 'length' }] }) + done;
    for (const newline of ['\n', '\r\n', '\r']) {
        resetLastFinishReason();
        assert.deepEqual(await readResponse(chunked(wire.replaceAll('\n', newline))), { text: '你好🌙！', deltas: ['你好🌙', '！'] });
        assert.equal(getLastFinishReason(), 'length');
    }
});

test('单块多个事件、无 DONE 的正常结束，以及普通 JSON 回退', async () => {
    assert.deepEqual(await readResponse(chunked(content('A') + content('B') + done, 65536)), { text: 'AB', deltas: ['A', 'B'] });
    assert.deepEqual(await readResponse(chunked(content('结束'))), { text: '结束', deltas: ['结束'] });
    const json = JSON.stringify({ choices: [{ message: { content: '普通回复🌙' } }] });
    assert.deepEqual(await readResponse(chunked(json)), { text: '普通回复🌙', deltas: ['普通回复🌙'] });
    assert.deepEqual(await readResponse(chunked('')), { text: '', deltas: [] });
});

test('最后一个事件后面不带空行、事件之间只用单个换行（不规范中转）', async () => {
    const raw = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] });
    assert.deepEqual(await readResponse(chunked(content('A') + raw('尾'))), { text: 'A尾', deltas: ['A', '尾'] });
    assert.deepEqual(await readResponse(chunked(content('A') + raw('尾') + '\n')), { text: 'A尾', deltas: ['A', '尾'] });
    for (const newline of ['\n', '\r\n']) {
        const wire = [raw('甲'), raw('乙'), 'data: [DONE]', ''].join(newline);
        assert.deepEqual(await readResponse(chunked(wire)), { text: '甲乙', deltas: ['甲', '乙'] });
    }
});

test('HTTP 错误与流中途错误仍然上报，已收到的内容照常回调', async () => {
    await assert.rejects(readResponse(new Response('bad gateway', { status: 502 })), /HTTP 502.*bad gateway/);
    const deltas = [];
    const wire = content('半条回复') + event({ error: { message: 'provider failed' } }) + done;
    installHost(chunked(wire));
    await assert.rejects(streamDirect('mock', '', {}, undefined, (delta) => deltas.push(delta), EMPTY_SETTINGS), /回复可能不完整.*provider failed/);
    assert.deepEqual(deltas, ['半条回复']);
});

test('DONE 后取消仍打开的响应，忽略后续内容', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(content('完成') + done + content('不应出现'))); },
        cancel() { cancelled = true; },
    }));
    assert.deepEqual(await readResponse(response), { text: '完成', deltas: ['完成'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
});

test('取消等待中的流式请求会结束读取并释放响应', async () => {
    const ctl = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const pending = readResponse(response, ctl.signal);
    setImmediate(() => ctl.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
});

test('后端转发仍直接使用原传输，不解析浏览器响应', async () => {
    const context = {
        ChatCompletionService: {
            async processRequest() {
                return (async function* () { yield { text: '后端' }; }());
            },
        },
    };
    setHostForTests({
        SillyTavern: { getContext: () => context },
        fetch: () => { throw new Error('不应 fetch'); },
        globals: { SillyTavern: { libs: {} }, YuzukiMemory: null },
    });
    const deltas = [];
    const text = await streamDirect('mock', '', {}, undefined, (delta) => deltas.push(delta), { directViaBackend: true });
    assert.deepEqual({ text, deltas }, { text: '后端', deltas: ['后端'] });
});

test('非流式回复外面多包一层 data 时也能取到正文（cline 中转实测）', async () => {
    const wrapped = { data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '<NodeDetail>\n写好了\n</NodeDetail>' } }] } };
    installHost(new Response(JSON.stringify(wrapped), { headers: { 'content-type': 'application/json' } }));
    assert.equal(await callDirect('mock', '', {}, undefined, EMPTY_SETTINGS), '<NodeDetail>\n写好了\n</NodeDetail>');
    assert.equal(getLastFinishReason(), 'stop');

    assert.equal((await readResponse(new Response(JSON.stringify(wrapped)))).text, '<NodeDetail>\n写好了\n</NodeDetail>');

    installHost(new Response(JSON.stringify(wrapped.data)));
    assert.equal(await callDirect('mock', '', {}, undefined, EMPTY_SETTINGS), '<NodeDetail>\n写好了\n</NodeDetail>');
});
