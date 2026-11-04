import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function jsFiles(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(prefix, entry.name);
        return entry.isDirectory() ? jsFiles(path.join(dir, entry.name), relative)
            : entry.name.endsWith('.js') ? [relative] : [];
    });
}

test('每个 src 模块无需浏览器／酒馆全局即可单独导入', async (t) => {
    const modules = jsFiles(path.join(root, 'src'), 'src').sort();
    for (const relative of modules) {
        await t.test(relative, () => {
            const url = pathToFileURL(path.join(root, relative));
            const result = spawnSync(
                process.execPath,
                ['--input-type=module', '--eval', `await import(${JSON.stringify(url.href)})`],
                { cwd: root, encoding: 'utf8' },
            );
            assert.equal(result.status, 0, result.stderr || result.stdout);
        });
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
