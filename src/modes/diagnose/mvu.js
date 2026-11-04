import { getCtx } from '../../core/settings.js';
import { sharedState } from '../../core/state.js';
import { REASONING_TAGS } from '../chat/context.js';
import { mvuMsgOpts } from './auto.js';
import { MVU_BLOCK_DIALECTS } from '../../prompts/builtins.js';
import { detectMvuBlockDialect, mvuBlockRegex, mvuDialectInnerOk } from '../../prompts/helpers.js';

/* ------------------------------------------------------------------ *
 * MVU（MagVarUpdate）集成 —— 普通聊天 / 参谋附带当前变量状态（stat_data）用，只读。
 * ------------------------------------------------------------------ */
export async function getMvu() {
    if (sharedState.mvuApi) return sharedState.mvuApi;
    if (window.Mvu) { sharedState.mvuApi = window.Mvu; return sharedState.mvuApi; }
    const th = window.TavernHelper;
    if (th && typeof th.waitGlobalInitialized === 'function') {
        try {
            sharedState.mvuApi = await Promise.race([
                th.waitGlobalInitialized('Mvu'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);
            if (sharedState.mvuApi) return sharedState.mvuApi;
        } catch (e) { /* fall through */ }
    }
    return window.Mvu || null;
}

// 纯函数：从一份 MvuData 里取出【当作状态看】的那一坨。正常卡上就是 stat_data；形状离奇（压根没有
// stat_data —— 少数卡把变量直接摊在 MvuData 顶层）时退回整份对象。
// ⚠ 这个回退口径必须是【全仓唯一】的一份（whole-branch review FIX 5），别在调用点另写一套。可单测。
export function mvuStatOf(data) {
    return (data && data.stat_data) ? data.stat_data : (data ?? null);
}

export async function getMvuStatData() {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') return null;
    try {
        return mvuStatOf(Mvu.getMvuData(mvuMsgOpts()));
    } catch (e) {
        console.warn('[Story Oracle] getMvuData failed:', e);
        return null;
    }
}

// 返回最近一条 AI 回复的 { idx, text }。idx 用于把推导出的更新块写回该消息（自动诊断衍生情形）。
export function getLatestAiMessage() {
    const chat = getCtx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) return { idx: i, text: m.mes };
    }
    return { idx: -1, text: '' };
}
export function getLatestAiMessageText() {
    return getLatestAiMessage().text;
}

// 纯函数：给定 chat 与【触发本轮自动处理的消息 id】，返回应处理的目标 { idx, text }。【钉住触发消息】而非
// 重扫「最近一条 AI 回复」——修 auto 校正 / 诊断偶发「改到上一条而非最新一条」：编排（maybePostReply）在延时 +
// 一次 LLM 往返之后才选目标，其间队尾可能变（触发消息此刻尚空 / 已被下一条顶掉 / 楼层被删），getLatestAiMessage
// 便回退到更早的一条。这里要求目标【仍是一条非空 AI 回复】：id 为空 / 越界 / 用户 / 系统 / 空白 → 视为已失效，
// 返回 { idx:-1, text:'' } 让调用方干净跳过（绝不误伤更早的回复）。nullish 安全。单测 fix-auto-target.test.mjs。
export function resolveAutoTargetMessage(chat, messageId) {
    const list = Array.isArray(chat) ? chat : [];
    if (messageId == null) return { idx: -1, text: '' };                       // null / undefined → 已失效
    const idx = Number(messageId);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return { idx: -1, text: '' };
    const m = list[idx];
    if (!m || m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) return { idx: -1, text: '' };
    return { idx, text: m.mes };
}

// 纯函数（数据变更）：把 text 作为【新 swipe】追加到消息 m 上并切到它——非破坏性，原 m.mes 留在
// swipe 0。若消息还没有 swipes 数组，先用当前 m.mes 播种 swipe 0。info（swipe 元数据）由调用方传入，
// 便于纯函数确定性单测。返回新的 swipe_id；m 无效返回 -1。可单测。
export function addSwipeToMessage(m, text, info) {
    if (!m || typeof m !== 'object') return -1;
    if (!Array.isArray(m.swipes) || m.swipes.length === 0) {
        m.swipes = [typeof m.mes === 'string' ? m.mes : ''];
        m.swipe_info = [Array.isArray(m.swipe_info) && m.swipe_info[0] ? m.swipe_info[0] : {}];
        m.swipe_id = 0;
    }
    if (!Array.isArray(m.swipe_info)) m.swipe_info = m.swipes.map(() => ({}));
    m.swipes.push(String(text == null ? '' : text));
    m.swipe_info.push(info || {});
    m.swipe_id = m.swipes.length - 1;
    m.mes = m.swipes[m.swipe_id];
    // Bug 3：换到新 swipe 后，作废渲染器写在 extra.display_text 上的【旧回复渲染缓存】。ST 的 updateMessageBlock
    // 渲染的是 extra.display_text ?? mes——小白X（LittleWhiteBox，本卡正用它）/ 翻译扩展会把渲染稿写进
    // display_text，不清掉它屏幕就停在旧回复，要用户点一下/划一下才切到校正稿（用户反馈：「自动修正后要调出界面
    // 才切到修正后的回复」）。对齐 ST 原生 swipe 的 loadFromSwipeId → clearMessageData（同样 delete display_text）。
    if (m.extra && typeof m.extra === 'object') delete m.extra.display_text;
    return m.swipe_id;
}

// 摘出这段文本里的更新区块（跨方言，见 MVU_BLOCK_DIALECTS）。取【文本里最早出现】的那一块——
// 自动诊断写回后一条消息里可能同时躺着卡片的方言块和神谕补的经典块，先来的那个才是这一楼原本的更新。
// 摘不到 → ''（调用方据此判断，但 甲/乙 判定另用 detectMvuBlockDialect 兜底，见 runAutoDiagnose）。
export function extractUpdateBlock(text) {
    const s = String(text == null ? '' : text);
    let best = '';
    let bestAt = Infinity;
    for (const d of MVU_BLOCK_DIALECTS) {
        if (!mvuDialectInnerOk(s, d)) continue;
        const m = s.match(mvuBlockRegex(d.wrapper));
        if (m && m.index < bestAt) { best = m[0]; bestAt = m.index; }
    }
    return best;
}

// 纯函数：这段【模型产出】里是否已经带着一个更新区块（跨方言，走 MVU_BLOCK_DIALECTS，绝不手搓正则）。
// 语义刻意【宽松】——与 detectMvuBlockDialect 同一口径：开标签在就算数（块被模型改写、截断、没闭合也算）。
// 用途只有一个：📋 自定义模板任务的「整条」路把 MVU 块一起交给了模型，模型很可能把块【改写】了（例如
// 「整篇翻译」会连块里的中文分析一起译）。composeFixedReply / mergeMvuTail 的补接判据是【逐字包含】，
// 分不清「模型弄丢了块」与「模型改写了块」——后者会让改写版与原版【同时】落进一条消息 = MVU 地雷 ②
// （一条消息两个更新区块 → 卡片的贪婪显示正则连状态栏一起吞掉，1734 张卡只有 123 张幸存）。
// 宽松判据是这里的 fail-safe 方向：宁可少接一次（块本来就在模型稿里），绝不多接出第二块。可单测。
export function fixOutputHasMvuBlock(text) {
    return !!detectMvuBlockDialect(text);
}

// 纯函数：把"排除标签"输入解析成标签名数组。每行 / 逗号分隔一项；项可写成开标签 <konatan_planning~> 或裸名 konatan_planning。
export function parseExcludeTagNames(str) {
    return String(str || '').split(/[,\n]+/)
        .map((s) => { const m = s.trim().replace(/^<\/?/, '').match(/^[A-Za-z0-9_一-龥-]+/); return m ? m[0] : ''; })
        .filter(Boolean);
}

// 纯函数（fix-exclude-nested-bracket.test.mjs）：把「排除区」输入解析成 [{name, bracket}]。每行 / 逗号一项。
// <tag> / </tag> / 裸名 tag → 尖括号块（bracket:false）；[tag] / [/tag] → 方括号块（bracket:true，如图生指令 [IMG_GEN]…[/IMG_GEN]）。
// 名字按标签名字符集（含中文、下划线、连字符）提取，容错前缀 < / </ / [ / [/。空 / 杂项 → 丢弃。
export function parseExcludeTags(str) {
    return String(str || '').split(/[,\n]+/).map((s) => {
        const t = s.trim();
        if (!t) return null;
        const bracket = t.charAt(0) === '[';
        const m = t.replace(/^[<[]\/?/, '').match(/^[A-Za-z0-9_一-龥-]+/);
        return m ? { name: m[0], bracket } : null;
    }).filter(Boolean);
}

// 排除·保留区占位标记：keep 块从 prose 里抠走时，原位留下 ⟦SO_KEEP_n⟧ 作锚点（n = 该块在 keepBlocks 里的下标），
// 让 composeFixedReply 能把原块还原【回原位】，而不是一律接到末尾（用户报的「保留块被挪到故事结尾」bug）。⟦⟧ 是罕见
// 数学括号，正文几乎不可能自然出现；模型被 buildFixPrompt 提示原样保留，万一弄丢由 composeFixedReply 兜底接回（不丢内容）。
const FIX_KEEP_MARK = '⟦SO_KEEP_';
export function fixKeepPlaceholder(i) { return FIX_KEEP_MARK + i + '⟧'; }
export function stripFixKeepMarks(t) { return String(t == null ? '' : t).replace(new RegExp(FIX_KEEP_MARK + '\\d+⟧', 'g'), ''); }

// 纯函数：从 reply 里抠出用户指定的"排除区"。keep 标签的整块（含截断未闭合）抠出后【原位留下占位标记 ⟦SO_KEEP_n⟧】
// 并把原块收进 keepBlocks（composeFixedReply 据标记还原回原位）；drop 标签的块抠出后直接丢弃（无标记）。两者都从 prose
// （送去校正的正文）里移除。返回 { prose, keep, keepBlocks }。可单测（fix-exclude*.test.mjs）。
// 【深度配平】（1.17.9）：按开 / 闭标签计数找【配平】的整块——嵌套同名标签（<div> 套 <div>）抠的是【最外层】整块，
// 而非旧非贪婪正则「外开配第一个内闭」把结构切碎（用户报的「<div> 放进保留区也没用、整段被肘碎」根因）。
// 【方括号块】（1.17.9）：[IMG_GEN]…[/IMG_GEN] 这类方括号分隔块同样支持（图生卡常用；parseExcludeTags 的 bracket）。
// 孤立闭合标签（深度 0、无配对开标签）留在 prose；开了没闭（截断）→ 取到结尾。各标签按列表顺序逐一抠（与旧版同）。
export function extractExcludedSections(reply, keepStr, dropStr) {
    let prose = String(reply || '');
    const keepBlocks = [];
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';   // 标签名后不得再跟名字字符（避免 <plan> 误匹配 <planning> / [IMG] 误匹配 [IMGX]；兼容中文标签）
    const pull = (spec, collect) => {
        const n = esc(spec.name);
        // 按尖 / 方括号给出开、闭标记的正则源（方括号块允许 [name attrs] 形态，闭标记 [/name]）。
        const openSrc = spec.bracket ? ('\\[' + n + nb + '[^\\]]*\\]') : ('<' + n + nb + '[^>]*>');
        const closeSrc = spec.bracket ? ('\\[\\/' + n + nb + '[^\\]]*\\]') : ('<\\/' + n + nb + '[^>]*>');
        const tokRe = new RegExp('(' + openSrc + ')|(' + closeSrc + ')', 'gi');
        const spans = [];
        let depth = 0, spanStart = -1, m;
        while ((m = tokRe.exec(prose)) !== null) {
            if (m[1] != null) {                                  // 开标签：深度 0→1 记起点，向上计数
                if (depth === 0) spanStart = m.index;
                depth += 1;
            } else if (depth > 0) {                              // 闭标签：向下计数，回到 0 即一整块配平
                depth -= 1;
                if (depth === 0) spans.push([spanStart, m.index + m[0].length]);
            }                                                    // 深度 0 的孤立闭合标签：忽略（留在 prose）
        }
        if (depth > 0 && spanStart >= 0) spans.push([spanStart, prose.length]);   // 截断：开了没闭 → 取到结尾
        if (!spans.length) return;
        let out = '', last = 0;
        for (const [a, b] of spans) {                            // 文档顺序遍历 → keepBlocks 文档顺序、占位标记落原位
            out += prose.slice(last, a);
            if (collect) { out += fixKeepPlaceholder(keepBlocks.length); keepBlocks.push(prose.slice(a, b)); }
            // drop：什么都不接（块被丢弃）
            last = b;
        }
        prose = out + prose.slice(last);
    };
    for (const spec of parseExcludeTags(keepStr)) pull(spec, true);
    for (const spec of parseExcludeTags(dropStr)) pull(spec, false);
    prose = prose.replace(/\n{3,}/g, '\n\n').trim();
    return { prose, keep: keepBlocks.join('\n\n'), keepBlocks };
}

// ✨ 思考块保护（W1 2026-08-16，§3.1 缺陷修复）：从 REASONING_TAGS（生产权威——同一常量管显示剥离与
// Zone-2 永久排除，绝不另列名单）派生要交给 extractExcludedSections 的 keep 串。只列【文本里真出现
// 开标签】的家族名（逗号分隔）；disabled / 无命中 → ''（extractExcludedSections 收 '' = 完全不抠，
// 字节面与旧行为一致）。只认开标签（'<'+名字，'</' 不算）：孤立闭合标签没有块可保护，交给旧行为。
// 名字边界与 extractExcludedSections 的 nb 同式（<think> 不误配 <thinkX>）。纯函数可单测
// （fix-manual-think-protect.test.mjs）。TDZ 提示：REASONING_TAGS 在本文件更靠后声明——本函数只在
// 运行时（captureFixContext）被调用，模块求值阶段不会碰它。
export function fixThinkKeepSpec(text, enabled) {
    if (!enabled) return '';
    const s = String(text == null ? '' : text);
    if (!s) return '';
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    return REASONING_TAGS.filter((t) => new RegExp('<' + t + nb, 'i').test(s)).join(',');
}

// ✨ 思考块保护回执（W1）：n 个思考区块被码侧收走、校正后原样接回——保护绝不静默（告知 + 指路开关，
// 「用户指令优先」经关开关兑现）。纯函数可单测；测试只钉关键词（块数 + 「思考」），不钉全句。
// 文案待 Prince 过目（候选 2/3 见 REPORT-FIXROUND-2026-08-16.md）
export function fixThinkProtectNote(n) {
    return '🛡 已保护 ' + n + ' 个思考区块（<think> 思维链等）：未送去改写，应用后原样留在原处。'
        + '若要连思考块一起改，请在 ✨ 校正设置（手动）里关闭「保护思考区块」后重试。';
}

// ✨ 校正「只校正 <content> 内」作用域（纯函数，单测钉 fix-content-scope.test.mjs）。
// splitContentScope —— 把回复按【正文标签】拆成「信封 + 内层正文」：prefix + <tag…> + inner + </tag> + suffix。
//   只有 inner 会送去校正，其余作为信封【逐字保留、原位回插】——绝不抽出重排，所以正文【外】的状态栏 / 选项 /
//   世界书 / htmlcontent 地图 / UpdateVariable / 占位符 全都原地不动（这正是「排除区逐个枚举又对嵌套同名标签失效」
//   的根治：反过来只圈定要改的正文，其余一律不动）。tag 为空 / 回复里找不到该标签 → {active:false}，调用方回退到
//   「校正整条回复」的旧行为（简单卡不受影响）。截断（只有 <tag> 没 </tag>）→ inner 取到结尾、close/suffix 空。
//   只作用域【第一处】<tag>…</tag>，其余留在 suffix（不丢、不改）。tag 名经 parseExcludeTagNames 容错
//   （content / <content> / </content> 等价）。<content> 不会误命中 <contentX>（nb 名字边界）。
export function splitContentScope(reply, tagName) {
    const name = parseExcludeTagNames(tagName)[0] || '';
    if (!name) return { active: false };
    const text = String(reply == null ? '' : reply);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    const mo = text.match(new RegExp('<' + esc + nb + '[^>]*>', 'i'));
    if (!mo) return { active: false };
    const prefix = text.slice(0, mo.index);
    const open = mo[0];
    const rest = text.slice(mo.index + open.length);
    const mc = rest.match(new RegExp('<\\/' + esc + nb + '[^>]*>', 'i'));
    if (!mc) return { active: true, prefix, open, inner: rest, close: '', suffix: '' };   // 截断：内层取到结尾
    return { active: true, prefix, open, inner: rest.slice(0, mc.index), close: mc[0], suffix: rest.slice(mc.index + mc[0].length) };
}

// 把校正后的内层正文回插信封原位：prefix + <tag…> + innerFixed + </tag> + suffix。inactive → 直接返回 inner（无操作）。
export function wrapContentScope(scope, innerFixed) {
    const inner = String(innerFixed == null ? '' : innerFixed);
    if (!scope || !scope.active) return inner;
    return scope.prefix + scope.open + inner + scope.close + scope.suffix;
}