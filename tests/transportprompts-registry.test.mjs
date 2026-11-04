import assert from 'node:assert/strict';
import test from 'node:test';

import { ADVISOR_SPEEDS, DEFAULT_SYSTEM_PROMPT } from '../src/prompts/builtins.js';
import {
    P,
    PROMPT_DEFS,
    PROMPT_DEF_MAP,
    PROMPT_VAR_RE,
    promptDef,
    promptProblems,
    promptReset,
    promptSet,
    renderPromptTemplate,
} from '../src/prompts/registry.js';

test('提示词注册表的数组、Map 与查找保持一一对应', () => {
    assert.ok(PROMPT_DEFS.length > 0);
    assert.equal(PROMPT_DEF_MAP.size, PROMPT_DEFS.length, '提示词 id 不得重复');
    for (const definition of PROMPT_DEFS) {
        assert.equal(PROMPT_DEF_MAP.get(definition.id), definition);
        assert.equal(promptDef(definition.id), definition);
    }
    assert.equal(promptDef('missing.prompt'), null);
});

test('P 使用显式设置读取 legacy 与普通覆盖，不依赖宿主设置', () => {
    const settings = { systemPrompt: '自定义系统', promptOverrides: { 'chat.tail': '自定义尾锚 {%name%}' } };
    assert.equal(P('chat.system', null, settings), '自定义系统');
    assert.equal(P('chat.tail', { name: '甲' }, settings), '自定义尾锚 甲');

    promptSet('chat.tail', '第二版', settings);
    assert.equal(P('chat.tail', null, settings), '第二版');
    promptReset('chat.tail', settings);
    assert.equal(P('chat.tail', null, settings), promptDef('chat.tail').builtin);

    promptSet('chat.system', DEFAULT_SYSTEM_PROMPT, settings);
    assert.equal(settings.systemPrompt, DEFAULT_SYSTEM_PROMPT);
});

test('PROMPT_VAR_RE 与模板渲染保持条件段、空行和单次代入语义', () => {
    PROMPT_VAR_RE.lastIndex = 0;
    assert.deepEqual([...'{% alpha %}/{%beta%}/{%#ignored%}'.matchAll(PROMPT_VAR_RE)].map((match) => match[1]), ['alpha', 'beta']);

    const template = [
        '头',
        '可选：{%empty%}',
        '{%#shown%}显示 {%shown%}{%/shown%}',
        '{%^missing%}缺失{%/missing%}',
        '尾 {%unknown%}',
    ].join('\n');
    assert.equal(renderPromptTemplate(template, {
        empty: '',
        shown: '{%unknown%}',
        missing: '',
    }), '头\n显示 {%unknown%}\n缺失\n尾 {%unknown%}');
    assert.deepEqual(promptProblems('diag.rules', '没有变量与契约'), []);
    assert.ok(promptProblems('chat.statOn', '没有 stat').includes('{%stat%}'));
});

test('ADVISOR_SPEEDS 三档文案逐字固定', () => {
    assert.deepEqual(ADVISOR_SPEEDS, {
        slow: {
            label: '慢推',
            caption: '多写过程和人物互动，过几个场景再达成当前目标',
            directive: '不急着推进，多写过程、细节和人物之间的互动，过几个场景再走到当前目标的结果。',
        },
        normal: {
            label: '正常',
            caption: '每个场景往当前目标靠近一步，时机到了自然达成',
            directive: '每个场景往当前目标靠近一步，时机到了自然达成，不刻意拖延也不急于求成。',
        },
        fast: {
            label: '快推',
            caption: '在接下来一两个场景内达成当前目标',
            directive: '在接下来一两个场景内达成当前目标；仍要接得上眼下的局面，不显得突兀。',
        },
    });
});
