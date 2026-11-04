import { getSummary, persistConvo } from '../../core/chat-metadata.js';
import { getCtx } from '../../core/settings.js';

import { buildCardSection, buildTranscriptTurns, composeSummaryWithBridges, renderFixResultHtml, stripMechanismBlocks } from '../chat/context.js';
import { registerFixApply } from '../chat/history.js';
import { chatIdentityKey } from '../chat/send.js';
import { extractExcludedSections, fixThinkKeepSpec, fixThinkProtectNote, getLatestAiMessage, parseExcludeTags, resolveAutoTargetMessage, splitContentScope } from '../diagnose/mvu.js';
import { detectScopeTag, fixCustomRawTable, fixKeepNameSet, fixScopeVerdict, fixSegmentReply, fixTableCounts, proseCharCount, resolveFixPieces } from './algorithms.js';
import { fixDropMinusKeep, fixUsePresetFor, getEffectiveFixCfg, getFixCfg, resolveFixCustomCfg, resolveFixModeCfg } from './templates.js';
import { ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_PIECEWISE, ENABLE_WI_EJS_RENDER, STATUS_PLACEHOLDER } from '../../prompts/builtins.js';
import { fixNoOp } from '../../prompts/helpers.js';
import { buildWorldInfo, buildWorldInfoSplit, sideChatScanBlob } from '../../st/adapters.js';
import { addFixApplyControls, parseFixReply } from '../../ui/messages.js';
import { presetCurationActive } from '../../ui/settings.js';
import { setWiAfter, setWiBefore } from '../chat/state.js';
import { fixActiveMode, fixCaptured, fixCustomJoin, fixExtraKeep, fixOriginalReply, fixPieceDecision, fixPieceTable, fixScope, fixTargetIdx, fixTargetProse, fixThinkProtected, setFixActiveMode, setFixAutoPromptFlavor, setFixAutoPromptVersion, setFixCaptured, setFixCardBlock, setFixContextBlock, setFixCustomJoin, setFixExtraKeep, setFixOriginalReply, setFixPieceDecision, setFixPieceTable, setFixScope, setFixScopeDecision, setFixSummaryBlock, setFixTargetIdx, setFixTargetProse, setFixThinkProtected, setFixWorldBlock } from './state.js';

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4 —— 目标完整性守卫（M1）+ 两个数据完整性缺陷。PURE 层（无 DOM / 无副作用 / 确定）
 * 外加两个读 getCtx 的运行时薄封装（chatIdentityKey / fixCurrentSnapshot）。把「这份校正稿到底该不该写进这条
 * 回复」的判据抠成可单测的纯函数：
 *   · P-CORRUPT（切聊天跨聊天写）：捕获触发时的聊天身份 + 目标快照；应用前若聊天已切 / 目标已变 → 不写、记一条。
 *   · P-TRUNC（截断稿被应用）：模型回复被中转 / max_tokens 截断 → 半句稿会腰斩回复 → 不应用、记一条。
 * ------------------------------------------------------------------ */

// 纯函数：陈旧判定真值表。captured/current 均为普通对象 {chatId,targetIdx,swipeId,fingerprint,prose}（current 另带
// exists?:boolean）。优先级【自上而下】：缺任一 → gone；chatId 变 → chatSwitched（P-CORRUPT，压过一切）；目标
// 消失（exists:false / targetIdx 空 / <0）→ gone；swipe 变 → swipeChanged；指纹变 → contentChanged；否则 ok。
// prose 只随行、【不参与】判定。可单测（fix-target-integrity.test.mjs）。
// ✨ overlap（fixWaitForMvu）：把回复剥成【纯叙述正文】用于陈旧比对——去掉【两种】机制块：<UpdateVariable>（stripMechanismBlocks
// 管）+ 状态栏占位符 <StatusPlaceHolderImpl/>（stripMechanismBlocks【不】管，得单独去）。MVU 额外模型更新两样都会事后注入，
// 只有把两样都剥掉，捕获时 vs 写入时的正文才可比——正文一致 = 只 MVU 动过 → 放行。纯函数、nullish 安全、可单测。
function fixBodyProse(text) {
    const noPlaceholder = String(text == null ? '' : text).split(STATUS_PLACEHOLDER).join('');
    return stripMechanismBlocks(noPlaceholder);   // stripMechanismBlocks 内含收敛空行 + trim
}

export function fixTargetStale(captured, current, opts) {
    const o = opts || {};
    if (!captured || !current) return { stale: true, reason: 'gone' };
    if (current.chatId !== captured.chatId) return { stale: true, reason: 'chatSwitched' };
    if (current.exists === false || current.targetIdx == null || current.targetIdx < 0) return { stale: true, reason: 'gone' };
    if (current.swipeId !== captured.swipeId) return { stale: true, reason: 'swipeChanged' };
    // ✨ overlap 版（fixWaitForMvu）：MVU 额外模型更新会在回复末尾注入 <UpdateVariable> + 占位符——那是【预期】变化，
    // 会让整条 m.mes 的指纹变。mvuTolerant 时改比【去机制块的正文 bodyProse】：正文一致 = 只有 MVU 动过 → 放行；
    // 正文变了（用户编辑 / 换成别的回复）→ 仍判陈旧。换 swipe / 切聊天 / 目标没了 上面已各自拦下，安全网不塌。
    if (o.mvuTolerant) {
        if (current.bodyProse !== captured.bodyProse) return { stale: true, reason: 'contentChanged' };
    } else if (current.fingerprint !== captured.fingerprint) {
        return { stale: true, reason: 'contentChanged' };
    }
    return { stale: false, reason: 'ok' };
}

// 纯函数：便宜确定性指纹——长度 + djb2 滚动哈希（36 进制）。对【整条 m.mes】取；捕获与应用两端比对以检测这条
// 回复是否在校正往返期间被编辑 / 换 swipe。不追求抗碰撞，只要「同文同指纹、异文极大概率异指纹」。nullish 安全。
export function fixFingerprint(text) {
    const s = String(text == null ? '' : text);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;   // h*33 + c，逐步夹在 32 位
    return s.length + ':' + (h >>> 0).toString(36);
}

// 纯函数：截断检测。finish==='length'（上游 finish_reason，或 R1 合成：<FixedReply> 开了没闭）→ 权威判截断；
// 空成品 → empty。启发式【三条全中才算截断】：成品末尾无终止标点 且 原文收尾干净 且 成品散文字数 < 原文一半——
// 单看任一条都会误伤（✂️收紧本就合法缩短；RP 片段本就常无标点收尾），保守 AND 才不挡合法校正。终止标点正则与
// 0.5 比例【就地内联】（不设常量）。复用 proseCharCount。可单测。
export function fixOutputTruncated(fixedText, finish, originalText) {
    if (finish === 'length') return { truncated: true, reason: 'length' };
    const fixed = String(fixedText == null ? '' : fixedText).trim();
    if (!fixed) return { truncated: true, reason: 'empty' };
    const orig = String(originalText == null ? '' : originalText).trim();
    const term = /[。．.！!？?…⋯~〜」』】）)"”’\]]$/;   // CJK + ASCII 终止 / 收尾标点
    const fixedMidSentence = !term.test(fixed);
    if (fixedMidSentence && term.test(orig) && proseCharCount(fixed) < 0.5 * proseCharCount(orig)) {
        return { truncated: true, reason: 'midSentenceShort' };
    }
    if (fixedMidSentence) return { truncated: false, reason: 'midSentenceOnly' };   // 断句但不短 → 放行
    return { truncated: false, reason: 'ok' };
}

// 纯函数：目标消息【当前】swipe 是否已是一次校正结果（applyFixAsSwipe 在 swipe_info[...].extra.story_oracle_fix
// 打了 true）。只看当前 swipe（防止在校正稿上再叠一层）。nullish 安全。可单测。
export function isFixSwipe(m) {
    return m?.swipe_info?.[m.swipe_id]?.extra?.story_oracle_fix === true;
}

// 运行时薄封装（非导出）：读【当前】getCtx() 造出 current 快照供 fixTargetStale 比对。复用 resolveAutoTargetMessage
// 的「仍是非空 AI 回复」判据（失效 → idx:-1 → exists:false → gone）；指纹取当前 m.mes；swipe 取当前 swipe_id。
export function fixCurrentSnapshot(idx) {
    const ctx = getCtx();
    const chat = (ctx && ctx.chat) || [];
    const t = resolveAutoTargetMessage(chat, idx);
    const exists = t.idx >= 0;
    const m = exists ? chat[t.idx] : null;
    return {
        chatId: chatIdentityKey(),
        targetIdx: t.idx,
        swipeId: exists ? ((m && m.swipe_id) | 0) : -1,
        fingerprint: fixFingerprint(m ? m.mes : ''),
        // ✨ overlap（fixWaitForMvu）：纯叙述正文（去 <UpdateVariable> + 状态栏占位符）——MVU 注入这两样不改它，用户真编辑才改。
        bodyProse: fixBodyProse(m ? m.mes : ''),
        exists,
        prose: '',
    };
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 5 —— 按聊天懒检测 + 记忆 + 静默兜底（D+E）。PURE 决策层
 * （无 DOM / 无副作用 / 确定；无时钟无随机；不发 LLM 调用）。复用 Phase 1 的 detectScopeTag /
 * fixScopeVerdict，不重新扫描——这里只把「这条回复该用哪个作用域标签、要不要出提示」的判断收拢成
 * 一张可单测的决策表：
 *   缓存命中（cachedTag 在这条回复里找得到）→ 直接用、不重检测（省 detectScopeTag 的开销）。
 *   缓存未命中 → 按来源分流：自动（用户没手填过）→ 高置信就采纳新标签并记住（下次就是缓存命中）；
 *     中低置信 / 检测出来的还是同一个标签（这条只是个例）→ 静默跳过这条，不瞎猜也不整条校正（D）。
 *   手动（用户明确填过）→ 永不代替用户改写，只在侧聊建议、原样跳过这条（E）。
 *   两种来源有一个共同例外：这条回复压根没有任何信封结构（noWrapper）→ 校正整条回复本就安全、正确
 *   （D 的例外——没有结构可保护，就没有「误伤」这回事）。
 * ------------------------------------------------------------------ */

// 纯函数：给定 chat，取【最近 n 条非空 AI 回复】原文，供 detectScopeTag 当嗅探语料。排除 chat[0]
// （开场白 / 问候语可能不代表卡片真实回复形态，见设计 §3「懒检测」）；跳过用户 / 系统消息与空白/非字符串；
// 按时间顺序（旧→新）返回，条数不足 n 也不补齐。nullish / 非数组 chat → []。可单测。
export function recentAiReplies(chat, n = 5) {
    const list = Array.isArray(chat) ? chat : [];
    const lim = Math.max(1, Number(n) || 5);
    const picked = [];
    for (let i = list.length - 1; i >= 1 && picked.length < lim; i -= 1) {   // 止步于下标 1：排除 chat[0]
        const m = list[i];
        if (!m || m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        picked.push(m.mes);
    }
    return picked.reverse();   // 出栈顺序是新→旧，翻回旧→新（与 buildTranscriptTurns 等「前文数组」的惯例一致）
}

// 纯函数：D+E 决策核。reply = 已【钉住】的待校正回复原文（cache-hit 用 fixScopeVerdict 判在场；钉住来自
// resolveAutoTargetMessage，未必是「最新一条」——刻意与 replies 分开传参，两者合并会重犯 1.17.12
// 「改到上一条」那次教训）；replies = 供 detectScopeTag 嗅探用的最近 AI 回复语料（不含 reply 本身也没关系——
// 嗅探要的是【卡片的一般形态】，不是这一条本身）。
//   action:
//     'fallbackWhole' —— 用户主动留空作用域【或】这条回复所在的语料压根没有信封结构（noWrapper，D 的
//                        例外）→ 校正整条回复；tag 回空串，active:false。
//     'cache'         —— 缓存的 cachedTag 在这条回复里找得到 → 直接用，不重检测；tag 原样回传，active:true。
//     'detected'      —— 缓存未命中 + 自动来源 + 高置信 + 检测出的标签≠缓存 → 采纳新标签（调用方负责
//                        setFixCfg 写回 + 缓存，本函数只判断不写状态）；tag 换成检测到的标签，active:true。
//     'skip'          —— 缓存未命中，但不该猜：自动来源且检测结果就是缓存本身（这条是个例，note 码
//                        skipAnomaly）；或置信不够（note 码 skipUncertain）→ 跳过这条，不改、不整条校正；
//                        tag 原样回传（仅供参考），active:false。
//     'suggest'       —— 缓存未命中 + 手动来源（用户明确填过标签，永不代替用户改写）→ 只建议、不采纳；
//                        tag 原样回传，active:false。
//   note: null | { code, cachedTag, detectedTag }，code ∈ 'detected'|'suggest'|'skipAnomaly'|'skipUncertain'。
//   标签比较大小写不敏感（cache-hit 判定复用 fixScopeVerdict/splitContentScope 内建的不敏感匹配；
//   det.tag ↔ cachedTag 的「是否同一个标签」比较本函数自己转小写再比）。nullish 安全（各参数缺省视作
//   空/关闭，委托 fixScopeVerdict / detectScopeTag 自身的 nullish 兜底）。可单测。
export function resolveFixScope({ cachedTag, scopeManual, reply, replies }) {
    const cached = (cachedTag == null) ? '' : String(cachedTag);
    if (!cached.trim()) return { tag: '', active: false, action: 'fallbackWhole', note: null };   // 用户主动关闭作用域（opt-out）

    const verdict = fixScopeVerdict(reply, cached, '');
    if (!verdict.danger) return { tag: cached, active: true, action: 'cache', note: null };   // 缓存命中——无需重检测

    const det = detectScopeTag(replies);
    if (det.noWrapper) return { tag: '', active: false, action: 'fallbackWhole', note: null };   // D 例外：无信封可保护，整条本就安全

    const manual = !!scopeManual;
    if (!manual) {
        if (det.confidence === 'high') {
            const same = det.tag.toLowerCase() === cached.toLowerCase();
            if (same) return { tag: cached, active: false, action: 'skip', note: { code: 'skipAnomaly', cachedTag: cached, detectedTag: det.tag } };
            return { tag: det.tag, active: true, action: 'detected', note: { code: 'detected', cachedTag: cached, detectedTag: det.tag } };
        }
        return { tag: cached, active: false, action: 'skip', note: { code: 'skipUncertain', cachedTag: cached, detectedTag: '' } };
    }
    const detectedTag = (det.confidence === 'high') ? det.tag : '';   // 只在高置信时才给出候选，认不准就不瞎猜
    return { tag: cached, active: false, action: 'suggest', note: { code: 'suggest', cachedTag: cached, detectedTag } };
}

// 纯函数：resolveFixScope 的 note 码 → 人话文案表（仿 fixEnvNote / autoDiagNoteContent 的 reason→人话查表）。
// emoji：detected ✨（采纳新标签）/ suggest ⚠️（提醒但不代劳）/ skipAnomaly、skipUncertain 都是 ⏭️（跳过）。
// nullish-safe：note 为空 / 非对象 / 无法识别的 code → 都回 { emoji:'', body:'' }（调用方据此自然不出提示）。
export function fixScopeNoteText(note) {
    if (!note || typeof note !== 'object') return { emoji: '', body: '' };
    const cachedTag = String(note.cachedTag || '');
    const detectedTag = String(note.detectedTag || '');
    if (note.code === 'detected') {
        return { emoji: '✨', body: `检测到本卡正文标签是 <${detectedTag}>，已自动切换（原设 <${cachedTag}> 这条回复里没找到）。` };
    }
    if (note.code === 'suggest') {
        const body = detectedTag
            ? `你设的 <${cachedTag}> 不在这条回复里；检测到的可能是 <${detectedTag}>，要改就去校正设置里改（已跳过、未动这条回复）。`
            : `你设的 <${cachedTag}> 不在这条回复里，也没能猜出别的候选；已跳过、未动这条回复——去校正设置里检查一下作用域标签。`;
        return { emoji: '⚠️', body };
    }
    if (note.code === 'skipAnomaly') {
        return { emoji: '⏭️', body: `这条回复没找到 <${cachedTag}>，但最近其它回复都还在用它——像是这条的个例，已跳过、未动它（没有误改整条）。` };
    }
    if (note.code === 'skipUncertain') {
        return { emoji: '⏭️', body: `这条回复没找到 <${cachedTag}>，也认不准换成了哪个标签；已跳过、未动这条回复，避免误改整条。` };
    }
    // ✨ 分段校正（1.18.0）新码：
    if (note.code === 'autoWrapped') {
        return { emoji: '✨', body: `已自动识别本卡正文标签 <${detectedTag}>——之后每条回复只校正标签内的正文，标签外的结构块原样保留（点「扫描」可更改）。` };
    }
    if (note.code === 'noNarrative') {
        return { emoji: '⏭️', body: '这条回复没有可校正的正文（全是结构块 / 正文太短），已跳过、未改动。' };
    }
    return { emoji: '', body: '' };
}

// ✨ 校正模式「自动配置」Phase 6（B+C 扫描面板用）——纯函数：把扫描出的结构块并入用户现有【保留区】标签串。
// 去重按「名 + 分隔符」大小写不敏感；existing 内容在前、新增块按传入顺序每行一个追加；existing 里已有的不重复加。
// blocks = detectInnerBlocks 的 [{name,bracket}]。existing/blocks nullish 安全。复用 parseExcludeTags 解析已有串。
export function mergeKeepTags(existing, blocks) {
    const cur = String(existing == null ? '' : existing);
    const have = new Set(parseExcludeTags(cur).map((sp) => (sp.bracket ? '[' : '<') + sp.name.toLowerCase()));
    const add = [];
    for (const b of (Array.isArray(blocks) ? blocks : [])) {
        if (!b || !b.name) continue;
        const key = (b.bracket ? '[' : '<') + String(b.name).toLowerCase();
        if (have.has(key)) continue;
        have.add(key);
        add.push(b.bracket ? ('[' + b.name + ']') : ('<' + b.name + '>'));
    }
    if (!add.length) return cur;
    return cur + ((cur && !cur.endsWith('\n')) ? '\n' : '') + add.join('\n');
}

// 抓取待校正回复 + 按开关备好上下文块。含前文用 buildTranscriptTurns 多取一条再去掉末条——末条就是待校正回复本身
// （已在 <text_to_transform>，不重复喂；与 recast 的 slice(-(N+1),-1) 同理）。generateReply 的 fixMode 分支与 runFixByTargets 共用。
// mode='manual'（在输入框直接说要改什么）或 'auto'（按目标校正按钮 / 每条新回复自动校正）。两套设置经
// resolveFixModeCfg 归一后彻底独立：手动=上下文丰富 / 无目标 / 不收紧 / 无排除区；自动=按 fixA_* 的目标 + 上下文 +
// 排除区 + 收紧。排除区仅自动有（手动 keepTags/dropTags 恒空）；MVU 机制块两模式都自动剥离（composeFixedReply 原样接回）。
export async function captureFixContext(s, { mode = 'manual', targetId, wholeFloor = false } = {}) {
    const ctx = getCtx();
    let manualScopeMissed = '';   // 二创版 2.1：整篇手动填了正文标签、这条回复里却没有它 → 标签名（调用方据此提示）
    // 这样「按目标校正」/ 自动 / 选段校正 都不可能捡到上一次的画布（否则会用错契约解析）。
    // 走【本聊天】生效值（per-chat 覆盖全局 s），再按 mode 归一成手动 / 自动各自的一套——绝不直读 fixM_/fixA_ 原始键。
    const cfgRaw = getEffectiveFixCfg(s, getFixCfg());
    // 📋 自定义模板任务：沿用自动那套归一（作用域 / 阶梯 / 分段），只把两区换成自定义档自己的（两区同名 → 保留优先）。
    const cc = (ENABLE_FIX_CUSTOM_TASK && mode === 'custom') ? resolveFixCustomCfg(cfgRaw) : null;
    const norm = resolveFixModeCfg(cfgRaw, cc ? 'auto' : mode);
    if (cc) { norm.keepTags = cc.keepTags; norm.dropTags = fixDropMinusKeep(cc.keepTags, cc.dropTags); }
    setFixCustomJoin(null);
    const autoLike = mode === 'auto' || (cc && cc.useMechanic);   // 自定义·沿用识别 = 自动的捕获路径
    // 自动·事件驱动（runAutoFix 经 maybePostReply 传入触发消息 id）→ 钉住那条；手动 / 「按目标校正」按钮无 id → 仍取最近一条。
    const latest = (targetId != null) ? resolveAutoTargetMessage(ctx.chat, targetId) : getLatestAiMessage();
    setFixTargetIdx(latest.idx);
    // ✨ 作用域（仅自动；用户功能请求）：若设了正文标签（默认 content）且回复里确有该标签 → 只校正 <content> 内层，
    // 正文外的所有块作为【信封】逐字保留、原位回插（应用时 wrapContentScope）。找不到该标签 / 留空 → active:false，
    // baseText 回退整条回复（旧行为，简单卡不受影响）。后续 extractExcludedSections / 机制块剥离 / 看改动 都基于 baseText。
    // ✨ Phase 5（D+E）：不再直接 splitContentScope(norm.scopeTag) —— 缓存的标签可能已经不在这条回复里了（卡片
    // 格式变了 / 这条回复是个例）。resolveFixScope 先判「缓存是否命中」，未命中再按来源（自动可自纠 / 手动只建议）
    // 决定用哪个标签、要不要出提示；本函数只负责【决策 + 落状态】，不写配置也不发通知——那是 runAutoFix /
    // runFixByTargets（D+E 门）的事，这里保持 captureFixContext「只搭建上下文」的既有契约。手动模式没有自动识别：
    // 只有整篇手动填了正文标签（fixM_scopeTag，二创版 2.1）时才按那个标签拆信封，见下方最后一个分支。
    if (autoLike && ENABLE_FIX_PIECEWISE) {
        // ✨ 分段校正（1.18.0）：决策阶梯（提议→确认一次→记住）取代 resolveFixScope（老路径完整保留在下面的
        // else-if，关开关即字节回退）。wrapped 干净单块走 bypass = 字面老路径（fixScope 单段作用域，逐字节
        // 不变）；多块 / 内嵌结构 / 已确认 bare 建分段表（fixPieceTable），由 runAutoFixPieces /
        // runFixByTargetsPieces 逐段调用 + 原位回拼。本函数只【决策 + 落模块状态】，不写配置不发通知——
        // 采纳 / 记忆 / 提示是 runAutoFix / runFixByTargets 的事（与 1.17.16 的分工惯例一致）。
        const dec = resolveFixPieces({ pieceMode: norm.pieceMode, scopeTag: norm.scopeTag, scopeManual: norm.scopeManual, pieceAsked: norm.pieceAsked, reply: latest.text });
        setFixScopeDecision(null);
        setFixPieceTable(null);
        setFixScope({ active: false });
        if (dec.action === 'run' && dec.mode === 'wrapped') {
            const table = fixSegmentReply(latest.text, { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(norm.keepTags) });
            if (table.bypass && !cc) {
                setFixScope(splitContentScope(latest.text, dec.tag));   // 干净单块：字面老路径（📋 自定义留着单块表 → 恒有 join）
            } else if (!table.pieces.length) {
                dec.action = 'skip'; dec.note = { code: 'noNarrative' };   // P7：包裹里全是结构 → 可读跳过
            } else {
                setFixPieceTable(table);
            }
        } else if (dec.action === 'run' && dec.mode === 'bare') {
            const table = fixSegmentReply(latest.text, { mode: 'bare' });
            if (!table.pieces.length) { dec.action = 'skip'; dec.note = { code: 'noNarrative' }; }
            else setFixPieceTable(table);
        } else if (dec.action === 'ask' || dec.action === 'pending') {
            // 提案计数按提案形态建表：wrapped 提案（梯 7.5 未知包裹名）用该标签的 wrapped 表，bare 提案用 bare 表。
            dec.proposal = fixTableCounts(fixSegmentReply(latest.text, (dec.mode === 'wrapped' && dec.tag)
                ? { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(norm.keepTags) }
                : { mode: 'bare' }));
            if (!dec.proposal.pieces) { dec.action = 'skip'; dec.note = { code: 'noNarrative' }; }   // 全结构：没什么可确认
        }
        setFixPieceDecision(dec);
    } else if (autoLike) {
        const dec = resolveFixScope({ cachedTag: norm.scopeTag, scopeManual: norm.scopeManual, reply: latest.text, replies: recentAiReplies(ctx.chat, 5) });
        setFixScopeDecision(dec);
        setFixPieceDecision(null);
        setFixPieceTable(null);
        setFixScope(dec.active ? splitContentScope(latest.text, dec.tag) : { active: false });
    } else {
        setFixScopeDecision(null);
        setFixPieceDecision(null);
        setFixPieceTable(null);
        // 二创版 2.1：整篇手动也能只改某个标签里的正文（fixM_scopeTag）。只认 wholeFloor：✂️ 选段家族同以
        // mode:'manual' 进来、只取上下文槽，绝不能被作用域改掉字节面。标签不在这条回复里 → 退回整条，并告诉调用方。
        const wantScope = wholeFloor && mode === 'manual' && norm.scopeTag;
        setFixScope(wantScope ? splitContentScope(latest.text, norm.scopeTag) : { active: false });
        if (wantScope && !fixScope.active) manualScopeMissed = norm.scopeTag;
    }
    // 📋 自定义模板任务（spec §5.2）：「整条」= 跳过整套阶梯，原文 + 自带两区 → raw 表（不剥 MVU）。沿用识别但阶梯没建出表
    // （whole：没包裹也没结构；或分段开关关着）→ 同一张表但 raw:false（仍剥 MVU、composeFixedReply 接回）。
    if (cc && !cc.useMechanic) {
        setFixScopeDecision(null); setFixPieceDecision(null); setFixPieceTable(null); setFixScope({ active: false });
        setFixCustomJoin(fixCustomRawTable(latest.text, cc.keepTags, cc.dropTags, { raw: true }));
    } else if (cc && !fixPieceTable && !(fixPieceDecision && ['ask', 'pending', 'suggest', 'skip'].includes(fixPieceDecision.action))) {
        setFixScope({ active: false });
        setFixCustomJoin(fixCustomRawTable(latest.text, cc.keepTags, cc.dropTags, { raw: false }));
    }
    // 分段表在场：baseText = 各段 core 拼接——只用于「有没有可校正正文」早退与 R2/预过滤语义；真正逐段的
    // 抠保留区 / 剥机制块 / 建提示在 fixPieceCall 里按【单段】重做。无表：老语义原样（作用域内层 / 整条）。
    const baseText = fixCustomJoin ? fixCustomJoin.core : (fixPieceTable ? fixPieceTable.pieces.map((p) => p.core).join('\n\n') : (fixScope.active ? fixScope.inner : latest.text));
    setFixOriginalReply(baseText);   // 机制块接回 + 看改动「before」基于作用域内层（作用域外的块在信封里、不参与校正与差异）
    // ✨ 思考块保护（W1 2026-08-16，§3.1 修复）：手动整篇校正把 REASONING_TAGS 家族思考块经【既有】保留区机械
    // （extractExcludedSections → ⟦SO_KEEP_n⟧ 原位锚 → composeFixedReply 原样接回）码侧收走——模型看不到 =
    // 结构性不可删（实测整篇手动 6/10 静默删光整块 <thinking>，软约束挡不住）。两重门：
    // ① wholeFloor —— 只有 generateReply 的手动整篇分支传 true（✂️ 选段 / 批量选段同以 mode:'manual' 进来，
    //    但只取上下文槽，字节面必须不动）；
    // ② norm.protectThink（fixM_protectThink，默认开）——用户可关 =「用户指令优先」的真出口：码侧收走后模型
    //    看不到块，提示词例外条款够不着；要模型改思考块，先关保护。
    const thinkKeep = (wholeFloor && mode === 'manual')
        ? fixThinkKeepSpec(baseText, norm.protectThink) : '';
    const ex = fixCustomJoin
        ? { prose: fixCustomJoin.core, keepBlocks: fixCustomJoin.keepBlocks }   // 📋 raw 表已抠过两区，不再抠第二遍
        : extractExcludedSections(baseText, thinkKeep || norm.keepTags, norm.dropTags);   // 排除区（自动=用户 keepTags；手动整篇=思考块保护）
    setFixTargetProse((fixCustomJoin && fixCustomJoin.raw) ? ex.prose : stripMechanismBlocks(ex.prose));   // 仍自动剥离 MVU 机制块（<UpdateVariable>，composeFixedReply 会原样接回）；📋 整条 raw：不剥
    setFixExtraKeep(ex.keepBlocks);   // 保留区块数组（composeFixedReply 按 ⟦SO_KEEP_n⟧ 位置还原，而非接到末尾）
    setFixThinkProtected(thinkKeep ? ex.keepBlocks.length : 0);   // 回执计数（renderFixCard 消费；非保护路径恒 0）
    // ✨ Phase 4 目标完整性：抓下这次校正的【身份 + 目标快照】。应用前（尤其手动卡「应用」的延迟点击、以及自动
    // 在 LLM 往返后）用 fixTargetStale 比对，聊天已切（P-CORRUPT）/ 目标换 swipe / 内容变更 / 目标消失 → 不写、记一条。
    // 指纹取整条 m.mes（换 swipe 后 mes 也变，两端不一致即拦下）；prose 存去机制块正文，供 addFixApplyControls 廉价截断复检。
    setFixCaptured({
        chatId: chatIdentityKey(),
        targetIdx: latest.idx,
        swipeId: (ctx.chat[latest.idx]?.swipe_id) | 0,
        fingerprint: fixFingerprint(ctx.chat[latest.idx]?.mes),
        prose: fixTargetProse,
        // ✨ overlap（fixWaitForMvu）：捕获时（MVU 写块【之前】）的纯叙述正文（去 <UpdateVariable> + 状态栏占位符）；写入前与当前比对——只有 MVU 注块 → 一致 → 放行。
        bodyProse: fixBodyProse(latest.text),
    });
    // 📜剧情概要（手动默认带、自动可选）；buildFixEnvelope 包成 <story_summary>。柏宝书记忆桥沿用同一
    // 开关（勾了概要才一并带柏宝书摘要——信封只有一个概要槽，composeSummaryWithBbs 合成；桥空 = 原样）。
    setFixSummaryBlock(norm.includeSummary ? composeSummaryWithBridges(getSummary()) : '');
    setFixActiveMode(mode);              // buildFixPrompt 据此选系统提示：手动 → FIX_SYSTEM_PROMPT_MANUAL；自动 → 轻校恒收紧版 / 精校按侧重（1.18.3）
    setFixAutoPromptVersion(norm.promptVersion);   // ✨ 精校版本（仅自动生效；手动 norm 恒 'light'）；'thorough' → buildFixPrompt 用精校
    setFixAutoPromptFlavor(norm.promptFlavor);     // ✨ 精校侧重（'deepseek' / 'opus'）
    if (norm.includeContext) {
        const depth = norm.contextDepth | 0;              // -1（或任何非正数）= 全部前文
        const fetchDepth = depth > 0 ? depth + 1 : -1;    // 多取 1 条以便下面去掉待校正回复；非正数→-1 取全部
        const turns = buildTranscriptTurns(ctx, { ...s, contextDepth: fetchDepth }, false);
        const prior = turns.slice(0, -1);   // 去掉末条（待校正回复本身）
        setFixContextBlock(prior.map((l) => `${l.name}: ${l.text}`).join('\n\n'));
    } else {
        setFixContextBlock('');
    }
    // 卡 / 世界书：经【自定义补全预设】发送时（fixM_/fixA_usePreset + 已精选预设），由预设的 charDescription / worldInfo 标记在
    // 各自位置提供（见 buildFixPresetMessages 的 expandMarker），故信封里【不再带】卡 / 世界书（slim，免重复）——
    // 改备 before/after 两槽给那两个标记。否则（普通发送）按 fix 模式上下文开关带卡 / 世界书。概要 / 前文两模式都仍在信封里。
    // 手动校正：侧聊最近问答（校正房间里的指示 / 讨论）参与绿灯扫描（1.31.0）；自动校正是后台跑，
    // 房间里只有 note 记录（本就不参与）——不传，保持逐字节稳定。
    const fixSideScan = mode === 'manual' ? await sideChatScanBlob() : '';
    if (fixUsePresetFor(s, mode) && presetCurationActive(s)) {
        setFixCardBlock('');
        setFixWorldBlock('');
        const split = await buildWorldInfoSplit(undefined, fixSideScan, { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs && mode === 'manual' });   // 仅【手动】校正 = READ 家族；自动校正后台跑 → 恒 raw
        setWiBefore(split.before);
        setWiAfter(split.after);
    } else {
        setFixCardBlock(norm.includeCard ? buildCardSection(ctx) : '');
        setFixWorldBlock(norm.includeWorld ? await buildWorldInfo('st', fixSideScan, { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs && mode === 'manual' }) : '');   // 仅【手动】校正执行世界书 EJS；自动 → raw
    }
    return { manualScopeMissed };
}

// 校正卡的「解析成功 → 渲染 → 出按钮」公共段：generateReply 的 fixMode 分支与 runFixByTargets 共用（Phase 2b 评审要求去重）。
// 只处理解析成功这一支（真正重复的那段）：历史存干净校正正文 + persistConvo + 把校正稿渲染进 .so-content（同普通回复
// 路径，不动 .so-bubble.innerHTML，否则会连角色标签/复制重生删除按钮一起抹掉）+ 在 .so-bubble 层挂「发现并修正」note
// + 出「应用到回复」按钮条。读 module 级 fixOriginalReply/fixTargetIdx/fixExtraKeep（captureFixContext 已抓好）。
// 返回 true=已渲染校正卡；false=解析不出 <FixedReply>，**失败处理留给各调用点自己做**（两处失败语义不同：手动分支此时
// .so-content 已显示剥离后的 cleanText、不应覆盖；按目标分支要把原文/「（空回复）」回填——故不在这里统一）。
export function renderFixCard(assistantEl, contentEl, aEntry, finalText) {
    // 手动宽容 / 自动严格：路由归一成 status；非 ok（'truncated' / 'unparseable'）原样回传给调用点出对应提示。
    const r = parseFixReply(finalText, fixActiveMode);
    if (r.status !== 'ok') return r.status;
    // P-TRUNC：解析成功但成品像是被截断（<FixedReply> 开了没闭 / 末尾断句且明显偏短）→ 当截断处理，回传
    // 'truncated' 让调用点提示「调大 token / 重试」并【不出应用按钮】——半句稿会腰斩这条回复。
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(r.fixed, finishHint, fixTargetProse).truncated) return 'truncated';
    const parsed = { fixed: r.fixed, problems: r.problems };   // 保持下游 parsed.fixed / parsed.problems / addFixApplyControls 契约不变
    aEntry.content = parsed.fixed;   // 历史里存干净的校正正文，而非原始 <FixedReply> 标签
    persistConvo();
    const html = renderFixResultHtml(parsed.fixed);
    if (html != null) {
        contentEl.innerHTML = html;
        contentEl.classList.add('so-rendered');
        contentEl.style.whiteSpace = 'normal';
    } else {
        contentEl.textContent = parsed.fixed;
    }
    // 无改动检测：模型把原文原样返回（手动模式没有 <problems> 可解释——否则用户只看到「同样的输出、没说明」，
    // 这正是用户报的「偶尔拒绝改动、又不解释」）。明确告知，且【不出「应用」按钮】——应用一条与原文相同的 swipe 没意义。
    if (fixNoOp(fixTargetProse, parsed.fixed)) {
        const note = document.createElement('div');
        note.className = 'so-fix-changes';
        note.textContent = '模型没有做出改动——它认为按当前要求无需修改。可换一句更具体的指令、或调整目标后再试。';
        assistantEl.querySelector('.so-bubble')?.appendChild(note);
        return 'ok';   // 已处理（解析失败那条 note 不该再补）；但不挂应用按钮
    }
    if (parsed.problems) {
        const note = document.createElement('div');
        note.className = 'so-fix-changes';
        note.textContent = '发现并修正：\n' + parsed.problems;
        // 「发现并修正」note 挂在 .so-bubble 层（同 addApplyControls 的做法），落在 .so-content 下方而非混进正文。
        assistantEl.querySelector('.so-bubble')?.appendChild(note);
    }
    // ✨ 思考块保护回执（W1 2026-08-16）：本次捕获抠走了思考块 → 卡下一行可见回执（保护绝不静默——
    // 告知 + 指路开关）。仅整篇手动路径会有计数（captureFixContext 保护条件），按目标 / 自动经此函数时恒 0。
    const thinkNote = fixThinkProtected > 0 ? fixThinkProtectNote(fixThinkProtected) : '';
    if (thinkNote) {
        const tn = document.createElement('div');
        tn.className = 'so-fix-changes so-fix-think-note';
        tn.textContent = thinkNote;
        assistantEl.querySelector('.so-bubble')?.appendChild(tn);
    }
    // 把捕获快照 fixCaptured 一并传给应用控件：延迟点击「应用」时用它做陈旧守卫（P-CORRUPT 主要面）。
    // 重画保真（1.33.1）：先登记应用材料——换房重画时最新一条凭它重挂「应用到回复 / 看改动」。
    // 思考块回执并入 noteText（重画时以单个 .so-fix-changes 重挂——1.33.1 契约，回执不因换房丢失）。
    registerFixApply(aEntry, parsed, fixOriginalReply, fixTargetIdx, fixExtraKeep, fixScope, fixCaptured, undefined,
        [parsed.problems ? '发现并修正：\n' + parsed.problems : '', thinkNote].filter(Boolean).join('\n'));
    addFixApplyControls(assistantEl, parsed, fixOriginalReply, fixTargetIdx, fixExtraKeep, fixScope, fixCaptured, undefined, { entry: aEntry });
    return 'ok';
}