import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceConvo } from '../src/core/conversation-store.js';
import { activateOracleMode } from '../src/core/oracle-modes.js';
import { parseStoryPlanBlock, parseStoryPlans } from '../src/modes/advisor/cards.js';
import { buildPath, pathAdvance, pathHasUnplayed, pathSkipNode, pathSpliceTail } from '../src/modes/advisor/story-path.js';
import { generateReply } from '../src/modes/chat/send.js';
import { pathInjectionText } from '../src/modes/fix/templates.js';
import { ADVISOR_SPEEDS } from '../src/prompts/builtins.js';
import { setHostForTests } from '../src/st/host.js';

const hostContext = {
    chat: [],
    chatMetadata: {},
    extensionSettings: {},
    name1: '用户',
    name2: '角色',
    substituteParams: (text) => text,
    saveMetadataDebounced() {},
};
setHostForTests({
    SillyTavern: { getContext: () => hostContext },
    globals: {},
});
test.after(() => setHostForTests(null));

const PATH_BLOCK = `讨论到这里，排一下：
<StoryPlan>
标题：出城
整体目标：苏哲和薇拉离开王都，在城外落脚
1. 薇拉请缨：主动、收拾行囊、同行
   详细：薇拉默默收拾行囊。
   到这个节点结束时，两人已经决定同行。
2. 城门盘查：卫兵、盘查、蒙混过关
   详细：两人在北门被拦下。
3. 林中扎营：天黑、扎营、守夜
</StoryPlan>`;

const MULTI_PLAN = {
    title: '出城', overall: '苏哲和薇拉离开王都，在城外落脚',
    nodes: [
        { name: '薇拉请缨', keywords: '主动、收拾行囊、同行', detail: '薇拉默默收拾行囊。\n到这个节点结束时，两人已经决定同行。' },
        { name: '城门盘查', keywords: '卫兵、盘查、蒙混过关', detail: '两人在北门被拦下。' },
        { name: '林中扎营', keywords: '天黑、扎营、守夜', detail: '' },
    ],
};

test('剧情脉络：解析多节点 / 单节点 / 截断尾块，旧序列格式不再认', () => {
    const [multi] = parseStoryPlans(PATH_BLOCK);
    assert.deepEqual(multi, MULTI_PLAN);
    assert.deepEqual(parseStoryPlanBlock(PATH_BLOCK.match(/<StoryPlan>([\s\S]*?)<\/StoryPlan>/)[1]), MULTI_PLAN);

    const singles = parseStoryPlans('两个方向：\n<StoryPlan>\n标题：匿名信\n目标：门缝里塞进一封信。\n信里写着交接时间。\n</StoryPlan>\n<story_plan>\ntitle: 旧识来访\ngoal: 老管家深夜登门。\n</story_plan>');
    assert.deepEqual(singles, [
        { title: '匿名信', overall: '', nodes: [{ name: '匿名信', keywords: '', detail: '门缝里塞进一封信。\n信里写着交接时间。' }] },
        { title: '旧识来访', overall: '', nodes: [{ name: '旧识来访', keywords: '', detail: '老管家深夜登门。' }] },
    ]);
    const cut = parseStoryPlans('<StoryPlan>\n标题：出城\n1. 请缨：同行\n   详细：她收拾行囊\n2. 盘查');
    assert.equal(cut.length, 1);
    assert.deepEqual(cut[0].nodes.map((node) => node.name), ['请缨', '盘查']);
    assert.equal(parseStoryPlans('<StorySequence>\ntitle: 旧\nbeat: 第一拍\ngoal: x\n</StorySequence>').length, 0);
    assert.equal(parseStoryPlans('<StoryPlan>\n只是一段话\n</StoryPlan>').length, 0);
});

test('剧情脉络：完成推进、跳过、用新卡替换剩下的部分', () => {
    const [plan] = parseStoryPlans(PATH_BLOCK);
    const path = buildPath(plan, 'fast', 10);
    assert.equal(path.speed, 'fast');
    assert.deepEqual(path.nodes.map((node) => node.status), ['active', 'pending', 'pending']);
    const result = pathAdvance(path, 15);
    assert.equal(result.ended, false);
    assert.equal(result.node.name, '城门盘查');
    assert.equal(path.cursor, 1);
    assert.equal(path.nodeStartAt, 15);
    assert.equal(pathSkipNode(path, 2), false, '当前节点不能跳过');
    assert.equal(pathSkipNode(path, 3), true);
    pathSpliceTail(path, { title: '', overall: '换个走法', nodes: [{ name: '翻墙', keywords: '夜里', detail: '' }, { name: '出海', keywords: '', detail: '' }] }, 20);
    assert.deepEqual(path.nodes.map((node) => `${node.id}:${node.name}:${node.status}`), ['1:薇拉请缨:done', '4:翻墙:active', '5:出海:pending']);
    assert.equal(path.title, '出城');
    assert.equal(path.overall, '换个走法');
    assert.equal(pathAdvance(path, 30).node.name, '出海');
    assert.equal(pathAdvance(path, 40).ended, true);
    assert.equal(pathHasUnplayed(path), false);
});

test('剧情脉络：注入按 整体目标 / 已完成 / 当前目标 / 后续 排列；单节点只有目标', () => {
    const [plan] = parseStoryPlans(PATH_BLOCK);
    const path = buildPath(plan, 'normal', 0);
    pathAdvance(path, 5);
    const lines = pathInjectionText(path, {}).split('\n');
    assert.equal(lines[0], '<剧情导向>');
    assert.doesNotMatch(lines[1], /user|希望/);
    assert.deepEqual(lines.slice(2), [
        '整体目标：苏哲和薇拉离开王都，在城外落脚',
        '已完成：薇拉请缨',
        '当前目标（节点 2/3 · 城门盘查）：',
        '两人在北门被拦下。',
        '后续节点（只用来把握方向；当前目标达成之前，严禁写到这些情节）：林中扎营——天黑、扎营、守夜',
        '节奏：' + ADVISOR_SPEEDS.normal.directive,
        '</剧情导向>',
    ]);
    pathAdvance(path, 9);
    const last = pathInjectionText(path, {});
    assert.match(last, /当前目标（节点 3\/3 · 林中扎营）：\n林中扎营——天黑、扎营、守夜\n节奏：/);
    assert.doesNotMatch(last, /后续/);
    assert.match(last, /已完成：薇拉请缨、城门盘查/);
    const [single] = parseStoryPlans('<StoryPlan>\n标题：匿名信\n目标：门缝里塞进一封信。\n</StoryPlan>');
    const one = pathInjectionText(buildPath(single, 'slow', 0), {}).split('\n');
    assert.deepEqual(one.slice(2), ['目标：', '门缝里塞进一封信。', '节奏：' + ADVISOR_SPEEDS.slow.directive, '</剧情导向>']);
    path.nodes[path.cursor].status = 'done';
    assert.equal(pathInjectionText(path, {}), '');
});

function assistantElement() {
    const content = {
        textContent: '',
        innerHTML: '',
        style: {},
        classList: { add() {}, remove() {} },
    };
    return { content, element: { querySelector: (selector) => selector === '.pad-content' ? content : null } };
}

const sendSettings = (mode, stream, sendTemperature) => ({
    mode, stream, sendTemperature, endpoint: 'https://mock/v1', model: 'gemini-3-test',
    apiKey: 'test-key', profileId: 'profile', maxTokens: 1024, temperature: 0.4,
    applyRegex: false,
});

test('发送入口参数矩阵：generateReply', async () => {
    const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }];
    activateOracleMode('chat');
    for (const mode of ['direct', 'profile']) for (const stream of [false, true]) for (const temperature of [false, true]) {
        replaceConvo([]);
        hostContext.chatMetadata = {};
        const settings = sendSettings(mode, stream, temperature);
        const calls = [];
        const { content, element } = assistantElement();
        const capture = (kind, args, isStream) => {
            const direct = kind.startsWith('direct');
            const signal = args[direct ? 3 : 4];
            const body = direct ? args[2] : { messages: args[1], max_tokens: args[2], ...args[3] };
            const call = { kind, args, body, signal, stream: isStream, updates: [] };
            calls.push(call);
            return call;
        };
        const transport = {
            async callDirect(...args) { capture('direct', args, false); return 'AB'; },
            async streamDirect(...args) {
                const call = capture('directStream', args, true);
                for (const delta of ['A', 'B']) { args.at(-1)(delta); call.updates.push(content.textContent); }
                return 'AB';
            },
            async callProfile(...args) { capture('profile', args, false); return 'AB'; },
            async callProfileStream(...args) {
                const call = capture('profileStream', args, true);
                for (const full of ['A', 'AB']) { args.at(-1)(full); call.updates.push(content.textContent); }
                return 'AB';
            },
        };

        await generateReply({ settings, messages, assistantEl: element, showTyping: () => () => {}, transport });

        assert.equal(calls.length, 1);
        const call = calls[0];
        assert.equal(call.kind, mode + (stream ? 'Stream' : ''));
        assert.equal(call.stream, stream);
        assert.deepEqual(call.body, {
            ...(mode === 'direct' ? { model: settings.model } : {}), messages,
            max_tokens: mode === 'direct' ? 4096 : 1024,
            ...(temperature ? { temperature: 0.4 } : {}),
        });
        assert.equal(call.signal instanceof AbortSignal, true);
        assert.equal(call.signal.aborted, false);
        if (mode === 'direct') assert.deepEqual(call.args.slice(0, 2), ['https://mock/v1/chat/completions', 'test-key']);
        else assert.equal(call.args[0], 'profile');
        if (stream) assert.deepEqual(call.updates, ['A', 'AB']);
        assert.equal(content.textContent, 'AB');
    }
});
