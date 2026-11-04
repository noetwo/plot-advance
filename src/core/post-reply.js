import { POST_REPLY_CALL_TIMEOUT_MS, getCtx, getSettings } from './settings.js';
import { sharedState } from './state.js';
import { buildDiagnosePromptFrom } from '../modes/chat/context.js';
import { chatIdentityKey } from '../modes/chat/send.js';
import { diagSeedTargetFloor, mvuLatestMsgId, mvuMsgOpts } from '../modes/diagnose/auto.js';
import { diagCountPatchBlocks, diagOpOutcomes, diagParseFailReason, diagPatchOpsOf, diagScopePatchToUntouched, diagStatKey, mvuedMaybeRefresh, runTrainer, trainerReadRules } from '../modes/diagnose/editor.js';
import { extractUpdateBlock, getLatestAiMessage, getMvu, getMvuStatData, mvuStatOf, resolveAutoTargetMessage } from '../modes/diagnose/mvu.js';
import { canonicalizeDiagOps, diagGateProbe, diagSchemaFilterPatch, diagSchemaRetryRound, diagShownPatch, diagZeroChangeReport, dismissToast, injectDiagPatchIntoMessage, maybeRunSaveHealth, notifyAutoDiagnose, repairDiagPatch, showAutoDiagGenerating, toastDiagChatSwitched } from '../modes/diagnose/schema.js';
import { diagCaptureSwipe, diagCmpKey, diagPinMoved } from '../modes/fix/algorithms.js';
import { fixDrainParked, runAutoFix, runCustomTask } from '../modes/fix/staging.js';
import { getEffectiveFixCfg, getFixCfg, resolveFixCustomCfg } from '../modes/fix/templates.js';
import { updateFixVerdict } from '../modes/fix/ui.js';
import { buildDiagSelectedWi, diagPickerActive } from '../modes/lorebook/core.js';
import { buildDiagnosePresetMessages } from '../presets/messages.js';
import { AUTO_DIAGNOSE_WRITE_BACK, ENABLE_AUTO_DIAGNOSE, ENABLE_DIAG_BODY_INJECT, ENABLE_DIAG_FLOOR_SEED, ENABLE_FIX_CUSTOM_TASK, ENABLE_MVU_TRAINER, ENABLE_REPLY_FIX, ENABLE_SCHEMA_DIAG, STATUS_PLACEHOLDER } from '../prompts/builtins.js';
import { P } from '../prompts/registry.js';
import { buildWorldInfo, collectMvuUpdateRules, wiContextMode } from '../st/adapters.js';
import { callDirect, callProfile, resolveEndpointUrl } from '../transport/direct.js';
import { maybeWrapJb, presetCurationActive } from '../ui/settings.js';

/* ------------------------------------------------------------------ *
 * 用户功能请求：自动诊断 + ✨ 校正模式 Phase 3 —— 统一的「回复后编排」。
 * 每收到一条新的主聊天 AI 回复，就在【单一共享锁】下按固定顺序跑：先自动校正（润色 / 换 swipe），
 * 后自动诊断（确有错误时经 MVU 自动应用修复）。诊断【在后】是刻意的：它读到的是已校正后的正文（§5.10）。
 * 两者各自全程无界面：自建提示词（不碰窗口共享状态）、非流式调用，仅在确有改动时落地。
 * MVU「额外模型解析」并用由 autoDiagnoseMvuCompat 显式协调；默认关时保持既有时序、不增加等待。
 * ------------------------------------------------------------------ */
sharedState.postReplyBusy = false;         // 单一共享锁：自动校正与自动诊断不得并发抢占同一条回复
sharedState.autoDiagErrorToasted = false;  // 诊断错误 toast 每会话只弹一次，免得每条回复都打扰
sharedState.postReplyAbortCtl = null;      // 当前在途的「回复后」自动调用（自动校正 / 自动诊断）的中断器（120s 超时 + 用户中断共用）
sharedState.postReplyCancelled = false;    // 用户点了「正在自动…」提示里的中断 → 跳过本轮剩余步骤（如自动校正被中断后不再接着自动诊断）
sharedState.activePostReplyRun = null;     // { messageId, superseded }：新用户回合可静默作废旧作业，不冒充手动取消
sharedState.pendingPostReplyRun = null;    // {messageId,chatKey,messageRef}：锁忙时只保留最新 AI 回复，并钉住所属聊天

// 仿 arcBeginCall：把在途调用的中断器挂到模块级，让「正在自动校正 / 诊断…」提示可点一下中断它（ms = 超时兜底）。
export function beginPostReplyCall(ms) {
    let ctl = null;
    try { ctl = new AbortController(); } catch (e) { return { signal: undefined, end() {} }; }
    sharedState.postReplyAbortCtl = ctl;
    let timer = null;
    try { timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, ms); } catch (e) { /* 无 timers 环境 */ }
    return { signal: ctl.signal, end() { if (timer) clearTimeout(timer); if (sharedState.postReplyAbortCtl === ctl) sharedState.postReplyAbortCtl = null; } };
}
// 用户点提示「中断」：作废本轮（让 maybePostReply 跳过剩余步骤）+ 中断在途调用。自动校正与自动诊断共用同一个。
export function cancelPostReply() {
    sharedState.postReplyCancelled = true;
    try { if (sharedState.postReplyAbortCtl) sharedState.postReplyAbortCtl.abort(); } catch (e) { /* ignore */ }
}

// 当前自动轮是否必须停止。手动取消与“新用户输入使旧轮过期”在执行层都要停，但只有前者应提示用户。
export function postReplyShouldStop() {
    return sharedState.postReplyCancelled || !!(sharedState.activePostReplyRun && sharedState.activePostReplyRun.superseded);
}

// MESSAGE_SENT 专用：静默让旧轮失效并撤掉尚未开跑的旧 AI pending。只中止 Story Oracle 自己的请求；
// MVU 外部解析没有公开 cancel，仍可在后台自行收尾。返回值只供测试 / 诊断，不参与业务判断。
export function supersedePostReply() {
    sharedState.pendingPostReplyRun = null;
    if (!sharedState.activePostReplyRun) return false;
    sharedState.activePostReplyRun.superseded = true;
    try { if (sharedState.postReplyAbortCtl) sharedState.postReplyAbortCtl.abort(); } catch (e) { /* ignore */ }
    return true;
}

// 纯（1.77.0）：切聊天时【哪些处理器】的在途轮次必须随之作废。
// 🩺 诊断 / 🎛 修改器写的是【当前聊天】的 MVU 状态 —— 切走即作废，这一条不变。
// ✨ 校正 / 📋 模板任务只往【那条回复】里写一个新 swipe，让它跑完：落地时发现聊天已切走就暂存
// （fixLandOrPark），回到原聊天时自动落地（fixDrainParked）。step 为空（还没进任一步）时不作废——
// 那一轮还没花钱，也没有任何待写的东西。
function postReplyStepCancels(step) {
    return step === 'diag' || step === 'trainer';
}

// 运行时薄封装：当前这一轮该不该因为切聊天而作废。onChatChanged 与 CHAT_CHANGED 的 supersede
// 监听器【共用同一条判据】——两处各写一份就是漂移温床（1.77.0 第一版就漏了监听器那一处，
// 结果模板轮照样被 supersede 掉、暂存永远走不到）。
export function postReplyCancelsOnChatSwitch() {
    return !!(sharedState.postReplyBusy && sharedState.activePostReplyRun && postReplyStepCancels(sharedState.activePostReplyRun.step));
}

// CHAT_CHANGED 专用：切聊天先撤掉尚未开跑的旧 AI pending（它属于旧聊天，绝不该在新聊天里补跑），
// 但只有诊断 / 修改器的在途轮次才随之作废。返回值只供测试 / 诊断。
export function supersedePostReplyOnChatSwitch() {
    sharedState.pendingPostReplyRun = null;
    if (postReplyCancelsOnChatSwitch()) return supersedePostReply();
    return false;
}

// 共享锁的【补跑步】：锁忙期间若又落了一条 AI 回复，释放后立即补跑最新那条。maybePostReply 的 finally
// 与 📋 runCustomTaskNow 的 finally 逐字共用同一份（两处曾各写一份 = 漂移温床）。
// 不 await，保持与原 MESSAGE_RECEIVED 调度一样 fire-and-forget，也避免把旧轮的 finally 生命周期错误地
// 延长到新轮。调用点必须先把 postReplyBusy 置回 false（否则补跑那一轮会立刻被锁挡下、再次入队）。
export function drainPendingPostReply() {
    const pending = sharedState.pendingPostReplyRun;
    sharedState.pendingPostReplyRun = null;
    const pendingCtx = getCtx();
    if (pending
        && pending.chatKey === chatIdentityKey()
        && (pendingCtx?.chat || [])[pending.messageId] === pending.messageRef) {
        Promise.resolve(maybePostReply(pending.messageId)).catch((e) => console.warn('[Story Oracle] pending 回复后编排失败：', e));
    }
    // ✨/📋 1.77.0（复审 minor #9）：暂存的成品若因为「有一轮在飞」而被 fixDrainParked 让过，这里是锁刚
    // 释放的那一刻——补唤一次。放在补跑【之后】：补跑那一轮若真开跑会同步把锁重新置真，我们就再让一次，
    // 由它自己的 finally 把这条链接下去（不会丢，也永远不会与在飞的一轮交错写）。
    Promise.resolve(fixDrainParked()).catch((e) => console.warn('[Story Oracle] 暂存的校正结果落地失败：', e));
}

// 纯决策核（零回归证据核，单测在 fix-orchestrator.test.mjs）：给定杀死开关 flags={fix,diag,trainer,custom}
// 与设置 s，返回按执行顺序排好的处理器名数组。'fix'（或占同一槽位的 'custom'）在前、'diag' 在后；某项要跑
// 当且仅当「杀死开关开 且 对应设置开」。【false 开关压过 true 设置】。nullish 安全（flags / s 缺省即按未开处理）。
// 诊断单开（autoFixEnabled:false）时计划恒为 ['diag']，与旧 maybeAutoDiagnose 的门控严格等价。
// 📋 'custom' 与 'fix' 是【二选一】（if/else），绝不同现：同一个 autoFixEnabled 闸门、同一个槽位，
// 由 s.fixTask（'fix' | 'custom'）分流；fixTask 缺省 / 非 'custom' 一律回退 'fix'——老用户零波及。
function postReplyPlan(flags, s) {
    const plan = [];
    // 📋 自定义模板任务（spec §5.1）：占 fix 的槽位、与 fix 二选一——同一把锁、同一顺序（诊断 / 修改器仍排其后）。
    const custom = !!(flags && flags.custom && s && s.autoFixEnabled && s.fixTask === 'custom');
    if (custom) plan.push('custom');
    else if (flags && flags.fix && s && s.autoFixEnabled) plan.push('fix');
    if (flags && flags.diag && s && s.autoDiagnoseEnabled) plan.push('diag');
    // 🎛 修改器（1.63.0）恒排最后：诊断是「猜剧情该怎么改」，修改器是用户的显式覆盖，后写者赢。
    // 条件是【本聊天有生效规则】，与两个自动开关无关——关了自动校正不该让修改器停摆。
    if (flags && flags.trainer && s && s.trainerActive) plan.push('trainer');
    return plan;
}

// 回复后编排的事件类型闸（1.89.0，单测在 postreply-first-message.test.mjs）：MESSAGE_RECEIVED 的第二参是生成类型。
// 'first_message' 不是一条新回复——ST public/script.js getChatResult() 每次打开「只有开场白」的聊天（新建 + 重开）
// 都会发 MESSAGE_RECEIVED(0, 'first_message')，角色编辑里重生成开场白也发一次。照跑的话，每开一次聊天就在开场白上
// 跑一轮自动校正 / 自动诊断 / 修改器（修改器「每轮 +X」每开一次加一次；诊断每开一次花一次模型调用）。
// 其余类型（含缺省 / 旧式不带类型的 emit）一律照旧放行。
export function postReplyHandlesType(type) {
    return type !== 'first_message';
}

// message_received 监听的落点：在共享锁下，对一条 AI 回复按 postReplyPlan 顺序跑校正 / 诊断。
// ✨ 自动校正 ↔ MVU「额外模型更新」抢写协调（opt-in fixWaitForMvu）。MVU 的额外模型解析在回复后【自己异步】发一次
// 模型调用再写 <UpdateVariable> + 状态；auto-校正也在回复后异步发调用 + 写新 swipe——两者抢写同一条消息会串味 /
// 覆盖 / 出重复块。MVU 暴露 isDuringExtraAnalysis()（+ mag_variable_update_started/ended 事件），据此在动手前等它写完。
// 纯防御：无 MVU / 旧版无此 API → 一律「不忙」，等待即刻结束，对不用额外模型更新的人零影响。可单测。
export function mvuIsBusy(mvu) {
    return !!(mvu && typeof mvu.isDuringExtraAnalysis === 'function' && mvu.isDuringExtraAnalysis());
}

const MVU_COMPAT_START_WAIT_MS = 4000;       // MVU 的 MESSAGE_RECEIVED 入口有 3s throttle；从原回复落地起给 4s
const MVU_COMPAT_BATCH_CAP_MS = 600000;      // 整批（含重试）最多 10 分钟；到点宁可跳过，绝不与仍在跑的 MVU 抢写
const MVU_COMPAT_POLL_MS = 100;
const MVU_COMPAT_SETTLE_MS = 300;            // UPDATE_ENDED 早于 MVU 最后的消息 / 状态写入，给尾写一个短稳定窗
const mvuCompatLifecycle = {
    startedSeq: 0,
    endedSeq: 0,
    idleEndedSeq: 0,
    lastIdleEndedAt: 0,
};

// 记录 MVU 的公开生命周期信号。ended 只有在“事件当下 MVU 已空闲”时才进入 idleEndedSeq：这样旧额外请求
// 仍忙时，新楼层自己发出的 ended 不会被误认成旧批次最终完成。state 可注入，只为纯异步单测隔离。
export function mvuCompatLifecycleMark(kind, mvu, now = Date.now(), state = mvuCompatLifecycle) {
    if (!state || typeof state !== 'object') return state;
    state.startedSeq = Number(state.startedSeq) || 0;
    state.endedSeq = Number(state.endedSeq) || 0;
    state.idleEndedSeq = Number(state.idleEndedSeq) || 0;
    state.lastIdleEndedAt = Number(state.lastIdleEndedAt) || 0;
    if (kind === 'started') {
        state.startedSeq++;
    } else if (kind === 'ended') {
        state.endedSeq++;
        if (!mvuIsBusy(mvu)) {
            state.idleEndedSeq++;
            state.lastIdleEndedAt = Number(now) || Date.now();
        }
    }
    return state;
}

// 等待一次 MVU“额外模型解析”逻辑批次。第一眼 false 只表示“此刻不忙”，不能说明没开；先观察 4s。
// 一旦见过 true 就【锁存 started】——之后 retry 间隙的 false 一律不放行，须等最终 idle UPDATE_ENDED。
// opts 的短时值仅供单测；生产调用只传 enabled/isCancelled，使用上面四个具名常量。
async function awaitMvuCompatBatch(mvu, opts = {}) {
    const enabled = !!opts.enabled;
    const startedWall = Date.now();
    const result = (status, started) => ({
        status,
        started: !!started,
        waitedMs: Math.max(0, Date.now() - startedWall),
    });
    if (!enabled) return { status: 'disabled', started: false, waitedMs: 0 };
    if (!mvu || typeof mvu.isDuringExtraAnalysis !== 'function') return result('not-started', false);

    const lifecycle = (opts.lifecycle && typeof opts.lifecycle === 'object') ? opts.lifecycle : mvuCompatLifecycle;
    const startWaitMs = opts.startWaitMs != null ? Math.max(0, Number(opts.startWaitMs) || 0) : MVU_COMPAT_START_WAIT_MS;
    const batchCapMs = opts.batchCapMs != null ? Math.max(0, Number(opts.batchCapMs) || 0) : MVU_COMPAT_BATCH_CAP_MS;
    const pollMs = opts.pollMs != null ? Math.max(1, Number(opts.pollMs) || 1) : MVU_COMPAT_POLL_MS;
    const settleMs = opts.settleMs != null ? Math.max(0, Number(opts.settleMs) || 0) : MVU_COMPAT_SETTLE_MS;
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    const baselineIdleEnded = Number(lifecycle.idleEndedSeq) || 0;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let started = mvuIsBusy(mvu);
    while (!started && Date.now() - startedWall < startWaitMs) {
        if (isCancelled()) return result('cancelled', false);
        await sleep(pollMs);
        started = mvuIsBusy(mvu);
    }
    if (isCancelled()) return result('cancelled', started);
    // Deadline 边缘再读一次，避免恰在最后一个 poll 后起跑却被误判 not-started。
    if (!started) started = mvuIsBusy(mvu);
    if (!started) return result('not-started', false);

    const batchStartedWall = Date.now();
    while (Date.now() - batchStartedWall < batchCapMs) {
        if (isCancelled()) return result('cancelled', true);
        const idleEndedSeq = Number(lifecycle.idleEndedSeq) || 0;
        if (!mvuIsBusy(mvu) && idleEndedSeq > baselineIdleEnded) {
            const endedAt = Number(lifecycle.lastIdleEndedAt) || 0;
            if (settleMs) await sleep(settleMs);
            if (isCancelled()) return result('cancelled', true);
            // settle 窗内若下一次 retry 又起跑，就回循环继续等；false 间隙永远不是完成证据。
            if (!mvuIsBusy(mvu)
                && (Number(lifecycle.idleEndedSeq) || 0) >= idleEndedSeq
                && (Number(lifecycle.lastIdleEndedAt) || 0) >= endedAt) {
                return result('completed', true);
            }
        }
        await sleep(pollMs);
    }
    return result('timed-out', true);
}

// 每条回复只建一份兼容会话；promise 在 MESSAGE_RECEIVED 编排入口立刻起跑，故既能覆盖 MVU 的
// 3s throttle，又能与 Story Oracle 既有 settle / fixer LLM 重叠。wait 可被校正与诊断重复消费，
// 但真正的生命周期观察只执行一次。disabled 会立即 resolve，默认关闭没有轮询也没有四秒延时。
function createMvuCompatSession(mvu, enabled) {
    const active = !!enabled;
    const promise = awaitMvuCompatBatch(mvu, {
        enabled: active,
        isCancelled: postReplyShouldStop,
    });
    return {
        enabled: active,
        wait: () => promise,
    };
}

// 既有回复后 settle 也属于本轮自己的等待：新用户发言时应在很短时间内静默释放旧 worker，不能
// 固定睡完 1.2s 才发现它早已过期。返回 false 表示本轮已被手动取消或 supersede。
async function awaitPostReplyDelay(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
        if (postReplyShouldStop()) return false;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, end - Date.now()))));
    }
    return !postReplyShouldStop();
}
// 条件式等待 MVU 空闲：轮询 isDuringExtraAnalysis() 直到为假 / 到 cap（兜底绝不挂死，到点照常继续）/ 被取消。
// 回已等毫秒（供日志 / 测试）。这是「按条件等」而非盲计时——MVU 写完的那一刻就往下走，无论它的额外模型调用多慢。
export async function awaitMvuIdle(mvu, opts = {}) {
    const capMs = (opts.capMs != null) ? opts.capMs : 120000;   // 额外模型是一次完整 LLM 往返；给足，但到点仍继续
    const pollMs = (opts.pollMs != null) ? opts.pollMs : 250;
    const isCancelled = (typeof opts.isCancelled === 'function') ? opts.isCancelled : () => false;
    let waited = 0;
    while (mvuIsBusy(mvu) && waited < capMs && !isCancelled()) {
        await new Promise((r) => setTimeout(r, pollMs));
        waited += pollMs;
    }
    return waited;
}

// 自动校正的统一写边界。诊断兼容开启时，即使 fixWaitForMvu 没勾，fixer 也必须共享同一批次 promise：
// LLM 生成照常与 MVU 并行，但落 swipe 前才 await；批次超时 / 取消则丢弃旧稿。旧的 fixer-only
// fixWaitForMvu 仍保留（没开诊断兼容也照常按 busy 等），两者任一开启即启用尾块合并 + MVU 容忍守卫。
export async function awaitFixMvuBoundary(s, compatSession, capturedChatId) {
    const compatEnabled = !!(compatSession && compatSession.enabled && typeof compatSession.wait === 'function');
    const coordinated = !!(s && s.fixWaitForMvu) || compatEnabled;
    if (postReplyShouldStop()) return { proceed: false, coordinated, status: 'cancelled' };
    // 1.77.0：切聊天不再作废校正 / 模板轮（成品会暂存），但【等 MVU】这件事在切走之后已经没有意义 ——
    // 它协调的是【当前聊天】的 MVU 写入，而本轮的成品接下来只会被暂存。继续等只会白占共享锁最长十分钟
    // （兼容会话的上限）。直接放行：落地闸随即判 chatSwitched → 暂存。coordinated 报 false 是诚实的
    // （这一轮没等成），也让 mergeMvuTail 不去动一条已经不在眼前的回复；fixTargetStale 先比 chatId，
    // 所以暂存的结论与 coordinated 无关。
    // ★ 判据用【调用方传进来的】捕获聊天 id，绝不读模块级 fixCaptured（复审 Critical #1）：那个全局
    // 在这几十秒里可能已被别的聊天里的手动校正覆写，读它会让「聊天已切走」判成假 → 逃生门失灵 →
    // 接着按【别人的】捕获去比对现状 → 跨聊天串写。缺省（旧的两参调用）= 不启用逃生门，行为同 1.76.0。
    if (capturedChatId != null && capturedChatId !== chatIdentityKey()) return { proceed: true, coordinated: false, status: 'chatSwitched' };

    if (compatEnabled) {
        const outcome = await compatSession.wait();
        if (postReplyShouldStop()) return { proceed: false, coordinated, status: 'cancelled' };
        if (outcome && (outcome.status === 'timed-out' || outcome.status === 'cancelled')) {
            return { proceed: false, coordinated, status: outcome.status };
        }
    }
    if (s && s.fixWaitForMvu) {
        await awaitMvuIdle(await getMvu(), { isCancelled: postReplyShouldStop });
    }
    if (postReplyShouldStop()) return { proceed: false, coordinated, status: 'cancelled' };
    return { proceed: true, coordinated, status: 'ready' };
}

export async function maybePostReply(messageId) {
    const ctx = getCtx(); if (!ctx) return;
    const s = getSettings();
    // 编排门控：autoFixEnabled 走【本聊天】生效配置（Phase 4 per-chat 迁移）；autoDiagnoseEnabled
    // 不迁移、仍读全局 s。postReplyPlan 保持纯函数——这里把两者拼成它要读的 {autoFixEnabled, autoDiagnoseEnabled}。
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const gate = {
        autoFixEnabled: cfg.autoFixEnabled,
        autoDiagnoseEnabled: s.autoDiagnoseEnabled,
        // 现读规则表：修改器的「开关」就是「这个聊天有没有规则」，没有第二个开关要维护。
        trainerActive: ENABLE_MVU_TRAINER && trainerReadRules().length > 0,
        // 📋 自定义模板任务：任务选择也是【本聊天】配置，与 autoFixEnabled 同一份 cfg（'fix' | 'custom'）。
        fixTask: resolveFixCustomCfg(cfg).task,
    };
    const plan = postReplyPlan({ fix: ENABLE_REPLY_FIX, diag: ENABLE_AUTO_DIAGNOSE, trainer: ENABLE_MVU_TRAINER, custom: ENABLE_FIX_CUSTOM_TASK && ENABLE_REPLY_FIX }, gate);
    if (!plan.length) return;                               // 两个杀死开关 / 两个设置都没开 → 不做事、不动模型
    const idx = Number(messageId); const m = (ctx.chat || [])[idx];
    if (!m || m.is_user || m.is_system) return;             // 只处理 AI 回复（排除用户 / 系统消息）
    // eventSource 不会等本函数；若上一轮仍占锁，保留最新合法 AI 回复，释放后补跑。单槽刻意采用
    // “last write wins”：连着 swipe / regenerate 时，过期的中间回复不值得再花一次模型调用。
    if (sharedState.postReplyBusy) {
        sharedState.pendingPostReplyRun = { messageId: idx, chatKey: chatIdentityKey(), messageRef: m };
        return;
    }
    if (sharedState.isGenerating) return;                               // 不在主聊天生成中途插手
    // 身份钉在【入口】现拍一次，不要留到调用 runTrainer 那一行才现读 chatIdentityKey()——runTrainer 内部
    // 自己的两道身份判断（写前/写后）拿这个值当基准，若基准本身是调用那一刻才现采的，就跟它要判断
    // 的对象（当前 chatIdentityKey()）在时间上几乎重合，判了等于没判。这里钉住的是「这一整轮编排开始时」
    // 是哪个聊天，才是它俩真正该比对的锚点。
    // 🩺 诊断加固 Task 3：自动诊断的事务闸也认这【同一枚】锚点（它的模型往返比修改器长得多，
    // 更需要一个「这一轮开始时」的基准），故一并顺给 runAutoDiagnose。
    const chatKey = chatIdentityKey();
    const run = { messageId: idx, superseded: false, step: null };   // step = 正在跑的处理器名（onChatChanged 据此决定作废谁）
    sharedState.postReplyBusy = true;
    sharedState.postReplyCancelled = false;                                 // 每轮开始清零；用户点提示「中断」会把它置真
    sharedState.activePostReplyRun = run;
    // 兼容会话必须在 MESSAGE_RECEIVED 入口、既有 settle 之前启动。只在“自动诊断实际会跑 + 用户显式
    // 勾选兼容”时启用；否则是即时 resolved 的 disabled，会保持旧用户零额外等待。
    const compatSession = createMvuCompatSession(
        sharedState.mvuApi || window.Mvu,
        plan.includes('diag') && !!s.autoDiagnoseMvuCompat,
    );
    try {
        // 给普通 / 行内 MVU 先消化这条回复的更新，再读取权威状态。兼容开启时，额外解析的 4s
        // 启动窗已在上方并行起跑；校正与诊断仍共用这一次 settle，不另叠一份固定延时。
        if (!await awaitPostReplyDelay(Math.max(0, (s.autoDiagnoseDelayMs | 0) || 1200))) return;
        for (const step of plan) {
            if (postReplyShouldStop()) break;                   // 用户中断 / 新回合 supersede → 跳过剩余步骤
            // 🩺/🎛 诊断与修改器写的是【当前聊天】的 MVU 状态：聊天已切走就别再开跑（此前靠 onChatChanged
            // 的无条件 cancelPostReply 顺手挡下；1.77.0 起校正 / 模板轮不再被切聊天作废，这道判据要显式写出来，
            // 否则「校正跑到一半切了聊天」会让诊断在新聊天里白花一次调用，回来才被写入前的事务闸拦下）。
            // 判据走【唯一那份】谓词 postReplyStepCancels —— 把 'diag' / 'trainer' 的名单抄第二遍就是漂移温床。
            if (postReplyStepCancels(step) && chatIdentityKey() !== chatKey) break;
            run.step = step;                                    // onChatChanged 的作废判据读它（只作废 diag / trainer）
            try {
                if (step === 'fix') await runAutoFix(ctx, s, idx, compatSession);
                else if (step === 'custom') await runCustomTask(ctx, s, idx, compatSession);
                else if (step === 'diag') await runAutoDiagnoseWithRetry(ctx, s, idx, chatKey, compatSession);
                else await runTrainer(chatKey, compatSession);
            } catch (e) {
                if (postReplyShouldStop()) break;               // abort / supersede → 静默收尾，不当报错
                const stepName = step === 'fix' ? '自动校正' : (step === 'custom' ? '📋 模板任务' : (step === 'diag' ? '自动诊断' : '🎛 修改器'));
                console.warn(`[Story Oracle] ${stepName}失败：`, e);
                // 沿用诊断的「每会话一次」错误 toast（校正的失败已在其侧聊记录里反映，不再额外打扰；
                // 修改器有意静默——不弹 toast，只留上面这行 console.warn）。
                if (step === 'diag' && !sharedState.autoDiagErrorToasted) {
                    sharedState.autoDiagErrorToasted = true;
                    try { window.toastr && window.toastr.warning && window.toastr.warning('剧情推进：自动诊断这一轮没跑成（详见控制台）。后续回复会继续尝试。', '自动诊断'); } catch (e2) { /* ignore */ }
                }
            }
        }
    } finally {
        // 用户中断：给一句确认（abort 发生在写入之前，故这条回复未被改动）。
        if (sharedState.postReplyCancelled) { try { window.toastr && window.toastr.info && window.toastr.info('已中断本轮自动处理（未改动这条回复）。', '剧情推进'); } catch (e) { /* ignore */ } }
        try { updateFixVerdict(); } catch (e) { /* 窗口没开等——判定预览行刷新失败无碍（✨ 1.18.0） */ }
        if (sharedState.activePostReplyRun === run) sharedState.activePostReplyRun = null;
        sharedState.postReplyCancelled = false;
        sharedState.postReplyBusy = false;
        // 🎛 打开中的变量编辑器「跟随现实」：自动诊断刚刚可能写过 stat_data，而【这里】才是它写完的确定时刻。
        // 直接刷、不走防抖：message_received 那颗定时器早在 300ms 后就烧完了（诊断一趟是完整的模型往返），
        // 靠它等于赌运气。本函数空操作安全（卡没开 / 值没变 / 切了聊天都自己返回），无脑调即可。
        try { mvuedMaybeRefresh('post-reply'); } catch (e) { /* 刷新失败绝不影响编排收尾 */ }
        // 锁忙期间若又落了一条 AI 回复，立即补跑最新那条（共用 drainPendingPostReply）。
        drainPendingPostReply();
    }
}

// ── 🔁 自动诊断 · 失败自动重试（Prince 点单 2026-08-28，默认关） ──────────────────────────
// 纯：一轮自动诊断的【结局】→ 重试类别；null = 恒不重试。
// outcome = runAutoDiagnose 的返回值：安全跳过（早退）回 undefined；分类结局回 result
// （{status, code?}）；调用抛错由包装层折成 { kind: 'error' }。
//   'empty'  空白回复——unparsed 且 diagParseFailReason 码 'empty'（拒答 / 截断，模型什么都没给）
//   'format' 格式错误——unparsed 其余码（unclosed/noblock/nonstd）+ doubleblock + failed
//            （模型给了东西但我们受理不了 / MVU 解析不动）
//   'error'  调用本身失败（网络 / 中转 / 超时）
// 「恒不重试」是承重面：applied/verified = 成功；ineffective/nochange = 【判定型】结局（补丁被
// 受理、跑过了——重掷大概率原样落空，且 noop-equal 本就是「已生效」的签名，见 1.69.0 地雷条）；
// stale 与一切安全跳过 = 世界已变（切聊天 / 状态被写 / 中断 / supersede），重试 = 与事务闸对着干。
function diagRetryCategory(outcome) {
    if (!outcome) return null;
    if (outcome.kind === 'error') return 'error';
    if (outcome.status === 'unparsed') return outcome.code === 'empty' ? 'empty' : 'format';
    if (outcome.status === 'doubleblock' || outcome.status === 'failed') return 'format';
    return null;
}

// 纯：重试次数上限。用户可输入任意次数（Prince 定调：2 只是默认值）——非数回默认 2，取整后钳
// [1,99]（想关请用主开关，0 不是「关」的写法；上钳挡手滑的天文数字——每一跳都是真调用）。
export function diagRetryMax(s) {
    const n = Math.floor(Number(s && s.autoDiagnoseRetryMax));
    if (!Number.isFinite(n)) return 2;
    return Math.min(99, Math.max(1, n));
}

// 纯：这一轮结束后还要不要再试。used = 已用掉的重试次数（首跑之后为 0）。
// 三道闸依次：主开关 → 次数上限 → 该类别的勾选框。
function diagShouldRetry(outcome, s, used) {
    if (!s || !s.autoDiagnoseRetry) return false;
    if (used >= diagRetryMax(s)) return false;
    const cat = diagRetryCategory(outcome);
    if (cat === 'empty') return !!s.autoDiagnoseRetryOnEmpty;
    if (cat === 'format') return !!s.autoDiagnoseRetryOnFormat;
    if (cat === 'error') return !!s.autoDiagnoseRetryOnError;
    return false;
}

// 编排包装（maybePostReply 的 diag 步走这里）：跑一次 runAutoDiagnose，按结局决定重不重试。
// 每一跳都是【完整的一轮】——重新等 MVU、重新快照状态与正文、重新组提示词，绝不拿上一跳的旧
// 快照凑合（部分失败后世界可能已经变了）。抛错折成 'error' 类别参与裁决；最终不再重试的抛错
// 【原样上抛】，走 maybePostReply 既有的 console.warn + 每会话一次的失败 toast（= 主开关关时
// 与旧行为逐字节相同）。中断 / supersede 恒赢：跳与跳之间再核一次 postReplyShouldStop。
async function runAutoDiagnoseWithRetry(ctx, s, targetId, chatKey, compatSession) {
    const max = (s && s.autoDiagnoseRetry) ? diagRetryMax(s) : 0;
    for (let used = 0; ; used++) {
        let outcome = null, thrown = null;
        try {
            outcome = await runAutoDiagnose(ctx, s, targetId, chatKey, compatSession, { used, max });
        } catch (e) {
            thrown = e;
            outcome = { kind: 'error', error: e };
        }
        if (postReplyShouldStop() || !diagShouldRetry(outcome, s, used)) {
            if (thrown) throw thrown;
            return;
        }
        console.warn(`[Story Oracle] 自动诊断这一跳没跑成（${thrown ? '调用失败' : String(outcome && outcome.status)}），自动重试 ${used + 1}/${max}…`, thrown || '');
    }
}

// 后台诊断主体：自建诊断提示词 → 调模型 → 解析出修正区块 → 仅在确有改动时经 MVU 应用。
// chatKey（第 4 参）= 编排入口 maybePostReply 现拍的聊天身份锚点，事务闸拿它当基准；compatSession
//（第 5 参）= 同一入口立刻起跑的 MVU 外部解析批次观察器，必须先于状态 / 正文快照消费。
// retryState（第 6 参，可空）= 🔁 重试包装传入的 { used, max }：used>0 时「正在诊断」toast 带上
// 重试标注；本轮失败且还会再试时，记录末尾加一行标注、失败 warning 让位（见 notifyAutoDiagnose）。
// 返回值 = 本轮结局（分类结局回 result，安全跳过回 undefined），供包装层裁决重试；直调不接返回值
// 的旧调用方零影响。
async function runAutoDiagnose(ctx, s, targetId, chatKey, compatSession, retryState) {
    const Mvu = await getMvu();
    if (!Mvu) return;                                       // 没有 MVU 就没什么可诊断
    // 连接没配好就静默退出——别让每条回复都报错（开自动模式的人一般已配好直连 / 配置文件）。
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) return;
    if (s.mode === 'profile' && !s.profileId) return;
    // opt-in 兼容：整批（含重试）结束后才捕获目标楼与权威状态。外部解析成功追加有效块 → 下方走核验；
    // 失败 / 空结果 → 下方照常走推导。十分钟仍不能证明收尾则宁可跳过，绝不与未知在途写者抢写。
    if (compatSession && compatSession.enabled && typeof compatSession.wait === 'function') {
        const compat = await compatSession.wait();
        if (postReplyShouldStop()) return;
        if (compat && (compat.status === 'timed-out' || compat.status === 'cancelled')) {
            console.debug(`[Story Oracle] 自动诊断：MVU 额外解析兼容等待 ${compat.status}，本轮安全跳过（未写入）。`);
            return;
        }
    }
    // 诊断与额外模型解析零排序是审计簇 G——修改器同款等待，写前也再等一次。
    // MVU 的「额外模型解析」在回复后自己发一次 LLM 调用再写状态：读在它写完之前 = 拿旧状态算补丁，
    // 写在它之前 = 两边互相盖。位置刻意排在上面两道早退【之后】——没配好连接的人本来就要 return，
    // 不该先被这里晾最多 120 秒。
    await awaitMvuIdle(Mvu, { isCancelled: postReplyShouldStop });
    if (postReplyShouldStop()) return;
    if (ENABLE_SCHEMA_DIAG) await maybeRunSaveHealth('first');   // 🩺 1.89.0：本聊天首次自动诊断 → 查一次存档（去重在里面）

    // 🩺 楼层播种（1.77.2，ENABLE_DIAG_FLOOR_SEED）：目标楼没有 MVU 数据（MVU「额外模型解析 + 不自动请求」对它什么都不做）
    // → 先替 MVU 把上一有效楼的状态种到这一楼、跑一遍它自己的指令、补占位符，下面读到的才是真状态，甲/乙/丙 闸与写回
    // 逐字照旧。只在【目标楼仍是最末非系统楼】（用户又发了消息则 MVU 的 MESSAGE_SENT 已把状态抄到用户楼）且【聊天仍是
    // 起跑时那个】时动手；播种内部任何拿不准都原样退出。位置在两道早退与 awaitMvuIdle 之后：没配好连接的人不该被晾。
    if (ENABLE_DIAG_FLOOR_SEED && targetId != null) {
        const pre = resolveAutoTargetMessage(ctx.chat, targetId);
        const anchor = (chatKey != null ? chatKey : chatIdentityKey());
        if (pre.idx >= 0 && pre.idx === mvuLatestMsgId() && chatIdentityKey() === anchor) {
            await diagSeedTargetFloor(Mvu, ctx, pre.idx, {
                graceMs: s.autoDiagnoseSeedGraceMs,
                isCancelled: postReplyShouldStop,
                anchorOk: () => chatIdentityKey() === anchor,
            });
            if (postReplyShouldStop()) return;
        }
    }

    // 自建诊断上下文（不碰窗口共享的 worldInfoBlock / diagStatData / diagLatestUpdate）。
    let wiBlock;
    if (diagPickerActive()) {
        // 精选模式（用户功能请求）：只喂本聊天挑选的条目（无视启用 / 禁用；L2 混合并入当前命中绿灯），不自动补规则。
        wiBlock = (await buildDiagSelectedWi()).block;
    } else {
        wiBlock = await buildWorldInfo(wiContextMode(s));
        const mvuRules = await collectMvuUpdateRules(wiBlock);
        if (mvuRules.length) wiBlock = [wiBlock, ...mvuRules].filter(Boolean).join('\n\n');
    }
    const stat = await getMvuStatData();
    const statStr = stat ? JSON.stringify(stat, null, 2) : '';
    // 事务捕获（审计簇 A）：钉死「这一轮是按【哪个聊天】、按【哪份状态】算的」。模型往返是一次完整
    // LLM 调用（几十秒起步），期间用户可能切了聊天、别的扩展 / MVU 额外解析可能写过状态——写入前拿
    // 这两枚锚点核验一次，不符就整轮作废。chatKey 缺省（旧的三参调用）→ 现拍一次兜底，绝不留空。
    // ⚠ statKey 取的是 getMvuStatData() 的返回值，写侧（applyFix / autoApplyFix）取的是 mvuStatOf(oldData)
    // —— 【同一个回退口径的同一份实现】（FIX 5）。以前写侧只认 oldData.stat_data，于是「没有 stat_data 的
    // 退化 MvuData」上两边恒不相等 → 每一次应用都被判陈旧。现在两侧同源，那种卡上也能正常写。
    const captured = {
        chatKey: (chatKey != null ? chatKey : chatIdentityKey()),
        statKey: diagStatKey(stat),
        // 🧩 1.83.0 并写：勾选时多留一份【诊断时】的 stat_data 副本，作 autoApplyFix 逐条裁剪的基线；关着时不留，
        // 写侧收不到 coWrite = 1.64.0 整份指纹闸逐字节不变。
        statSnap: (s.autoDiagnoseCoWrite && stat != null) ? JSON.parse(JSON.stringify(stat)) : null,
    };
    // 钉住触发本轮的消息（maybePostReply 传入 targetId）：避免延时 + 调用窗口内队尾变化时诊断落到上一条；
    // 无 id（不应发生，防御性）→ 回退最近一条，保持旧行为。
    const { idx: aiIdx, text: latestReply } = (targetId != null)
        ? resolveAutoTargetMessage(ctx.chat, targetId)
        : getLatestAiMessage();
    if (!latestReply.trim()) return;                        // 没有可分析的 AI 回复（或触发消息已失效 → 干净跳过）
    const latestBlock = extractUpdateBlock(latestReply);
    // 关键：正文里没有内联更新区块也【不退出】——此时自动诊断改为据回复正文【推导】本回合的更新，充当
    // MVU「额外模型解析」的替代（用户要的正是这个：不开额外模型解析，靠自动诊断补出更新）。
    // 但推导是【破坏性】分支（写库 + 把推导块写回主聊天消息），所以 甲/乙 判定必须【失败朝甲倒】：
    // 只有连 detectMvuBlockDialect 这道宽松探测都找不到任何痕迹，才认定「这回合真的没人更新过」。
    // 摘不到但探测得到 = 有更新、只是格式我们解析不干净 → 走核验，绝不重推一遍（1.40.2，smallmj 上报的
    // 「金钱算两次」正是这里：他那张卡用 <update>/<json_patch>，旧代码摘不到 → 每回合都误入推导）。
    // 审计簇 N（Task 3 加宽）：方言探测只认【包装标签】。卡片直接甩一段无包装的 <json_patch> 或行首
    // `_.set(` 时它探不到，旧闸就误判「这回合没人更新过」→ 走推导。可 MVU 是【按文本位置】执行这两种
    // 裸指令的（MVU_BLOCK_DIALECTS 注释）：它们【已经生效】了，再推一遍就是同一笔算两次——1.40.2
    // 那只 bug 的同族入口，只是形态更隐蔽。
    // 1.69.0 D6：闸门整枚换成 diagGateProbe —— 判据从「有没有【痕迹】」升级成「MVU 这一回合到底
    // 【执行】了没有」。旧式三项并排（extract / dialect / bare）见痕迹即判甲，于是叙述者吐出的
    // 【死区块】（漏闭合标签 / 标签带空白 / 毒元素 / 全 move / 全开错根）每回合都被当成「已经生效」
    // → 诊断永远修不好那个由叙述者亲手造成的冻结（2026-08-15 异录死锁的机理）。新闸多出第三条
    // 支路【丙】：块在、但一条都没执行 → 按推导语义重算这一回合，用自己那套绝不说「已生效」的文案。
    const gate = diagGateProbe(latestReply, stat);
    const deadBlockMode = !gate.executed && gate.deadBlock;              // 丙
    const deriveMode = !gate.executed && !gate.deadBlock;                // 乙（语义逐字不变）
    const systemPrompt = buildDiagnosePromptFrom(ctx, s, { wiBlock, statStr, latestBlock, latestReply, auto: true, derive: deriveMode, deadBlock: deadBlockMode });
    const userMsg = deadBlockMode
        ? P('diag.askDead', null, s)
        : (deriveMode ? P('diag.askDerive', null, s) : (latestBlock ? P('diag.askVerify', null, s) : P('diag.askUnparsed', null, s)));
    // 经自定义补全预设（1.43.0，opt-in s.diagnoseUsePreset）：破限 / 越狱用，形状同 runAutoFix。
    // ⚠ maybeWrapJb 的模式键必须是【字面量】'diagnose' —— 自动诊断在后台无头跑，触发时用户
    // 可能正坐在任何一个模式里，currentJbModeKey() 会读到那个模式的 flag、给出错误判定。
    const messages = (s.diagnoseUsePreset && presetCurationActive(s))
        ? buildDiagnosePresetMessages(s, systemPrompt, userMsg)
        : maybeWrapJb([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
        ], 'diagnose', s);
    // 调试提示词查看器快照（与 generateReply 同一形状）。自动诊断在后台跑、不经 generateReply，1.40.2 前
    // 从不入快照 —— 用户遇到自动诊断异常时，「调试提示词」面板里根本看不到它发了什么（smallmj 那个 bug
    // 因此多绕了好几轮）。这里补上。
    sharedState.lastPrompt = messages.map((m) => ({ role: m.role, content: m.content }));
    sharedState.lastPromptMeta = {
        mode: '自动诊断',
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: sharedState.lastPrompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    };

    const effMaxTokens = Math.max(s.maxTokens, 4096);
    // 一次模型往返（1.89.0 起抽成局部助手：schema 重写那一次要原样再走一遍同一条连接 / 中断 / 提示）。
    const callOnce = async (msgs) => {
        const ctl = beginPostReplyCall(POST_REPLY_CALL_TIMEOUT_MS);      // 模块级中断器：240s 超时兜底 + 让「正在自动诊断…」提示可点一下中断
        // 「正在分析…（点此中断）」——点一下即 cancelPostReply。重试跳（used>0）带标注，用户看得出是第几次。
        const genToast = showAutoDiagGenerating(retryState && retryState.used > 0 ? retryState : null);
        try {
            if (s.mode === 'direct') {
                const body = { model: s.model, messages: msgs, max_tokens: effMaxTokens };
                if (s.sendTemperature) body.temperature = s.temperature;
                return await callDirect(resolveEndpointUrl(s), s.apiKey, body, ctl.signal);
            }
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            return await callProfile(s.profileId, msgs, effMaxTokens, override, ctl.signal);
        } finally {
            ctl.end();
            dismissToast(genToast);   // 无论成功 / 失败 / 抛错，都收掉「正在诊断」提示
        }
    };
    let finalText = await callOnce(messages);

    // 事务闸（审计簇 A/T）：模型往返期间世界可能已变——切聊天 / 状态被谁写过 / 用户点了中断。
    // 写前一次性核验；不符 = 本轮作废，留一条说人话的记录，绝不写。
    if (postReplyShouldStop()) return;                                // T：手动中断 / 新回合 supersede 都赢
    await awaitMvuIdle(Mvu, { isCancelled: postReplyShouldStop });    // G：写前再等一次额外模型解析
    if (postReplyShouldStop()) return;                                // 等待期间才发生的作废同样算数
    if (chatIdentityKey() !== captured.chatKey) {
        // 【有意不留侧聊记录】：notifyAutoDiagnose → appendNoteToRoom → getChatMetadataSafe() 读的是
        // 【现在】的上下文，也就是用户刚切过去的那个聊天 —— 记录会落在一个完全无辜的对话里，说的还是
        // 另一个对话的事。与中断路径同款处理：不写记录，只留一行控制台。
        // 但 toast 要发（whole-branch review FIX 3）：这道闸与 autoApplyFix 那道判的是【同一件事】，
        // 而用户完全看不出是哪一道拦的 —— 一处彻底静默、一处弹提示，等于同一个动作有两种随机结果。
        // 两处共用 toastDiagChatSwitched（记录=聊天级持久物，恒不写；toast=会话级环境提示，恒发）。
        toastDiagChatSwitched();
        console.debug('[Story Oracle] 自动诊断：聊天已切换，本轮作废（未写入）。');
        return;
    }

    // 🩺 1.89.0 A 的一次重写（spec §4.3）：卡片规则拒绝了模型【自己写错】的指令 → 带着原因再问一次，只一次。
    // 第二次往返后照样过同一道事务闸（中断 / 切聊天）；第二份回复摘不到区块 → 仍用第一份（交给下面照旧处理）。
    let schemaRetried = null;
    if (ENABLE_SCHEMA_DIAG) {
        let md = null;
        try { md = Mvu.getMvuData(mvuMsgOpts()); } catch (e) { md = null; }
        const round = await diagSchemaRetryRound(finalText, md, s, messages, (msgs2) => {
            sharedState.lastPrompt = msgs2.map((m) => ({ role: m.role, content: m.content }));
            return callOnce(msgs2);
        }, postReplyShouldStop);
        if (round.schemaRetried) {
            if (postReplyShouldStop()) return;
            if (chatIdentityKey() !== captured.chatKey) { toastDiagChatSwitched(); return; }   // 与另两道切聊天闸同一句（FIX 3）
            finalText = round.finalText;
            schemaRetried = round.schemaRetried;
        }
    }

    // 用户功能请求：每跑完一轮都留一条记录（含「无需改动」）。改动 → 带补丁 + 撤销按钮；其余按
    // 【真正发生的那件事】分类渲染（审计簇 C/E，见 autoDiagNoteContent 的状态表）。
    // 摘不到区块 = 我们没看懂模型说了什么 —— 旧代码在这里回 'nochange'，于是记录写着「已检查最新
    // 回复，本回合无需改动」= 对用户撒谎。改回 'unparsed'，并把「为什么没摘到」（diagParseFailReason，
    // 会点名缺了哪个闭合标签）连同回复原文一起带上，让用户自己看得见一眼。
    let patchBlock = extractUpdateBlock(finalText);
    // 第 5 参 finalText（1.68.0）：双区块闸要数「MVU 会执行几块」，而 extractUpdateBlock 只摘【最早】
    // 那一个包装块 —— 模型甩了两个包装块时，第二块的指令会被静默丢掉（语料 2/768，其中一格两块的 op
    // 完全不同）。把回复原文一并交给它，那一档才拦得住。
    // 🔁 重试要按「为什么没读懂」分类（空白 vs 格式），故 code 随 detail 一起进 result——
    // diagParseFailReason 只算一次，两个槽同源。
    const parseFail = patchBlock ? null : diagParseFailReason(finalText);
    const result = patchBlock
        ? await autoApplyFix(Mvu, patchBlock, captured.statKey, captured.chatKey, finalText,
            captured.statSnap != null ? { coWrite: { snap: captured.statSnap } } : undefined)
        : { status: 'unparsed', code: parseFail.code, detail: parseFail.detail, raw: finalText };
    if (schemaRetried) result.schemaRetried = schemaRetried;
    // 🩺 1.89.0（minors M8）：autoApplyFix 已拿原块写完；往后的记录正文 / 推导写回都用【实际写入】的那一块——zod 卡真筛掉了
    // 指令时是已修复 + 已筛的块，否则原样（原生卡 / 无 schema 卡 → 逐字节同 1.88）。
    if (ENABLE_SCHEMA_DIAG) patchBlock = diagShownPatch(result, patchBlock);
    // 确有改动 → 把结果反映到消息 / 状态栏（auto 诊断走 replaceMvuData，不发刷新事件，状态栏不会自己更新）：
    //   衍生（乙，原回复无块）：写回推导块 + saveChat + 重渲染（与官方 MVU 更新一致）；
    //   核验（甲，原回复已有块）：只重渲染刷新状态栏，不碰消息正文（避免出现两个更新块）。
    // ⚠ 多一道 chatIdentityKey() 判定（审计簇 A 的写回半边）：上面的事务闸是在 autoApplyFix 【之前】判的，
    // 而 autoApplyFix 内部还有一次 await（parseMessage 可能是异步的）——那期间照样能切聊天。
    // autoApplyFix 现在自己也带 expectChatKey（那种情形直接回 'stale'、根本到不了 'applied'），所以这道
    // 判定是【第二重保险】：写正文是不可逆的，不指望上游任何一处单独兜住。
    let writeBack = null;                                    // 实际写进正文的那段（撤销 / 重新应用时据此精确同步）
    if (AUTO_DIAGNOSE_WRITE_BACK && result.status === 'applied' && aiIdx >= 0 && chatIdentityKey() === captured.chatKey) {
        if (deadBlockMode) {
            // 丙（1.69.0）：变量照写，正文【一个字节都不碰】—— 这一楼里已经躺着一个（死）区块了。
            //   · 再追加一个包装块 = 直撞状态栏吞噬地雷（卡片显示正则贪婪 + dotall，实测 1734 张
            //     MVU 卡里只有 123 张能在同层第二个块下活下来；CLAUDE.md 地雷条）；
            //   · 插进那个已有块的内部也不行：1.41.0 的 insertDiagPatchIntoBlock 按设计拒绝没闭合的
            //     块，而「没闭合」正是丙最常见的成因；标签带空白那一档就算插进去了 MVU 照样看不见。
            // 所以丙的写回半边与【甲】同款：只刷状态栏，让楼层读数追上真数据。
            refreshMessageBar(aiIdx);
        } else if (deriveMode) {
            // 第三参 latestReply = 陈旧守卫：诊断期间用户改了这条回复 / 别的扩展写过它 → 正文已不是
            // 我们诊断的那一份，绝不往上面追加推导块（与 injectDiagPatchIntoMessage 同款）。
            // ⚠ 守卫拦下时【仍要刷状态栏】：变量确实已经写进去了，不刷的话数据变了而楼层状态栏停在旧值 ——
            // 正是茶茶报的那一类「要手动重新读取初始变量才看到新数据」。注入分支早有这个 else，衍生分支
            // 原先没有（它以前不会中途放弃，所以不需要），加守卫就必须同时把它补上。
            if (await writeUpdateBlockToMessage(aiIdx, patchBlock, latestReply)) writeBack = { idx: aiIdx, text: patchBlock, mode: 'derive' };
            else refreshMessageBar(aiIdx);
        } else if (ENABLE_DIAG_BODY_INJECT && s.diagInjectBody) {
            // 实验性 opt-in：把这次诊断的【实际改动】折成绝对值补丁，插进卡片已有的更新区块内部，
            // 让 MVU 的【重新处理变量】重放正文时也落到同一结果。没写成 → 照旧只刷状态栏。
            const injected = await injectDiagPatchIntoMessage(aiIdx, canonicalizeDiagOps(result.snapshot, Mvu), latestReply);
            if (injected) writeBack = { idx: aiIdx, text: injected, mode: 'inject' };
            else refreshMessageBar(aiIdx);
        } else {
            refreshMessageBar(aiIdx);
        }
    }
    // 聊天在 autoApplyFix 的 parseMessage 等待期间被切走（reason === 'chatSwitched'）→ 与写入前那道
    // 事务闸同一条不变量：【侧聊记录】是【聊天作用域】的东西，appendNoteToRoom 写的是【现在】那个聊天
    // 的元数据 —— 落进去就是在一个无辜的对话里说另一个对话的事。toast 则是【会话作用域】的环境提示、
    // 不落任何聊天，该发照发（用户刚切走，也有权知道上一轮作废了）。故这里只掐掉记录、留住 toast。
    // 🔁 本轮失败且包装层还会再试 → 记录末尾标注一行、失败 warning 让位给紧随其后的「正在重试」
    // 提示。判据与包装层是【同一枚纯函数 + 同一份输入】——两处裁决构造性一致，绝不出现「记录说
    // 会重试、实际没试」的错位。成功 / 安全跳过在 diagShouldRetry 里天然为 false，不受影响。
    const willRetry = !!(retryState && diagShouldRetry(result, s, retryState.used));
    notifyAutoDiagnose(result, patchBlock, writeBack, {
        noNote: result.status === 'stale' && result.reason === 'chatSwitched',
        retryLine: willRetry ? `↻ 这一轮没跑成，将自动重试（第 ${retryState.used + 1}/${retryState.max} 次）…` : '',
    });
    return result;
}

// 自动应用修复：解析补丁。与手动 applyFix 同一套闸（陈旧 / 诚实 / swipe 钉），只是回状态码而不写状态行。
//   'applied'     确有改动、已写入（带 snapshot / applied / report）
//   'verified'    模型给了【空】<JSONPatch> = 它核验通过，本回合本就无需改动（真·合格）
//   'ineffective' 有 op 却一个值都没变 —— 与 verified 是两回事，绝不能混着报「无需改动」
//   'stale'       状态指纹对不上 / 解析期间换了楼或 swipe / 解析期间切了聊天 → 一个字都没写
//   'failed'      无 MVU 或没解析出数据
// 'stale' 另带 reason（Task 4 的诚实文案要用它说清「为什么跳过」）：'stateMoved' = 状态指纹对不上、
// 'chatSwitched' = 解析期间切了聊天；换楼 / 换 swipe 那支【有意】不给 reason —— 记录会渲染兜底的
// 「目标已失效」，它对那种情形本来就成立（reason 键名是给文案查表用的，不是内部日志）。
// expectChatKey（可选，第 4 参）= 调用方钉的聊天身份锚点。parseMessage 是一次 await，等待期间照样能
// 切聊天 —— 那时写进去的就是【A 聊天算出来的补丁落在 B 聊天的状态上】。
// replyText（可选，第 5 参，1.68.0）= 模型这一轮回复的【原文】，供双区块闸看清「MVU 会执行几块」。
// extra（可选，第 6 参，1.83.0）= { coWrite: { snap } }：🧩「允许与其他脚本并写 MVU」勾选时由调用方带来【诊断时】拍的
// stat_data 副本。状态指纹对不上时不再整份作废，而是按 diagScopePatchToUntouched 逐条裁：落在没被别人动过的路径上
// 的 op 照写（写在【现态】之上），与改动冲突的 op 丢弃并随结果带回（scoped = { kept, dropped }，记录里点名）；一条都不
// 剩 / 裁不动（_.set 方言）→ 仍回 stale/stateMoved。缺席 = 1.82.0 行为逐字节不变。
// 空补丁（模型核验通过、说无需改动）【不过】陈旧闸（Prince 2026-09-15）：本来就一字不写，判它陈旧只会把「无需改动」
// 报成「已跳过」—— 卡自带回合后引擎的用户每一回合都看见一条假跳过。
async function autoApplyFix(Mvu, patchBlock, expectStatKey, expectChatKey, replyText, extra) {
    if (!Mvu || typeof Mvu.parseMessage !== 'function') return { status: 'failed' };
    // 双区块闸（1.68.0）—— 与 applyFix 【同一条】，理由见那里。自动诊断才是每回合都跑的那个入口。
    const nBlocks = Math.max(diagCountPatchBlocks(patchBlock), diagCountPatchBlocks(replyText));
    if (nBlocks >= 2) return { status: 'doubleblock', blocks: nBlocks };
    const opts = mvuMsgOpts();   // F4：读写共用同一解析结果（消掉 TOCTOU），别在写之前再解析一次
    const oldData = Mvu.getMvuData(opts);
    // 陈旧闸（审计簇 A/F）：补丁按【诊断当时】的状态算，现读对不上就不写。
    // 取数走 mvuStatOf（同 applyFix，理由见该函数头注 FIX 5）。
    const moved = expectStatKey != null && diagStatKey(mvuStatOf(oldData)) !== expectStatKey;
    const parsedOps = diagPatchOpsOf(patchBlock);
    const emptyPatch = !!(parsedOps && Array.isArray(parsedOps.ops) && parsedOps.ops.length === 0);
    let patch = null, scoped;
    if (moved && !emptyPatch) {
        const snap = extra && extra.coWrite ? extra.coWrite.snap : undefined;
        if (snap == null) return { status: 'stale', reason: 'stateMoved' };
        // 🧩 并写：先过修复流水线（路径掰正了才裁得准），再按「谁动过哪条路径」逐条裁。
        patch = repairDiagPatch(patchBlock, mvuStatOf(oldData));
        const sc = diagScopePatchToUntouched(patch.text, snap, mvuStatOf(oldData));
        if (!sc) return { status: 'stale', reason: 'stateMoved' };
        scoped = { kept: sc.kept, dropped: sc.dropped };
        if (!sc.kept) return { status: 'stale', reason: 'stateMoved', scoped };
        patch = Object.assign({}, patch, { text: sc.text });
    }
    const done = (r) => (scoped ? Object.assign(r, { scoped }) : r);   // 裁过才带读数；没裁 = 返回形状逐字节同旧
    // 修复流水线 —— 与 applyFix 【同一条】（repairDiagPatch，1.67.0；含 1.66.1 的开错根掰正）。自动诊断
    // 是另一个写入口，且才是每回合都跑的那个；只接手动那条等于漏掉大头。
    if (!patch) patch = repairDiagPatch(patchBlock, mvuStatOf(oldData));
    if (patch.fixed) console.warn('[Story Oracle] 自动诊断补丁自动修正：', patch);
    // 🩺 1.89.0 A：按卡片规则预演，只写能过的指令（spec §4.2）。拿不到规则 → sf=null，下面逐字节照旧。
    const sf = diagSchemaFilterPatch(patch.text, oldData);
    if (sf) {
        if (!sf.dry.passOps.length) return done({ status: 'schemarefused', schemaDry: sf.dry, repair: patch });
        if (sf.text !== patch.text) patch = Object.assign({}, patch, { text: sf.text });
    }
    const withDry = (r) => (sf ? Object.assign(r, { schemaDry: sf.dry }) : r);
    const swipePin = diagCaptureSwipe();          // M1 钉：解析【之前】取样
    const snapshot = JSON.parse(JSON.stringify(oldData));
    const newData = await Mvu.parseMessage(patch.text, oldData);
    if (!newData) return done({ status: 'failed' });
    // 诚实闸（审计簇 C）：基线用 snapshot（解析前深拷贝）、比对走 diagCmpKey（剔除派生数据），理由同 applyFix。
    const report = diagOpOutcomes(patch.text, (snapshot || {}).stat_data, newData.stat_data);
    if (diagCmpKey(newData) === diagCmpKey(snapshot)) {
        // 🩺 1.89.0：zod 卡上一次有内容的修复一个值都没变 → 让存档检查看看是不是存档被污染（去重在里面）。
        if (ENABLE_SCHEMA_DIAG && !emptyPatch && (snapshot || {}).schema === '没有用别管这个') maybeRunSaveHealth('failure');
        // 没有逐 op 对账依据（diagOpOutcomes 回 null）→ 旧路一律回笼统的 'nochange'。1.67.0 收窄它：
        // 对账件只认 <JSONPatch> 拼法，而 MVU 连 <json_patch> 拼法一起执行 —— 那种块上 report 恒为 null，
        // 于是「补丁明明一条都没落地」也会被报成「本回合无需改动」= 又一次撒谎。预检认得两种拼法，
        // 所以：**看得见 op** 就照实报 ineffective（正文走同一份 diagZeroChangeReport）；只有真的
        // 判不出（_.set 方言 / 我们解析不动 = 'nodata'）或补丁本来就是空数组（'empty'）才退回旧的
        // 'nochange' —— 那两档的行为与 1.67.0 之前【逐字一致】（diag-applyfix 的 _.set 方言腿钉着）。
        if (!report) {
            const bare = diagZeroChangeReport(patch.text, mvuStatOf(snapshot), null, patch, (snapshot || {}).schema);
            return done(withDry((bare.code === 'nodata' || bare.code === 'empty')
                ? { status: 'nochange', repair: patch }
                : { status: 'ineffective', zero: bare, repair: patch }));
        }
        // 1.67.0：零变化语境的逐条诊断在这里【一次算好】随结果带走（本函数拿得到补丁与状态，侧聊记录
        // 那个纯函数拿不到）。zero.code === 'empty' 才是真·「模型说无需改动」——毒元素被剔光那档
        // （total 0 但 dropped > 0）绝不能混进 verified。
        // 基线同 diagOpOutcomes：snapshot（解析前深拷贝），理由见 applyFix 同处注释。
        // schema 第 5 参同 applyFix（1.77.3）。
        const zero = diagZeroChangeReport(patch.text, mvuStatOf(snapshot), report, patch, (snapshot || {}).schema);
        return done(withDry((report.total === 0 && zero.code === 'empty')
            ? { status: 'verified', report, repair: patch }
            : { status: 'ineffective', report, zero, repair: patch }));
    }
    // swipe 钉（审计簇 M1）：绝不把 A swipe 算的状态写进 B。
    if (diagPinMoved(swipePin, diagCaptureSwipe())) return done({ status: 'stale' });
    // 聊天在 parseMessage 等待期间被切换 → 绝不把 A 聊天的补丁写进 B；'applied' 不产生 →
    // 撤销记录也不会挂错房。
    if (expectChatKey != null && chatIdentityKey() !== expectChatKey) return done({ status: 'stale', reason: 'chatSwitched' });
    await Mvu.replaceMvuData(newData, opts);
    return done(withDry({ status: 'applied', snapshot, applied: JSON.parse(JSON.stringify(newData)), report, repair: patch }));
}

// 重渲染该 AI 消息，让前端状态栏反映这次自动诊断的写入。auto 诊断经 Mvu.replaceMvuData 写库，而它【不发】
// VARIABLE_UPDATE_ENDED（官方更新走 MVU 更新引擎才发），状态栏不会自己刷新；重渲染（ctx.updateMessageBlock →
// 重跑 messageFormatting / 卡片 <StatusPlaceHolderImpl/> 状态栏正则）令其读取刚写入的 display_data 而刷新。
// MVU 只在 MESSAGE_RECEIVED/SENT 解析更新块，重渲染不触发其重解析，故不二次写库。衍生与核验两情形共用；
// 卡片侧状态栏实现各异，视觉刷新仍需真卡验证。
export function refreshMessageBar(idx) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m) return;
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 自动诊断后重渲染消息失败：', e); }
    // updateMessageBlock 只把 .mes_text 重渲染成状态栏 HTML 代码块；【酒馆助手】要收到 MESSAGE_UPDATED 才会把那段
    // HTML 真正渲染成 iframe（运行其 <script>）——其消息 iframe 渲染器（JS-Slash-Runner store/iframe_runtimes/
    // message.ts）正监听 CHARACTER/USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED。不补发它，状态栏就停在
    //「原始 HTML 代码」（用户手动编辑→保存能修，正因为保存会发 MESSAGE_UPDATED）。故重渲染后补发。MVU 只听
    // MESSAGE_RECEIVED/SENT，不会被它二次触发（不会重解析 / 二次写库）。
    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
            // 1.71.1（Discord 实报：诊断一写，正则 / 美化就被刷掉，得刷新浏览器或点「重新处理变量」
            // 才回来）：再补发一枚 RENDERED。生态事实（对酒馆助手真源码钉：src/function/
            // displayed_message.ts refreshOneMessage 收尾）——TH 每次程序化改楼重渲染后发的是
            // USER/CHARACTER_MESSAGE_RENDERED（按楼层类型二选一），MVU 每回合写块走的就是它，所以
            // 正则 / 卡内美化生态的重渲染钩子普遍挂在 RENDERED 上；上面的 updateMessageBlock 已把
            // .mes_text 重画成素身 HTML，只发 MESSAGE_UPDATED 这些美化就一直死着。安全性：MVU 不听
            // RENDERED（结构性证明：TH 在每次 MVU 写库后都发它，MVU 若监听即自环）；translate/TTS
            // 这类挂 RENDERED 的官方扩展在 MVU 生态里本就每回合收到 TH 的同款补发，不构成新行为。
            const rendered = m.is_user
                ? (et.USER_MESSAGE_RENDERED || 'user_message_rendered')
                : (et.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered');
            Promise.resolve(ctx.eventSource.emit(rendered, idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 自动诊断后发 MESSAGE_UPDATED 失败：', e); }
}

// 手动诊断「应用 / 撤销」后刷新楼层状态栏。手动 applyFix / undoFix 也走 Mvu.replaceMvuData 写库，它同样【不发】
// VARIABLE_UPDATE_ENDED，状态栏（卡片 <StatusPlaceHolderImpl/> iframe）不会自己更新 —— 用户得手动点「重新读取
// 初始变量」才看到新数据（用户反馈：茶茶）。自动诊断早有 refreshMessageBar 兜底，手动这条路一直没接上（pre-1.17.0
// 备份里也没有，是历史欠账，非校正改动所致）。这里对最新一条 AI 消息（= MVU 'latest' 指向的那条）复用同一刷新
// （重渲染 + 补发 MESSAGE_UPDATED，让酒馆助手重建状态栏 iframe）。尽力而为：拿不到目标 / 重渲染失败都不影响数据已写入。
export function refreshLatestMvuBar() {
    try {
        const { idx } = getLatestAiMessage();
        if (idx >= 0) refreshMessageBar(idx);
    } catch (e) { console.warn('[Story Oracle] 诊断应用 / 撤销后刷新状态栏失败：', e); }
}

// 纯函数：把 block（+ 可选状态栏占位符 placeholder）幂等追加到 m.mes，并【镜像到当前 swipe 槽】。
// 为什么要镜像：校正模式把校正稿换成了新 swipe（addSwipeToMessage），此时 m.mes 与 m.swipes[swipe_id]
// 指向同一文本；若只改 m.mes 不改槽，下一次 swipe 重渲染会从 m.swipes[swipe_id] 取回旧文本 → 追加的更新块
// 被丢弃。故：追加完 m.mes 后，若有 swipes 数组且当前槽是字符串，把当前槽对齐成 m.mes。
// 幂等（!includes 守卫）；无 swipes 时退化为「只动 m.mes」（与改写前的写回逐字节相同）。返回新的 m.mes。
export function applyBlockToCurrentSwipe(m, block, placeholder) {
    if (!m || typeof m.mes !== 'string') return m ? m.mes : '';
    if (block && !m.mes.includes(block)) {                   // 幂等：已写过就不重复追加
        const tail = m.mes.trimEnd();
        if (placeholder && tail.endsWith(placeholder)) {
            // 消息已以占位符收尾（1.77.2 楼层播种先补了它）→ 块插到占位符【前面】，保持 MVU 自己的顺序：
            // 先块、后占位符（额外模型解析路 = 先追加解析结果、handleVariablesInMessage 再补占位符；1734 卡实测的
            // 就是这个顺序）。没有尾随占位符时行为逐字不变。
            const head = tail.slice(0, tail.length - placeholder.length).trimEnd();
            m.mes = (head ? head + '\n\n' : '') + block + '\n\n' + placeholder;
        } else {
            m.mes = tail + '\n\n' + block;
        }
    }
    // 再补上 MVU 状态栏占位符（衍生情形 MVU 没跑、不会自己加它）——否则有更新块也不出状态栏（见 STATUS_PLACEHOLDER）。
    if (placeholder && !m.mes.includes(placeholder)) {
        m.mes = m.mes.trimEnd() + '\n\n' + placeholder;
    }
    // 镜像到当前 swipe 槽（仅当存在 swipes 数组且当前槽本就是字符串）——非 swipe 消息上此步为 no-op。
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') {
        m.swipes[m.swipe_id] = m.mes;
    }
    return m.mes;
}

// 衍生（乙）情形专用：把推导出的 <UpdateVariable> 块 + MVU 状态栏占位符写回这条 AI 消息（让消息像官方 MVU
// 更新那样【携带】更新记录 + 触发状态栏；块默认被卡片「去除变量更新」正则在显示 / 提示词里隐藏，占位符由卡片
// 显示正则渲染成状态栏，二者都跨重载存活，故 saveChat），再调 refreshMessageBar 重渲染。核验（甲）情形不走这里
// （消息里已有块 + 占位符，再追加会重复），只 refreshMessageBar。写回经 applyBlockToCurrentSwipe → 同时落在
// m.mes 与【当前 swipe 槽】（校正换 swipe 后不丢块；非 swipe 消息上镜像是 no-op，行为与旧实现逐字节相同）。
// expectText（Task 3）= 诊断当时读到的正文，陈旧守卫，与 injectDiagPatchIntoMessage 同款：模型往返
// 期间用户改了正文 / 划了 swipe / 别的扩展写过 → 这条消息已不是我们诊断的那一份，直接放手（变量修正
// 照常生效，只是不再往错的正文上追加推导块）。缺省（nullish）→ 旧行为逐字不变。
async function writeUpdateBlockToMessage(idx, block, expectText) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || typeof m.mes !== 'string' || !block) return false;
    if (expectText != null && m.mes !== expectText) {
        console.warn('[Story Oracle] 自动诊断推导块未写回：这条回复在诊断期间被改动过（已跳过，变量修正照常生效）。');
        return false;
    }
    const before = m.mes;
    applyBlockToCurrentSwipe(m, block, STATUS_PLACEHOLDER);
    if (m.mes !== before) {                                  // 确有追加才存盘
        try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
        catch (e) { console.warn('[Story Oracle] 自动诊断写回消息后保存失败：', e); }
    }
    refreshMessageBar(idx);
    // 返回「这次是否真把 block 追加进去了」——撤销据此决定该不该把它摘掉（幂等守卫可能压根没追加）。
    // 旧调用点忽略返回值，行为不变。
    return !before.includes(block) && m.mes.includes(block);
}