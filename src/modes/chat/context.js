import { convoForPrompt, getSummary } from '../../core/chat-metadata.js';
import { getCtx, getSettings } from '../../core/settings.js';

import { parseStoryPlans } from '../advisor/cards.js';
import { getLbApplySnapshot, getPath } from '../advisor/metadata.js';
import { wantAutoDetail } from '../advisor/story-path.js';
import { chatMsgCount, fixUsePresetFor, pathIsMulti, pathProgressLabel, pathSpeedKey, resolveFixAutoPrompt } from '../fix/templates.js';
import { lbFormatApplyLine } from '../lorebook/core.js';
import { buildAdvisorPresetMessages, buildBuilderPresetMessages, buildDiagnosePresetMessages, buildFixPresetMessages, buildLorebookPresetMessages, buildPresetMessages } from '../../presets/messages.js';
import { ADVISOR_SPEEDS, ENABLE_BBS_BRIDGE, ENABLE_FIX_CUSTOM_TASK, ENABLE_LWB_BRIDGE, ENABLE_OFFSTAGE_GUARD, MVU_BLOCK_DIALECTS } from '../../prompts/builtins.js';
import { buildPersonaBlock, mvuBlockRegex, mvuDialectInnerOk } from '../../prompts/helpers.js';
import { P, buildSystemPrompt, wrapTranscriptEnvelope } from '../../prompts/registry.js';
import { locateTagOpen } from '../../ui/messages.js';
import { escapeHtml } from '../../ui/mode-shell.js';
import { currentJbModeKey, maybeWrapJb, presetCurationActive } from '../../ui/settings.js';
import { advisorMode, builderMode, diagnoseMode, fixMode, lorebookMode } from '../../core/runtime-state.js';
import { advStatData } from '../advisor/state.js';
import { chatWorldData, lwbSummaryCache, setLwbSummaryCache, worldInfoBlock } from './state.js';
import { diagLatestUpdate, diagStatData } from '../diagnose/state.js';
import { fixActiveMode, fixAutoPromptFlavor, fixAutoPromptVersion, fixCardBlock, fixContextBlock, fixCustomJoin, fixCustomTemplateText, fixExtraKeep, fixSummaryBlock, fixTargetProse, fixWorldBlock } from '../fix/state.js';
import { lbContextText } from '../lorebook/state.js';
import { regexEngine, setSoMdConverter, soMdConverter } from '../../st/runtime-state.js';

// ===== 外部扩展世界信息桥接（用户功能请求）=========================================
// 让神谕读到「住在别的扩展自己系统里」的世界信息——主聊天与 MVU 之外、神谕原本看不到的后台世界。
// 两路来源：
//   (1) 内置「世界引擎」适配器：直接读 window.WORLD_ENGINE_CORE（官方原版与 Prince 的 World-mod 同名全局）。
//       仅当该聊天确有落盘状态（hasState）时才喂——loadState() 在无状态时只返回空的默认世界，喂它没意义。
//       按用户选择喂【完整 state JSON】（含全部字段，包括 blackbox 私密层）。
//   (2) 通用注册表 window.__ST_CONTEXT_PROVIDERS__：任何扩展可 push({ name, getContext })，getContext()
//       返回字符串或对象。将来别的扩展无需改神谕即可接入——三行注册即可。
// 全程 try/catch + 全局存在性判断：相关扩展没装 / 没加载时安静返回空、零副作用（仿 getMvuStatData 的写法）。
function getExternalWorldBlocks() {
    const blocks = [];

    // (1) 世界引擎 / World-mod
    try {
        const we = window.WORLD_ENGINE_CORE;
        if (we && typeof we.loadState === 'function' &&
            (typeof we.hasState !== 'function' || we.hasState())) {
            const state = we.loadState();
            if (state && typeof state === 'object') {
                blocks.push({ name: '世界引擎（World Engine）', text: JSON.stringify(state, null, 2) });
            }
        }
    } catch (e) { console.warn('[Story Oracle] 读取世界引擎状态失败:', e); }

    // (2) 通用上下文提供者注册表（任何扩展可自行注册）
    try {
        const providers = window.__ST_CONTEXT_PROVIDERS__;
        if (Array.isArray(providers)) {
            for (const p of providers) {
                if (!p || typeof p.getContext !== 'function') continue;
                try {
                    const out = p.getContext();
                    const text = (out == null) ? ''
                        : (typeof out === 'string' ? out : JSON.stringify(out, null, 2));
                    if (text && text.trim()) {
                        blocks.push({ name: String(p.name || '外部扩展'), text: text });
                    }
                } catch (e) { console.warn('[Story Oracle] 外部上下文提供者出错:', p && p.name, e); }
            }
        }
    } catch (e) { console.warn('[Story Oracle] 读取上下文提供者注册表失败:', e); }

    return blocks; // [{ name, text }, ...]
}

// 把各来源拼成一段文本（每段带「来源」小标题），无任何来源时返回 ''。在 generateReply 里算好、存进
// chatWorldData；buildChatWorldSection 负责加外层大标题。拆两步与 stat_data 那套写法保持一致。
export function assembleExternalWorld() {
    const blocks = getExternalWorldBlocks();
    if (!blocks.length) return '';
    return blocks.map((b) => `--- 来源：${b.name} ---\n${b.text}`).join('\n\n');
}

// 外部世界信息区块。无数据时返回 ''（被 parts.filter(Boolean) / pushMsg 跳过）——与参谋的 stat_data
// 一样属「可选情报，没有就整段省略」，不像普通模式 stat 那样留拒答占位。
export function buildChatWorldSection() {
    if (!chatWorldData) return '';
    return P('ctx.world', { world: chatWorldData });
}

// 用户功能请求：用户粘贴的运行概要 / 前情提要（本聊天）。在【普通聊天】与【剧情参谋】模式下
// 插入到最近对话记录的正前方——填补「有总结但存在预设 / 世界书 / 主聊天之外」、神谕本来读不到
// 的那段故事。纯函数（文本入参），可单测：空串回空串（调用处用 if/pushMsg 跳过）；末尾的
// substituteParams 由各调用方统一处理。
export function buildSummarySection(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return P('ctx.summary', { summary: t });
}

// ==================== 柏宝书记忆桥（ENABLE_BBS_BRIDGE，1.33.0） ====================
// 柏宝书（ST-BaiBai-Book）是记忆引擎类扩展：逐楼自动摘要、把窗口外旧楼 /hide 隐藏、只给主模型注入
// 摘要。神谕默认不读隐藏楼层（messageVisibleForTranscript）→ 早期剧情对神谕不可见。本桥在【构建
// 提示词时】直接调它的公开只读 API 取回这段摘要文本，作为普通文本插进上下文——不依赖各路径是否
// substituteParams（预设路径不展宏，宏方案在那条路径会原样送出 {{bbsInjectedHistory}}）。
// getInjectedHistory() 与柏宝书注入主模型的口径一致：只含【已隐藏】楼层的摘要（窗口内全文楼层不含
// → 与神谕自己的对话记录天然无重叠）、带相对时间标注。设置 chatIncludeBbs 默认关（opt-in）。

// 自守门解析器：开关关 / 设置关 / 未装柏宝书 / API 缺失或抛错 / 文本空白 → 一律 ''，绝不抛错。
// 同步调用、每次构建提示词现取（柏宝书返回深拷贝 DTO，永远是当下最新）。
export function getBbsHistoryText() {
    if (!ENABLE_BBS_BRIDGE) return '';
    try {
        if (!getSettings().chatIncludeBbs) return '';
        const api = (typeof window !== 'undefined') ? window.STBaiBaiBook : null;
        if (!api || typeof api.getInjectedHistory !== 'function') return '';
        const h = api.getInjectedHistory();
        const t = (h && typeof h.relativeText === 'string') ? h.relativeText.trim() : '';
        return t;
    } catch (e) {
        console.warn('[Story Oracle] 读取柏宝书历史摘要失败（本次跳过）：', e);
        return '';
    }
}

// 柏宝书节格式化（镜像 buildSummarySection）：空 → ''；有货 → 大标题 + 原文。
// 插在用户 剧情概要 之后、故事对话记录之前——摘要覆盖的隐藏楼层正好在可见对话之前，时间线连续。
export function buildBbsHistorySection(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return P('ctx.bbs', { text: t });
}

// 单槽合成（校正信封 <story_summary> 只有一个概要位）：用户概要在前、柏宝书标注块在后。
// 桥空时【原样返回入参】（不 trim）——桥关 / 未装柏宝书时对既有行为字节级零变化。
function composeSummaryWithBbs(userText) {
    const u = String(userText || '');
    const b = getBbsHistoryText();
    if (!b) return u;
    const block = '【柏宝书 · 历史剧情摘要（被隐藏旧楼层的自动总结，是下方前文之前的剧情）】\n' + b;
    return u.trim() ? u + '\n\n' + block : block;
}


// ==================== 小白X 剧情总结桥（ENABLE_LWB_BRIDGE，1.50.0） ====================
// 取数与柏宝书不同：小白X 无同步公开 API，其总结只在主聊天生成时写进公共槽、生成完即删。故读取器读的是
// lwbSummaryCache（由抓拍钩子 / metadata 回填 / 冷启动暖填充），而非现调 API。格式化 / 信封 / 插桩全镜像柏宝书。
const LWB_EXT_PROMPT_KEY = 'LittleWhiteBox_StorySummary';   // 小白X 注入公共槽的 key（其内部常量，硬编码）
const LWB_SNAPSHOT_META_KEY = 'storyOracle_lwbSummary';     // 抓拍持久化到 chat_metadata 的 key（(a)）

// 读取器（同步、自守门）：镜像 getBbsHistoryText 的契约，数据源换成缓存。
export function getLwbSummaryText() {
    if (!ENABLE_LWB_BRIDGE) return '';
    try {
        if (!getSettings().chatIncludeLwb) return '';
        return String(lwbSummaryCache || '').trim();
    } catch (e) {
        console.warn('[Story Oracle] 读取小白X 总结缓存失败（本次跳过）：', e);
        return '';
    }
}

// 切聊天回填(a)：先清缓存，再从本聊天 metadata 快照回填（不设门于开关——缓存即事实，读取器负责按开关拦）。
export function primeLwbFromMetadata() {
    setLwbSummaryCache('');
    if (!ENABLE_LWB_BRIDGE) return;
    try {
        const md = getCtx().chatMetadata;
        const t = md && typeof md[LWB_SNAPSHOT_META_KEY] === 'string' ? md[LWB_SNAPSHOT_META_KEY].trim() : '';
        if (t) setLwbSummaryCache(t);
    } catch (e) { /* 静默 */ }
}

// 小白X 节格式化（镜像 buildBbsHistorySection）：空 → ''；有货 → 大标题 + 原文。
export function buildLwbHistorySection(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    return P('ctx.lwb', { text: t });
}

// 单槽合成（校正信封）：镜像 composeSummaryWithBbs。桥空时【原样返回入参】（不 trim），字节稳定。
function composeSummaryWithLwb(userText) {
    const u = String(userText || '');
    const b = getLwbSummaryText();
    if (!b) return u;
    const block = '【小白X · 剧情总结（自动记忆，是下方前文之前的剧情）】\n' + b;
    return u.trim() ? u + '\n\n' + block : block;
}

// 两桥串接：用户概要 → 柏宝书块 → 小白X 块。两桥皆空 → 原样返回入参（字节稳定）。
export function composeSummaryWithBridges(userText) {
    return composeSummaryWithLwb(composeSummaryWithBbs(userText));
}


// 从 extension_prompts 形状对象取小白X 注入文本（纯、自守门）。
function extractLwbInjectedText(extPrompts) {
    try {
        const slot = extPrompts && extPrompts[LWB_EXT_PROMPT_KEY];
        return slot && typeof slot.value === 'string' ? slot.value.trim() : '';
    } catch (e) { return ''; }
}

// 抓拍(A)：主聊天生成期、小白X 已写槽时读一份缓存并持久化(a)。空则不覆盖已有缓存。
export function captureLwbSnapshot() {
    if (!ENABLE_LWB_BRIDGE) return;
    try {
        if (!getSettings().chatIncludeLwb) return;
        const ctx = getCtx();
        const text = extractLwbInjectedText(ctx.extensionPrompts);
        if (!text) return;
        setLwbSummaryCache(text);
        const md = ctx.chatMetadata;
        if (md) {
            md[LWB_SNAPSHOT_META_KEY] = text;
            (ctx.saveMetadataDebounced || ctx.saveMetadata || (() => {}))();
        }
    } catch (e) { /* 静默：绝不连累生成 */ }
}

// 暖启动判定（纯）：开关开且缓存空才该暖。
function shouldWarmLwb() {
    if (!ENABLE_LWB_BRIDGE) return false;
    try {
        return !!getSettings().chatIncludeLwb && !String(lwbSummaryCache || '').trim();
    } catch (e) { return false; }
}

// 冷启动兜底(b)：缓存空时破例动态 import 小白X 内部组装函数暖一份（仅非向量静态版）。受保护、自降级——
// 小白X 未装 / 改版路径或导出变了 / 抛错 / 返回空 → 一律不暖（保持空，等下次主聊天生成由抓拍钩子接管）。
export async function warmLwbSummaryIfCold() {
    if (!shouldWarmLwb()) return;
    try {
        const mod = await import('/scripts/extensions/third-party/LittleWhiteBox/modules/story-summary/generate/prompt.js');
        if (!mod || typeof mod.buildNonVectorPromptText !== 'function') return;
        const text = String(mod.buildNonVectorPromptText() || '').trim();
        if (!text) return;
        if (String(lwbSummaryCache || '').trim()) return;   // 竞态兜底：期间被真实抓拍填了就不覆盖
        setLwbSummaryCache(text);
        const md = getCtx().chatMetadata;
        if (md) {
            md[LWB_SNAPSHOT_META_KEY] = text;
            (getCtx().saveMetadataDebounced || getCtx().saveMetadata || (() => {}))();
        }
    } catch (e) { /* 静默降级：小白X 未装 / 改版 / 抛错 */ }
}

export function buildDiagnosePrompt(ctx, s) {
    // 手动诊断模式：用 generateReply 现算好的模块状态变量。
    return buildDiagnosePromptFrom(ctx, s, {
        wiBlock: worldInfoBlock, statStr: diagStatData, latestBlock: diagLatestUpdate,
    });
}

// 纯函数（选段校正 1.27.0，Part C）：选段调用信封。块序 characters → story_summary → scene_context →
// full_message → selected_span（选段在【尾】＝近因；full_message 给模型定位/衔接的完整上下文）。空块省略、
// 末两块必在。上下文用与手动同一套 fixM_* 开关——用户想开大前文就开大，选段正是能扛高上下文的那个形态。可单测。
function buildFixSpanEnvelope(b) {
    const parts = [];
    const card = String((b && b.card) || '').trim(), summary = String((b && b.summary) || '').trim(), context = String((b && b.context) || '').trim();
    if (card) parts.push('<characters>\n' + card + '\n</characters>');
    if (summary) parts.push('<story_summary>\n' + summary + '\n</story_summary>');
    if (context) parts.push('<scene_context>\n' + context + '\n</scene_context>');
    parts.push('<full_message>\n' + String((b && b.full) || '') + '\n</full_message>');
    parts.push('<selected_span>\n' + String((b && b.span) || '') + '\n</selected_span>');
    return parts.join('\n\n');
}

// 选段调用系统提示 = 冻结的 FIX_SPAN_PROMPT + 信封（卡/概要/前文取模块槽，captureFixContext 已按 fixM_* 填）。
// sel = { full, text }（完整楼层正文 + 划选片段）。可单测（ctx=null 时 subst 恒等）。
function buildFixSpanPrompt(ctx, s, sel) {
    let subst = (t) => t;
    if (ctx && typeof ctx.substituteParams === 'function') subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    return subst(P('fix.span', null, s || undefined)) + '\n\n' + buildFixSpanEnvelope({ card: fixCardBlock, summary: fixSummaryBlock, context: fixContextBlock, full: (sel && sel.full) || '', span: (sel && sel.text) || '' });
}

// 选段调用的消息数组（单一来源，R9）：单段路径 runFixSelect 与多段批发 runFixSelectBatch 都从这儿拿——
// 两路 prompt 字节同源，H1 的 n=1 字节同一性由构造保证（multifix.test.mjs 钉）。ctx/s/sel 语义同
// buildFixSpanPrompt（sel = {full, text}）。
export function buildSpanMessages(ctx, s, sel, instruction) {
    // 选段校正（含 1.37.0 多段批次）是【手动】校正的一支 → 跟手动校正共用 opt-in 开关。
    // FIX_SPAN_PROMPT 与 buildFixSpanEnvelope 在此仍逐字节不变（1.27.0 冻结契约）：破限只在【外面】包一层。
    return maybeWrapJb(
        [{ role: 'system', content: buildFixSpanPrompt(ctx, s, sel) }, { role: 'user', content: instruction }],
        'fixManual', s);
}

// 纯函数：解析 <FixedSpan> 改写稿。locateTagOpen 取行首/末次（防模型在 <fix_think> 里提及标签劫持首次锚定，
// 同 parseFixedReply 的 Tier-0 ② 加固）。有 <fix_think> 开而无可用 <FixedSpan> → truncated（截断/额度耗尽）。可单测。
export function parseFixSpan(text) {
    const src = String(text || '');
    const open = locateTagOpen(src, 'FixedSpan');
    if (!open) return /<fix_think\b/i.test(src) ? { status: 'truncated', span: '' } : { status: 'unparseable', span: '' };
    const rest = src.slice(open.index + open.length);
    const close = rest.match(/<\/FixedSpan\s*>/i);
    const span = (close ? rest.slice(0, close.index) : rest).trim();
    return span ? { status: 'ok', span } : { status: 'unparseable', span: '' };
}

// 纯函数：把可选上下文块（角色卡 / 激活世界书 / 前文）+ 待校正正文拼成校正调用信封。空块省略；
// <text_to_transform> 始终存在。顺序：characters → world_info → scene_context → text_to_transform。可单测。
function buildFixEnvelope(blocks) {
    const b = blocks || {};
    const parts = [];
    const card = String(b.card || '').trim();
    const world = String(b.world || '').trim();
    const summary = String(b.summary || '').trim();   // 📜剧情概要 / 前情提要（用户提供）
    const context = String(b.context || '').trim();
    if (card) parts.push('<characters>\n' + card + '\n</characters>');
    if (world) parts.push('<world_info>\n' + world + '\n</world_info>');
    // 概要在前情、scene_context 是最近对话——按时间线放在世界书之后、最近对话之前。
    if (summary) parts.push('<story_summary>\n' + summary + '\n</story_summary>');
    if (context) parts.push('<scene_context>\n' + context + '\n</scene_context>');
    parts.push('<text_to_transform>\n' + String(b.reply || '').trim() + '\n</text_to_transform>');
    return parts.join('\n\n');
}

// 手动校正结构块保留软约束（尾附在手动提示词后）：手动模式不走自动的信封 / 分段保护（那是仅自动），
// 故显式叮嘱模型默认原样保留非叙事结构块（状态栏 / [方括号]标记 / HTML-XML 区块 / 选项 / 图生提示）；
// 但【用户指令优先】——用户明确要改某块内部时以用户要求为准（否则「让描写更生动」这类泛指令会顺手删掉
// 结构块，用户反馈）。纯函数、可单测（fix-manual-structural.test.mjs）。
function fixManualStructuralNote() {
    return P('fix.structuralNote');
}

// 校正系统提示 = 基础规则 + 内嵌的【待校正正文】。基础规则的优先级：旧全局覆盖 s.fixSystemPrompt
// ＞ 自动两档各自的用户覆盖（1.46.0：轻校 fixLightSystemPrompt / 精校 fixThoroughSystemPrompt）＞ 内置常量。
export function buildFixPrompt(ctx, s) {
    const override = (s.fixSystemPrompt || '').trim();   // 旧全局覆盖（无 UI、手改 settings 用）：仍最高优先，行为不变
    // 自动分支：轻校 / 精校（含侧重）都由 resolveFixAutoPrompt 从提示词注册表取（fix.light / fix.thorough / fix.thoroughOpus）。
    // 📋 自定义模板任务（ENABLE_FIX_CUSTOM_TASK）：模式先判——系统提示 = 用户模板 + 代码页脚，
    // 【有意】压过 s.fixSystemPrompt 旧全局覆盖与轻校 / 精校覆盖（那些描述的是「校正」语义，
    // 与「按模板做任意处理」直接矛盾；输出契约是机械的，不是口味问题）。
    // 📋 契约补丁：判据 =【这次的 join 表是不是 fixCustomRawTable 出的】（fixCustomJoin 非 null），**不是** .raw ——
    // 该函数的 head/tail 只装首尾空白，包裹标签与结构块全在 core 里，raw:false（沿用识别但阶梯没建出分段表，
    // 如 fixA_scopeTag 为空 → whole）那条退路一样把 <content> 原样交给模型 = 电池 §R2 量到的同一处信封丢失。
    // raw:false 时 MVU 块已被 stripMechanismBlocks 剥掉，句里提 <UpdateVariable> 只是空转、无害。
    // 沿用识别【有分段表】时 fixCustomJoin 恒 null ⇒ 不附：那条路的包裹与结构块由代码收进 head/tail 或保留区锚点，
    // 模型根本碰不到，再叮嘱「原样保留结构块」会与「系统已经替你收走了」自相矛盾。
    const custom = (ENABLE_FIX_CUSTOM_TASK && fixActiveMode === 'custom');
    const customRawTable = !!(custom && fixCustomJoin);
    const base = custom
        ? (fixCustomTemplateText + '\n\n' + P('fix.customFooter', null, s) + (customRawTable ? '\n' + P('fix.customRawNote', null, s) : ''))
        : (override || (fixActiveMode === 'manual'
            ? P('fix.manual', null, s)
            : resolveFixAutoPrompt({ promptVersion: fixAutoPromptVersion, promptFlavor: fixAutoPromptFlavor }, s)));
    let subst = (t) => t;
    if (ctx && typeof ctx.substituteParams === 'function') {
        subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    }
    const reply = fixTargetProse || '（未捕获到待校正的回复——请确认主聊天里已有一条 AI 回复）';
    const envelope = custom
        ? buildFixEnvelope({ reply })   // 📋 自定义：本版只发正文（角色卡 / 世界书 / 概要 / 前文有意不带，spec §10）
        : buildFixEnvelope({ card: fixCardBlock, world: fixWorldBlock, summary: fixSummaryBlock, context: fixContextBlock, reply });
    let prompt = subst(base) + '\n\n' + envelope;
    // 排除·保留区：正文里嵌了 ⟦SO_KEEP_n⟧ 占位锚点时，明确要求模型原样留在原位（弄丢了由 composeFixedReply 兜底接回）。
    if (Array.isArray(fixExtraKeep) && fixExtraKeep.length) {
        prompt += '\n\n' + P('fix.keepAnchors', null, s);
    }
    // 手动模式：尾附「结构块保留」软约束（自动走信封 / 分段保护，不需要——也避免干扰调优过的自动提示）。
    if (fixActiveMode === 'manual') {
        prompt += '\n\n' + fixManualStructuralNote();
    }
    return prompt;
}

// 无状态版诊断提示词构建器（用入参而非模块变量）——这样「自动诊断」后台运行能自建提示词、
// 不与窗口共享的 worldInfoBlock/diagStatData/diagLatestUpdate 抢状态。keepMechanism 这里强制
// 为 true：诊断是唯一需要读 <UpdateVariable> 区块的模式。
//
// auto=true 时进入「自动诊断」双模（见 ADDENDUM）：回复里有更新区块就核验修正；没有区块就把这条
// 回复的正文当输入、据 MVU 规则【推导】出本回合应有的更新——即充当 MVU「额外模型解析」的替代品
// （那也是每回合用另一个模型从回复里抽更新；二者择一，绝不并用——见首开警告）。latestReply 是这条
// AI 回复的正文（仅在没有更新区块的推导情形用到）。手动诊断 auto 缺省为假，行为与原先完全一致。
export function buildDiagnosePromptFrom(ctx, s, { wiBlock, statStr, latestBlock, latestReply, auto, derive, deadBlock }) {
    // 审计簇 J：数据段恒【逐字】，指令段照旧展开宏。
    // 原先整条拼好的 prompt 过一次 substituteParams —— 序列化状态里【字面写着】的 {{user}} 也被展开成
    // 真名：模型读到的是展开值，可它开出的补丁打在的却是字面数据（parseMessage 拿到的 stat_data 里就写着
    // {{user}}），路径 / 取值两头都可能瞄错。世界书模式早有「书文恒 VERBATIM」军规（补丁锚定的就是字面
    // 文本），诊断在此补齐。
    //   pushRaw（恒逐字）＝ 当前变量状态 / 最新更新区块 / 最新一条 AI 回复正文 —— 它们是【数据】；
    //                       小节标题本身无宏，跟正文一起走逐字最简单。
    //   push  （展开宏）＝ 模式提示词 / 自动诊断甲乙附则 / 世界书规则 / 角色卡 / 故事对话记录 ——
    //                       宏是这些文本的语义，冻住反而错。
    // 替换【逐段】进行：某一段的 substituteParams 抛错只吃掉那一段的展开（回落原文），其余段照常。
    const parts = [];
    const push = (text) => { parts.push({ text, verbatim: false }); };
    const pushRaw = (text) => { parts.push({ text, verbatim: true }); };

    push(P('diag.system', null, s));

    // 自动诊断附则：基础诊断提示词假设「当前状态已反映最新更新」——这在【没有区块、需从正文推导】
    // 的情形里是错的（没有任何机制写过这条回复）。
    // 1.40.2：两种情形【按 derive 分流下发】，不再把甲乙两段一起塞给模型。旧写法里「（乙）…当前状态
    // 【尚未】包含这条回复带来的变化…请充当变量更新引擎」这句在核验情形下也照样在提示词里，模型只能靠
    // 「哪个小节标题出现了」自行选边——高上下文下这是实打实的误选风险。现在它只会看到当下适用的那一段。
    if (auto) {
        push(deadBlock
            // 丙（1.69.0 D6）：回复里【有】区块，但 MVU 一条都没执行（漏闭合标签 / 标签带空白 /
            // 毒元素 / 全 move / 全开错根）。甲的「已经生效」在这里是【假的】，乙的「正文里没有
            // 区块」也是【假的】—— 两条都会把模型引向错误动作，故单列第三段。
            ? P('diag.autoDead', null, s)
            : (derive ? P('diag.autoDerive', null, s) : P('diag.autoVerify', null, s)));
    }

    // World info carries the card's MVU rules (blue/constant entries always fire).
    push(P('diag.rules', { wi: wiBlock || '' }, s));

    // 状态是【数据】：补丁按这里的字面路径 / 取值来开，展开宏就等于给模型看了一份假数据。
    pushRaw(P('diag.stat', { stat: statStr || '' }, s));

    // 更新区块 / 回复正文同理，全走逐字（下面五条分支都是 pushRaw）。
    // 丙（1.69.0）排在【最前】：那种回复往往【摘得到】一个闭合齐全的 <UpdateVariable>（坏的只是
    // 里面的 <JSONPatch>），若让 latestBlock 那一支先命中，模型会看到一个写着「待检查的更新」的
    // 小节 —— 等于把它引回核验，正是这次要修掉的那条死路。
    if (auto && latestReply && deadBlock) {
        pushRaw(P('diag.latestDead', { reply: latestReply }, s));
    } else if (latestBlock) {
        pushRaw(P('diag.latestBlock', { block: latestBlock }, s));
    } else if (auto && latestReply && derive) {
        // 推导情形：把整条回复正文交给模型，明确「正文里没有更新区块、请据此推导」。
        pushRaw(P('diag.latestDerive', { reply: latestReply }, s));
    } else if (auto && latestReply) {
        // 摘不到但探测得到（卡片用了非标准标签 / 区块被截断）：整条回复交给模型自己找那段更新来核验。
        // 措辞必须堵死「重推一遍」——这条路正是 1.40.2 修的双重计数入口。
        pushRaw(P('diag.latestUnparsed', { reply: latestReply }, s));
    } else {
        pushRaw(P('diag.latestNone', null, s));
    }

    if (s.includeCard) push(buildCardSection(ctx));

    const transcript = buildTranscript(ctx, s, /*keepMechanism*/ true);
    if (transcript) push(P('diag.transcript', { transcript }, s));

    const subst = (t) => { try { return ctx.substituteParams(t); } catch (e) { return t; } };
    return parts.filter((p) => p.text).map((p) => (p.verbatim ? p.text : subst(p.text))).join('\n\n');
}

export function buildLorebookPrompt(ctx, s) {
    const parts = [P('lb.system', null, s)];

    // 说话人格（仅当用户主动选了某个人格时）：管家指令之上叠一层语气皮肤，
    // 附带职责调整 + 结构保护（区块格式与围栏正文不受人格影响）。
    const personaBlock = buildPersonaBlock(s.personaId, 'lorebook', s);
    if (personaBlock) parts.push(personaBlock);

    // F5：世界书正文【不再】随这段指令走——它被移到全部对话历史之后的尾部〔世界书快照〕块
    //（buildLorebookSnapshotBlock，由 buildMessages / buildLorebookPresetMessages 追加）。这里只留
    // 管家指令 + 人格 + 可选故事上下文，书正文只在快照块里出现一次（避免重复投喂、并让书正文最新、贴近末尾）。

    if (s.lorebookIncludeStory) {
        // 柏宝书记忆桥 + 运行概要：骑「同时带上最近剧情对话」——管家的故事上下文本就在这个 opt-in 后面；
        // 时间线与普通模式同款：概要 → 摘要（旧）→ 对话（新）。桥 / 概要为空时零字节（既有约定）。
        // 预设路径 buildLorebookPresetMessages 的 loreBlock 就是本函数 ⇒ 这一处同时覆盖裸 / 预设两路。
        const summarySection = buildSummarySection(getSummary());
        if (summarySection) parts.push(summarySection);
        const bbsSection = buildBbsHistorySection(getBbsHistoryText());
        if (bbsSection) parts.push(bbsSection);
        const lwbSection = buildLwbHistorySection(getLwbSummaryText());   // 小白X 记忆桥（同位柏宝书）
        if (lwbSection) parts.push(lwbSection);
        const transcript = buildTranscript(ctx, s);
        if (transcript) parts.push(P('lb.transcript', { transcript }, s));
    }

    // 不跑 substituteParams：管家指令本身无宏，而书正文（现由尾部快照块承载）里的字面 {{user}}/{{char}}
    // 与大括号必须原样保留（替换会打乱锚点、还会把真名写死进条目）——这也是书正文不再随本函数走的原因之一。
    return parts.filter(Boolean).join('\n\n');
}

// F5 世界书快照块（纯函数、可单测）：把书正文包进带版本号 + 上次应用结果的尾部权威块。
//   bookText  = 书正文（buildLorebookContext 产出的 lbContextText，宏说明图例已在其头部、随之一并带上）。
//   applySnap = getLbApplySnapshot() 的返回（{serial, ops} 或 null）：决定版本号 + 有没有〔上次应用结果〕。
// 版本号：无快照 = 第 1 版（该聊天从未应用过）；有快照用其 serial。无 ops 时整段〔上次应用结果〕省略。
function formatLbSnapshotBlock(bookText, applySnap) {
    const book = (bookText == null || String(bookText).trim() === '')
        ? '（未读取到世界书 —— 请检查上方的选择。）'
        : String(bookText);
    const serial = (applySnap && Number.isFinite(applySnap.serial) && applySnap.serial >= 1) ? applySnap.serial : 1;
    const ops = (applySnap && Array.isArray(applySnap.ops)) ? applySnap.ops : [];
    return P('lb.snapshot', { serial: String(serial), applied: ops.map(lbFormatApplyLine).join('\n'), book });
}
// 非纯封装：从模块级 lbContextText + 当前聊天的应用快照现拼快照块。
function buildLorebookSnapshotBlock() {
    return formatLbSnapshotBlock(lbContextText, getLbApplySnapshot());
}
// 尾部快照消息（钉在全部对话历史之后；裸路径与预设路径共用，保证书正文只出现这一次、且恒在末尾）。
export function lbSnapshotMsg() {
    return { role: 'system', content: buildLorebookSnapshotBlock() };
}


// 剧情脉络状态块（2.5.0）：参谋讨论期间的全景，也是「找参谋改改」的修订依据。since = 当前节点开始以来的主聊天
// 消息数，由调用方传入。末尾那句是承重的：参谋重新提案时只交出「当前节点起剩下的部分」，adoptPath 的替换才接得上
// （它按 cursor 切，历史节点不动）——模型若把已完成的节点也重抄一遍，历史就会被当成新节点再走一遍。
function buildAdvisorPathBlock(path, since) {
    const mark = { done: '已完成', active: '进行中', pending: '未开始', skipped: '已跳过' };
    const nodes = path.nodes.map((n, i) => {
        const head = `${i + 1}.（${mark[n.status] || n.status}）${n.name}${n.keywords ? `：${n.keywords}` : ''}`;
        const d = String(n.detail || '').trim();
        return (d && (n.status === 'active' || n.status === 'pending')) ? `${head}\n   详细：${d}` : head;
    });
    return P('advisor.pathBlock', {
        title: path.title || '',
        overall: pathIsMulti(path) ? String(path.overall || '').trim() : '',
        progress: (pathIsMulti(path) ? pathProgressLabel(path) : '单个方案') + (path.paused ? '（引导已暂停，主聊天暂时没有注入）' : ''),
        speed: ADVISOR_SPEEDS[pathSpeedKey(path)].label,
        since: String(Math.max(0, Number(since) || 0)),
        nodes: nodes.join('\n'),
    });
}

// 参谋模式提示词：参谋指令 + 方案格式 + 人格（若选）+ 当前剧情脉络（若有，供"检查进度"）+ 角色卡 + 世界书 +
// 对话记录。over（可选）= { wi, stat }：显式给世界书和变量（「到了再写」的单独调用用），不传就用 generateReply
// 备好的那两个全局。
export function buildAdvisorPrompt(ctx, s, over) {
    const wiText = over ? over.wi : worldInfoBlock;
    const statText = over ? over.stat : advStatData;
    const parts = [P('advisor.system', null, s)];
    // 方案格式单独一段推，不并进内置正文——自定义过参谋提示词的用户覆盖掉的只是内置正文，格式仍到得了他们手上。
    // 预设路径复用本函数产物（advBlock），所以这一处同时喂到裸参谋与预设参谋两条路（同柏宝书 / 小白X 记忆桥的漏斗）。
    parts.push(P('advisor.format', { later: wantAutoDetail(s) ? '1' : '' }, s));

    // 说话人格（仅当用户主动选了某个人格时）：参谋指令之上叠语气皮肤，附带
    // 职责调整（构思未来剧情正是本职，不算「擅自续写」）+ 结构保护。
    const personaBlock = buildPersonaBlock(s.personaId, 'advisor', s);
    if (personaBlock) parts.push(personaBlock);

    // 当前正在引导主聊天的剧情脉络：参谋拿到它才能回答"检查进度"、按进度修订剩下的节点。计时口径与停滞提醒同源。
    const path = getPath();
    if (path) parts.push(buildAdvisorPathBlock(path, chatMsgCount() - (path.nodeStartAt || 0)));

    if (s.includeCard) parts.push(buildCardSection(ctx));

    // 变量状态：剧情的硬事实层。有 MVU 时给出，方案必须与数值现状自洽
    //（好感度还没到的别提结婚，钱包空的别提一掷千金）；无 MVU 卡时整段省略，
    // 不显示“不可用”占位——这对参谋是可选情报，不是必需输入。
    if (statText) {
        parts.push(P('advisor.stat', { stat: statText }, s));
    }

    // 外部扩展世界信息（世界引擎等）——参谋规划须知道后台正在酝酿的事件 / 势力动向（用户功能请求）。
    parts.push(buildChatWorldSection());

    if (wiText) {
        parts.push(P('ctx.wi', { wi: wiText }, s));
    }

    // 用户功能请求：运行概要插在对话记录的正前方。对话记录现遵循「上下文深度」设置（T13），
    // 概要对被裁剪掉早期剧情的长聊天尤其重要——参谋默认仍然读它。
    const summarySection = buildSummarySection(getSummary());
    if (summarySection) parts.push(summarySection);

    // 柏宝书记忆桥：与普通聊天同位（概要 → 摘要 → 对话记录）。参谋预设路径复用本函数产物（advBlock）。
    const bbsSection = buildBbsHistorySection(getBbsHistoryText());
    if (bbsSection) parts.push(bbsSection);
    // 小白X 记忆桥：与普通聊天同位。
    const lwbSection = buildLwbHistorySection(getLwbSummaryText());
    if (lwbSection) parts.push(lwbSection);

    // 遵循设置面板共享的「上下文深度」设置（T13：此前强制全量 contextDepth:-1）。
    const transcript = buildTranscript(ctx, s);
    if (transcript) {
        if (ENABLE_OFFSTAGE_GUARD) {
            // 戏外守卫：围栏（结构层）+ 尾锚（行为层）。字节冻结，改必重测（见常量处注释）。
            parts.push(wrapTranscriptEnvelope(transcript));
            parts.push(P('advisor.tail', null, s));
        } else {
            parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);
        }
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

export function buildCardSection(ctx) {
    const v = { char: '', user: '', description: '', personality: '', scenario: '', persona: '' };
    try {
        const f = ctx.getCharacterCardFields();
        v.char = ctx.name2 || '';
        v.user = ctx.name1 || '';
        v.description = f.description || '';
        v.personality = f.personality || '';
        v.scenario = f.scenario || '';
        v.persona = f.persona || '';
    } catch (e) { /* group chat or no char selected */ }
    return Object.values(v).some(Boolean) ? P('ctx.card', v) : '';
}

// 一条主聊天消息是否进入喂给神谕的剧情记录。默认排除 /hide 的隐藏楼层（is_system）；
// includeHidden（用户设置 includeHiddenFloors）勾选后纳入。纯谓词，便于单测。
function messageVisibleForTranscript(m, includeHidden) {
    return !!m && (includeHidden || !m.is_system) && typeof m.mes === 'string';
}

// Story-context turns as role-tagged objects {role:'user'|'assistant', name, text}.
// Mirrors ST's prompt builder: drop system messages, run each through the regex
// engine (isPrompt, depth relative to full chat), trim empties, take last N.
export function buildTranscriptTurns(ctx, s, keepMechanism = diagnoseMode) {
    if (s.contextDepth === 0) return [];
    const coreChat = (ctx.chat || []).filter((m) => messageVisibleForTranscript(m, s.includeHiddenFloors));
    const useRegex = s.applyRegex && regexEngine && regexEngine.getRegexedString;

    let processed = coreChat.map((m, index) => {
        let text = m.mes;
        if (useRegex) {
            const placement = m.is_user
                ? regexEngine.regex_placement.USER_INPUT
                : regexEngine.regex_placement.AI_OUTPUT;
            const depth = coreChat.length - index - 1; // last message = depth 0
            try {
                text = regexEngine.getRegexedString(text, placement, { isPrompt: true, depth });
            } catch (e) {
                console.warn('[Story Oracle] regex failed on a message; using raw.', e);
            }
        }
        return {
            role: m.is_user ? 'user' : 'assistant',
            name: m.name || (m.is_user ? ctx.name1 : ctx.name2),
            // v1.14.5：主聊天消息里嵌着的 <UpdateVariable> 是【增量】不是【状
            // 态】——普通/参谋模式的模型看到「好感度+5」这种碎片、又没有权威
            // 基线，就会自信地推算出离谱数值。除诊断模式外（读这些区块正是诊
            // 断的本职），一律从喂给神谕的剧情记录里剥掉。整条消息只剩区块时
            // 会变成空串，被下方的过滤器自然丢弃。
            text: keepMechanism ? text : stripMechanismBlocks(text),
        };
    });

    processed = processed.filter((l) => l.text && l.text.trim() !== '');
    if (s.contextDepth > 0) processed = processed.slice(-s.contextDepth);
    return processed;
}

export function buildTranscript(ctx, s, keepMechanism) {
    return buildTranscriptTurns(ctx, s, keepMechanism).map((l) => `${l.name}: ${l.text}`).join('\n\n');
}

// v1.14.1 修复：用户预设里常带「每条回复末尾必须输出 <UpdateVariable>」的输出
// 契约（MVU 卡），忠实组装会让神谕也继承它——于是神谕的回复尾巴上挂出一个对
// 主聊天毫无意义的机制区块（“Variables remain unchanged”之类）。主聊天里这
// 些区块由 MVU 自己的管线消化隐藏，神谕没有那条管线，所以原样可见，还会写进
// 神谕历史让后续回合越锁越死。普通 / 参谋模式下从显示与历史两头剥掉它。
// v1.14.5 起也用于【喂入神谕的主聊天剧情记录】（见 buildTranscriptTurns）：
// 消息里的更新区块是增量不是状态，留着只会诱导模型瞎报数值。
// v1.40.2 起跨方言（MVU_BLOCK_DIALECTS）：卡片用 <update>/<json_patch> 这类自定义标签时，旧实现漏剥 →
// 那些增量片段原样泄进普通 / 参谋的提示词，正是本函数要防的事。inner 门在【原文】上判一次（剥完块之后
// 内层标签就没了，届时再判会漏掉截断尾巴）。
export function stripMechanismBlocks(text) {
    let out = String(text || '');
    const src = out;
    for (const d of MVU_BLOCK_DIALECTS) {
        if (!mvuDialectInnerOk(src, d)) continue;
        out = out.replace(mvuBlockRegex(d.wrapper, 'gi'), '');
        // 被截断、没闭合的尾部区块也剥掉（开标签一路到结尾）。
        out = out.replace(new RegExp('<' + d.wrapper + '\\b[^>]*>[\\s\\S]*$', 'i'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// 思维链（CoT）标签——某些自定义补全预设或推理模型会把 <think> / <thinking> 这类
// 思考区块直接吐进回复正文里。主聊天靠自带管线把它们藏起来，神谕没有那条管线，于是
// 它们会原样显示在气泡里；用户的「清理思维链」正则往往是按某一个预设调的，常常漏网。
// 所以这里做一道内置兜底，用在普通 / 参谋模式的回复上（显示 + 历史两头都剥）。
export const REASONING_TAGS = ['think', 'thinking', 'thought', 'reasoning', 'reflection', 'cot'];

export function stripReasoningTags(text) {
    let out = String(text || '');
    for (const tag of REASONING_TAGS) {
        // 已知结构化区块的开标签白名单——pass 0 和 pass 2 都要用，提到循环体顶部（放在 pass 0
        // 之前，否则先引用后声明会抛 ReferenceError/TDZ）。这些区块绝不能被当思维链删掉。
        const BLOCK_OPENERS = '(?:CharDraft|CharBrief|DraftPatch|Story[_-]?Plan|Story[_-]?Sequence|Node[_-]?Detail|FixedReply|LorebookEdit|UpdateVariable)';
        // 0) 闭标签出现在任何开标签之前：预设把 <think> 预填进 assistant 消息（开标签在提示词里、
        //    补全里只剩闭标签），或推理模型省略开标签、只回「思考内容</think>正文」——从开头到
        //    闭标签整段都是思维链，连内容一起删。护栏：闭标签之前若已开了已知结构区块（<StoryPlan>
        //    等），则不动（fail-open 交给 pass 3 只删标签字面量），绝不误吞成稿——与 pass 2 同理。
        const close = out.match(new RegExp('<\\/' + tag + '\\b[^>]*>', 'i'));
        if (close) {
            const open = out.match(new RegExp('<' + tag + '\\b[^>]*>', 'i'));
            const block = out.match(new RegExp('<' + BLOCK_OPENERS + '\\b', 'i'));
            if ((!open || close.index < open.index) && (!block || close.index < block.index)) {
                out = out.slice(close.index + close[0].length);
            }
        }
        // 1) 成对区块（大小写不敏感、跨行、容忍属性）——最常见的情况，连内容一起删。
        out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), '');
        // 2) 被截断、没闭合的开标签——原则上从开标签删到结尾（同 stripMechanismBlocks）。
        //    但模型有时写满思考忘了闭合、直接接着输出正文区块（真实案例：完整 CharDraft 被
        //    整个吞成「空回复」，用户白丢一份好稿；<StorySequence> 序列卡同理）——所以后文若出现
        //    已知结构区块的开标签，只删到区块开始处。
        out = out.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?(?=<' + BLOCK_OPENERS + '\\b)|<' + tag + '\\b[^>]*>[\\s\\S]*$', 'i'), '');
        // 3) 任何残留的孤立标签（如推理放在单独字段、只漏出一个 </think>）——只删标签本身、
        //    保留周围文字，确保标签字面量绝不残留在屏幕上。
        out = out.replace(new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Run a finished Oracle reply through the enabled AI_OUTPUT regex.
//   forPrompt=true  -> prompt stage (what ST feeds back into context); used for
//                      the copy stored in history, so the Oracle doesn't
//                      re-ingest its own think tags / status bars next turn.
//   forPrompt=false -> display stage (markdown); rarely needed directly because
//                      renderReplyHtml() applies it via ST's own formatter.
export function applyOutputRegex(text, forPrompt) {
    if (!regexEngine || !regexEngine.getRegexedString || !regexEngine.regex_placement) return text;
    try {
        const opts = forPrompt
            ? { isPrompt: true, isMarkdown: false, depth: 0 }
            : { isPrompt: false, isMarkdown: true, depth: 0 };
        const out = regexEngine.getRegexedString(String(text || ''), regexEngine.regex_placement.AI_OUTPUT, opts);
        return (typeof out === 'string') ? out : text;
    } catch (e) {
        console.warn('[Story Oracle] output regex failed; using raw reply.', e);
        return text;
    }
}

// Render a reply to sanitized HTML using ST's OWN message formatter — the same
// path main chat uses — so display-stage regex, markdown, and HTML/CSS widgets
// (e.g. a status-bar beautifier) render identically here. Returns null if the
// formatter isn't available, signaling the caller to fall back to plain text.

// 只渲染 Markdown（不跑 ST 正则引擎）——用于普通聊天【关闭「应用正则」】时的显示。showdown + DOMPurify 均由 ST 挂在 window 上。
// 拿不到库时返回 null，调用方回退纯文本（jsdom 无这两个库 → null → textContent，安全）。
export function renderMarkdownOnly(text) {
    try {
        if (!soMdConverter && typeof window !== 'undefined' && window.showdown) {
            setSoMdConverter(new window.showdown.Converter({ simpleLineBreaks: true, strikethrough: true, tables: true, literalMidWordUnderscores: true }));
        }
        if (soMdConverter && typeof window !== 'undefined' && window.DOMPurify) {
            const html = window.DOMPurify.sanitize(soMdConverter.makeHtml(String(text || '')));
            if (typeof html === 'string' && html) return html;
        }
    } catch (e) {
        console.warn('[Story Oracle] markdown render failed; showing raw text.', e);
    }
    return null;
}
export function renderReplyHtml(text) {
    const ctx = getCtx();
    try {
        if (typeof ctx.messageFormatting === 'function') {
            const html = ctx.messageFormatting(String(text || ''), ctx.name2 || '剧情推进', false, false, null);
            if (typeof html === 'string' && html) return html;
        }
    } catch (e) {
        console.warn('[Story Oracle] messageFormatting failed; showing raw text.', e);
    }
    return null;
}

// ✨ 校正结果卡的渲染分道（1.84.1）。
// 背景：有些卡/预设的「美化」不是内联小部件（状态栏、天气头、思维链折叠那种），而是一整份 HTML
// 文档——显示阶段正则把正文替换成一个 ``` 代码围栏，围栏里装着 <!DOCTYPE html>…。主聊天里
// 酒馆助手（JS-Slash-Runner）会把这种围栏渲成 iframe 并藏掉 <pre>；神谕窗口没有那个渲染器，
// 于是 ST 格式化出来的 <pre><code>&lt;!DOCTYPE html&gt;…</code></pre> 就原封不动地摊在结果卡上
// （创世回廊 ~100KB 字面 HTML，正文埋在里头 —— Discord 报障）。
// 处置（中间路线）：保留今天的「照主聊天渲染」，只在【ST 格式化后的 HTML 里出现酒馆助手会 iframe 掉的
// <pre>】这一种情形整条改走 renderMarkdownOnly（showdown + DOMPurify，不跑 ST 正则）——内联美化
// 一律照旧逐字节渲染。判据与酒馆助手 src/util/is_frontend.ts 对齐（三子串 'html>' / '<head>' / '<body'，
// 对【解码后】的 <pre> 文本判定，因为格式化输出的是 &lt;!DOCTYPE html&gt;）。
// ✂️ 选段结果走 textContent、流式直播本就是纯文本，都不经这里，一个字不动。
// PURE（只读传入字符串 + 一次性 <template> 解析）：判定 ST 格式化后的 HTML 里是否有
// 酒馆助手会当成「前端界面」接管的 <pre> 代码块。任何异常 / 无 DOM → false（fail-open = 今天的行为）。
function fixHtmlHasFrontendPayload(html) {
    if (typeof html !== 'string' || !html) return false;
    try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        const root = tpl.content || tpl;
        const pres = root.querySelectorAll ? root.querySelectorAll('pre') : [];
        for (const pre of pres) {
            const text = String(pre.textContent || '');
            // 酒馆助手 isFrontend：三子串任一命中即接管为 iframe（src/util/is_frontend.ts）。
            if (text.includes('html>') || text.includes('<head>') || text.includes('<body')) return true;
        }
    } catch (e) {
        console.warn('[Story Oracle] frontend-payload probe failed; keeping ST formatting.', e);
    }
    return false;
}

// 校正结果卡专用渲染器：先照常走 ST 格式化；只有当结果里含 iframe 型前端载荷时才整条退回
// 纯 Markdown 渲染。返回 null 与 renderReplyHtml 同义（调用方回退 textContent）。
export function renderFixResultHtml(text) {
    const html = renderReplyHtml(text);
    if (html == null) return null;
    if (!fixHtmlHasFrontendPayload(html)) return html;
    return renderMarkdownOnly(text);
}


// PURE：把参谋回复按 <StoryPlan> 块切成有序段表（1.18.2 参谋 Markdown）。平铺不变量：
// segments.map(g=>g.text).join('') === 原文——渲染层怎么分道都绝不丢字。闭合块与 parseStoryPlans 同一
// 配对规则（大小写不敏感、非贪婪到最近闭合、同样容错 <story_plan>/<story-plan> 等方言变体）；未闭合的
// 尾部 <StoryPlan>（截断回复）整段算方案块，免得半截方案被 Markdown 搅碎——这条 EOF 救援 parseStoryPlans
// 也有，两侧【完全一致】。孤儿 </StoryPlan> 留在散文里（parseStoryPlans 同样无视它）。
// 1.72.0 序列引导：<StorySequence> 卡走同一条 raw 段（渲染层照旧进 <pre class="so-plan-raw">，
// 采纳卡由 parseStorySequences 另行从【字符串】解析）。开关关时表达式退回 1.71.0 那条正则字面量
// = 字节惰性。⚠ 有意【不用反向引用】配对：开闭标签各自按变体匹配，才与上面那条「第三块闭标签
// snake_case」的容错逐字一致。
function splitStoryPlanSegments(text) {
    const t = String(text || '');
    if (!t) return [];
    const out = [];
    const re = /<Story[_-]?(?:Plan|Sequence)>[\s\S]*?<\/Story[_-]?(?:Plan|Sequence)>|<Story[_-]?(?:Plan|Sequence)>[\s\S]*$/gi;
    let last = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
        if (m.index > last) out.push({ type: 'prose', text: t.slice(last, m.index) });
        out.push({ type: 'plan', text: m[0] });
        last = m.index + m[0].length;
    }
    if (last < t.length) out.push({ type: 'prose', text: t.slice(last) });
    return out;
}

// 参谋回复的显示渲染（1.18.2）：散文段渲 Markdown（只走 renderMarkdownOnly，不碰正则引擎——参谋不是主聊天，
// 不该被显示正则/挂件加工），<StoryPlan> 块进 <pre class="so-plan-raw"> 转义原样（采纳卡在气泡下方照旧，
// 由 parseStoryPlans 从【字符串】解析，与这里的 DOM 渲染无关）。库缺失（无 showdown/DOMPurify）→ 返回 null，
// 调用方回退纯文本；纯散文回复与普通聊天关正则时同路输出。
export function renderAdvisorReplyHtml(text) {
    const segs = splitStoryPlanSegments(text);
    if (!segs.some((g) => g.type === 'plan')) return renderMarkdownOnly(String(text || ''));
    let html = '';
    for (const g of segs) {
        if (g.type === 'plan') {
            // 2.5.0：解析得出来的方案块不再原样显示（下面的卡片就是它）；解析不出的照旧进 <pre>，免得内容凭空消失。
            if (!parseStoryPlans(g.text).length) html += '<pre class="so-plan-raw">' + escapeHtml(g.text) + '</pre>';
        } else if (g.text.trim()) {
            const h = renderMarkdownOnly(g.text);
            if (h == null) return null;   // 库缺失 → 整条回退纯文本（不出半渲染的杂拼）
            html += h;
        }
    }
    return html;
}

export function buildMessages() {
    const s = getSettings();
    if (lorebookMode && s.lorebookUsePreset && presetCurationActive(s)) {
        return buildLorebookPresetMessages(s);
    }
    if (advisorMode && s.advisorUsePreset && presetCurationActive(s)) {
        return buildAdvisorPresetMessages(s);
    }
    if (fixMode && fixUsePresetFor(s, 'manual') && presetCurationActive(s)) {
        return buildFixPresetMessages(s);   // 自由发挥（手动）：用户那句话在 convoForPrompt() 里，directive 省略
    }
    if (builderMode && s.bldUsePreset && presetCurationActive(s)) {
        return buildBuilderPresetMessages(s);   // 访谈经预设（opt-in）；锻造走 runForge，永不经此
    }
    if (diagnoseMode && s.diagnoseUsePreset && presetCurationActive(s)) {
        // 诊断经预设（1.43.0，opt-in）：破限 / 越狱用。directive 省略 = 用户那句话在 convoForPrompt() 里
        return buildDiagnosePresetMessages(s, buildDiagnosePrompt(getCtx(), s));
    }
    if (!diagnoseMode && !lorebookMode && !advisorMode && !fixMode && !builderMode && presetCurationActive(s)) {
        return buildPresetMessages(s);
    }
    // 内置破限（1.40.0）：包裹神谕自己建好的这一组。普通聊天默认开、其余模式一律 opt-in（诊断自 1.43.0 起也接得上，门是 diagnoseUsePreset）
    // ——判定全在 modeWantsJb 里。上面那些 presetCurationActive 分支走的是【真预设替换】通道，
    // 与内置破限互斥（哨兵在 presetCurationActive 里已被排除），所以只需要在这一条裸路径上接。
    const wrapped = maybeWrapJb(
        [{ role: 'system', content: buildSystemPrompt() }, ...convoForPrompt()],
        currentJbModeKey(), s);
    // F5：世界书模式把书正文钉成【全部对话历史之后】的尾部快照块（唯一权威；只此一处，末尾恒在）。
    if (lorebookMode) wrapped.push(lbSnapshotMsg());
    return wrapped;
}