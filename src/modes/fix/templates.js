import { saveChatMetadata } from '../../core/chat-metadata.js';
import { getCtx, getSettings, save, uiConfirm } from '../../core/settings.js';
import { sharedState } from '../../core/state.js';
import { ADVISOR_PROMPT_KEY, FIX_CFG_META_KEY, getChatMetadataSafe, getPath } from '../advisor/metadata.js';
import { parseExcludeTags } from '../diagnose/mvu.js';
import { filterBundleCfg, normalizeScopeInput } from './algorithms.js';
import { loadFixCfgForChat, populateFixTemplates, updateFixTplDirtyMarker, updateFixVerdict } from './ui.js';
import { ADVISOR_SPEEDS, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_TEMPLATE_HUB, ENABLE_INJECT_GLUE, FIX_SAMPLE_TEMPLATES, SO_VERSION } from '../../prompts/builtins.js';
import { fixSampleTemplateByName, fixTemplateIsBuiltin } from '../../prompts/helpers.js';
import { P, promptIsCustom } from '../../prompts/registry.js';
import { MVU_UPDATE_TAG } from '../../st/adapters.js';

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：校正配置按【当前聊天】持久化（同 plan/convo/summary/diagwi 风格）。
 * 元数据只存被【显式覆盖】的 fix* 键（getEffectiveFixCfg 现场回退到全局 getSettings 默认）；空 = 删键。
 * getEffectiveFixCfg 是纯函数（合并全局 s + 本聊天 md），是校正代码读取配置的唯一入口。
 * ------------------------------------------------------------------ */
// 迁到 per-chat 的校正键（全局 getSettings 默认仍是回退值）。autoDiagnoseEnabled 不在此列——自动诊断不迁移、仍走全局。
const FIX_CFG_KEYS = [
    // 手动模式（per-chat 可覆盖）
    'fixM_contextDepth', 'fixM_includeCard', 'fixM_includeWorld', 'fixM_includeSummary',
    'fixM_protectThink',   // ✨ 思考块保护（W1 2026-08-16）：偏好键，per-chat 可覆盖、可进套餐
    'fixM_scopeTag',       // 二创版 2.1：手动整篇的正文标签（per-chat，可进套餐）
    // 自动模式（per-chat 可覆盖）
    'fixA_includeCard', 'fixA_includeContext', 'fixA_contextDepth', 'fixA_includeWorld', 'fixA_includeSummary',
    'fixA_targetSlop', 'fixA_targetDialogue', 'fixA_targetPrecision', 'fixA_targetMagic', 'fixA_targetPacing', 'fixA_targetArchaic',
    'fixA_knowledgeBoundary', 'fixA_guardrails', 'fixA_keepTags', 'fixA_dropTags', 'fixA_scopeTag', 'fixA_scopeManual', 'fixA_tighten',
    'fixA_pieceMode', 'fixA_pieceAsked',   // ✨ 分段校正（1.18.0）：正文形态按聊天记忆 + 已询问标记（卡片专属，不进套餐）
    'fixA_pieceJoin',   // ✨ 整体校正开关（偏好，可进套餐）：1 次调用锚点保留 vs 分段逐次调用
    'fixA_promptVersion', 'fixA_promptFlavor',   // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）
    'autoFixEnabled', 'fixAutoMinChars',
    'fixA_task', 'fixC_template', 'fixC_useMechanic', 'fixC_keepTags', 'fixC_dropTags',   // 📋 自定义模板任务（spec 2026-09-03 §3）
];

// 纯函数：把全局设置 s 与本聊天元数据 md（或 null/undefined）合并成生效校正配置。
// 每个 fix* 键：md 用 hasOwnProperty 显式拥有该键就取 md 的值（尊重显式 false / 0 / ''），否则回退 s。
// 校正代码一律读这里返回的对象，绝不直读 s.fix*（否则 per-chat 覆盖会被绕过——这正是本任务要根治的 bug）。
export function getEffectiveFixCfg(s, md) {
    const out = {};
    const g = s || {};
    const m = (md && typeof md === 'object') ? md : null;
    for (const k of FIX_CFG_KEYS) {
        out[k] = (m && Object.prototype.hasOwnProperty.call(m, k)) ? m[k] : g[k];
    }
    return out;
}

// ✨ 校正：「经自定义补全预设发送」开关按模式取值——手动/自动分家后各自独立（用户功能请求 2026-06-27）。
// 全局键 fixM_usePreset / fixA_usePreset / fixC_usePreset（📋 自定义模板任务自成一套，绝不借手动/自动的键）；
// 其余模式一律看手动键；s 缺失容错为 false。纯判定，便于单测（fix-custom-prompt.test.mjs）。
export function fixUsePresetFor(s, mode) {
    const key = mode === 'auto' ? 'fixA_usePreset' : (mode === 'custom' ? 'fixC_usePreset' : 'fixM_usePreset');
    return !!(s && s[key]);
}

// 纯函数：把 getEffectiveFixCfg 的【原始 fixM_*/fixA_* 键】归一成校正代码消费的统一形状（按 mode 取对应一套）。
// 校正代码（captureFixContext / runFixByTargets / runAutoFix）一律读这里的输出，不直读 fixM_/fixA_ 原始键——
// 这样手动 / 自动两套设置彻底独立（同名设置互不串味），且收紧/目标的「仅自动」规则集中在此一处。
// 手动：上下文按 fixM_*（depth=0 视作不带前文）、永不收紧、无目标 / 约束 / 排除区（纯指令驱动，省时间）。
// 自动：上下文 / 目标 / 约束 / 排除区 / 收紧全按 fixA_*（收紧默认开，显式 false 才关）。可单测。
export function resolveFixModeCfg(e, mode) {
    const c = e || {};
    if (mode === 'auto') {
        return {
            includeCard: !!c.fixA_includeCard, includeContext: !!c.fixA_includeContext,
            contextDepth: (c.fixA_contextDepth | 0) || 30, includeWorld: !!c.fixA_includeWorld,
            includeSummary: !!c.fixA_includeSummary, tighten: true,   // 1.18.3：✂️收紧 开关移除，轻校恒收紧（fixA_tighten 键保留，只为旧配置 / 套餐兼容）
            targets: {
                slop: !!c.fixA_targetSlop, dialogue: !!c.fixA_targetDialogue, precision: !!c.fixA_targetPrecision,
                magic: !!c.fixA_targetMagic, pacing: !!c.fixA_targetPacing, archaic: !!c.fixA_targetArchaic,
            },
            knowledge: c.fixA_knowledgeBoundary || '', guardrails: c.fixA_guardrails || '',
            keepTags: c.fixA_keepTags || '', dropTags: c.fixA_dropTags || '',
            // 作用域标签：缺省（旧聊天 / 未设）→ 'content' 默认；显式空串 '' → 关闭作用域（校正整条）。
            scopeTag: (c.fixA_scopeTag == null ? 'content' : c.fixA_scopeTag),
            // ✨ 自动配置 Phase 5（D+E）：这个标签是否用户手填过——resolveFixScope 据此决定缓存未命中时能不能
            // 自我纠正（false）还是只能建议不能代劳（true）。
            scopeManual: !!c.fixA_scopeManual,
            // ✨ 分段校正（1.18.0）：正文形态缓存归一——只有 'wrapped' / 'bare' 合法，其余（缺省 / null / 未知）→ ''（未定）。
            pieceMode: (c.fixA_pieceMode === 'wrapped' || c.fixA_pieceMode === 'bare') ? c.fixA_pieceMode : '',
            pieceAsked: !!c.fixA_pieceAsked,
            pieceJoin: c.fixA_pieceJoin !== false,   // ✨ 整体校正：默认开（显式 false 才回分段逐次调用）
            // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：归一 raw fixA_promptVersion/Flavor 成校验值。缺省 / null /
            // 未知 → 默认（light / deepseek），迁移安全（老聊天无值 = 轻校 = 零行为变化）。resolveFixAutoPrompt 据此选提示。
            promptVersion: (c.fixA_promptVersion === 'thorough' ? 'thorough' : 'light'),
            promptFlavor: (['opus', 'gemini'].includes(c.fixA_promptFlavor) ? c.fixA_promptFlavor : 'deepseek'),
            protectThink: false,   // ✨ 思考块保护为【手动整篇】专属（W1）；自动有自己的 fixA_keepTags 用户排除区，给确定值避免 undefined 外泄
        };
    }
    // 手动：depth 显式 0 = 不带前文；其余非正数 / 缺省 = -1（全部）。
    const depth = (c.fixM_contextDepth === 0) ? 0 : ((c.fixM_contextDepth | 0) || -1);
    return {
        includeCard: !!c.fixM_includeCard, includeContext: depth !== 0, contextDepth: depth,
        includeWorld: !!c.fixM_includeWorld, includeSummary: !!c.fixM_includeSummary, tighten: false,
        targets: { slop: false, dialogue: false, precision: false, magic: false, pacing: false, archaic: false },
        knowledge: '', guardrails: '', keepTags: '', dropTags: '',
        scopeTag: normalizeScopeInput(c.fixM_scopeTag),   // 二创版 2.1：手动整篇的正文标签（只在整篇手动生效，captureFixContext 按 wholeFloor 门控）
        scopeManual: false,   // 手动模式下这个字段无意义（作用域本就关闭），给个确定值避免 undefined 外泄
        pieceMode: '', pieceAsked: false, pieceJoin: false,   // 手动模式不走分段（captureFixContext 也按 mode 门控）；给确定值避免 undefined 外泄
        promptVersion: 'light', promptFlavor: 'deepseek',   // 手动模式不走精校（buildFixPrompt 手动分支另选 FIX_SYSTEM_PROMPT_MANUAL）；给确定值避免 undefined 外泄
        protectThink: c.fixM_protectThink !== false,   // ✨ 思考块保护（W1）：缺键（老配置 / 老套餐）= 开——迁移安全；显式 false 才关
    };
}

// 📋 纯函数：自定义模板任务的 per-chat 配置归一（resolveFixModeCfg(cfg,'auto') 逐字节不动——校正用户零波及）。
// 缺键 = 校正任务 / 沿用识别开（迁移安全）；task 非法 → 'fix'；显式 false 才关识别。可单测（fix-custom-cfg.test.mjs）。
export function resolveFixCustomCfg(e) {
    const c = e || {};
    return {
        task: c.fixA_task === 'custom' ? 'custom' : 'fix',
        template: typeof c.fixC_template === 'string' ? c.fixC_template : '',
        useMechanic: c.fixC_useMechanic !== false,
        keepTags: c.fixC_keepTags || '',
        dropTags: c.fixC_dropTags || '',
    };
}

// 📋 纯函数：全局模板库读时归一——去空名 / 非对象、名字 trim、prompt 非字符串归 ''。
// 同名：内容保【后者】，位置保【首次出现处】（Map.set 覆写不挪位）——面板列表不会因为改一条就跳到末尾。
export function normalizeFixTemplates(arr) {
    if (!Array.isArray(arr)) return [];
    const byName = new Map();
    for (const t of arr) {
        if (!t || typeof t.name !== 'string') continue;
        const name = t.name.trim();
        if (!name) continue;
        byName.set(name, { name, prompt: typeof t.prompt === 'string' ? t.prompt : '' });
    }
    return [...byName.values()];
}

// 📋 纯函数：按名取模板；缺失 → null（调用方判 prompt 是否为空）。
// 用户库【先】查，内置示例是【兜底】：同名时用户那份赢（老存档里可能躺着一份 1.77.0 之前存下的同名模板；
// 新建同名由 saveFixTemplate 硬拒，所以冲突造不出来）。兜底这一支让「选中内置示例」与「选中自己的模板」
// 在整条运行路上完全同形——runCustomTask / runCustomTaskNow / 判定行 / 套餐提示全走这一个函数。
export function findFixTemplate(s, name) {
    const list = normalizeFixTemplates(s && s.fixTemplates);
    const n = String(name || '');
    if (!n) return null;
    return list.find((t) => t.name === n) || fixSampleTemplateByName(n);
}

// 📋 纯函数：一个标签规格（parseExcludeTags 的产物）的【比对键】= 分隔符种类 + 小写名
// （<Status> → '<status'，[IMG_GEN] → '[img_gen'）。「同名」的口径只此一处——两区比对原来在
// fixDropMinusKeep / fixTagOverlap 里各手写了三四遍，改口径时漏改一处两边就会分家。
function fixTagKey(spec) {
    return (spec.bracket ? '[' : '<') + spec.name.toLowerCase();
}

// 📋 纯函数：两区同名规则 = 保留优先（spec §5.2）——丢弃串里剔掉也在保留串里的项（名 + 括号种类都相同才算同项）。
// 保留原始书写形式与顺序，行分隔输出。
export function fixDropMinusKeep(keepTags, dropTags) {
    const keep = new Set(parseExcludeTags(keepTags).map(fixTagKey));
    return String(dropTags || '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).filter((raw) => {
        const spec = parseExcludeTags(raw)[0];
        if (!spec) return false;
        return !keep.has(fixTagKey(spec));
    }).join('\n');
}

// 📋 纯函数：两区同名的名字列表（面板警告用；大小写不敏感、括号种类须相同）。
export function fixTagOverlap(keepTags, dropTags) {
    const keep = new Set(parseExcludeTags(keepTags).map(fixTagKey));
    const out = [];
    for (const sp of parseExcludeTags(dropTags)) {
        if (keep.has(fixTagKey(sp)) && !out.includes(sp.name.toLowerCase())) out.push(sp.name.toLowerCase());
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 🌐 模板广场（1.86.0）纯函数层
 * 提交规则是 story-oracle-templates/lib/submission.mjs 的逐条副本——两边由同一张夹具表
 * （test/fixtures/submission-cases.json）钉住；改一边必须同改另一边 + 夹具。
 * 广场来的一切文字都是【不可信】的：本层只做解析与校验，渲染层一律 textContent。
 * ------------------------------------------------------------------ */
const FIX_HUB_REPO = 'namelessone88/story-oracle-templates';
const FIX_HUB_MARKER = '<!-- SO-TEMPLATE v1 -->';
const FIX_HUB_LIMITS = Object.freeze({ name: 40, prompt: 8000, description: 200, author: 30, model: 60, client: 20, tagsMin: 1, tagsMax: 3 });
const FIX_HUB_ERR_TEXT = Object.freeze({
    'name.required': '模板名字不能为空',
    'name.too_long': '模板名字最多 40 个字',
    'prompt.required': '模板正文不能为空',
    'prompt.too_long': '模板正文最多 8000 个字',
    'description.too_long': '说明最多 200 个字',
    'author.too_long': '作者名最多 30 个字',
    'model.too_long': '测试模型最多 60 个字',
    'tags.too_few_tags': '至少选 1 个标签',
    'tags.too_many_tags': '最多选 3 个标签',
    'tags.bad_tag': '标签不在列表里，刷新广场后再选',
    'updateOf.bad_update': '要更新的模板在广场里找不到了',
    'updateOf.unknown_update': '要更新的模板在广场里找不到了',
    '_fallback': '内容格式不对',
});
const fixHubIdRe = /^t\d{4,}$/;
sharedState.fixHubSkipWarned = false;   // 坏条目只 console.warn 一次（spec §5）

// 清洗口径（与仓库 clean 逐条相同）：孤立代理 → U+FFFD、CRLF / CR → LF、去 C0/C1 控制字符（留 \t \n）。
function fixHubClean(s) {
    let t = String(s);
    t = typeof t.toWellFormed === 'function'
        ? t.toWellFormed()
        : t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
    t = t.replace(/\r\n?/g, '\n');
    return t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

// 提交校验（与仓库 validateSubmission 逐条相同）：长度按【码点】数；错误按字段顺序；未知键丢弃。
// knownIds = null → 不核 updateOf 是否存在（广场连不上时的离线分享）。
// 单行字段（name / author / description / model）清洗后把「换行 / 制表符连同两侧空白」折成一个空格再 trim；
// prompt 保留换行（spec §3.5）。
function fixHubValidateSubmission(input, tags, knownIds) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: [{ field: '_', code: 'bad_type' }] };
    const cpLen = (s) => [...s].length;
    const errors = [];
    const value = {};
    const str = (field, required, max, singleLine) => {
        const raw = input[field];
        if (raw === undefined || raw === null) {
            if (required) errors.push({ field, code: 'required' });
            value[field] = '';
            return;
        }
        if (typeof raw !== 'string') { errors.push({ field, code: 'bad_type' }); value[field] = ''; return; }
        let t = fixHubClean(raw);
        if (singleLine) t = t.replace(/\s*[\n\t]\s*/g, ' ');
        t = t.trim();
        if (required && !t) errors.push({ field, code: 'required' });
        else if (cpLen(t) > max) errors.push({ field, code: 'too_long' });
        value[field] = t;
    };
    str('name', true, FIX_HUB_LIMITS.name, true);
    str('prompt', true, FIX_HUB_LIMITS.prompt, false);
    str('description', false, FIX_HUB_LIMITS.description, true);
    str('author', false, FIX_HUB_LIMITS.author, true);
    const rawTags = (input.tags === undefined || input.tags === null) ? [] : input.tags;
    if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string')) {
        errors.push({ field: 'tags', code: 'bad_type' });
        value.tags = [];
    } else {
        const uniq = [...new Set(rawTags.map((t) => fixHubClean(t).trim()).filter(Boolean))];
        value.tags = uniq;
        const allowed = Array.isArray(tags) ? tags : [];
        if (uniq.length < FIX_HUB_LIMITS.tagsMin) errors.push({ field: 'tags', code: 'too_few_tags' });
        else if (uniq.length > FIX_HUB_LIMITS.tagsMax) errors.push({ field: 'tags', code: 'too_many_tags' });
        else if (uniq.some((t) => !allowed.includes(t))) errors.push({ field: 'tags', code: 'bad_tag' });
    }
    str('model', false, FIX_HUB_LIMITS.model, true);
    const u = input.updateOf;
    if (u === undefined || u === null || u === '') value.updateOf = null;
    else if (typeof u !== 'string') { errors.push({ field: 'updateOf', code: 'bad_type' }); value.updateOf = null; }
    else if (!fixHubIdRe.test(u)) { errors.push({ field: 'updateOf', code: 'bad_update' }); value.updateOf = null; }
    else if (Array.isArray(knownIds) && !knownIds.includes(u)) { errors.push({ field: 'updateOf', code: 'unknown_update' }); value.updateOf = u; }
    else value.updateOf = u;
    value.client = typeof input.client === 'string' ? [...fixHubClean(input.client).trim()].slice(0, FIX_HUB_LIMITS.client).join('') : '';
    return errors.length ? { ok: false, errors } : { ok: true, value };
}

function fixHubFieldMessage(field, code) {
    return FIX_HUB_ERR_TEXT[`${field}.${code}`] || FIX_HUB_ERR_TEXT._fallback;
}

// 分享区块：JSON 里的反引号 / 尖括号一律转义成 \u0060 / \u003c——正文里就算写着 ``` 或标记本身，
// 区块里也只剩两道围栏的 6 个反引号、标记只出现一次（Review Focus 3）。
function fixHubBuildShareBlock(value) {
    const body = JSON.stringify(value, null, 2).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
    return `${FIX_HUB_MARKER}\n\`\`\`json\n${body}\n\`\`\``;
}

// 单个广场条目 → HubEntry | null（坏条目整条跳过，绝不半条渲染）。校验复用提交规则，标签只校形不校名单。
function fixHubLibraryEntry(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (typeof e.id !== 'string' || !fixHubIdRe.test(e.id)) return null;
    if (!Number.isInteger(e.version) || e.version < 1) return null;
    const ownTags = Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string').map((t) => fixHubClean(t).trim()) : [];
    const v = fixHubValidateSubmission({ name: e.name, prompt: e.prompt, author: e.author, description: e.description, tags: e.tags, model: e.model }, ownTags, null);
    if (!v.ok) return null;
    const { name, prompt, author, description, tags, model } = v.value;
    return { id: e.id, version: e.version, updatedAt: typeof e.updatedAt === 'string' ? fixHubClean(e.updatedAt).trim() : '', name, prompt, author, description, tags, model };
}

// 广场 JSON → { ok, lib, skipped } | { ok:false, reason }。reason：'shape' = 根本不是广场（200 回 HTML 门户页、
// 缺 schema…，该试下一个镜像）；'schema' = 真广场但格式号不认识（该停下提示更新神谕）。
function fixHubParseLibrary(body) {
    let data = body;
    if (typeof body === 'string') {
        try { data = JSON.parse(body); } catch (e) { return { ok: false, reason: 'shape' }; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'shape' };
    if (data.schema !== 1) return { ok: false, reason: typeof data.schema === 'number' ? 'schema' : 'shape' };
    if (!Array.isArray(data.templates)) return { ok: false, reason: 'shape' };
    const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string').map((t) => fixHubClean(t).trim()).filter(Boolean) : [];
    const templates = [];
    const seen = new Set();
    let skipped = 0;
    for (const raw of data.templates) {
        const t = fixHubLibraryEntry(raw);
        if (!t || seen.has(t.id)) { skipped += 1; continue; }
        seen.add(t.id);
        templates.push(t);
    }
    if (skipped && !sharedState.fixHubSkipWarned) { sharedState.fixHubSkipWarned = true; console.warn(`[Story Oracle] 模板广场：${skipped} 个条目格式不对，已跳过`); }
    return { ok: true, lib: { generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '', tags, templates }, skipped };
}

// 过滤：标签（单选，'' = 全部）AND 搜索（名字 / 作者 / 说明，不分大小写）。
function fixHubFilter(templates, { tag = '', q = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return (Array.isArray(templates) ? templates : []).filter((t) => {
        if (tag && !t.tags.includes(tag)) return false;
        if (!needle) return true;
        return [t.name, t.author, t.description].some((f) => String(f || '').toLowerCase().includes(needle));
    });
}

// 下载到本地时的名字：撞名追加「（2）」「（3）」…（taken 须含内置示例名——saveFixTemplate 会硬拒保留名，Review Focus 2）。
function fixHubLocalName(name, taken) {
    const set = new Set(Array.isArray(taken) ? taken : []);
    if (!set.has(name)) return name;
    for (let n = 2; ; n += 1) {
        const cand = `${name}（${n}）`;
        if (!set.has(cand)) return cand;
    }
}

// 'none' | 'installed' | 'update'。本地那份被改名 / 删掉（按名字对不上）= 'none'。
function fixHubInstallStatus(entry, installed, localNames) {
    const rec = installed && Object.prototype.hasOwnProperty.call(installed, entry.id) ? installed[entry.id] : null;
    if (!rec || !Array.isArray(localNames) || !localNames.includes(rec.name)) return 'none';
    return rec.version < entry.version ? 'update' : 'installed';
}

// 剪掉本地已不存在的已下载记录——恒返回【新对象】（调用方整体赋回 s.fixHubInstalled，绝不原地改）。
function fixHubPruneInstalled(installed, localNames) {
    const out = {};
    const names = Array.isArray(localNames) ? localNames : [];
    for (const [id, rec] of Object.entries(installed || {})) {
        if (rec && names.includes(rec.name)) out[id] = { version: rec.version, name: rec.name };
    }
    return out;
}

// 三个读取镜像，按序试（spec §4.1）。
function fixHubLibraryUrls(repo) {
    return [
        `https://testingcf.jsdelivr.net/gh/${repo}@main/dist/library.json`,
        `https://cdn.jsdelivr.net/gh/${repo}@main/dist/library.json`,
        `https://raw.githubusercontent.com/${repo}/main/dist/library.json`,
    ];
}

// 广场卡读这一个；旗关 = 空表 = 永不联网。
function fixHubLibraryUrlsDefault() {
    return ENABLE_FIX_TEMPLATE_HUB ? fixHubLibraryUrls(FIX_HUB_REPO) : [];
}

/* ------------------------------------------------------------------ *
 * 🌐 模板广场 UI（1.86.0）——拉取 / 缓存 / 渲染 / 下载。广场文字不可信：一律 textContent。
 * 卡片骨架（buildFixHubCard 里那段静态 innerHTML）不含任何外来数据。
 * ------------------------------------------------------------------ */
const FIX_HUB_CACHE_KEY = 'so-fixhub-cache-v1';
sharedState.fixHubState = { lib: null, source: '', fetchedAt: 0, tag: '', q: '', open: new Set(), pending: '' };

// 缓存 = localStorage 里的 { fetchedAt, url, body }；每次读写都 try/catch（隐私模式 / 满了 / 被禁用都照常能用）。
function fixHubCacheRead() {
    try {
        const raw = localStorage.getItem(FIX_HUB_CACHE_KEY);
        if (!raw) return null;
        const c = JSON.parse(raw);
        return (c && typeof c.body === 'string') ? c : null;
    } catch (e) { return null; }
}
function fixHubCacheWrite(obj) {
    try { localStorage.setItem(FIX_HUB_CACHE_KEY, JSON.stringify(obj)); } catch (e) { /* 隐私模式 / 满了：不缓存也能用 */ }
}

// 纯函数：广场的「新旧」= generatedAt 的时间戳；解析不了 → 0（最旧）。
function fixHubLibTime(lib) {
    const t = Date.parse(lib && lib.generatedAt);
    return Number.isFinite(t) ? t : 0;
}

// 三个镜像【同时】问，取 generatedAt 最新的那份合法广场（1.86.0 真机实测：testingcf 镜像是独立缓存、
// 发布后的清缓存够不着它，按顺序取第一份会一直拿到旧的空广场）。并列时按镜像顺序优先。
// 200 但不是合法广场（HTML 门户页等）= 这一路失败；没有任何合法广场、且有一路回了不认识的 schema 号 =
// 真广场出了新格式 → 不写缓存。网上拿到的比本地缓存还旧（只连得上陈旧镜像）→ 继续用缓存那份、不回写。
// 全失败 → 回缓存（source:'cache'）；连缓存都没有 → unreachable。
async function fixHubLoadLibrary({ force = false } = {}) {
    if (!force && sharedState.fixHubState.lib) return { ok: true, lib: sharedState.fixHubState.lib, source: sharedState.fixHubState.source, fetchedAt: sharedState.fixHubState.fetchedAt };
    const urls = fixHubLibraryUrlsDefault();
    const results = await Promise.all(urls.map(async (url) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        try {
            const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
            if (!res.ok) return null;
            const text = await res.text();
            return { url, text, parsed: fixHubParseLibrary(text) };
        } catch (e) {
            return null;   // 超时 / 断网 / CORS：这一路算失败
        } finally {
            clearTimeout(timer);
        }
    }));
    let best = null;
    for (const r of results) {
        if (r && r.parsed.ok && (!best || fixHubLibTime(r.parsed.lib) > fixHubLibTime(best.parsed.lib))) best = r;
    }
    if (best) {
        const cachedNow = fixHubCacheRead();
        const cachedParsed = cachedNow ? fixHubParseLibrary(cachedNow.body) : null;
        const fetchedAt = Date.now();
        if (cachedParsed && cachedParsed.ok && fixHubLibTime(cachedParsed.lib) > fixHubLibTime(best.parsed.lib)) {
            Object.assign(sharedState.fixHubState, { lib: cachedParsed.lib, source: 'net', fetchedAt });
            return { ok: true, lib: cachedParsed.lib, source: 'net', fetchedAt };
        }
        fixHubCacheWrite({ fetchedAt, url: best.url, body: best.text });
        Object.assign(sharedState.fixHubState, { lib: best.parsed.lib, source: 'net', fetchedAt });
        return { ok: true, lib: best.parsed.lib, source: 'net', fetchedAt };
    }
    if (results.some((r) => r && r.parsed.reason === 'schema')) {
        // 真广场换了新格式：内存里那份旧列表作废（否则搜索 / 点标签的重画会把它画回提示上面）；存储缓存不动。
        sharedState.fixHubState.lib = null;
        return { ok: false, reason: 'schema' };
    }
    const cached = fixHubCacheRead();
    const parsed = cached ? fixHubParseLibrary(cached.body) : null;
    if (parsed && parsed.ok) {
        Object.assign(sharedState.fixHubState, { lib: parsed.lib, source: 'cache', fetchedAt: cached.fetchedAt });
        return { ok: true, lib: parsed.lib, source: 'cache', fetchedAt: cached.fetchedAt };
    }
    // 存储缓存用不了（隐私模式 / 被清 / 坏了）但这次会话里拉到过 → 那份就是离线副本（Prince 裁：保留列表）。
    if (sharedState.fixHubState.lib) {
        sharedState.fixHubState.source = 'cache';
        return { ok: true, lib: sharedState.fixHubState.lib, source: 'cache', fetchedAt: sharedState.fixHubState.fetchedAt };
    }
    return { ok: false, reason: 'unreachable' };
}

function fixHubMmDd(ms) {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 纯 DOM：只 createElement + textContent。ctx.pending = 正在问「覆盖 / 另存」的那条 id。
function fixHubRenderList(listEl, entries, ctx) {
    listEl.textContent = '';
    const mk = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
    for (const e of entries) {
        const item = mk('div', 'so-fixhub-item');
        item.dataset.id = e.id;
        const head = mk('div', 'so-fixhub-item-head');
        head.appendChild(mk('span', 'so-fixhub-name', e.name));
        head.appendChild(mk('span', 'so-fixhub-meta', `v${e.version} · ${e.author || '匿名'}`));
        item.appendChild(head);
        if (e.description) item.appendChild(mk('div', 'so-fixhub-desc', e.description));
        item.appendChild(mk('div', 'so-fixhub-tagline', e.tags.map((t) => '#' + t).join('  ') + (e.model ? `  测试模型：${e.model}` : '')));
        const btns = mk('div', 'so-fixhub-item-btns');
        const open = ctx.open.has(e.id);
        const pv = mk('button', 'so-fixhub-btn so-fixhub-preview', open ? '收起' : '预览');
        pv.type = 'button';
        const status = fixHubInstallStatus(e, ctx.installed, ctx.localNames);
        const dl = mk('button', 'so-fixhub-btn so-fixhub-dl', status === 'installed' ? '已下载' : status === 'update' ? '有新版本' : '下载');
        dl.type = 'button';
        if (status === 'installed') dl.disabled = true;
        if (status === 'update') dl.classList.add('so-fixhub-update');
        btns.append(pv, dl);
        item.appendChild(btns);
        if (open) item.appendChild(mk('pre', 'so-fixhub-prompt', e.prompt));
        if (ctx.pending === e.id) {
            const localName = (ctx.installed[e.id] && ctx.installed[e.id].name) || e.name;
            const row = mk('div', 'so-fixhub-confirm');
            row.appendChild(mk('span', 'so-fixhub-confirm-q', '这个模板有新版本。'));
            const ow = mk('button', 'so-fixhub-btn so-fixhub-overwrite', `覆盖本地的〔${localName}〕`); ow.type = 'button';
            const cp = mk('button', 'so-fixhub-btn so-fixhub-copy', '另存一份'); cp.type = 'button';
            const cc = mk('button', 'so-fixhub-btn so-fixhub-cancel', '取消'); cc.type = 'button';
            row.append(ow, cp, cc);
            item.appendChild(row);
        }
        listEl.appendChild(item);
    }
}

// 用户自己的模板名（不含内置示例）——「已下载」按名字认领本地那份。
function fixHubLocalNames() {
    return normalizeFixTemplates(getSettings().fixTemplates).map((t) => t.name);
}

// 下载 = 存成普通 {name,prompt} 模板 + 记一笔已下载 + 选中它。脏着先问（Review Focus 1，沿用「切换」同一句）；
// 取消 = 什么都不动。新名字避让用户库 + 内置示例名（Review Focus 2：saveFixTemplate 会硬拒保留名）。
async function fixHubDownload(entry, mode) {
    if (sharedState.fixTplDirty && !(await uiConfirm('当前模板正文有未保存的改动，放弃并切换？'))) return false;
    const s = getSettings();
    const mine = fixHubLocalNames();
    const installed = fixHubPruneInstalled(s.fixHubInstalled, mine);
    const builtinNames = FIX_SAMPLE_TEMPLATES.map((t) => t.name);
    const name = (mode === 'overwrite' && installed[entry.id])
        ? installed[entry.id].name
        : fixHubLocalName(entry.name, [...mine, ...builtinNames]);
    if (!saveFixTemplate(name, entry.prompt)) return false;
    s.fixHubInstalled = { ...installed, [entry.id]: { version: entry.version, name } };   // 赋新对象，绝不原地改
    save();
    setFixCfg({ fixC_template: name });
    populateFixTemplates();
    const sel = sharedState.win && sharedState.win.querySelector('#so-fixc-template');
    const box = sharedState.win && sharedState.win.querySelector('#so-fixc-prompt');
    if (sel) sel.value = name;
    if (box) box.value = entry.prompt;
    sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = name; updateFixTplDirtyMarker();
    updateFixVerdict();
    // 名字来自广场（不可信）：显式要求 toastr 转义，不依赖 ST 的全局默认。
    if (typeof toastr !== 'undefined') toastr.success(`已下载：〔${name}〕`, '', { escapeHtml: true });
    return true;
}

function buildFixHubCard() {
    let el = sharedState.win.querySelector('#so-fixhub');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-fixhub';
    el.innerHTML =
        '<div id="so-fixhub-card">' +
        '<div id="so-fixhub-head"><span class="so-warn-title">🌐 模板广场</span>' +
        '<span class="so-fixhub-headbtns"><div class="so-iconbtn" id="so-fixhub-refresh" title="刷新"><i class="fa-solid fa-rotate-right"></i></div>' +
        '<div class="so-iconbtn so-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></span></div>' +
        '<input id="so-fixhub-search" type="search" placeholder="搜索名字 / 作者 / 说明……">' +
        '<div id="so-fixhub-tags"></div>' +
        '<div id="so-fixhub-status" class="so-hint"></div>' +
        '<div id="so-fixhub-list"></div>' +
        '<div id="so-fixhub-foot" class="so-hint"></div>' +
        '</div>';
    sharedState.win.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeFixHub(); });   // 点遮罩关闭
    el.querySelector('.so-warn-x').addEventListener('click', closeFixHub);
    el.querySelector('#so-fixhub-refresh').addEventListener('click', () => fixHubRefresh(true));
    el.querySelector('#so-fixhub-search').addEventListener('input', (e) => { sharedState.fixHubState.q = e.target.value; fixHubRender(); });
    el.querySelector('#so-fixhub-tags').addEventListener('click', (e) => {
        const chip = e.target.closest('.so-fixhub-chip');
        if (!chip) return;
        sharedState.fixHubState.tag = chip.dataset.tag || '';
        fixHubRender();
    });
    el.querySelector('#so-fixhub-list').addEventListener('click', async (e) => {
        const item = e.target.closest('.so-fixhub-item');
        if (!item || !sharedState.fixHubState.lib) return;
        const entry = sharedState.fixHubState.lib.templates.find((t) => t.id === item.dataset.id);
        if (!entry) return;
        if (e.target.closest('.so-fixhub-preview')) {
            if (sharedState.fixHubState.open.has(entry.id)) sharedState.fixHubState.open.delete(entry.id); else sharedState.fixHubState.open.add(entry.id);
        } else if (e.target.closest('.so-fixhub-dl')) {
            const st = fixHubInstallStatus(entry, getSettings().fixHubInstalled || {}, fixHubLocalNames());
            if (st === 'update') sharedState.fixHubState.pending = entry.id;
            else if (st === 'none') await fixHubDownload(entry, 'new');
        } else if (e.target.closest('.so-fixhub-overwrite')) {
            sharedState.fixHubState.pending = '';
            await fixHubDownload(entry, 'overwrite');
        } else if (e.target.closest('.so-fixhub-copy')) {
            sharedState.fixHubState.pending = '';
            await fixHubDownload(entry, 'copy');
        } else if (e.target.closest('.so-fixhub-cancel')) {
            sharedState.fixHubState.pending = '';
        } else return;
        fixHubRender();
    });
    return el;
}

// 按 fixHubState 重画标签条 / 列表 / 状态行 / 页脚。本地那份被改名或删掉的已下载记录在这里剪掉并落盘（spec §3.6）。
function fixHubRender() {
    const el = sharedState.win && sharedState.win.querySelector('#so-fixhub');
    if (!el) return;
    const statusEl = el.querySelector('#so-fixhub-status');
    const listEl = el.querySelector('#so-fixhub-list');
    const tagsEl = el.querySelector('#so-fixhub-tags');
    const footEl = el.querySelector('#so-fixhub-foot');
    const libNow = sharedState.fixHubState.lib;
    tagsEl.textContent = '';
    if (!libNow) { listEl.textContent = ''; footEl.textContent = ''; return; }
    if (sharedState.fixHubState.tag && !libNow.tags.includes(sharedState.fixHubState.tag)) sharedState.fixHubState.tag = '';   // 标签被 Prince 撤掉了 → 回「全部」
    for (const t of ['', ...libNow.tags]) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'so-fixhub-chip' + (sharedState.fixHubState.tag === t ? ' so-on' : '');
        chip.dataset.tag = t;
        chip.textContent = t || '全部';
        tagsEl.appendChild(chip);
    }
    const s = getSettings();
    const localNames = fixHubLocalNames();
    const installed = fixHubPruneInstalled(s.fixHubInstalled, localNames);
    if (Object.keys(installed).length !== Object.keys(s.fixHubInstalled || {}).length) { s.fixHubInstalled = installed; save(); }
    fixHubRenderList(listEl, fixHubFilter(libNow.templates, { tag: sharedState.fixHubState.tag, q: sharedState.fixHubState.q }), {
        installed, localNames, open: sharedState.fixHubState.open, pending: sharedState.fixHubState.pending,
    });
    statusEl.textContent = sharedState.fixHubState.source === 'cache' ? `离线副本 · 更新于 ${fixHubMmDd(sharedState.fixHubState.fetchedAt)}` : '';
    // 页脚「更新于」= 广场本身最后一次发布（generatedAt）；解析不了（含 1970 的空仓占位）才退回拉取时刻。
    const gen = Date.parse(libNow.generatedAt);
    footEl.textContent = `共 ${libNow.templates.length} 个模板 · 更新于 ${fixHubMmDd(gen > 0 ? gen : sharedState.fixHubState.fetchedAt)}`;
}

async function fixHubRefresh(force) {
    const el = sharedState.win && sharedState.win.querySelector('#so-fixhub');
    if (!el) return;
    const r = await fixHubLoadLibrary({ force });
    const statusEl = el.querySelector('#so-fixhub-status');
    if (!r.ok) {
        el.querySelector('#so-fixhub-list').textContent = '';
        el.querySelector('#so-fixhub-tags').textContent = '';
        el.querySelector('#so-fixhub-foot').textContent = '';
        statusEl.textContent = r.reason === 'schema' ? '模板广场格式已更新，请先更新剧情推进' : '广场暂时连不上';
        if (r.reason === 'unreachable') {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'so-fixhub-btn';
            retry.textContent = '重试';
            retry.addEventListener('click', () => fixHubRefresh(true));
            statusEl.appendChild(document.createTextNode(' '));
            statusEl.appendChild(retry);
        }
        return;
    }
    fixHubRender();
}

export function openFixHub() {
    if (!ENABLE_FIX_TEMPLATE_HUB || !sharedState.win) return;
    const el = buildFixHubCard();
    el.classList.add('open');
    // 先用缓存秒开，再联网刷新（spec §4.1 第 1 条）。
    if (!sharedState.fixHubState.lib) {
        const cached = fixHubCacheRead();
        const parsed = cached ? fixHubParseLibrary(cached.body) : null;
        if (parsed && parsed.ok) Object.assign(sharedState.fixHubState, { lib: parsed.lib, source: 'cache', fetchedAt: cached.fetchedAt });
    }
    fixHubRender();
    fixHubRefresh(true);
}

function closeFixHub() {
    const el = sharedState.win && sharedState.win.querySelector('#so-fixhub');
    if (el) el.classList.remove('open');
    sharedState.fixHubState.pending = '';
}

/* ------------------------------------------------------------------ *
 * 📤 分享（1.86.0）——表单 / 复制分享文本（发到 Discord）。2026-09-29 起只剩复制：「提交分享」（经 Worker
 * 往 GitHub 开 Issue）已移除，见 docs/agent/removed/fix-hub-submit/README.md。复制纯本地、不联网、不受
 * ENABLE_FIX_TEMPLATE_HUB 管；旗开时开卡会顺带读广场（现行标签表 + 「更新」下拉），旗关只用内置标签表。
 * ------------------------------------------------------------------ */
const FIX_HUB_AUTHOR_KEY = 'so-fixhub-author-v1';
const FIX_HUB_TAGS_FALLBACK = ['去AI味', '润色文风', '翻译', '格式整理', '视角人称', '扩写补写', '精简', '其他'];
sharedState.fixShareOpenSeq = 0;   // 每次开卡 +1：开卡时的异步拉取回来晚了（卡已关 / 已重开）就不再往卡上写

// '' = 可以分享；否则 = 为什么不行（点 📤 时以 toast 说明）。
function fixHubShareBlockedReason(name, s, dirty) {
    if (!name) return '先选一份自己的模板';
    if (fixTemplateIsBuiltin(name)) return '内置示例不能分享，先另存为自己的模板';
    const t = normalizeFixTemplates(s && s.fixTemplates).find((x) => x.name === name);
    if (!t) return '先选一份自己的模板';
    // 脏着先说「先保存」：刚新建、正文正写在框里时，已存的那份还是空的——说「正文是空的」是错话。
    if (dirty) return '先保存模板，再分享';
    if (!t.prompt.trim()) return '模板正文是空的，先写点内容';
    return '';
}

function fixHubShareText(value) {
    return '把这段发到神谕 Discord 的模板分享频道\n' + fixHubBuildShareBlock(value);
}

function fixHubShareCollect(el, tags, knownIds) {
    const val = (id) => el.querySelector(id).value;
    const chosen = [...el.querySelectorAll('#so-fixshare-tags .so-fixhub-chip.so-on')].map((c) => c.dataset.tag);
    const isUpd = el.querySelector('#so-fixshare-isupdate').checked;
    return fixHubValidateSubmission({
        name: val('#so-fixshare-name'), prompt: val('#so-fixshare-prompt'), author: val('#so-fixshare-author'),
        description: val('#so-fixshare-desc'), tags: chosen, model: val('#so-fixshare-model'),
        updateOf: isUpd ? val('#so-fixshare-updateof') : null, client: SO_VERSION,
    }, tags, knownIds);
}

function fixHubShowErrors(el, lines) {
    const box = el.querySelector('#so-fixshare-errors');
    box.textContent = lines.join('\n');
    box.hidden = !lines.length;
    // 报错行在滚动体最底下（公开须知之后）：窗口矮时不滚过去就看不见原因。没有 scrollIntoView（jsdom 等）就跳过。
    if (lines.length && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
}

function fixHubShareErrorLines(errors) {
    return [...new Set(errors.map((x) => fixHubFieldMessage(x.field, x.code)))];
}

// 复制前的整表检查：勾了「更新」却没选条目 → 拦下（不复制）；否则走提交规则（与仓库 lib 同一张夹具表）。
// 返回 { ok:true, value } | { ok:false, lines }（lines = 行内报错文案）。
function fixHubShareCheck(el) {
    if (el.querySelector('#so-fixshare-isupdate').checked && !el.querySelector('#so-fixshare-updateof').value) {
        return { ok: false, lines: ['选择要更新的模板'] };
    }
    const r = fixHubShareCollect(el, el._soTags, el._soKnown);
    return r.ok ? r : { ok: false, lines: fixHubShareErrorLines(r.errors) };
}

async function fixHubCopy(el, value) {
    const text = fixHubShareText(value);
    try {
        await navigator.clipboard.writeText(text);   // 非安全上下文（局域网 http）里 clipboard 不存在 → 抛 → 走兜底
        if (typeof toastr !== 'undefined') toastr.success('已复制——发到神谕 Discord 的模板分享频道就行');
    } catch (e) {
        const box = el.querySelector('#so-fixshare-copybox');
        box.hidden = false;
        box.value = text;
        box.focus();
        box.select();
        fixHubShowErrors(el, ['自动复制失败，请手动全选复制']);
    }
}

// 标签 chips（重画时保留已选中的同名标签——开卡先用内置表，广场拉回来再换成现行表）。
function fixHubShareRenderTags(el, tags) {
    const tagsEl = el.querySelector('#so-fixshare-tags');
    const picked = new Set([...tagsEl.querySelectorAll('.so-fixhub-chip.so-on')].map((c) => c.dataset.tag));
    tagsEl.textContent = '';
    for (const t of tags) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'so-fixhub-chip' + (picked.has(t) ? ' so-on' : '');
        chip.dataset.tag = t;
        chip.textContent = t;
        tagsEl.appendChild(chip);
    }
}

// 「这是对已分享模板的更新」：广场可用且非空才显示；下拉项 = 广场条目（名字经 textContent）。
function fixHubShareRenderUpdate(el, libNow) {
    const upd = el.querySelector('#so-fixshare-updateof');
    const box = el.querySelector('#so-fixshare-isupdate');
    upd.textContent = '';
    box.checked = false;
    upd.hidden = true;
    el.querySelector('#so-fixshare-isupdate-row').hidden = !libNow || !libNow.templates.length;
    if (!libNow) return;
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '选择要更新的模板';
    upd.appendChild(ph);
    for (const t of libNow.templates) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name}（${t.id}）`;
        upd.appendChild(opt);
    }
}

function buildFixShareCard() {
    let el = sharedState.win.querySelector('#so-fixshare');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-fixshare';
    el.innerHTML =
        '<div id="so-fixshare-card">' +
        '<div id="so-fixshare-head"><span class="so-warn-title">📤 分享模板</span><div class="so-iconbtn so-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>' +
        '<div id="so-fixshare-body">' +
        '<label class="so-fixshare-label">模板名字<input id="so-fixshare-name" type="text"></label>' +
        '<label class="so-fixshare-label">模板正文（只读预览）<textarea id="so-fixshare-prompt" rows="5" readonly></textarea></label>' +
        '<label class="so-fixshare-label">作者（可不填）<input id="so-fixshare-author" type="text"></label>' +
        '<label class="so-fixshare-label">一句话说明<input id="so-fixshare-desc" type="text"></label>' +
        '<div class="so-fixshare-label">标签（1–3 个）</div><div id="so-fixshare-tags"></div>' +
        '<label class="so-fixshare-label">测试过的模型<input id="so-fixshare-model" type="text"></label>' +
        '<label class="so-check so-lb-check" id="so-fixshare-isupdate-row"><input id="so-fixshare-isupdate" type="checkbox"><span>这是对已分享模板的更新</span></label>' +
        '<select id="so-fixshare-updateof" hidden></select>' +
        '<div class="so-hint">点「复制分享文本」，把复制到的内容发到神谕 Discord 的模板分享频道。分享出去的模板是公开的，任何人都能拿去用。</div>' +
        '<div id="so-fixshare-errors" class="so-hint so-fixshare-errors" hidden></div>' +
        '<textarea id="so-fixshare-copybox" rows="4" readonly hidden></textarea>' +
        '</div>' +
        '<div id="so-fixshare-btns">' +
        '<button type="button" id="so-fixshare-copy" class="so-fixhub-btn so-fixshare-go">复制分享文本</button>' +
        '</div></div>';
    sharedState.win.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el) closeFixShare(); });   // 点遮罩关闭
    el.querySelector('.so-warn-x').addEventListener('click', closeFixShare);
    el.querySelector('#so-fixshare-tags').addEventListener('click', (e) => {
        const chip = e.target.closest('.so-fixhub-chip');
        if (chip) chip.classList.toggle('so-on');
    });
    el.querySelector('#so-fixshare-isupdate').addEventListener('change', (e) => { el.querySelector('#so-fixshare-updateof').hidden = !e.target.checked; });
    el.querySelector('#so-fixshare-author').addEventListener('change', (e) => { try { localStorage.setItem(FIX_HUB_AUTHOR_KEY, e.target.value); } catch (err) { /* 不记也行 */ } });
    el.querySelector('#so-fixshare-copy').addEventListener('click', async () => {
        const r = fixHubShareCheck(el);
        if (!r.ok) { fixHubShowErrors(el, r.lines); return; }
        fixHubShowErrors(el, []);
        await fixHubCopy(el, r.value);
    });
    return el;
}

// 开卡：不可分享 → toast 说明原因、不开；可分享 → 立刻用内置标签表开卡（不等网络），广场拉回来后换成现行
// 标签表 + 填「更新」下拉；拉不到（旗关 = 从不联网；或无缓存）→ 保留内置表、隐藏「更新」勾选。
export async function openFixShare() {
    if (!sharedState.win) return;
    const s = getSettings();
    const name = (sharedState.win.querySelector('#so-fixc-template') || {}).value || '';
    const blocked = fixHubShareBlockedReason(name, s, sharedState.fixTplDirty);
    if (blocked) { if (typeof toastr !== 'undefined') toastr.info(blocked); return; }
    const tpl = normalizeFixTemplates(s.fixTemplates).find((t) => t.name === name);
    const el = buildFixShareCard();
    const seq = ++sharedState.fixShareOpenSeq;
    el.querySelector('#so-fixshare-name').value = tpl.name;
    el.querySelector('#so-fixshare-prompt').value = tpl.prompt;
    let author = '';
    try { author = localStorage.getItem(FIX_HUB_AUTHOR_KEY) || ''; } catch (e) { author = ''; }
    el.querySelector('#so-fixshare-author').value = author;
    el.querySelector('#so-fixshare-desc').value = '';
    el.querySelector('#so-fixshare-model').value = '';
    el.querySelector('#so-fixshare-copybox').hidden = true;
    fixHubShowErrors(el, []);
    el.querySelector('#so-fixshare-tags').textContent = '';
    el._soTags = FIX_HUB_TAGS_FALLBACK;
    el._soKnown = null;
    fixHubShareRenderTags(el, el._soTags);
    fixHubShareRenderUpdate(el, null);
    el.classList.add('open');
    // 广场：先认内存 / 缓存（与广场卡同一份状态），都没有才联网。
    if (!sharedState.fixHubState.lib) {
        const cached = fixHubCacheRead();
        const parsed = cached ? fixHubParseLibrary(cached.body) : null;
        if (parsed && parsed.ok) Object.assign(sharedState.fixHubState, { lib: parsed.lib, source: 'cache', fetchedAt: cached.fetchedAt });
    }
    const r = await fixHubLoadLibrary({ force: false });
    if (seq !== sharedState.fixShareOpenSeq || !el.classList.contains('open')) return;
    const libNow = r.ok ? r.lib : null;
    el._soTags = libNow && libNow.tags.length ? libNow.tags : FIX_HUB_TAGS_FALLBACK;
    el._soKnown = libNow ? libNow.templates.map((t) => t.id) : null;
    fixHubShareRenderTags(el, el._soTags);
    fixHubShareRenderUpdate(el, libNow);
}

function closeFixShare() {
    sharedState.fixShareOpenSeq += 1;
    const el = sharedState.win && sharedState.win.querySelector('#so-fixshare');
    if (el) el.classList.remove('open');
}

// ✨ 自动校正提示词选择器（纯映射，设计 §4）：把归一后的 {promptVersion, promptFlavor} 映射到具体系统提示常量。
//   version !== 'thorough' → 轻校 = FIX_SYSTEM_PROMPT_TIGHTEN（今天的现行提示，默认，byte 不变）
//   thorough + flavor==='opus'   → FIX_PROMPT_JINGXIAO_OPUS（对「数据包腔」强攻，适合 Claude / Opus）
//   thorough + flavor==='gemini' → FIX_PROMPT_JINGXIAO_DEEPSEEK【暂用】——Gemini 经诊断（2026-07-01）属 DeepSeek 类：
//       它自己就清数据包，而 Opus 强攻 clause 反而把它的正式对白过校正（死谏 −25）。将来若做专属
//       FIX_PROMPT_JINGXIAO_GEMINI，只改这一行的返回值即可（UI / 设置的 gemini 侧重已就位）。
//   thorough + 其它 / 缺省       → FIX_PROMPT_JINGXIAO_DEEPSEEK（克制版，适合 DeepSeek / 国产模型）
// 只有精确的 'thorough' 才是精校；null / '' / 未知一律回落轻校（迁移安全）。cfg 缺失也回落轻校，不抛。
// 二创版 2.0：三份都在提示词注册表里可改。精校的「DeepSeek / Gemini 侧重」那一条沿用原版旧键 fixThoroughSystemPrompt——
// 原版语义是「一份覆盖两种侧重都用」，所以 Opus 侧重自己没改过、而 DeepSeek 那条改过时，Opus 也用改过的那份。
export function resolveFixAutoPrompt(cfg, s) {
    const c = cfg || {};
    const st = s || getSettings();
    if (c.promptVersion !== 'thorough') return P('fix.light', null, st);
    if (c.promptFlavor === 'opus' && (promptIsCustom('fix.thoroughOpus', st) || !promptIsCustom('fix.thorough', st))) {
        return P('fix.thoroughOpus', null, st);
    }
    return P('fix.thorough', null, st);   // DeepSeek；Gemini 暂用同一份（← seam：将来换成专属一条）
}

// 读本聊天保存的校正覆盖（始终回对象，可能为空 {}）。喂给 getEffectiveFixCfg 当 md。
export function getFixCfg() {
    const md = getChatMetadataSafe();
    return (md && md[FIX_CFG_META_KEY]) || {};
}

// 把 patch 合并进本聊天的校正覆盖并写回。合并后为空 = 删键（保持元数据干净，同 setDiagWiMeta）。
// 只存被覆盖的 fix* 键——读取时 getEffectiveFixCfg 现场回退全局默认，故无需在此存全量。
export function setFixCfg(patch) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const cur = (md[FIX_CFG_META_KEY] && typeof md[FIX_CFG_META_KEY] === 'object') ? md[FIX_CFG_META_KEY] : {};
    const merged = { ...cur, ...(patch || {}) };
    if (Object.keys(merged).length) md[FIX_CFG_META_KEY] = merged;
    else delete md[FIX_CFG_META_KEY];
    saveChatMetadata();
    return true;
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：全局命名套餐库（save / load / delete）。
 * 套餐存全局设置（getSettings().fixBundles，跨聊天可用）；加载时把套餐里的配置写进【本聊天】
 * 的 per-chat 覆盖（setFixCfg）。快照只取 FIX_CFG_KEYS 的生效值（getEffectiveFixCfg 合并后），
 * 故套餐里永远是「当前用户实际看到的那套配置」，与 per-chat 覆盖机制一致。
 * ------------------------------------------------------------------ */
// 把【当前生效】校正配置快照成一个具名套餐，存进全局 fixBundles（同名则替换）。name 必填、去空白。
// Phase 5 RESOLUTION C：快照经 filterBundleCfg 过滤——此前这里直接存全量 FIX_CFG_KEYS，filterBundleCfg
// 定义了却没人调用（死代码），套餐因此会带着上一张卡的 fixA_scopeTag / fixA_scopeManual 泄漏到下一张卡上。
// 只影响【新存】的套餐；已存的旧套餐不受影响，除非用户重新保存。
export function saveFixBundle(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    const eff = getEffectiveFixCfg(getSettings(), getFixCfg());
    const cfg = {};
    for (const k of FIX_CFG_KEYS) cfg[k] = eff[k];
    const snapshot = filterBundleCfg(cfg);   // 剔除卡片专属（scopeTag/scopeManual）+ 模式开关（autoFixEnabled）
    const s = getSettings();
    if (!Array.isArray(s.fixBundles)) s.fixBundles = [];
    const idx = s.fixBundles.findIndex((b) => b && b.name === trimmed);
    if (idx >= 0) s.fixBundles[idx] = { name: trimmed, cfg: snapshot };
    else s.fixBundles.push({ name: trimmed, cfg: snapshot });
    save();
    return true;
}

// 📋 「模板不存在 / 正文为空」的侧聊记录【每聊天每模板只留一条】的记忆。runCustomTask 这条路每来一条
// 新回复都会走一遍——无条件写会把侧聊无界刷爆（评审 owed A2）。键 = 聊天身份 + 模板名，故换聊天 /
// 换模板自然各提醒一次；保存同名模板时清掉（fixNoTemplateForget），补完正文若仍为空要再提醒。
export const fixNoTemplateNoted = new Map();

// 纯函数（唯一副作用是改【传进来的】map）：这一次该不该写记录。第一次见 (chatKey, name) → true 并记下，
// 之后恒 false。map 缺失 / 不是 Map → true（宁可多写一条，也不静默吞掉用户唯一的线索）。
export function fixNoTemplateShouldNote(map, chatKey, name) {
    if (!map || typeof map.has !== 'function') return true;
    const key = String(chatKey == null ? '' : chatKey) + '::' + String(name == null ? '' : name);
    if (map.has(key)) return false;
    map.set(key, true);
    return true;
}

// 纯函数（同上）：忘掉某个模板名在【所有聊天】里的记忆——名字进了键的后半段，故按后缀清一族。
function fixNoTemplateForget(map, name) {
    if (!map || typeof map.keys !== 'function') return;
    const suffix = '::' + String(name == null ? '' : name);
    for (const key of [...map.keys()]) if (key.endsWith(suffix)) map.delete(key);
}

// 📋 全局模板库（仿套餐）：存 / 删；名字 trim、同名覆盖。读取一律经 normalizeFixTemplates。
// 恒【赋新数组】给 s.fixTemplates，绝不 push 进原数组——getSettings 的 defaults 是按引用赋的，
// 往原数组里 push 会污染 defaults 常量（下一个空设置对象会带着上一位用户的模板出生）。
export function saveFixTemplate(name, prompt) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    // 内置示例的名字是【保留名】：造得出同名，findFixTemplate 的兜底就够不着示例、下拉里也两条同名。
    // 硬拒在这一层（唯一的写入口），面板不必各自设防。
    if (fixTemplateIsBuiltin(trimmed)) {
        if (typeof toastr !== 'undefined') toastr.info('这是内置示例的名字，换一个');
        return false;
    }
    const s = getSettings();
    const list = normalizeFixTemplates(s.fixTemplates).filter((t) => t.name !== trimmed);
    list.push({ name: trimmed, prompt: String(prompt == null ? '' : prompt) });
    s.fixTemplates = list;
    save();
    fixNoTemplateForget(fixNoTemplateNoted, trimmed);   // 正文改了 → 下一条回复若仍为空，值得再提醒一次
    return true;
}
export function deleteFixTemplate(name) {
    const s = getSettings();
    const before = normalizeFixTemplates(s.fixTemplates);
    const after = before.filter((t) => t.name !== name);
    if (after.length === before.length) return false;
    s.fixTemplates = after;
    save();
    return true;
}

// 把某个具名套餐加载进【本聊天】的校正覆盖（setFixCfg）并回填控件（loadFixCfgForChat）。
export function loadFixBundle(name) {
    const s = getSettings();
    const bundle = (Array.isArray(s.fixBundles) ? s.fixBundles : []).find((b) => b && b.name === name);
    if (!bundle || !bundle.cfg) return false;
    // P6（红队核实）：filterBundleCfg 此前只在【保存】时跑——1.17.0–1.17.15 存的旧套餐仍带着上一张卡的
    // fixA_scopeTag / scopeManual，加载时会泄漏到当前卡。加载侧也过滤（新键 pieceMode/pieceAsked 一并挡住）。
    setFixCfg(filterBundleCfg(bundle.cfg));
    loadFixCfgForChat();     // 重新种子校正控件，UI 立刻反映
    // 📋 自定义模板任务：套餐会把本聊天整个切到模板任务——这是【看不见】的行为变化（面板可能还停在自动视图），
    // 故明说一句；套餐点名的模板本机不存在时降级成警告（spec §3「加载的套餐点名的模板本机不存在 → toast 提醒」）。
    if (ENABLE_FIX_CUSTOM_TASK && bundle.cfg.fixA_task === 'custom' && typeof toastr !== 'undefined') {
        const tplName = typeof bundle.cfg.fixC_template === 'string' ? bundle.cfg.fixC_template : '';
        if (findFixTemplate(getSettings(), tplName)) toastr.info('套餐已把本聊天切到模板任务〔' + tplName + '〕');
        else toastr.warning('套餐指定的模板〔' + tplName + '〕本机不存在——到「校正设置 → 自定义」里新建同名模板，或换回校正');
    }
    return true;
}

// 从全局 fixBundles 删除一个具名套餐。
export function deleteFixBundle(name) {
    const s = getSettings();
    if (!Array.isArray(s.fixBundles)) return false;
    const before = s.fixBundles.length;
    s.fixBundles = s.fixBundles.filter((b) => !(b && b.name === name));
    if (s.fixBundles.length === before) return false;
    save();
    return true;
}

// 纯函数：选中的条目里是否含至少一条 [mvu_update] 变量规则条目（按 comment 匹配，复用 MVU_UPDATE_TAG）。
// WYSIWYG 提醒用：精选模式下一条规则都没选时，诊断可能不准。entries = 选中条目对象数组。
export function diagSelHasRules(entries) {
    return (Array.isArray(entries) ? entries : []).some((e) => e && MVU_UPDATE_TAG.test(e.comment || ''));
}


// 纯函数：ST 扫描结果 allActivatedEntries（Set<entry> 或数组）-> { 书名: Set<uid> }。
// 只含当前【真正被激活】的条目（常驻蓝灯 + 命中关键词的绿灯）；筛绿灯交给调用方。
export function activeUidsFromScan(activated) {
    const out = {};
    const list = activated instanceof Set ? [...activated] : (Array.isArray(activated) ? activated : []);
    for (const e of list) {
        if (!e || e.world == null || e.uid == null) continue;
        if (!out[e.world]) out[e.world] = new Set();
        out[e.world].add(Number(e.uid));
    }
    return out;
}

// 纯函数：把混合模式要追加的 uid（extra）并入精选选择（base）。二者均为 { 书名: Set<uid> }；
// 返回新并集，不改入参。
export function mergeHybridUids(base, extra) {
    const out = {};
    for (const [book, set] of Object.entries(base || {})) out[book] = new Set(set);
    for (const [book, set] of Object.entries(extra || {})) {
        if (!out[book]) out[book] = new Set();
        for (const u of set) out[book].add(u);
    }
    return out;
}

// Non-system message count of the MAIN chat — used to derive "messages since
// adoption" without keeping a counter in sync.
export function chatMsgCount() {
    try {
        return (getCtx().chat || []).filter((m) => m && !m.is_system).length;
    } catch (e) { return 0; }
}

// 剧情脉络（2.5.0）的注入文本。节奏行 = 当前推进速度那一句（inject.speed.*）套进 inject.paceLine。
export function pathSpeedKey(path) {
    return (path && ADVISOR_SPEEDS[path.speed]) ? path.speed : 'normal';
}
function speedPaceLine(speed, s) {
    const k = ADVISOR_SPEEDS[speed] ? speed : 'normal';
    return P('inject.paceLine', { pace: P('inject.speed.' + k, null, s) }, s);
}
export function pathIsMulti(path) {
    return !!path && path.nodes.length > 1;
}
export function pathActiveNode(path) {
    const n = path && path.nodes && path.nodes[path.cursor];
    return (n && n.status === 'active') ? n : null;
}
export function pathProgressLabel(path) {
    return `节点 ${path.cursor + 1}/${path.nodes.length}`;
}
export function pathNodeNeedsDetail(node) {
    return !!node && !String(node.detail || '').trim();
}
// 节点的目标文字：有详细用详细；还没写（「到了再写」在等参谋，或参谋没给）就退回节点名 + 关键词。
export function nodeTargetText(node) {
    const d = String(node.detail || '').trim();
    if (d) return d;
    const kw = String(node.keywords || '').trim();
    return kw ? `${node.name}——${kw}` : String(node.name || '');
}

// 主聊天实际收到的整段：「剧情导向」外壳（inject.path）里依次是 整体目标 / 已完成（只给节点名）/
// 当前目标（详细）/ 后续（节点名 + 关键词）/ 节奏。单节点只有目标和节奏。注入与方案条「查看注入内容」共用，所见即所注。
export function pathInjectionText(path, s = getSettings()) {
    const node = pathActiveNode(path);
    if (!node) return '';
    const multi = pathIsMulti(path);
    const done = multi ? path.nodes.filter((n) => n.status === 'done').map((n) => n.name).join('、') : '';
    const later = multi ? path.nodes.filter((n, i) => i > path.cursor && n.status === 'pending')
        .map((n) => (n.keywords ? `${n.name}——${n.keywords}` : n.name)).join('；') : '';
    const current = P('inject.current', {
        label: multi ? `${pathProgressLabel(path)} · ${node.name}` : '',
        detail: nodeTargetText(node),
    }, s);
    let text = P('inject.path', {
        overall: multi ? String(path.overall || '').trim() : '', done, current, later,
        pace: speedPaceLine(pathSpeedKey(path), s),
    }, s);
    try { text = getCtx().substituteParams(text); } catch (e) { /* 原样 */ }
    return text;
}

// 1.3.1：剧情导向只在【主聊天生成】拼提示词的那一段挂上——GENERATION_STARTED（正文类生成）挂上，
// GENERATE_AFTER_DATA（提示词已拼完：世界书扫描、贴合注入都在这之前做完）撤下，中止 / 结束也撤。平时不挂：
// 酒馆助手的 generate（MVU 额外模型解析、「重新处理变量」按钮）拼请求时直接读全部已登记的扩展注入，又不触发
// GENERATION_STARTED——常驻登记会被它们一并带走（副模型看到剧情导向就去勾别的插件留下的「本拍已落」，云端实证 2026-10-25）。
const GUIDE_GEN_TYPES = ['normal', 'regenerate', 'swipe', 'continue'];
sharedState.soGuideText = '';       // 当前该注入的整段（applyPlanInjection 算好放这里）
sharedState.soGuideArmed = false;   // 正处在主聊天拼提示词的那一段

function registerGuideSlot(text) {
    const ctx = getCtx();
    if (typeof ctx.setExtensionPrompt !== 'function') return false;
    const s = getSettings();
    const pos = (ctx.extension_prompt_types && ctx.extension_prompt_types.IN_CHAT != null)
        ? ctx.extension_prompt_types.IN_CHAT : 1;                    // IN_CHAT
    const role = (ctx.extension_prompt_roles && ctx.extension_prompt_roles.SYSTEM != null)
        ? ctx.extension_prompt_roles.SYSTEM : 0;                     // SYSTEM
    const depth = Number.isFinite(s.advisorDepth) ? Math.max(0, s.advisorDepth) : 4;
    try {
        // 🧭 1.85.2：scan=true（第 5 参）——引导文本里点名的 NPC/地点关键词要能扫进世界书触发绿灯
        // 条目，否则模型只能瞎编人设（ST 只把 extensionPrompts[key].scan 为真的槽塞进 WI 扫描缓冲，见 checkWorldInfo）。
        ctx.setExtensionPrompt(ADVISOR_PROMPT_KEY, text, pos, depth, true, role);
        return true;
    } catch (e) {
        console.warn('[Story Oracle] setExtensionPrompt failed:', e);
        return false;
    }
}
// GENERATION_STARTED(type, params, dryRun)：只认正文类生成（quiet / impersonate 等一律不挂）。空跑（算 token、
// 预览提示词）也挂——它同样会发 GENERATE_AFTER_DATA，随即撤下。
export function armGuide(type) {
    if (!GUIDE_GEN_TYPES.includes(type || 'normal')) return;
    sharedState.soGuideArmed = true;
    registerGuideSlot(sharedState.soGuideText);
}
export function disarmGuide() {
    if (!sharedState.soGuideArmed) return;
    sharedState.soGuideArmed = false;
    registerGuideSlot('');
}

// 按当前聊天的剧情脉络算出该注入的整段，存进 soGuideText。窗口外只把槽清空（顺带清掉旧版本留下的常驻登记）；
// 窗口内（生成途中改了计划）立即换成新文本。返回 false 仅当这个酒馆版本没有 setExtensionPrompt。
export function applyPlanInjection() {
    const ctx = getCtx();
    if (typeof ctx.setExtensionPrompt !== 'function') return false;
    // 同一时间只有当前节点在引导主聊天；暂停、没有当前节点（元数据被外力弄脏）都注入空串。
    const path = getPath();
    const text = (path && !path.paused) ? pathInjectionText(path) : '';
    sharedState.soGuideText = text;
    return registerGuideSlot(sharedState.soGuideArmed ? text : '');
}


/* ------------------------------------------------------------------ *
 * 贴合注入（inject glue）—— 纯函数层。spec docs/superpowers/specs/2026-09-02-inject-glue-design.md §5–6。
 * 输入不改；返回 { chat: 新数组 | null, reason }。null = 不动出站提示词（今日字节）。
 * ------------------------------------------------------------------ */
const GLUE_SEP = '\n\n';

// 在 system 条里定位一段槽文本：整条相等（equals）或作为被 \n 包夹的整块（block，ST 把同 depth
// 同角色的扩展提示词用单个 \n 拼成一条）。返回 {index, mode} / null（0 命中）/ 'dup'（≥2 命中）。
function glueFindSlot(chat, text) {
    let hit = null, count = 0;
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.role !== 'system' || typeof m.content !== 'string') continue;
        const c = m.content;
        let mode = null;
        if (c.trim() === text) mode = 'equals';
        else {
            const at = c.indexOf(text);
            if (at >= 0) {
                const end = at + text.length;
                const before = at === 0 || c[at - 1] === '\n';
                const after = end === c.length || c[end] === '\n';
                if (before && after) mode = 'block';
            }
        }
        if (mode) { count++; if (!hit) hit = { index: i, mode }; }
    }
    if (count === 0) return null;
    if (count > 1) return 'dup';
    return hit;
}

// 从拼接条里拔掉我们的块 + 它与邻块之间的那一个 \n；返回剩余文本（已去首尾 \n）。
function glueRemoveBlock(content, text) {
    const at = content.indexOf(text);
    let start = at, end = at + text.length;
    if (end < content.length && content[end] === '\n') end += 1;
    else if (start > 0 && content[start - 1] === '\n') start -= 1;
    return (content.slice(0, start) + content.slice(end)).replace(/^\n+|\n+$/g, '');
}

function glueOutgoingPrompt(chat, slots, opts) {
    if (!Array.isArray(chat) || !chat.length) return { chat: null, reason: 'no-user' };
    const directive = String((slots && slots.directive) || '').trim();
    if (!directive) return { chat: null, reason: 'empty-slots' };
    const intensity = opts && opts.intensity;
    const userName = String((opts && opts.userName) || '');
    const out = chat.map((m) => ({ ...m }));
    // 1) 定位：恰好 1 命中
    const f = glueFindSlot(out, directive);
    if (!f) return { chat: null, reason: 'slot-missing' };
    if (f === 'dup') return { chat: null, reason: 'slot-dup' };
    // 2) seed/normal 的宿主 = 我们引导槽【之前】最近的 user（在槽之前，拔槽不影响它的下标）
    let dirHost = -1;
    if (intensity !== 'push') {
        for (let i = f.index - 1; i >= 0; i--) if (out[i].role === 'user') { dirHost = i; break; }
        if (dirHost < 0) return { chat: null, reason: 'no-host' };
    }
    // 3) 拔槽
    const rest = f.mode === 'equals' ? '' : glueRemoveBlock(out[f.index].content, directive);
    if (rest) out[f.index] = { ...out[f.index], content: rest };
    else out.splice(f.index, 1);
    // 4) 玩家末条
    let lastUser = -1;
    // 按 role 找末条、不看 content 类型：带图消息被 ST 转成数组 content（openai.js ensureContentIsArray），
    // 若因此退到更早的玩家消息，引导会贴错回合且自检照样通过——故末条非字符串 = 不贴（今日字节）。
    for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'user') { lastUser = i; break; }
    if (lastUser < 0 || typeof out[lastUser].content !== 'string') return { chat: null, reason: 'no-user' };
    // 5) 贴引导
    if (intensity === 'push') {
        const u = out[lastUser];
        const prefix = userName && u.content.startsWith(userName + ': ') ? userName + ': ' : '';
        out[lastUser] = { ...u, content: prefix + directive + GLUE_SEP + u.content.slice(prefix.length) };
    } else {
        const u = out[dirHost];
        if (!u || u.role !== 'user' || typeof u.content !== 'string') return { chat: null, reason: 'no-host' };
        out[dirHost] = { ...u, content: u.content + GLUE_SEP + directive };
    }
    // 6) 自检：引导全数组恰 1 次且在 user 条
    let n = 0, inUser = 0;
    for (const m of out) {
        if (typeof m.content !== 'string') continue;
        let at = -1;
        while ((at = m.content.indexOf(directive, at + 1)) >= 0) { n++; if (m.role === 'user') inUser++; }
    }
    if (n !== 1 || inUser !== 1) return { chat: null, reason: 'selfcheck' };
    return { chat: out, reason: 'ok' };
}
// 生成类型由 GENERATION_STARTED 记下（prompt_ready 事件本身不带 type）。
export const glueGen = { type: null };
// 生成结束 / 中止即清空：prompt_ready 若被 Generate 之外的调用方触发，不得继承上一次的类型。
export function glueGenReset() {
    glueGen.type = null;
}
// 最近一次判决（只在内存，不落盘）：支持排查「上一回合贴合跑了没」。
const glueLast = { at: 0, applied: false, reason: 'never' };
function glueNote(applied, reason) {
    glueLast.at = Date.now(); glueLast.applied = applied; glueLast.reason = reason;
    return applied;
}
const GLUE_GEN_TYPES = ['normal', 'regenerate', 'swipe'];

// 外来 prompt-ready 数组（柏宝书自动总结走 generateRaw、小白X 在自家快照上重发同名事件）：类型闩仍是
// normal 时它们也会到这里。判据 = 引导文本在数组里一处都没有 → 不是我们的回合：不改读数、不打印。
function glueArrayCarriesOurs(chat, slots) {
    const text = slots.directive;
    return !!text && chat.some((m) => m && typeof m.content === 'string' && m.content.includes(text));
}

// CHAT_COMPLETION_PROMPT_READY 监听：data.chat 就是 ST 即将发出的 messages 数组（openai.js
// prepareOpenAIMessages 把它 emit 出来再原样 return），原地 splice 才生效。四道闸任一不过 = 不碰。
// 控制台读数（spec §9，开发者面、无 UI）：成功 console.debug 一行；闸都过了却
// 没贴上（slot-missing / slot-dup / no-host / no-user / selfcheck / error）console.info 一行；闸拒绝、
// empty-slots、外来数组静默。glueLast 仍是内存里的唯一记录。
export function onPromptReadyGlue(data) {
    let eligible = false;
    try {
        if (!ENABLE_INJECT_GLUE) return glueNote(false, 'flag-off');
        if (!data || !Array.isArray(data.chat)) return glueNote(false, 'no-chat');
        if (data.dryRun) return glueNote(false, 'dryrun');
        if (!GLUE_GEN_TYPES.includes(glueGen.type)) return glueNote(false, 'type:' + glueGen.type);
        const path = getPath();
        if (!path) return glueNote(false, 'construct:none');
        eligible = true;
        const ctx = getCtx();
        const reg = ctx.extensionPrompts || {};
        const norm = (v) => {
            const s = String(v || '');
            let t = s;
            try { t = ctx.substituteParams(s); } catch (e) { t = s; }
            return String(t).trim();
        };
        const slots = { directive: norm((reg[ADVISOR_PROMPT_KEY] || {}).value) };
        // 快推贴在玩家末条正文之前（最醒目，glueOutgoingPrompt 的 push 路）；慢推 / 正常贴在我们槽位之前最近的玩家消息后面。
        const r = glueOutgoingPrompt(data.chat, slots, {
            intensity: pathSpeedKey(path) === 'fast' ? 'push' : 'normal', userName: String(ctx.name1 || ''),
        });
        if (!r.chat) {
            if (r.reason === 'empty-slots') return glueNote(false, r.reason);
            if (r.reason === 'slot-missing' && !glueArrayCarriesOurs(data.chat, slots)) return false;
            console.info('[Story Oracle] 贴合注入未生效：' + r.reason);
            return glueNote(false, r.reason);
        }
        data.chat.splice(0, data.chat.length, ...r.chat);
        console.debug('[Story Oracle] 贴合注入 ok');
        return glueNote(true, 'ok');
    } catch (e) {
        console.warn('[Story Oracle] 贴合注入跳过（出站提示词未改）：', e);
        if (eligible) console.info('[Story Oracle] 贴合注入未生效：error');
        return glueNote(false, 'error');
    }
}