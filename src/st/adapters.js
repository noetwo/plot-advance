import { deserializeEntrySel, getWiCustomMeta, wiCustomChatId } from '../core/chat-metadata.js';
import { getCtx, getSettings } from '../core/settings.js';

import { ensureWiCustomSeeded, wiCustomGreens } from '../modes/diagnose/pickers.js';
import { mergeHybridUids } from '../modes/fix/templates.js';
import { collectWiCustomEntries } from '../modes/lorebook/entries.js';
import { getActiveBookNames, getActiveScanUids, getAllBookNames, getCharChatBookNames, getWiEditApi, resolveLbTargetNames } from '../modes/lorebook/world-info.js';
import { ENABLE_WI_CUSTOM_PICK, ENABLE_WI_EJS_RENDER } from '../prompts/builtins.js';
import { convo } from '../core/conversation-store.js';
import { getHostGlobal, hostFetch, importHostModule } from './host.js';

let regexEngine = null;
let worldInfoModule = null;
let scriptCore = null;
let personasModule = null;
let mvuApi = null;
export function getRegexEngine() {
    return regexEngine;
}

export function getLoadedMvu() {
    return mvuApi || getHostGlobal('Mvu') || null;
}

export async function getMvu() {
    if (mvuApi) return mvuApi;
    const globalMvu = getHostGlobal('Mvu');
    if (globalMvu) {
        mvuApi = globalMvu;
        return mvuApi;
    }
    const th = getHostGlobal('TavernHelper');
    if (th && typeof th.waitGlobalInitialized === 'function') {
        try {
            mvuApi = await Promise.race([
                th.waitGlobalInitialized('Mvu'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]);
        } catch (e) { /* fall through */ }
    }
    return mvuApi || getHostGlobal('Mvu') || null;
}

/**
 * Lazily import SillyTavern's regex engine from its served path. The absolute
 * URL resolves against ST's web root, so it works whether this extension lives
 * in the data dir or in third-party. Returns the module, or false if unavailable.
 */
export async function loadRegexEngine() {
    if (regexEngine !== null) return regexEngine;
    try {
        const mod = await importHostModule('/scripts/extensions/regex/engine.js');
        regexEngine = (mod && mod.getRegexedString && mod.regex_placement) ? mod : false;
        if (!regexEngine) console.warn('[Story Oracle] regex engine loaded but missing exports; sending raw text.');
    } catch (e) {
        console.warn('[Story Oracle] Could not load regex engine; sending raw messages.', e);
        regexEngine = false;
    }
    return regexEngine;
}

export async function loadWorldInfoModule() {
    if (worldInfoModule !== null) return worldInfoModule;
    try {
        const mod = await importHostModule('/scripts/world-info.js');
        worldInfoModule = (mod && mod.getSortedEntries) ? mod : false;
    } catch (e) {
        console.warn('[Story Oracle] Could not load world-info module.', e);
        worldInfoModule = false;
    }
    return worldInfoModule;
}

 // '/script.js' module, lazily imported (false = unavailable)
async function loadScriptCore() {
    if (scriptCore !== null) return scriptCore;
    try {
        scriptCore = await importHostModule('/script.js');
    } catch (e) {
        console.warn('[Story Oracle] Could not load /script.js for context size.', e);
        scriptCore = false;
    }
    return scriptCore;
}

/* ------------------------------------------------------------------ *
 * 角色工坊 Task 8：Persona 写入 / undo 插管（新建 / 改描述）。
 *
 * personas.js 不在 getContext() 里，只能像 world-info.js 那样动态 import；缓存一份。
 * NPC 走既有世界书管线（applyLorebookOps），Persona 侧则直接读写 power_user 两张表
 * （personas: avatarId→name、persona_descriptions: avatarId→descriptor）——
 * descriptor 是持久层，扁平字段（persona_description）是 UI/生成用缓存，两处都要写。
 * getContext() 已暴露 powerUserSettings / saveSettingsDebounced / eventSource /
 * eventTypes / getRequestHeaders（本版全部齐备，无需回退 /script.js）。
 * ------------------------------------------------------------------ */
   // '/scripts/personas.js'，惰性 import（null=未试，object=已装，null 表示失败会重试）
async function loadPersonasModule() {
    if (personasModule) return personasModule;
    try { personasModule = await importHostModule('/scripts/personas.js'); } catch (e) { personasModule = null; }
    return personasModule;
}

// 改写当前激活 Persona 的描述。两处都要写：descriptor 是持久层，扁平字段是 UI/生成用的缓存。
// 返回 { prevText, avatarId } 作为 undo 快照（撤销 = 再写回 prevText）。
export async function writeActivePersonaDesc(text) {
    const ctx = getCtx();
    const mod = await loadPersonasModule();
    if (!mod) throw new Error('personas 模块不可用');
    const pu = ctx.powerUserSettings;
    const avatarId = mod.user_avatar;
    if (!pu.persona_descriptions[avatarId]) mod.getOrCreatePersonaDescriptor?.();
    if (!pu.persona_descriptions[avatarId]) pu.persona_descriptions[avatarId] = { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' };
    const prevText = pu.persona_descriptions[avatarId].description || '';
    pu.persona_descriptions[avatarId].description = text;
    pu.persona_description = text;
    mod.setPersonaDescription();
    ctx.saveSettingsDebounced();
    try { await ctx.eventSource.emit(ctx.eventTypes.PERSONA_UPDATED || 'persona_updated', avatarId); } catch (e) { /* non-fatal */ }
    return { prevText, avatarId };
}

// 撤销专用：把描述写回快照里的那个 persona（可能已不是当前激活的）——只有它仍是
// 当前激活 persona 时才同步扁平字段（persona_description）与 UI（setPersonaDescription）。
export async function restorePersonaDesc(avatarId, text) {
    const ctx = getCtx();
    const mod = await loadPersonasModule();
    if (!mod) throw new Error('personas 模块不可用');
    const pu = ctx.powerUserSettings;
    if (!pu.persona_descriptions[avatarId]) pu.persona_descriptions[avatarId] = { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' };
    pu.persona_descriptions[avatarId].description = text;
    if (mod.user_avatar === avatarId) {
        pu.persona_description = text;
        mod.setPersonaDescription();
    }
    ctx.saveSettingsDebounced();
    try { await ctx.eventSource.emit(ctx.eventTypes.PERSONA_UPDATED || 'persona_updated', avatarId); } catch (e) { /* non-fatal */ }
}

// 是否已存在同名 Persona（名字大小写归一后比对 personas 表的值）。
export function personaNameExists(name) {
    const pu = getCtx().powerUserSettings;
    const n = String(name || '').trim().toLowerCase();
    return Object.values(pu.personas || {}).some((v) => String(v).toLowerCase() === n);
}

// 新建 Persona：initPersona 只写两张表 + 存盘（silent 默认 false → 它自己发 PERSONA_CREATED），
// 不管头像文件——默认头像要自己传一份同名副本。返回新 avatarId（undo = deletePersonaById）。
export async function createPersonaWithAvatar(name, description) {
    const ctx = getCtx();
    const mod = await loadPersonasModule();
    if (!mod) throw new Error('personas 模块不可用');
    const avatarId = `${Date.now()}-${String(name).replace(/[^a-zA-Z0-9]/g, '')}.png`;
    await mod.initPersona(avatarId, name, description, '');
    try {
        const resp = await hostFetch('img/user-default.png');
        const blob = await resp.blob();
        const fd = new FormData();
        fd.append('avatar', new File([blob], 'avatar.png', { type: 'image/png' }));
        fd.append('overwrite_name', avatarId);
        const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders({ omitContentType: true }) : {};
        await hostFetch('/api/avatars/upload', { method: 'POST', headers, body: fd });
    } catch (e) { console.warn('[Story Oracle] 默认头像上传失败（Persona 数据已写入）', e); }
    try { await mod.getUserAvatars(true, avatarId); } catch (e) { /* 列表刷新失败不致命 */ }
    return avatarId;
}

// 删除 Persona（新建的 undo）：删头像文件 + 摘掉两张表 + 存盘 + 刷新列表。
export async function deletePersonaById(avatarId) {
    const ctx = getCtx();
    const pu = ctx.powerUserSettings;
    try {
        const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
        await hostFetch('/api/avatars/delete', { method: 'POST', headers, body: JSON.stringify({ avatar: avatarId }) });
    } catch (e) { /* 文件删不掉也要把数据摘掉 */ }
    delete pu.personas[avatarId];
    delete pu.persona_descriptions[avatarId];
    ctx.saveSettingsDebounced();
    try { await ctx.eventSource.emit(ctx.eventTypes.PERSONA_DELETED || 'persona_deleted', { avatarId }); } catch (e) { /* non-fatal */ }
    const mod = await loadPersonasModule();
    try { await mod?.getUserAvatars(true); } catch (e) { /* ignore */ }
}


/*
 * The token budget the ST world-info scan gets to spend. Inside checkWorldInfo
 * the budget is `世界信息 Context% × maxContext` (capped by the budget cap), and
 * once it overflows ST silently drops every remaining entry in order-descending
 * priority — CONSTANT (blue) ENTRIES INCLUDED.
 *
 * getContext().maxContext is the *text-completion* context slider. For
 * chat-completion users (the normal case) that's a stale default (2048+) with
 * no relation to the real context size, so passing it collapses the budget and
 * the scan sheds low-order entries that the main chat keeps. Main generation
 * derives its scan budget from getMaxPromptTokens(), so we mirror that, and
 * fall back to "effectively unlimited" rather than risk starving the Oracle's
 * view of the books.
 */
export async function getWiScanBudget() {
    const ctx = getCtx();
    const sc = await loadScriptCore();
    const candidates = [
        () => (sc && typeof sc.getMaxPromptTokens === 'function') ? sc.getMaxPromptTokens() : 0,
        () => (sc && typeof sc.getMaxContextTokens === 'function') ? sc.getMaxContextTokens() : 0,
        () => (typeof ctx.getMaxContextSize === 'function') ? ctx.getMaxContextSize() : 0,
    ];
    for (const get of candidates) {
        try {
            const v = Number(get());
            if (v > 0) return v;
        } catch (e) { /* try the next source */ }
    }
    return 1048576;
}

// ==== 侧聊触发世界书绿灯（1.31.0）====
// 侧聊里的触发词也能像主聊天一样激活绿灯条目：把当前侧聊房间最近 N 条真问答（user/assistant；
// note 是系统记录、永不参与也不占窗口位）折进世界书扫描，N = ST 世界书的「扫描深度」设置
// （world_info_depth，与主聊天同一窗口语义——滑出最近 N 条即失效）。折叠走 extraScanText 老轨：
// 并进最近一格、不挤占主聊天自己的扫描窗口；带 scanDepth 覆盖的条目
// 把整段侧聊当「最新一条」看（近似）。接线点：普通聊天 / 参谋（勾了世界书时）。
function sideChatScanText(list, depth) {
    const d = Number(depth);
    if (!Number.isFinite(d) || d <= 0) return '';
    const qa = (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
    return qa.slice(-d).map((m) => m.content.trim()).join('\n');
}
// ST 世界书「扫描深度」（模块 live binding，随设置面板实时变）；模块不可用（老版本 / 测试环境）退 ST 默认 2。
async function getWiScanDepth() {
    try {
        const mod = await loadWorldInfoModule();
        if (mod && typeof mod.world_info_depth !== 'undefined') {   // mod=false（不可用）不得被 Number 吞成 0
            const v = Number(mod.world_info_depth);
            if (Number.isFinite(v) && v >= 0) return v;
        }
    } catch (e) { /* fall through to the ST default */ }
    return 2;
}
// 当前侧聊房间的折叠文本（convo 永远指向当前模式的房间流——1.28.0 每模式分房后依然成立）。
export async function sideChatScanBlob() {
    return sideChatScanText(convo, await getWiScanDepth());
}
// 把额外扫描文本折进最近一格（深度无关地一定被扫到、不挤占 world_info_depth 窗口）。'st'/'char' 扫描共用。
export function foldExtraScanText(chatForWI, extraScanText) {
    if (!(extraScanText && String(extraScanText).trim())) return;
    const inj = String(extraScanText).trim();
    if (chatForWI.length) chatForWI[0] = inj + '\n' + chatForWI[0];
    else chatForWI.push(inj);
}

/**
 * Build the world-info / lorebook block for the system prompt.
 *   'st'  -> faithful ST scan: constant (blue) entries always, keyword (green)
 *            entries only when their keys match the chat/card. Uses a dry run so
 *            it never disturbs the main chat's sticky/cooldown state.
 *   'all' -> every non-disabled entry from the active books, regardless of keys.
 * extraScanText (optional, 'st' mode only): extra text folded into the scan so
 * keyword (green) entries whose keys appear in it activate even when recent chat
 * never mentioned them. 普通 / 参谋用它折进侧聊最近问答（见 sideChatScanBlob）。
 */
// 把 worldInfoMode 设置映射成 buildWorldInfo() 的模式，供「要带世界书」的调用点用（'off' 由调用方门控）。
// 'char' = 仅角色 / 对话相关世界书（排除全局 + 人设）；'custom' = 本聊天勾选的条目（1.81.0，旗关时经归一落回 st）。
export function wiContextMode(s) {
    const m = wiEffectiveMode(s);
    return m === 'all' ? 'all' : (m === 'char' ? 'char' : (m === 'custom' ? 'custom' : 'st'));
}

// 模式字符串归一（纯）：旗关时 'custom' 一律落回 'st'——不论来自设置还是 forceMode；其余原样。
function wiNormalizeMode(mode) {
    if (mode === 'custom') return ENABLE_WI_CUSTOM_PICK ? 'custom' : 'st';
    return mode;
}

// 设置里的世界书范围经归一后的有效值（纯；表单回填与 wiContextMode 共用，旗关 + 残留 custom 时下拉不留空白）。
export function wiEffectiveMode(s) {
    return wiNormalizeMode(s ? s.worldInfoMode : undefined);
}

// 提示词模板（ST-Prompt-Template）挂在 globalThis 的执行器接口（见其 exports.ts / 柏宝书 getEjsTemplate）。
// 只用到 prepareContext + evalTemplate；未安装 / 接口不完整时返回 null（调用方据此降级为不执行 EJS）。
function getEjsTemplateApi() {
    try {
        const api = getHostGlobal('EjsTemplate');
        if (api && typeof api.prepareContext === 'function' && typeof api.evalTemplate === 'function') return api;
    } catch (e) { /* globalThis 不可用 → 视作未装插件 */ }
    return null;
}

// 渲染一段世界书文本，让神谕读到「执行后」成品而非模板原文（镜像柏宝书 renderWorldInfoContent + 官方 evaluateWIEntities 的「先宏后 EJS」顺序）：
//   opts.level==='entry'（'char'/'all' 拿得到条目对象）：① substituteParams 展宏（guarded，抛错保留原文）→
//     ② 文本含 <% %> 且装了提示词模板 → env = prepareContext({ world_info: entry })（恒省略 end/取最新楼；柏宝书才需历史楼）
//     → evalTemplate；返回非字符串则弃用（保留展宏 / 原文）。
//   opts.level==='chunk'（'st' 已由 ST 拼装、宏已展开）：跳过展宏（重跑会重掷 {{random}} 等）→ 仅 EJS，prepareContext({})（无条目对象，同柏宝书降级路径）。
// opts.renderEjs 关（或旗 ENABLE_WI_EJS_RENDER 关）→ 原样返回（字节级 pass-through，连 substituteParams 都不跑）。
// 单条失败（EJS / prepareContext 抛错）→ console.warn + 退回该步文本（展宏后 / 原文），绝不让一条 EJS 崩掉整块。
// ⚠ 导出接口的 evalTemplate 强制 isDryRun=false：含 setvar 等【写】变量的模板会被真执行，故本功能 opt-in。
async function renderWiEjs(text, entry, opts) {
    const o = opts || {};
    if (!ENABLE_WI_EJS_RENDER || !o.renderEjs) return text;      // 字节级 pass-through（旗关 / 设置关）
    if (typeof text !== 'string' || text === '') return text;
    const level = (o.level === 'chunk') ? 'chunk' : 'entry';
    let out = text;
    try {
        // ① 展宏：仅条目级（'st' 分块 ST 已展宏，重跑会重掷 {{random}} / 重扫世界书）
        if (level === 'entry') {
            let ctx = null;
            try { ctx = getCtx(); } catch (e) { ctx = null; }
            if (ctx && typeof ctx.substituteParams === 'function') {
                try { out = ctx.substituteParams(text); } catch (e) { out = text; }   // 展宏失败保留原文
            }
        }
        // ② 无 EJS 标签 → 免调模板插件（省 prepareContext/sandbox 开销，复刻柏宝书 gate）
        if (!out.includes('<%')) return out;
        const ejs = getEjsTemplateApi();
        if (!ejs) return out;                                    // 未装提示词模板：条目级只做了展宏，分块级原样
        const env = (level === 'entry')
            ? await ejs.prepareContext({ world_info: entry })    // 恒省略 end（最新楼）
            : await ejs.prepareContext({});                      // 分块级无条目对象
        const rendered = await ejs.evalTemplate(out, env);
        if (typeof rendered === 'string') out = rendered;        // 非字符串返回 → 保留展宏 / 原文
    } catch (e) {
        console.warn('[Story Oracle] 世界书 EJS 渲染失败（退回未执行文本）：', e);
        return out;                                              // 退回该步，不崩整块
    }
    return out;
}

// 🌐 世界书范围「自定义」喂料（1.81.0）：镜像 'all' 分支的输出形状（无书名抬头、\n\n 拼接），取数换成本聊天的勾选。
//   chatId 无 / metadata 无 / 模块缺 / 范围空 → ''（fail-closed：宁少发不爆量）。
//   首次遇到无键的书先播种（ensureWiCustomSeeded）→ 混合模式并入已选书里此刻命中的绿灯 → collectWiCustomEntries
//   （剔 [mvu_update] 规则在 renderWiEjs 之前）→ 每条 entry 级 EJS（仅第三参 opt-in）→ 拼接 → stripMvuRuleContents。
async function buildWiCustomBlock(extraScanText, renderEjs) {
    const chatId = wiCustomChatId();
    if (chatId === null) return '';
    const mod = await getWiEditApi();
    if (!mod) return '';
    let meta = getWiCustomMeta();
    if (!meta) return '';
    let allNames = [];
    let activeNames = [];
    try { [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]); } catch (e) { return ''; }
    if (chatId !== wiCustomChatId()) return '';                // 等待期间聊天切走：这一趟不属于当前聊天，宁空不错发
    let names = resolveLbTargetNames(meta.books, allNames, activeNames);
    if (!names.length) return '';
    const seeded = await ensureWiCustomSeeded(names, chatId, extraScanText);
    if (chatId !== wiCustomChatId()) return '';
    meta = seeded || meta;
    let selMap = deserializeEntrySel(meta.sel);
    if (meta.hybrid) {
        try { selMap = mergeHybridUids(selMap, await wiCustomGreens(names, extraScanText)); } catch (e) { /* 混合失败就只用勾选 */ }
        if (chatId !== wiCustomChatId()) return '';
    }
    const ordered = [];
    for (const name of names) {
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }   // 单本读失败 → 跳过这本
        if (chatId !== wiCustomChatId()) return '';
        if (!data || !data.entries) continue;
        ordered.push({ name, entries: Object.values(data.entries) });
    }
    const entries = collectWiCustomEntries(selMap, ordered);
    if (!entries.length) return '';
    const rendered = await Promise.all(entries.map((e) => renderWiEjs(e.content.trim(), e, { renderEjs, level: 'entry' })));
    return await stripMvuRuleContents(rendered.join('\n\n'));
}

export async function buildWorldInfo(forceMode, extraScanText, opts) {
    // 世界书 EJS 渲染（1.52.0）：opt-in 只由【普通 / 参谋 / 手动校正】READ 调用点经【第三参】传 { renderEjs:true }。
    // 诊断 / 工坊等不传第三参的调用点 → 恒 raw。未知 / 未来调用点默认 raw，安全。
    const renderEjs = !!(opts && opts.renderEjs);
    const ctx = getCtx();
    const s = getSettings();
    const mode = wiNormalizeMode(forceMode || s.worldInfoMode);
    if (mode === 'off') return '';

    try {
        if (mode === 'custom') {
            return await buildWiCustomBlock(extraScanText, renderEjs);
        }

        if (mode === 'all') {
            const mod = await loadWorldInfoModule();
            if (!mod || !mod.getSortedEntries) return '';
            const entries = await mod.getSortedEntries();
            const kept = (entries || [])
                .filter((e) => e && !e.disable && typeof e.content === 'string' && e.content.trim())
                .filter((e) => !isMvuRuleEntry(e));         // 机制规则诊断专属（此处喂原始内容 → 必须按条目剔）
            // 世界书 EJS 渲染在 isMvuRuleEntry 过滤【之后】按条目做（渲染器 opt-in 关时逐字节 pass-through = 原 .map 行为）。
            const allBlock = (await Promise.all(kept.map((e) => renderWiEjs(e.content.trim(), e, { renderEjs, level: 'entry' }))))
                .join('\n\n');
            // Mechanism rules are Diagnose-only; see stripMvuRuleContents.
            return await stripMvuRuleContents(allBlock);
        }

        if (mode === 'char') {
            // 仅角色 / 对话相关世界书：跑 ST 的真实扫描拿到【当前被激活】的条目（蓝灯 + 命中绿灯），
            // 再按书名筛到角色 + 对话书集合（全局 / 人设书不在集合里 → 自然排除）。关键词匹配仍由 ST 决定。
            const mod = await getWiEditApi();
            const bookSet = new Set(await getCharChatBookNames());
            if (!mod || !bookSet.size) return '';
            const active = await getActiveScanUids(extraScanText);   // { 书名: Set<uid> }（侧聊折叠文本照常参与扫描）
            const blocks = [];
            for (const name of Object.keys(active)) {
                if (!bookSet.has(name)) continue;
                let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
                const entries = Object.values((data && data.entries) || {})
                    .filter((e) => e && active[name].has(Number(e.uid)) && !e.disable && typeof e.content === 'string' && e.content.trim())
                    .filter((e) => !isMvuRuleEntry(e))      // 机制规则诊断专属（此处喂原始内容 → 必须按条目剔）
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
                if (entries.length) {
                    // EJS 渲染在 isMvuRuleEntry 过滤之后按条目做（opt-in 关时 pass-through = 原 .map 行为）。
                    const rendered = await Promise.all(entries.map((e) => renderWiEjs(e.content.trim(), e, { renderEjs, level: 'entry' })));
                    blocks.push(rendered.join('\n\n'));
                }
            }
            return await stripMvuRuleContents(blocks.join('\n\n').trim());
        }

        // 'st' mode — replicate ST's scan input.
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse(); // most-recent first, as ST does

        // 把调用方传入的【额外扫描文本】（侧聊最近问答、工坊的访谈文本）并进最近一条消息所在的
        // 扫描格——它深度无关地一定被扫到，既不挤占 world_info_depth 窗口里的真实消息，又能让以这些
        // 词为关键词的绿条即便最近聊天没提到也照常激活（见 sideChatScanBlob）。仅 'st' 扫描有意义。
        foldExtraScanText(chatForWI, extraScanText);

        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group/no char */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };

        const budget = await getWiScanBudget();
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);

        // getWorldInfoPrompt buckets the activated entries by insertion position.
        // worldInfoString only holds Before/After Char Defs (positions 0/1), so
        // drain every bucket — otherwise @D, Author's Note, example-message and
        // outlet entries (including *constant* ones) get silently dropped.
        // The `|| []` / `|| {}` guards keep this safe on older ST builds that
        // don't return the newer fields (anBefore/anAfter/outletEntries).
        const parts = [];
        const push = (v) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()); };

        push(res?.worldInfoBefore);                                    // 0  Before Char Defs
        push(res?.worldInfoAfter);                                     // 1  After Char Defs
        for (const s of (res?.anBefore || [])) push(s);                // 2  Top of AN
        for (const s of (res?.anAfter  || [])) push(s);                // 3  Bottom of AN
        for (const d of (res?.worldInfoDepth || [])) (d?.entries || []).forEach(push); // 4  @D
        for (const e of (res?.worldInfoExamples || [])) push(typeof e === 'string' ? e : e?.content); // 5/6 Example Messages
        for (const arr of Object.values(res?.outletEntries || {})) (arr || []).forEach(push);          // 7  Outlet

        // 世界书 EJS 渲染（1.52.0）：'st' 是 ST 拼装好的分块（宏已展）→ 分块级仅跑 EJS，在 stripMvuRuleContents 之前逐块渲染。
        const stParts = renderEjs
            ? await Promise.all(parts.map((p) => renderWiEjs(p, undefined, { renderEjs, level: 'chunk' })))
            : parts;
        // Mechanism rules are Diagnose-only; see stripMvuRuleContents.
        return await stripMvuRuleContents(stParts.join('\n\n').trim());
    } catch (e) {
        console.warn('[Story Oracle] World info build failed:', e);
        return '';
    }
}

/**
 * Like buildWorldInfo, but split by insertion position for the faithful marker
 * fill: { before, after }. 'before' = Before-Char-Defs entries; 'after' =
 * After-Char-Defs plus every other bucket (AN, @D, examples, outlet) so nothing
 * is lost. 'all' mode dumps everything into 'before'; 'off' yields empties.
 */
export async function buildWorldInfoSplit(forceMode, extraScanText, opts) {
    const ctx = getCtx();
    const s = getSettings();
    const mode = wiNormalizeMode(forceMode || s.worldInfoMode);
    if (mode === 'off') return { before: '', after: '' };

    // 世界书 EJS 渲染（1.52.0）：仅经【第三参】从允许调用点（普通预设策展）传入；默认 raw。
    const renderEjs = !!(opts && opts.renderEjs);

    if (mode === 'all') {
        return { before: await buildWorldInfo('all', undefined, { renderEjs }), after: '' };
    }

    if (mode === 'char') {
        return { before: await buildWorldInfo('char', extraScanText, { renderEjs }), after: '' };
    }

    if (mode === 'custom') {
        return { before: await buildWorldInfo('custom', extraScanText, { renderEjs }), after: '' };
    }

    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return { before: '', after: '' };
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse();
        foldExtraScanText(chatForWI, extraScanText);   // 侧聊折叠文本（同 buildWorldInfo 'st'）

        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };

        const budget = await getWiScanBudget();
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);

        const beforeParts = [];
        const afterParts = [];
        const push = (arr, v) => { if (typeof v === 'string' && v.trim()) arr.push(v.trim()); };

        push(beforeParts, res?.worldInfoBefore);
        push(afterParts, res?.worldInfoAfter);
        for (const x of (res?.anBefore || [])) push(afterParts, x);
        for (const x of (res?.anAfter || [])) push(afterParts, x);
        for (const d of (res?.worldInfoDepth || [])) (d?.entries || []).forEach((e) => push(afterParts, e));
        for (const e of (res?.worldInfoExamples || [])) push(afterParts, typeof e === 'string' ? e : e?.content);
        for (const arr of Object.values(res?.outletEntries || {})) (arr || []).forEach((e) => push(afterParts, e));

        // 世界书 EJS 渲染（1.52.0）：'st' 分块级仅跑 EJS，两槽各自在 stripMvuRuleContents 之前逐块渲染（opt-in 关时 pass-through）。
        const beforeR = renderEjs ? await Promise.all(beforeParts.map((p) => renderWiEjs(p, undefined, { renderEjs, level: 'chunk' }))) : beforeParts;
        const afterR = renderEjs ? await Promise.all(afterParts.map((p) => renderWiEjs(p, undefined, { renderEjs, level: 'chunk' }))) : afterParts;
        // 机制规则一律不进神谕提示词；见 stripMvuRuleContents。
        return {
            before: await stripMvuRuleContents(beforeR.join('\n\n').trim()),
            after: await stripMvuRuleContents(afterR.join('\n\n').trim()),
        };
    } catch (e) {
        console.warn('[Story Oracle] World info split failed:', e);
        return { before: '', after: '' };
    }
}

/*
 * [mvu_update] rule entries — the card's variable-update mechanism rules
 * (update rules / output format contracts). Matching mirrors MVU's own
 * UPDATE_REGEX exactly: /[mvu_update]/i on the comment. Constant-only and
 * enabled-only.
 *
 * These entries are read straight from the stored world books via
 * loadWorldInfo(), bypassing the live WI scan, because MagVarUpdate in
 * "extra-model-parsing" update mode strips them from the lore arrays on the
 * `worldinfo_entries_loaded` event — which fires inside getSortedEntries,
 * upstream of BOTH getWorldInfoPrompt ('st') and getSortedEntries ('all').
 * On cards where MVU is NOT in that mode, the entries flow through the scan
 * untouched. The raw books see them either way.
 *
 * Policy: chat / advisor / preset prompts should NOT carry these mechanism
 * rules — they're noise there, and worse, the output-format contract is what
 * coaxes models into emitting <UpdateVariable> blocks in oracle replies (the
 * leakage stripMechanismBlocks exists to clean up). So buildWorldInfo /
 * buildWorldInfoSplit strip them from every block. Untagged variable entries
 * (e.g. threshold explanations) are not touched.
 */
export const MVU_UPDATE_TAG = /\[mvu_update\]/i;

// 条目级判据：这条世界书条目是不是 [mvu_update] 机制规则（标题带标签即算）。
// 'char' / 'all' 两条路径拿得到条目对象 —— 直接按标题剔除，比 stripMvuRuleContents 的
// 内容比对可靠：那边比的是【展宏后】的规则文本，而这两条路径喂的是【原始未展宏】内容，
// 规则里只要有 {{user}} 之类的宏就对不上、机制规则整段泄进普通/参谋提示词（2026-07-26 实测）。
export function isMvuRuleEntry(e) {
    return !!e && MVU_UPDATE_TAG.test(String(e.comment || ''));
}

// Enumerate every enabled, constant [mvu_update] entry from the raw active
// books. Returns substituted content strings, deduped, sorted by entry order.
async function collectMvuRuleContents() {
    const ctx = getCtx();
    const mod = await loadWorldInfoModule();
    if (!mod || typeof mod.getSortedEntries !== 'function' || typeof mod.loadWorldInfo !== 'function') {
        return [];
    }

    // Discover active book names. The entries themselves may have been stripped
    // by MVU, but the books still surface via their surviving (untagged) entries.
    let names = [];
    try {
        const sorted = await mod.getSortedEntries();
        names = [...new Set((sorted || []).map((e) => e && e.world).filter(Boolean))];
    } catch (e) {
        console.warn('[Story Oracle] Could not enumerate world books for MVU rules:', e);
        return [];
    }

    const collected = [];
    for (const name of names) {
        let book;
        try { book = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const entries = book && book.entries ? Object.values(book.entries) : [];
        for (const e of entries) {
            if (!e || e.constant !== true || e.disable) continue;
            if (!MVU_UPDATE_TAG.test(e.comment || '')) continue;
            let content = typeof e.content === 'string' ? e.content : '';
            try { content = ctx.substituteParams(content); } catch (_) { /* leave raw */ }
            content = content.trim();
            if (!content) continue;
            if (collected.some((c) => c.content === content)) continue; // dupe across books
            collected.push({ order: Number(e.order) || 0, content });
        }
    }

    collected.sort((a, b) => a.order - b.order);
    return collected.map((c) => c.content);
}

// Diagnose-mode recovery: the [mvu_update] rules that are NOT already in the
// built block (buildWorldInfo strips them by design; MVU may also have hidden
// them from the scan). Diagnose appends these so its audit always has the
// authoritative path/type/check rules.
export async function collectMvuUpdateRules(existingBlock) {
    const seen = existingBlock || '';
    const contents = await collectMvuRuleContents();
    return contents.filter((c) => !seen.includes(c));
}


// Remove [mvu_update] mechanism-rule content from a built world-info block.
// The scan returns joined strings (not entries), so removal is content-based:
// the same substituted content the scan would have inserted is matched and
// cut out, then leftover blank lines are collapsed. No-op on cards without
// [mvu_update] entries.
async function stripMvuRuleContents(text) {
    if (!text || typeof text !== 'string') return text || '';
    let contents;
    try { contents = await collectMvuRuleContents(); } catch (e) { return text; }
    if (!contents.length) return text;
    let out = text;
    for (const c of contents) {
        if (!c || !out.includes(c)) continue;
        out = out.split(c).join('');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}