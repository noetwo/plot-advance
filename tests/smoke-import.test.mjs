import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('./module-bindings.json', import.meta.url), 'utf8'));

function jsFiles(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(prefix, entry.name);
        return entry.isDirectory() ? jsFiles(path.join(dir, entry.name), relative)
            : entry.name.endsWith('.js') ? [relative] : [];
    });
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

test('每个模块的自由变量仅为许可的浏览器／酒馆全局', () => {
    const current = ['index.js', ...jsFiles(path.join(root, 'src'), 'src').sort()];
    assert.deepEqual(Object.keys(manifest.modules).sort(), current.sort(), '静态绑定清单应覆盖全部模块');
    assert.equal(manifest.assignedExactlyOnce, true);
    const allowed = new Set(manifest.allowedGlobals);
    for (const [file, item] of Object.entries(manifest.modules)) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        assert.equal(sha256(text), item.sha256, `${file} 已变化，需重新运行作用域分析`);
        assert.deepEqual(item.free.filter((name) => !allowed.has(name)), [], `${file} 有未绑定的非全局名字`);
    }
});

test('Node 最小浏览器桩可加载扩展入口，且 ready 回调不会提前执行', async () => {
    const readyCallbacks = [];
    globalThis.window = globalThis;
    globalThis.document = {};
    globalThis.location = { href: 'http://127.0.0.1:8000/' };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.jQuery = (callback) => { readyCallbacks.push(callback); };
    globalThis.$ = globalThis.jQuery;
    globalThis.SillyTavern = { getContext: () => ({}) };
    globalThis.toastr = { error() {}, info() {}, warning() {}, success() {} };

    await import(pathToFileURL(path.join(root, 'index.js')).href);
    assert.equal(readyCallbacks.length, 1, '入口应只注册一个 jQuery ready 回调');
});
