import { getSummary, persistConvo } from '../../core/chat-metadata.js';
import { getCtx } from '../../core/settings.js';
import { appendConvo, convo } from '../../core/conversation-store.js';

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
export async function captureFixContext(s, { mode = 'manual', targetId, wholeFloor = false, customTemplateText = '' } = {}) {
    const ctx = getCtx();
    let manualScopeMissed = '';
    let scopeDecision = null;
    let pieceDecision = null;
    let pieceTable = null;
    let scope = { active: false };
    let customJoin = null;
    const cfgRaw = getEffectiveFixCfg(s, getFixCfg());
    const cc = (ENABLE_FIX_CUSTOM_TASK && mode === 'custom') ? resolveFixCustomCfg(cfgRaw) : null;
    const norm = resolveFixModeCfg(cfgRaw, cc ? 'auto' : mode);
    if (cc) { norm.keepTags = cc.keepTags; norm.dropTags = fixDropMinusKeep(cc.keepTags, cc.dropTags); }
    const autoLike = mode === 'auto' || (cc && cc.useMechanic);
    const latest = (targetId != null) ? resolveAutoTargetMessage(ctx.chat, targetId) : getLatestAiMessage();
    const targetIdx = latest.idx;
    if (autoLike && ENABLE_FIX_PIECEWISE) {
        const dec = resolveFixPieces({ pieceMode: norm.pieceMode, scopeTag: norm.scopeTag, scopeManual: norm.scopeManual, pieceAsked: norm.pieceAsked, reply: latest.text });
        if (dec.action === 'run' && dec.mode === 'wrapped') {
            const table = fixSegmentReply(latest.text, { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(norm.keepTags) });
            if (table.bypass && !cc) {
                scope = splitContentScope(latest.text, dec.tag);
            } else if (!table.pieces.length) {
                dec.action = 'skip'; dec.note = { code: 'noNarrative' };
            } else {
                pieceTable = table;
            }
        } else if (dec.action === 'run' && dec.mode === 'bare') {
            const table = fixSegmentReply(latest.text, { mode: 'bare' });
            if (!table.pieces.length) { dec.action = 'skip'; dec.note = { code: 'noNarrative' }; }
            else pieceTable = table;
        } else if (dec.action === 'ask' || dec.action === 'pending') {
            dec.proposal = fixTableCounts(fixSegmentReply(latest.text, (dec.mode === 'wrapped' && dec.tag)
                ? { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(norm.keepTags) }
                : { mode: 'bare' }));
            if (!dec.proposal.pieces) { dec.action = 'skip'; dec.note = { code: 'noNarrative' }; }
        }
        pieceDecision = dec;
    } else if (autoLike) {
        scopeDecision = resolveFixScope({ cachedTag: norm.scopeTag, scopeManual: norm.scopeManual, reply: latest.text, replies: recentAiReplies(ctx.chat, 5) });
        scope = scopeDecision.active ? splitContentScope(latest.text, scopeDecision.tag) : { active: false };
    } else {
        const wantScope = wholeFloor && mode === 'manual' && norm.scopeTag;
        scope = wantScope ? splitContentScope(latest.text, norm.scopeTag) : { active: false };
        if (wantScope && !scope.active) manualScopeMissed = norm.scopeTag;
    }
    if (cc && !cc.useMechanic) {
        scopeDecision = null; pieceDecision = null; pieceTable = null; scope = { active: false };
        customJoin = fixCustomRawTable(latest.text, cc.keepTags, cc.dropTags, { raw: true });
    } else if (cc && !pieceTable && !(pieceDecision && ['ask', 'pending', 'suggest', 'skip'].includes(pieceDecision.action))) {
        scope = { active: false };
        customJoin = fixCustomRawTable(latest.text, cc.keepTags, cc.dropTags, { raw: false });
    }
    const originalReply = customJoin ? customJoin.core : (pieceTable ? pieceTable.pieces.map((p) => p.core).join('\n\n') : (scope.active ? scope.inner : latest.text));
    const thinkKeep = (wholeFloor && mode === 'manual')
        ? fixThinkKeepSpec(originalReply, norm.protectThink) : '';
    const ex = customJoin
        ? { prose: customJoin.core, keepBlocks: customJoin.keepBlocks }
        : extractExcludedSections(originalReply, thinkKeep || norm.keepTags, norm.dropTags);
    const targetProse = (customJoin && customJoin.raw) ? ex.prose : stripMechanismBlocks(ex.prose);
    const extraKeep = ex.keepBlocks;
    const thinkProtected = thinkKeep ? ex.keepBlocks.length : 0;
    const captured = Object.freeze({
        chatId: chatIdentityKey(),
        targetIdx,
        swipeId: (ctx.chat[targetIdx]?.swipe_id) | 0,
        fingerprint: fixFingerprint(ctx.chat[targetIdx]?.mes),
        prose: targetProse,
        bodyProse: fixBodyProse(latest.text),
    });
    const summaryBlock = norm.includeSummary ? composeSummaryWithBridges(getSummary()) : '';
    let contextBlock = '';
    if (norm.includeContext) {
        const depth = norm.contextDepth | 0;
        const fetchDepth = depth > 0 ? depth + 1 : -1;
        const turns = buildTranscriptTurns(ctx, { ...s, contextDepth: fetchDepth }, false);
        contextBlock = turns.slice(0, -1).map((l) => `${l.name}: ${l.text}`).join('\n\n');
    }
    const fixSideScan = mode === 'manual' ? await sideChatScanBlob() : '';
    let cardBlock = '';
    let worldBlock = '';
    let wiBefore = '';
    let wiAfter = '';
    if (fixUsePresetFor(s, mode) && presetCurationActive(s)) {
        const split = await buildWorldInfoSplit(undefined, fixSideScan, { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs && mode === 'manual' });
        wiBefore = split.before;
        wiAfter = split.after;
    } else {
        cardBlock = norm.includeCard ? buildCardSection(ctx) : '';
        worldBlock = norm.includeWorld ? await buildWorldInfo('st', fixSideScan, { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs && mode === 'manual' }) : '';
    }
    return Object.freeze({
        targetIdx, originalReply, targetProse, cardBlock, contextBlock, worldBlock, summaryBlock,
        extraKeep, thinkProtected, scope, scopeDecision, pieceDecision, pieceTable, customJoin, captured,
        activeMode: mode, customTemplateText: String(customTemplateText || ''),
        autoPromptVersion: norm.promptVersion, autoPromptFlavor: norm.promptFlavor,
        wiBefore, wiAfter, manualScopeMissed,
    });
}

// 校正卡的「解析成功 → 渲染 → 出按钮」公共段。捕获材料由调用方显式传入，
// 因此延迟应用卡始终绑定创建它的那一轮。
export function renderFixCard(assistantEl, contentEl, aEntry, finalText, fixContext) {
    const fc = fixContext || {};
    const r = parseFixReply(finalText, fc.activeMode);
    if (r.status !== 'ok') return r.status;
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(r.fixed, finishHint, fc.targetProse).truncated) return 'truncated';
    const parsed = { fixed: r.fixed, problems: r.problems };
    aEntry.content = parsed.fixed;
    if (!convo.includes(aEntry)) appendConvo(aEntry);
    persistConvo();
    const html = renderFixResultHtml(parsed.fixed);
    if (html != null) {
        contentEl.innerHTML = html;
        contentEl.classList.add('pad-rendered');
        contentEl.style.whiteSpace = 'normal';
    } else {
        contentEl.textContent = parsed.fixed;
    }
    if (fixNoOp(fc.targetProse, parsed.fixed)) {
        const note = document.createElement('div');
        note.className = 'pad-fix-changes';
        note.textContent = '模型没有做出改动——它认为按当前要求无需修改。可换一句更具体的指令、或调整目标后再试。';
        assistantEl.querySelector('.pad-bubble')?.appendChild(note);
        return 'ok';
    }
    if (parsed.problems) {
        const note = document.createElement('div');
        note.className = 'pad-fix-changes';
        note.textContent = '发现并修正：\n' + parsed.problems;
        assistantEl.querySelector('.pad-bubble')?.appendChild(note);
    }
    const thinkNote = fc.thinkProtected > 0 ? fixThinkProtectNote(fc.thinkProtected) : '';
    if (thinkNote) {
        const tn = document.createElement('div');
        tn.className = 'pad-fix-changes pad-fix-think-note';
        tn.textContent = thinkNote;
        assistantEl.querySelector('.pad-bubble')?.appendChild(tn);
    }
    registerFixApply(aEntry, parsed, fc.originalReply, fc.targetIdx, fc.extraKeep, fc.scope, fc.captured, undefined,
        [parsed.problems ? '发现并修正：\n' + parsed.problems : '', thinkNote].filter(Boolean).join('\n'));
    addFixApplyControls(assistantEl, parsed, fc.originalReply, fc.targetIdx, fc.extraKeep, fc.scope, fc.captured, undefined, { entry: aEntry });
    return 'ok';
}