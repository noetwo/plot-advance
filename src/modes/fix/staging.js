import { awaitFixMvuBoundary, beginPostReplyCall, beginPostReplyRun, drainPendingPostReply, finishPostReplyRun, isPostReplyBusy, postReplyShouldStop } from '../../core/post-reply.js';
import { POST_REPLY_CALL_TIMEOUT_MS, getCtx, getSettings } from '../../core/settings.js';

import { addSystemNote, renderEmptyState } from '../advisor/cards.js';
import { buildFixPrompt } from '../chat/context.js';
import { scrollToBottom } from '../chat/history.js';
import { chatIdentityKey } from '../chat/send.js';
import { fixOutputHasMvuBlock, getLatestAiMessage, getMvu, wrapContentScope } from '../diagnose/mvu.js';
import { applyFixAsSwipe, dismissToast } from '../diagnose/schema.js';
import { clampFixAutoMinChars, composeFixedReply, fixJoinTable, fixPiecePlan, fixPieceSummary, fixSpliceTable, mergeMvuTail } from './algorithms.js';
import { captureFixContext, fixCurrentSnapshot, fixOutputTruncated, fixScopeNoteText, fixTargetStale, isFixSwipe } from './capture.js';
import { addAutoFixNote, emitPieceAsk, emitPiecePending, fixCallTransport, fixJoinCall, fixPieceCall, showAutoFixGenerating } from './selection.js';
import { findFixTemplate, fixDropMinusKeep, fixNoTemplateNoted, fixNoTemplateShouldNote, fixUsePresetFor, getEffectiveFixCfg, getFixCfg, resolveFixCustomCfg, resolveFixModeCfg, setFixCfg } from './templates.js';
import { buildFixPresetMessages } from '../../presets/messages.js';
import { ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_PIECEWISE, STATUS_PLACEHOLDER } from '../../prompts/builtins.js';
import { compileFixTargets, detectMvuBlockDialect, fixEffMaxTokens, fixEffectivelyUnchanged, fixNoOp, fixPreFilter, fixTargetOverrides } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { addMessage, parseFixedReply, soFollowStream } from '../../ui/messages.js';
import { maybeWrapJb, presetCurationActive } from '../../ui/settings.js';
import { isGenerating } from '../../core/generation.js';
import { convoStreamKey } from '../../core/conversation-store.js';
import { getHostGlobal } from '../../st/host.js';
import { messagesEl, win } from '../../ui/refs.js';

// 自动校正离开原聊天时的会话内暂存；唯一写者和消费者均在本模块。
const fixParked = new Map();
const FIX_PARK_TTL_MS = 30 * 60 * 1000;
const FIX_PARK_MAX = 8;

/* ------------------------------------------------------------------ *
 * 📋 自定义模板任务的【流式直播】（1.77.0，Prince 点单 2026-09-04）。
 * 模板任务常常是「整条翻译 / 整条改写」，一趟往返几十秒起步——非流式时用户只看得到一个不动的提示，
 * 分不清「在跑」与「卡死」；而中转（navy 一类）对静默连接有 ~100s 的 CF 顶，流式还能把连接喂活。
 * 直播落在【哪里】按房间可见性分流，两条路都绝不碰主聊天（写入仍只发生在 applyFixAsSwipe 那一刻）：
 *   · 校正房正开着 → 临时气泡（与「按目标校正」的手动卡同一条 DOM 路：addMessage + pad-streaming），
 *     绝不进 convo / 不落盘，收尾必删（fixRunJoin 的 finally）。
 *   · 房间不可见（窗口关着 / 在别的房） → 把进度挂到「正在校正…」提示上（字数计数器）。
 * ------------------------------------------------------------------ */

// 纯（可单测）：不可见时提示里的进度文案。n = 到目前为止收到的字数（码点）。
// 「点此中断」半句必须留着——这个提示本身就是中断按钮（showAutoFixGenerating 的 onclick）。
function fixStreamCounterText(n) {
    return `正在用模板处理最新回复… 已收到 ${Math.max(0, Number(n) | 0)} 字（点此中断）`;
}

// toastr 的句柄是 jQuery 包装的 toast 元素；把它正文行的文本就地换掉。失败一律静默返回 false
// ——进度显示是锦上添花，绝不能让它把一次真正的模板处理搞崩。
function toastSetMessage(handle, text) {
    try {
        const el = (handle && handle.nodeType === 1) ? handle : ((handle && handle[0]) || null);
        const msg = (el && el.querySelector) ? el.querySelector('.toast-message') : null;
        if (!msg) return false;
        msg.textContent = text;
        return true;
    } catch (e) { return false; }
}

// 直播装置的构造口。返回 { onDelta, end }：
//   · onDelta === undefined ⇒ fixJoinCall 走非流式分支（校正路 / 关了流式 / 杀死开关关 = 字节不变）。
//   · end() 幂等，由 fixRunJoin 的 finally 无条件调用 —— 任何出口都不许留下预览气泡。
// 刻意【不】把气泡写进 convo：它不是一条对话，是一块进度显示；不进 convo ⇒ persistConvo 永远
// 看不见它 ⇒ 不会落盘、不会在重载后复活（这是「不持久化」最省事也最难写错的一种做法）。
function fixCustomPreviewStart(meta, toastHandle, s) {
    const NOOP = { onDelta: undefined, end() {} };
    try {
        if (!(ENABLE_FIX_CUSTOM_TASK && meta && meta.task === 'custom' && s && s.stream)) return NOOP;
        // ① 校正房正开着 → 临时气泡直播。
        // 「开着」= 窗口真的在屏上（`win.style.display !== 'none'`，全仓判可见的同一式）【且】当前可见流
        // 就是校正房。复审 minor #5：只看 convoStreamKey 会把「窗口关着但上次停在校正房」也判成可见，
        // 于是气泡进了一个没人看得见的容器、计数器又因为走了气泡枝而不出 —— 自动轮那几十秒里用户
        // 两样反馈都拿不到。窗口没建好 / 收起时一律落到 ② 的提示计数器。
        if (win && win.style.display !== 'none' && convoStreamKey === 'fix' && messagesEl) {
            const head = `📋 模板〔${meta.template || ''}〕 · 处理中…`;
            const wrap = addMessage('assistant', '', null);   // 不传 entry ⇒ 不挂编辑/重生成/删除按钮，也永不进 convo
            wrap.classList.add('pad-fixc-preview');
            const contentEl = wrap.querySelector('.pad-content');
            contentEl.classList.add('pad-streaming');
            contentEl.textContent = head;
            let done = false;
            return {
                onDelta: (acc) => {
                    if (done) return;
                    contentEl.textContent = head + '\n\n' + String(acc == null ? '' : acc);
                    if (soFollowStream) scrollToBottom();   // house law：在底部才自动滚（跟随位由滚动监听现测）
                },
                end() {
                    if (done) return;
                    done = true;
                    try {
                        contentEl.classList.remove('pad-streaming');
                        wrap.remove();
                        // 房间被这只气泡清掉过空态卡：真的空了才补回（renderEmptyState 自带 convo/children 守卫）。
                        if (messagesEl && !messagesEl.children.length) renderEmptyState();
                    } catch (e) { /* 页面已换 / 节点已被重画掉 */ }
                },
            };
        }
        // ② 房间不可见 → 提示上的字数计数器（~500ms 一次，不给 toastr 制造重排风暴）。
        let last = 0;
        return {
            onDelta: (acc) => {
                const now = Date.now();
                if (now - last < 500) return;
                last = now;
                toastSetMessage(toastHandle, fixStreamCounterText(Array.from(String(acc == null ? '' : acc)).length));
            },
            end() { /* 提示由 fixRunJoin 的 finally 统一 dismissToast */ },
        };
    } catch (e) { return NOOP; }
}

/* ------------------------------------------------------------------ *
 * ✨/📋 切聊天不取消：暂存 → 回到原聊天落地（1.77.0）。存取两个纯口 + 落地/暂存三件套。
 * 下面四个函数是【三条运行路 + 补落地】共用的唯一实现：整体校正 fixRunJoin、老单段 runAutoFix、
 * 分段 runAutoFixPieces 各自的「陈旧守卫 → 落 swipe → 记录」尾巴都收敛到这里，两边绝不漂移。
 * ------------------------------------------------------------------ */

// 纯（唯一副作用是改【传进来的】map，可单测）：存一份暂存结果，同一聊天后来居上。返回是否真的存下。
function fixParkPut(map, key, entry) {
    if (!map || key == null || key === '' || !entry) return false;
    map.set(String(key), entry);
    return true;
}

// 纯（唯一副作用是改【传进来的】map，可单测）：清掉过期与超额的槽。复审 minor #8 —— 暂存是「等你回来」
// 的短期承诺，不是无期限的存档：半小时前那条回复的处理结果再落地已经离用户的心智太远（他多半早就
// 手动重掷 / 换 swipe 了），而 Map 不封顶就会随着「切了 N 个聊天」一路长。
//   · 过期：`at` 早于 now - FIX_PARK_TTL_MS（30 分钟）的一律丢。
//   · 封顶：留最新 FIX_PARK_MAX 个（按 `at` 排序，旧的先出）。
// `at` 缺失（异常写入）按 0 处理 = 立刻过期，绝不让一条没有时间戳的成品赖在槽里。
function fixParkSweep(map, now) {
    if (!map || !map.size) return 0;
    const t = Number(now) || 0;
    let dropped = 0;
    for (const [k, v] of [...map.entries()]) {
        if (t - (Number(v && v.at) || 0) > FIX_PARK_TTL_MS) { map.delete(k); dropped += 1; }
    }
    if (map.size > FIX_PARK_MAX) {
        const byAge = [...map.entries()].sort((a, b) => (Number(a[1] && a[1].at) || 0) - (Number(b[1] && b[1].at) || 0));
        for (const [k] of byAge.slice(0, map.size - FIX_PARK_MAX)) { map.delete(k); dropped += 1; }
    }
    return dropped;
}

// 纯（同上）：取出并【立刻删除】。调用方必须先取后 await —— 连续两次 CHAT_CHANGED 才不会把同一份落两遍。
function fixParkTake(map, key) {
    if (!map || key == null) return null;
    const k = String(key);
    const entry = map.get(k) || null;
    if (entry) map.delete(k);
    return entry;
}

// 落地 = 写入 + 记录，两句【连体】。记录实参逐字节沿用各路原样（meta 为空 = 校正一族老字节；
// 分段路的 problems 是对象，照传不动）。即时落地与暂存补落地共用这一份。
async function fixLandResult(p) {
    const ctx = getCtx();
    await applyFixAsSwipe(p.targetIdx, p.joined);
    // 抓【应用后】落点的 swipe_id（addSwipeToMessage 把新 swipe 设为当前），给记录的「用原文 ↔ 用校正稿」开关用。
    const fixSwipeId = ((ctx && ctx.chat) || [])[p.targetIdx]?.swipe_id;
    addAutoFixNote(p.status, p.problems, { idx: p.targetIdx, before: p.before, after: p.after, fixSwipeId }, p.meta || null);
}

// 落地闸：陈旧守卫的裁决 → 立刻落 / 暂存 / 记一条 stale。返回 'landed' | 'parked' | 'stale'（供测试与日志）。
// 'chatSwitched' 是【唯一】可暂存的理由：其余（换 swipe / 正文被编辑 / 目标没了）说明这条回复本身已经
// 不是当初那条，暂存只会在用户回来时写坏东西 —— 照旧记一条 stale（文案字节不变）。
// 暂存时【绝不】往当前这个（别人的）聊天里写记录，只弹一句 toast。
// ★ 判据只认 payload.captured / payload.targetIdx，它们来自触发本轮时冻结的 fixContext ★
// （复审 Critical #1，1.77.0 fix round 1）：旧单槽实现会在用户切到聊天 B 并触发另一轮捕获后，把 A 轮
// 回来时的陈旧校验错误地改用 B 的捕获，继而可能把 A 的正文写进 B 的楼层。现在每轮捕获随调用链传到
// 这里，异步返回顺序不再改变目标身份。
// 捕获快照必须从 captureFixContext 返回值一路传到这里（三条运行路均遵守）。
async function fixLandOrPark(payload, opts) {
    const cap = payload.captured || null;
    const st = fixTargetStale(cap, fixCurrentSnapshot(payload.targetIdx), opts);
    if (!st.stale) { await fixLandResult(payload); return 'landed'; }
    if (st.reason === 'chatSwitched' && cap) {
        fixParkPut(fixParked, cap.chatId, { ...payload, captured: cap, at: Date.now() });
        try { getHostGlobal('toastr')?.info?.('结果已暂存，回到原聊天时自动落地', '剧情推进'); } catch (e) { /* ignore */ }
        return 'parked';
    }
    addAutoFixNote('stale', st.reason, null, payload.meta || null);
    return 'stale';
}

// 回到原聊天：把暂存的成品落地。onChatChanged 末尾 + drainPendingPostReply 里 fire-and-forget 调用
// （与后者同一约定：事件监听不该被一趟 saveChat 拖住）。取出【先于】任何 await，重入不会落两遍。
export async function fixDrainParked() {
    // 复审 minor #9：绝不与在飞的一轮交错落地（它随时会 applyFixAsSwipe / 写记录）。有轮在飞就让位，
    // 由那一轮 finally 里的 drainPendingPostReply 再唤我们一次（锁那时已释放）。
    if (isPostReplyBusy()) return 'deferred';
    // ★ 顺序是【先取本聊天这一份、再扫其余】★（G 轮复审）：反过来的话，槽里挤着 ≥9 个聊天、而本聊天恰是
    // 其中最旧的那一个时，封顶淘汰会把「马上就要落地的这一份」当成最旧的踢掉——用户回到原聊天，已经
    // 买单的成品凭空消失。取出后仍按同一把尺子判它【自己】的保质期，TTL 语义与扫描不变。
    const now = Date.now();
    const entry = fixParkTake(fixParked, chatIdentityKey());
    fixParkSweep(fixParked, now);          // 本聊天这一份已经出槽，扫的是【别人】的过期 / 超额
    if (!entry) return null;
    if (now - (Number(entry.at) || 0) > FIX_PARK_TTL_MS) return null;   // 过期：与被扫掉时一样，静默不落地
    // 回来后再核一次：暂存期间这条回复可能在别处被换过 swipe / 编辑过 / 删掉了。mvuTolerant 恒 false ——
    // MVU 早在暂存前就写完了，容忍窗口没有意义，宁可判陈旧也不写坏。
    const st = fixTargetStale(entry.captured, fixCurrentSnapshot(entry.targetIdx), { mvuTolerant: false });
    if (st.stale) { addAutoFixNote('stale', st.reason, null, entry.meta || null); return 'stale'; }
    await fixLandResult(entry);
    return 'landed';
}

// 📋 按钮路（meta.manual）专属：fixRunJoin 里三处 `postReplyShouldStop()` 的静默出口补一句人话。
// 有人正盯着屏幕等结果，「什么都没发生」是最坏的反馈（Prince 的实地报告就是这一幕）。自动路保持
// 今天的静默——它每条回复都跑，中断是常态，刷屏比沉默更糟。用 addSystemNote（临时提示，不进侧聊
// 持久记录）与按钮起飞前的各种拒绝同一族。
function fixNoteRunStopped(meta) {
    if (meta && meta.task === 'custom' && meta.manual === true) {
        try { addSystemNote('📋 模板处理已中断（你点了中断，或期间发出了新消息）。'); } catch (e) { /* 窗口没建好 */ }
    }
}

// ✨/📋 整体校正与自定义模板任务共用的「一次调用 → 闸门 → MVU 等待 → 陈旧守卫 → 落 swipe → 记录」尾巴。
// meta = null（校正）| { task:'custom', template, manual }（自定义，记录换族）。校正一族的记录实参逐字节不动
// （meta 为空时 nochange 恒不带理由 = 老字节；自定义才补「模型没有改动」）。
async function fixRunJoin(ctx, s, directive, join, compatSession, meta, fixContext) {
    const cap = fixContext.captured;
    const tIdx = fixContext.targetIdx;
    const genToast2 = showAutoFixGenerating();
    // 📋 只有自定义模板任务 + 全局流式开着时才拿得到 onDelta；校正路 preview.onDelta 恒 undefined。
    const preview = fixCustomPreviewStart(meta, genToast2, s);
    let r;
    const ctl2 = beginPostReplyCall(POST_REPLY_CALL_TIMEOUT_MS);
    try {
        r = await fixJoinCall(ctx, s, directive, join, ctl2.signal, preview.onDelta, fixContext);
    } catch (e) {
        preview.end();   // catch 体跑在 finally 之【前】：先撤气泡，记录才落在一间干净的房里（end() 幂等）
        if (!postReplyShouldStop()) addAutoFixNote('failed', '调用失败', null, meta);
        else fixNoteRunStopped(meta);
        return;
    } finally { ctl2.end(); preview.end(); dismissToast(genToast2); }   // 预览气泡在【任何】出口都必须撤掉，且早于 addAutoFixNote 落记录
    if (postReplyShouldStop()) { fixNoteRunStopped(meta); return; }
    if (r.status === 'failed') { addAutoFixNote('failed', r.reason && r.reason !== 'ok' ? ({ refusal: '模型像是拒绝了这次校正，可试试勾『经自定义补全预设发送』破限', empty: '中转返回空回复', garbage: '模型回复异常' }[r.reason] || '') : '', null, meta); return; }
    if (r.status === 'truncated') { addAutoFixNote('truncated', '', null, meta); return; }
    if (r.status !== 'fixed') { addAutoFixNote('nochange', meta ? '模型没有改动' : undefined, null, meta); return; }
    const boundary = await awaitFixMvuBoundary(s, compatSession, cap && cap.chatId);
    if (!boundary.proceed) { if (boundary.status === 'cancelled') fixNoteRunStopped(meta); return; }   // 'timed-out' 只可能来自 MVU 兼容会话（按钮路 compatSession 恒 null），不是「被中断」
    let joined = join.head + r.fixedCore + join.tail;
    // 📋 raw 表路：成品若已带（被模型改写 / 伪造的）更新区块，补接会造出第二块（MVU 地雷 ②）→ 只跳过块、留占位符。
    // 判据取 fixJoinCall 算好的 r.skipMvuTail（=「自定义任务 且 表来自 fixCustomRawTable」，两处一份，不再各自
    // 从 join.raw 重算）；块的有无仍对【拼好的成品】测。校正 / 手动路 r.skipMvuTail 恒 false ⇒ opts.skipBlock 恒
    // false ⇒ 与 1.76.0 逐字节同。
    if (boundary.coordinated) joined = mergeMvuTail(joined, (ctx.chat || [])[tIdx]?.mes, { skipBlock: !!(r.skipMvuTail && fixOutputHasMvuBlock(joined)) });
    const anchorNote = r.anchorsMissing ? `\n⚠ ${r.anchorsMissing} 个结构块的位置锚点被模型挪动 / 弄丢，内容已兜底接回正文末尾——位置若不对，左滑「用原文」即可还原。` : '';
    // 陈旧守卫 → 落地 / 暂存 / stale（1.77.0 起「切聊天」不再丢弃，见 fixLandOrPark）。
    await fixLandOrPark({
        captured: cap, targetIdx: tIdx, joined, status: 'fixed',
        problems: (r.problems || '') + anchorNote, before: r.before, after: r.after, meta,
    }, { mvuTolerant: boundary.coordinated });
}

// 自动分段校正【运行步】：整体校正（fixA_pieceJoin，默认开）= 折成一次调用（锚点原位保留结构）；
// 关掉则分段逐次调用（最大优先、上限 FIX_MAX_PIECE_CALLS、逐段成本门），全部结果一次性 splice 回原位。
// 两种都是单次 applyFixAsSwipe（绝不一段一个 swipe）+ 诚实侧聊记录。中断（「点此中断」toast →
// cancelPostReply）随时废弃整轮、不写任何东西（1.17.4「abort 在写入之前」不变量原样）。
// fixWaitForMvu / 陈旧守卫（mvuTolerant）与老单段路径同一套、只跑一次。
async function runAutoFixPieces(ctx, s, compatSession, fixContext) {
    const cap = fixContext.captured;
    const tIdx = fixContext.targetIdx;
    const table = fixContext.pieceTable;
    if (!table || !table.pieces.length) return;
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const a = resolveFixModeCfg(cfg, 'auto');
    const constraints = { knowledge: a.knowledge, guardrails: a.guardrails };
    const directive = compileFixTargets(a.targets, { card: a.includeCard, context: a.includeContext, world: a.includeWorld }, constraints, fixTargetOverrides(s));
    if (!directive) return;                                     // 什么都没配——与老路径一致的静默退出
    // ✨ 整体校正（默认开）：一次调用搞定全部正文，结构块锚点原位保留；写入 / 守卫尾巴与分段路径共用。
    if (a.pieceJoin) {
        const join = fixJoinTable(table, a.dropTags);
        if (!join) { addAutoFixNote('nochange'); return; }
        if (!fixPreFilter(join.core, a.targets, constraints, clampFixAutoMinChars(cfg.fixAutoMinChars))) { addAutoFixNote('nochange'); return; }
        await fixRunJoin(ctx, s, directive, join, compatSession, null, fixContext);
        return;
    }
    const plan = fixPiecePlan(table.pieces, a.targets, constraints, clampFixAutoMinChars(cfg.fixAutoMinChars));
    if (!plan.attempts.length) { addAutoFixNote('nochange'); return; }
    const results = plan.entries.map((e) => ({ status: e.status }));
    const genToast = showAutoFixGenerating();                   // 一轮一个「正在校正…（点此中断）」，中断=废弃整轮
    try {
        for (const i of plan.attempts) {
            if (postReplyShouldStop()) return;                  // 整轮作废，不写
            const ctl = beginPostReplyCall(POST_REPLY_CALL_TIMEOUT_MS);
            try {
                results[i] = await fixPieceCall(ctx, s, a, directive, table.pieces[i], ctl.signal, undefined, fixContext);
            } catch (e) {
                if (postReplyShouldStop()) return;              // 中断 / supersede 引发的 abort：静默收尾
                results[i] = { status: 'failed', reason: 'error' };
            } finally { ctl.end(); }
        }
        if (postReplyShouldStop()) return;
        const summary = fixPieceSummary(table.pieces, results);
        if (summary.status === 'none') {
            if (summary.failLines.length) addAutoFixNote('failed', summary.failLines.join('\n'));
            else addAutoFixNote('nochange');
            return;
        }
        // 写入前：等 MVU（opt-in）→ splice → 补接 MVU 尾块 → 陈旧守卫 → 单次落 swipe（与老路径同构）。
        const boundary = await awaitFixMvuBoundary(s, compatSession, cap && cap.chatId);
        if (!boundary.proceed) return;
        let finalText2 = fixSpliceTable(table, results);
        if (boundary.coordinated) finalText2 = mergeMvuTail(finalText2, (ctx.chat || [])[tIdx]?.mes);
        // 陈旧守卫 → 落地 / 暂存 / stale（1.77.0 起「切聊天」不再丢弃，见 fixLandOrPark）。
        await fixLandOrPark({
            captured: cap, targetIdx: tIdx, joined: finalText2, status: 'partial',
            problems: { headline: summary.headline, failLines: summary.failLines, problems: summary.problems, majority: summary.majority },
            before: summary.beforeJoined, after: summary.afterJoined, meta: null,
        }, { mvuTolerant: boundary.coordinated });
    } finally {
        dismissToast(genToast);
    }
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 3 —— 环境自检 PURE 层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 校正结果偶尔让人费解，真正原因常常出在【外部环境】——弱模型 / 中转拒绝或吐垃圾、连接没配好、这条回复
 * 压根没用 MVU——而不是校正本身的问题。这里只建纯检测 + 人话文案，供后续集成阶段调用：
 * fixFailureReason（把模型调用的失败分类成人话原因，港 arcFailureReason 的形状——权威 API 信号优先，
 * 文本启发式兜底）/ fixEnvNote（连接未配置 / MVU 缺失两种运行时条件的静态文案）/ replyExpectsMvu
 * （这条回复是否带 MVU 状态栏标记的纯谓词，供判断 mvuAbsent 提示该不该出——没用 MVU 的卡片不该被
 * 瞎报「状态栏不显示」）。真正读 window.Mvu / 设置的判断留给后续集成阶段；这一层只出文案 + 判定。
 * ------------------------------------------------------------------ */

// 纯函数：把模型调用的失败分类成人话原因。finish = 上游 finish_reason（今天实践中通常是 undefined，
// 这里先接住以便日后接入，不强求）。按权威信号优先、文本启发式兜底的顺序：
//   1. finish==='content_filter' → refusal（无条件，甚至先于「空回复」判断——这是 API 给的确凿信号）。
//   2. text 是 null/undefined（缺内容），或整条 trim 后是空串 → empty（= 空回复）。注意：模型【回复正文本身】
//      恰好是字面串 'null'/'[object Object]' 这类（序列化泄漏 = 有内容但是垃圾）仍走分支 4(d)——那是文本内容，不是缺内容。
//   3. refusal：命中常见破限/审查话术（中英，大小写不敏感），且没有可用的 <FixedReply> 尝试——哪怕
//      模型先道了个歉，只要还给出一份 <FixedReply>，就还有可用内容，不算拒绝（不按长度砍，只看这一个闸门）。
//   4. garbage：明显不是模型的叙事校正输出——中转/网关的 JSON 错误体（{...} 且带 error 键）、HTML 错误页
//      （<!DOCTYPE/<html 开头）、语言运行时调用栈（JS "at foo (file:12:34)" / Python Traceback）、整串
//      字面 undefined/null/NaN/[object Object]、连续 3+ 个 U+FFFD 替换字符（编码乱码）。刻意不做「同字符
//      连续重复」的启发式——正文里「啊啊啊啊」「哈哈哈哈」是正常 RP 语气，会被错杀。
//   5. 否则 → ok（放行；「解析不出校正稿」的通用兜底文案已由调用方的 autoFixNoteContent('failed') 承担，这里不重复）。
// 返回 {kind:'refusal'|'empty'|'garbage'|'ok', message}。可单测。
export function fixFailureReason(text, finish) {
    const refusalMsg = '模型像是拒绝了这次校正，可试试勾『经自定义补全预设发送』破限';
    if (finish === 'content_filter') return { kind: 'refusal', message: refusalMsg };
    const trimmed = text == null ? '' : String(text).trim();
    if (!trimmed) return { kind: 'empty', message: '中转返回空回复' };

    const refusalPattern = /抱歉|很遗憾|对不起|无法(协助|完成|生成)|不能(提供|生成|协助)|违反[^\n]{0,10}(政策|准则)|内容政策|i'm sorry|i cannot|i can'?t (assist|help|comply|provide)|i won'?t|as an ai|content policy/i;
    if (refusalPattern.test(trimmed) && !trimmed.includes('<FixedReply')) {
        return { kind: 'refusal', message: refusalMsg };
    }

    let jsonError = false;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, 'error')) jsonError = true;
        } catch (e) { /* 不是合法 JSON，不算命中 */ }
    }
    const lower = trimmed.toLowerCase();
    const isGarbage = jsonError
        || /^<!doctype|^<html/i.test(trimmed)
        || /\bat\s+\S+\s*\([^)]*:\d+:\d+\)/.test(trimmed)
        || trimmed.includes('Traceback (most recent call last)')
        || lower === 'undefined' || lower === 'null' || lower === 'nan' || lower === '[object object]'
        || /�{3,}/.test(trimmed);
    if (isGarbage) return { kind: 'garbage', message: '模型回复异常' };

    return { kind: 'ok', message: '' };
}

// 纯函数：环境自检提示文案——静态 kind→string 查表，供后续集成阶段在对应运行时条件成立时展示。
//   connectionUnset —— 自动校正开着，但连接（直连端点/模型，或配置档）没配好，所以不会运行。
//   mvuAbsent —— 这条回复带 MVU 状态栏标记，但当前环境检测不到 window.Mvu，状态栏不显示是环境问题，与校正无关。
// 其余 / nullish → ''（不出提示）。
export function fixEnvNote(kind) {
    if (kind === 'connectionUnset') return '自动校正已开，但还没配置连接（端点/模型 或 配置档），所以不会运行——去设置里配一下。';
    if (kind === 'mvuAbsent') return '状态栏由 MVU 渲染，当前没检测到 MVU，状态栏不显示与校正无关。';
    return '';
}

// 纯谓词：这条回复文本是否【期待】MVU 渲染状态栏（带 STATUS_PLACEHOLDER 占位符，或 <UpdateVariable> 更新块）。
// nullish → false。刻意不走 Phase 1 的 listTopLevelTagNames——那只看【顶层】块，标记若嵌在别的标签内部
// （如埋在 <content>/<gametxt> 里）会被漏判；这里就是要在整条文本里【任意位置】找，嵌套也要认得出来。
function replyExpectsMvu(text) {
    if (text == null) return false;
    const s = String(text);
    return s.includes(STATUS_PLACEHOLDER) || !!detectMvuBlockDialect(s);
}

// ✨/📋 自动 / 自定义共用：captureFixContext 决策的【落地】（采纳作用域 / 记忆 / 提示 / 决定跳过）。返回 {stop:true} = 本轮结束。
// meta 同 addAutoFixNote 第四参（自定义记录换族；scope/ask 类记录两族共用同一句式）。
//
// ✨ Phase 5 D+E 门：captureFixContext 已经把作用域决策放在 fixContext.scopeDecision；
// 这里只负责【落地】——写配置 / 出提示 / 决定继续还是跳过。调用点刻意排在 R2 双重校正之后（那条已经
// return 掉的情形不该再叠加一条作用域提示）、成本门 fixPreFilter 之前（省一次可能白花的 LLM 调用）。
//   detected → 采纳新标签：写回 per-chat 配置（缓存，且 scopeManual 仍是 false——这不是用户手填的）+
//     顺手同步一下设置面板里的 #pad-fix-scope 输入框（如果窗口开着，用户正好能看见变化），继续往下走。
//   suggest / skip → D 的静默兜底：只留一条侧聊记录，绝不整条回复瞎改，本轮直接结束。
//   cache / fallbackWhole → 无需任何动作，直接往下走（fixContext.scope 已按决策准备好）。
// 📋 自定义模板任务（沿用识别开）也走这里，因此模板任务会写 fixA_scopeTag / fixA_pieceMode / fixA_pieceAsked
// ——这是【有意】的，不是串档：spec §5.2 把「沿用识别」定义成【逐字沿用自动的捕获路径】，正文形态的记忆
// 本就是一张卡一份、两种任务共用（同一张卡的 <content> 不会因为换了任务就变），故不另开一套 fixC_ 形态键。
function fixLandAutoDecisions(s, meta, fixContext) {
    const scopeDec = fixContext.scopeDecision;
    if (scopeDec && scopeDec.action === 'detected') {
        setFixCfg({ fixA_scopeTag: scopeDec.tag, fixA_scopeManual: false });
        const scopeEl = win && win.querySelector('#pad-fix-scope');
        if (scopeEl) scopeEl.value = scopeDec.tag;   // 单字段回填；el.value= 不触发 'input' 事件，scopeManual 不会被误置 true
        addAutoFixNote('scope', scopeDec.note, null, meta);
        getHostGlobal('toastr')?.success?.(fixScopeNoteText(scopeDec.note).body, '', { timeOut: 6000 });
    } else if (scopeDec && (scopeDec.action === 'suggest' || scopeDec.action === 'skip')) {
        addAutoFixNote('scope', scopeDec.note, null, meta);
        return { stop: true };   // D 静默兜底：跳过这条，绝不整条误改
    }
    // ✨ 分段校正（1.18.0）门：captureFixContext 已跑决策阶梯并写入 fixContext.pieceDecision。这里只【落地】——
    // 记忆（adopt 写回 per-chat）/ 提示 / 决定走哪条路。bypass / whole（无分段表）落到调用方的老单段路径，
    // 行为逐字节不变；开关关时 pieceDecision 恒 null、整块蒸发。
    if (ENABLE_FIX_PIECEWISE && fixContext.pieceDecision) {
        const pd = fixContext.pieceDecision;
        if (pd.adopt) {
            const cur = getEffectiveFixCfg(s, getFixCfg());
            if (cur.fixA_pieceMode !== 'wrapped' || cur.fixA_scopeTag !== pd.tag) {   // 只在有变化时写（免得每条回复都 saveChatMetadata）
                setFixCfg({ fixA_pieceMode: 'wrapped', fixA_scopeTag: pd.tag, fixA_scopeManual: false });
                const scopeEl = win && win.querySelector('#pad-fix-scope');
                if (scopeEl) scopeEl.value = pd.tag;
                if (!pd.adopt.quiet) {
                    addAutoFixNote('scope', pd.note, null, meta);
                    getHostGlobal('toastr')?.success?.(fixScopeNoteText(pd.note).body, '', { timeOut: 6000 });
                }
            }
        }
        if (pd.action === 'ask') { emitPieceAsk(pd); return { stop: true }; }
        if (pd.action === 'pending') { emitPiecePending(pd); return { stop: true }; }   // ✨ Option B：不再无声——重弹可点确认 toast + 刷新判定行（按钮保持琥珀 pending，见 updateFixButtonVisual）
        if (pd.action === 'suggest' || pd.action === 'skip') { addAutoFixNote('scope', pd.note, null, meta); return { stop: true }; }
    }
    return { stop: false };
}

// 📋 自定义模板任务运行步（spec §5）：模板 → 捕获（沿用识别 = 自动路径；整条 = raw 表）→ 一次调用 → 共用尾巴。
// 没有禁词门、没有 directive 门；只有最少字数 + 双重处理守卫。
// manual（1.77.0）= 这一轮由「用模板处理最新回复」按钮发起。只影响【反馈】：有人正盯着屏幕，
// 中断类的静默出口要补一句人话（fixRunJoin 读 meta.manual）；自动路保持今天的静默。
export async function runCustomTask(ctx, s, targetId, compatSession, manual = false) {
    if (!ENABLE_FIX_CUSTOM_TASK) return;
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) return;
    if (s.mode === 'profile' && !s.profileId) return;
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const cc = resolveFixCustomCfg(cfg);
    const meta = { task: 'custom', template: cc.template, manual: manual === true };
    const tpl = findFixTemplate(s, cc.template);
    if (!tpl || !String(tpl.prompt || '').trim()) {
        // 📋 记录【每聊天每模板只写一次】：这条路每来一条新回复都会走一遍，无条件写会把侧聊无界刷爆。
        // 写不写与「跑不跑」无关——不写也照样 return，永远不发调用（判定 / 副作用分离）。
        if (fixNoTemplateShouldNote(fixNoTemplateNoted, chatIdentityKey(), cc.template)) addAutoFixNote('notemplate', '', null, meta);
        return;
    }
    const fixContext = await captureFixContext(s, { mode: 'custom', targetId, customTemplateText: tpl.prompt });
    const tIdx = fixContext.targetIdx;
    if (!fixContext.targetProse.trim()) return;
    if (isFixSwipe((ctx.chat || [])[tIdx])) { addAutoFixNote('nochange', '这条已是一次处理结果', null, meta); return; }
    if (cc.useMechanic && fixLandAutoDecisions(s, meta, fixContext).stop) return;
    const join = fixContext.customJoin || (fixContext.pieceTable ? fixJoinTable(fixContext.pieceTable, fixDropMinusKeep(cc.keepTags, cc.dropTags)) : null);
    if (!join) { addAutoFixNote('nochange', '没有可处理的正文', null, meta); return; }
    if ([...join.core].length < clampFixAutoMinChars(cfg.fixAutoMinChars)) { addAutoFixNote('nochange', '太短', null, meta); return; }
    await fixRunJoin(ctx, s, P('fix.customLead', null, s), join, compatSession, meta, fixContext);
}

// 📋 「用模板处理最新回复」按钮：一次性手动触发。起飞前的各种拒绝（连接没配 / 模板缺失 / 没有可处理的回复）
// 走 addSystemNote —— 有人盯着屏幕，说一句就够，不必留持久记录；真跑起来之后交给 runCustomTask，
// 它与自动路一样在侧聊留【持久记录】（addAutoFixNote）。
// postReplyBusy 是 maybePostReply 持的共享锁：自动轮在飞时点这颗会抢占同一 post-reply AbortController，
// 两轮互相中止，故直接挡住。
export async function runCustomTaskNow() {
    if (isGenerating || !ENABLE_FIX_CUSTOM_TASK) return;
    if (isPostReplyBusy()) { addSystemNote('正在跑自动处理，稍后再点。'); return; }
    const s = getSettings();
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) { addSystemNote('请先在设置里配置直连端点与模型。'); return; }
    if (s.mode === 'profile' && !s.profileId) { addSystemNote('请先在设置里选择一个连接配置档。'); return; }
    const cc = resolveFixCustomCfg(getEffectiveFixCfg(s, getFixCfg()));
    const tpl = findFixTemplate(s, cc.template);
    if (!tpl || !String(tpl.prompt || '').trim()) { addSystemNote(`模板〔${cc.template}〕不存在或正文为空——先在「自定义」面板里选一份模板。`); return; }
    if (getLatestAiMessage().idx < 0) { addSystemNote('没找到可处理的 AI 回复（主聊天里要先有一条 AI 回复）。'); return; }
    const ctx = getCtx();
    const idx = getLatestAiMessage().idx;
    const compatSession = null;
    // 锁【也要拿】，不只是让路（评审 F2）：光有上面那道 `if (postReplyBusy) return` 只挡住了一个方向。
    // 本函数自己跑的这几十秒里落一条新回复 → MESSAGE_RECEIVED；若不持锁，新的回复后任务会与本轮并发，
    // 抢占共享 post-reply AbortController，并让两个自动处理轮交错落地。持锁后新轮改为入队，
    // 由下面的 drainPendingPostReply 在释放后补跑（与 maybePostReply 的 finally 同一份补跑步）。
    // ★ 1.77.0 根因修复（调查报告 `.superpowers/sdd/2026-09-03-fix-custom-task/investigate-runnow-report.md`）★
    // postReplyCancelled 是【一轮的】状态，规矩是「谁开新一轮，谁起手清零」——今天只有 maybePostReply 照做了。
    // onChatChanged 每次切聊天/首次载入都调 cancelPostReply() 把它置真，而它【只】在 maybePostReply 里清零；
    // 两个自动开关都关的用户，maybePostReply 在 `if (!plan.length) return;` 就早退 ⇒ 旗子永久为真 ⇒ 按钮
    // 照发调用、模型照答、钱照花，回来撞上 fixRunJoin 的 `if (postReplyShouldStop()) return;` 静默丢弃（复现 4/4）。
    // 起手 + 收尾各清一次，并注册自己的 run —— 与 maybePostReply 逐字同款，这样 MESSAGE_SENT 的
    // supersedePostReply() 也能像作废自动轮一样作废按钮这一轮（此前按钮路从不注册 run，supersede 够不着）。
    const run = { messageId: idx, superseded: false, step: 'custom' };   // step：切聊天时 onChatChanged 只作废 diag / trainer，模板轮跑完后暂存
    beginPostReplyRun(run);
    try {
        await runCustomTask(ctx, s, idx, compatSession, true);
    } finally {
        finishPostReplyRun(run);
        drainPendingPostReply();
    }
}

// 自动校正【运行步】（仿 runAutoDiagnose）：对最新一条主聊天 AI 回复用【勾选目标 + 约束】跑一次两段式校正，
// 解析成功且确有改动则自动【作为新 swipe】应用（非破坏性，原文留在 swipe 0），每跑一轮在侧聊留一条记录。
// 后台操作：自建上下文、不碰窗口共享态、不 beginGeneration、不出问答气泡（与手动 runFixByTargets 的区别）。
// 【不】自管锁 / settle——编排（Task 5 的 message_received 监听）持锁；本函数只负责「跑这一次」。
// 一次性非流式调用（own AbortController + 120s 超时）。
export async function runAutoFix(ctx, s, targetId, compatSession, options = {}) {
    // 连接没配好就静默退出——别让每条回复都报错（开自动模式的人一般已配好直连 / 配置档）。
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) return;
    if (s.mode === 'profile' && !s.profileId) return;

    const fixContext = options.fixContext || await captureFixContext(s, { mode: 'auto', targetId });
    const cap = fixContext.captured;
    const tIdx = fixContext.targetIdx;
    if (!fixContext.targetProse.trim()) return;
    // R2 双重校正（自动）：目标当前 swipe 已是一次校正结果 → 跳过 + 记一条 nochange（防止在校正稿上再叠一层、越改越偏）。
    // 楼号一律读 tIdx（G 轮复审的纪律条）：快照取下之后，本函数只认 fixContext，
    // 让后续即使在中间加入 await，也不会转而读取另一轮捕获。
    if (isFixSwipe((ctx.chat || [])[tIdx])) { addAutoFixNote('nochange'); return; }

    if (fixLandAutoDecisions(s, null, fixContext).stop) return;
    if (ENABLE_FIX_PIECEWISE && fixContext.pieceDecision && fixContext.pieceTable) { await runAutoFixPieces(ctx, s, compatSession, fixContext); return; }
    // bypass / whole（无分段表）：继续走下面的老单段路径

    // 自动模式配置（per-chat 覆盖全局，再归一）；fixAutoMinChars = 成本门最小字符数（自动专属，不进归一）。
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const a = resolveFixModeCfg(cfg, 'auto');
    const targets = a.targets;
    const constraints = { knowledge: a.knowledge, guardrails: a.guardrails };

    // 成本门：不值得发调用（太短 / 没勾目标的禁词命中 / 没约束）→ 记一条「无需校正」直接跳过，不发 LLM。
    if (!options.messages && !fixPreFilter(fixContext.targetProse, targets, constraints, clampFixAutoMinChars(cfg.fixAutoMinChars))) { addAutoFixNote('nochange'); return; }

    const directive = options.directive ?? compileFixTargets(
        targets,
        { card: a.includeCard, context: a.includeContext, world: a.includeWorld },
        constraints,
        fixTargetOverrides(s),
    );
    if (!directive) return;                                      // 什么都没配（无目标 + 无约束）——不留记录、静默退出

    const messages = options.messages || ((fixUsePresetFor(s, 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive, fixContext)
        : maybeWrapJb([{ role: 'system', content: buildFixPrompt(ctx, s, fixContext) }, { role: 'user', content: directive }], 'fixAuto', s));
    const effMaxTokens = fixEffMaxTokens(s);   // Tier 0 ③：可被 fixMaxTokens 顶高（长楼层）
    const ctl = beginPostReplyCall(POST_REPLY_CALL_TIMEOUT_MS);      // 模块级中断器：240s 超时兜底 + 让「正在自动校正…」提示可点一下中断
    const genToast = showAutoFixGenerating();
    let finalText = '';
    try {
        finalText = await fixCallTransport(s, messages, ctl.signal, undefined, effMaxTokens, options.transport);
    } finally {
        ctl.end();
        dismissToast(genToast);
    }

    const parsed = parseFixedReply(finalText);
    if (!parsed) {   // ✨ 防呆（P5 接线）：失败分类成人话（空回复 / 模型拒绝 / 网关垃圾），空原因则记录字节不变
        const fr = fixFailureReason(finalText, undefined);
        let why = fr.kind === 'ok' ? '' : fr.message;
        // 这条回复期待 MVU 状态栏但环境没有 MVU：顺带说明「状态栏不显示是环境问题、与校正无关」（fixEnvNote）。
        try { if (replyExpectsMvu(fixContext.originalReply) && !(await getMvu())) why = (why ? why + '\n' : '') + fixEnvNote('mvuAbsent'); } catch (e) { /* ignore */ }
        addAutoFixNote('failed', why);
        return;
    }
    // Tier 0 ①：等于没改（逐字相同 或 近抄）→ 不落 swipe。区分提示：逐字相同=无需校正；近抄=模型基本没改（高上下文常见）。
    if (fixEffectivelyUnchanged(fixContext.targetProse, parsed.fixed)) { addAutoFixNote(fixNoOp(fixContext.targetProse, parsed.fixed) ? 'nochange' : 'nearcopy'); return; }
    // R1 P-TRUNC 截断守卫：原始回复里 <FixedReply> 开了没闭 → 合成 finish='length'；否则靠启发式（末尾断句 + 原文
    // 收尾干净 + 明显偏短）。截断稿会把回复腰斩成半句 → 不应用、记一条 truncated（不落 swipe）。
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(parsed.fixed, finishHint, fixContext.targetProse).truncated) { addAutoFixNote('truncated'); return; }

    // 接回原回复的机制块（<UpdateVariable> + 状态栏占位符）+ 用户「排除·保留」区，再作为【新 swipe】应用。
    // ✨ overlap（opt-in fixWaitForMvu）：校正的 LLM 已和 MVU 额外模型更新【并行】跑完；写 swipe 前【等 MVU 写完】，
    // 再把它事后注入的机制块（<UpdateVariable> + 占位符）从【当前】回复接到校正稿末尾（mergeMvuTail）。不开 / 无 MVU /
    // MVU 不忙 → awaitMvuIdle 即时返回、mergeMvuTail 无操作，行为字节不变。
    const boundary = await awaitFixMvuBoundary(s, compatSession, cap && cap.chatId);
    if (!boundary.proceed) return;   // 等 MVU 期间被中断 / supersede / 兼容超时 → 不写
    const innerFixed = composeFixedReply(parsed.fixed, fixContext.originalReply, fixContext.extraKeep);
    let finalText2 = wrapContentScope(fixContext.scope, innerFixed);
    if (boundary.coordinated) finalText2 = mergeMvuTail(finalText2, (ctx.chat || [])[tIdx]?.mes);   // MVU 事后注的机制块补接末尾
    // P-CORRUPT 权威网：LLM 返回后聊天可能已切走 / 这条回复已换 swipe / 被编辑 / 被删——写入前再核对捕获快照，失效则不写、记一条
    // stale。overlap 模式（fixWaitForMvu）用 mvuTolerant：只比去机制块正文，容忍 MVU 刚注入的块，仍拦真编辑 / 换 swipe / 切聊天 / 目标没了。
    // 陈旧守卫 → 落地 / 暂存 / stale（1.77.0 起「切聊天」不再丢弃，见 fixLandOrPark）。落地时抓【应用后】
    // 落点的 swipe_id（fixLandResult 里），给记录的「用原文 ↔ 用校正稿」开关用；原文留在 swipe 0。
    // before = 去机制块的本轮 targetProse；after 必须也是【纯散文】parsed.fixed——不是 finalText2：
    // finalText2 经 composeFixedReply 接回了 <UpdateVariable> + 状态栏占位符 + 保留区，拿它做 after 会让 MVU 卡
    // 的整个状态块在差异里被误标成大段绿色新增。prose ↔ prose 才干净（与手动卡 stripMechanismBlocks(原文)
    // vs parsed.fixed 一致）。swipe 目标仍是 finalText2 落点（不动）。
    await fixLandOrPark({
        captured: cap, targetIdx: tIdx, joined: finalText2, status: 'fixed',
        problems: parsed.problems, before: fixContext.targetProse, after: parsed.fixed, meta: null,
    }, { mvuTolerant: boundary.coordinated });
}

