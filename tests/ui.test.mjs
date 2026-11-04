import assert from 'node:assert/strict';
import test from 'node:test';

import { addFixApplyControls } from '../src/ui/messages.js';

test('移除实验卡后仍显示应用和看改动按钮，并保留陈旧/截断保护', async () => {
    const element = () => ({
        children: [], listeners: {}, classList: { add() {}, remove() {} },
        appendChild(el) { this.children.push(el); },
        insertBefore(el, before) { this.children.splice(this.children.indexOf(before), 0, el); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
    });
    const previousDocument = globalThis.document;
    globalThis.document = { createElement: element };
    try {
        for (const state of ['stale', 'truncated', 'ready', 'applied']) {
            const bubble = element();
            const writes = [];
            const dependencies = {
                fixNearCopyNote: () => '',
                fixTargetStale: () => ({ stale: state === 'stale', reason: 'changed' }),
                fixCurrentSnapshot: () => ({}), staleMsg: () => '目标已变',
                fixOutputTruncated: () => ({ truncated: state === 'truncated' }),
                applyFixAsSwipe: async (...args) => { writes.push(args); return true; },
            };
            addFixApplyControls({ querySelector: () => bubble }, { fixed: '新稿' }, '原稿', 4, [], {}, {}, undefined, { applied: state === 'applied' }, dependencies);
            const bar = bubble.children[0];
            assert.equal(bar.children.length, 3);
            const [apply, diff, status] = bar.children;
            assert.match(diff.innerHTML, /看改动/);
            assert.equal(typeof diff.listeners.click, 'function');
            await apply.listeners.click();
            assert.equal(writes.length, state === 'ready' ? 1 : 0);
            if (state === 'ready') assert.deepEqual(writes[0], [4, '新稿']);
            if (state === 'stale') assert.equal(status.textContent, '目标已变');
            if (state === 'truncated') assert.match(status.textContent, /截断/);
            if (state === 'applied') assert.equal(apply.disabled, true);
        }
    } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    }
});
