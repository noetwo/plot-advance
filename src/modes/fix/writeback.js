import { getCtx, uiConfirm } from '../../core/settings.js';
import {
    applyVariableTextChanges,
    inspectVariableTextChanges,
    reapplyVariableTextChanges,
    revertVariableTextChanges,
    sameVariableTextInspection,
} from './variable-text.js';

const FIX_MARKER_KEY = 'story_oracle_fix';
const FIX_UNDO_KEY = 'story_oracle_fix_undo';
const FIX_RECORD_VERSION = 1;
const fixActionPainters = new Set();

export function registerFixActionPainter(element, paint) {
    if (!element || typeof paint !== 'function') return;
    fixActionPainters.add({ element, paint });
}

export function refreshFixActionPainters() {
    for (const watcher of [...fixActionPainters]) {
        if (watcher.element?.isConnected === false) {
            fixActionPainters.delete(watcher);
            continue;
        }
        try { watcher.paint(); } catch (error) { /* stale UI must not break host events */ }
    }
}

function chatIdentity(ctx) {
    return String((ctx && ctx.groupId) || '') + '::' + String((ctx && ctx.chatId) || '');
}

function stamp(value) {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function newActionId() {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    } catch (error) { /* use portable fallback */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function currentSwipeId(message) {
    return Number.isInteger(message?.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
}

function currentSwipeInfo(message) {
    const id = currentSwipeId(message);
    return Array.isArray(message?.swipe_info) && message.swipe_info[id] && typeof message.swipe_info[id] === 'object'
        ? message.swipe_info[id]
        : null;
}

export function fixGenerationBinding(message) {
    if (!message || typeof message !== 'object') return null;
    const info = currentSwipeInfo(message);
    return {
        swipe_id: currentSwipeId(message),
        gen_started: stamp(info && Object.prototype.hasOwnProperty.call(info, 'gen_started') ? info.gen_started : message.gen_started),
        send_date: stamp(info && Object.prototype.hasOwnProperty.call(info, 'send_date') ? info.send_date : message.send_date),
    };
}

function sameBinding(left, right) {
    return !!left && !!right
        && Number(left.swipe_id) === Number(right.swipe_id)
        && stamp(left.gen_started) === stamp(right.gen_started)
        && stamp(left.send_date) === stamp(right.send_date);
}

function activeExtra(message) {
    const info = currentSwipeInfo(message);
    if (info && info.extra && typeof info.extra === 'object') return info.extra;
    return message?.extra && typeof message.extra === 'object' ? message.extra : null;
}

function boundRecord(message) {
    const extra = activeExtra(message);
    const record = extra?.[FIX_UNDO_KEY];
    const binding = fixGenerationBinding(message);
    if (!record || typeof record !== 'object' || record.version !== FIX_RECORD_VERSION) return null;
    if (!sameBinding(record.binding, binding)) return null;
    if (typeof record.before !== 'string' || typeof record.after !== 'string') return null;
    return record;
}

function normalizedRecordVars(record) {
    if (!Array.isArray(record?.vars)) return undefined;
    return record.vars
        .filter((change) => change && typeof change.pointer === 'string'
            && typeof change.oldValue === 'string' && typeof change.newValue === 'string')
        .map((change) => ({
            pointer: change.pointer,
            oldValue: change.oldValue,
            newValue: change.newValue,
        }));
}

function sameRecordVars(left, right) {
    const leftVars = normalizedRecordVars(left);
    const rightVars = normalizedRecordVars(right);
    if ((leftVars === undefined) !== (rightVars === undefined)) return false;
    return JSON.stringify(leftVars || []) === JSON.stringify(rightVars || []);
}

export function readFixUndo(message) {
    const record = boundRecord(message);
    if (!record) return null;
    const result = {
        version: record.version,
        actionId: typeof record.actionId === 'string' ? record.actionId : '',
        binding: { ...record.binding },
        before: record.before,
        after: record.after,
        applied: record.applied !== false,
    };
    const vars = normalizedRecordVars(record);
    if (vars !== undefined) result.vars = vars;
    return result;
}

export function isFixedReply(message) {
    const extra = activeExtra(message);
    const marker = extra?.[FIX_MARKER_KEY];
    const binding = fixGenerationBinding(message);
    if (marker && typeof marker === 'object') {
        const record = boundRecord(message);
        return marker.version === FIX_RECORD_VERSION && sameBinding(marker.binding, binding)
            && (!marker.actionId || marker.actionId === record?.actionId);
    }
    // 3.0.x 创建的校正 swipe 使用布尔标记，且 gen_started 固定为 null。只从当前
    // swipe_info 读取，避免把顶层 extra 里被新生成复制过去的旧标记当成当前校正。
    if (marker === true) {
        const info = currentSwipeInfo(message);
        return !!info && info.extra?.[FIX_MARKER_KEY] === true && info.gen_started == null;
    }
    return false;
}

function ensureCurrentSwipe(message) {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
        message.swipes = [typeof message.mes === 'string' ? message.mes : ''];
        message.swipe_id = 0;
    }
    if (!Number.isInteger(message.swipe_id) || message.swipe_id < 0) message.swipe_id = 0;
    const id = message.swipe_id;
    if (id >= message.swipes.length) return null;
    if (typeof message.swipes[id] !== 'string') message.swipes[id] = typeof message.mes === 'string' ? message.mes : '';
    if (!Array.isArray(message.swipe_info)) message.swipe_info = message.swipes.map(() => null);
    if (!message.swipe_info[id] || typeof message.swipe_info[id] !== 'object') {
        message.swipe_info[id] = {
            send_date: message.send_date,
            ...(message.gen_started !== undefined ? { gen_started: message.gen_started } : {}),
            ...(message.gen_finished !== undefined ? { gen_finished: message.gen_finished } : {}),
            extra: { ...(message.extra && typeof message.extra === 'object' ? message.extra : {}) },
        };
    }
    return message.swipe_info[id];
}

function mutationMeta(messageId, messages) {
    const message = messages[messageId];
    if (!message) return null;
    let playableSeq = 0;
    let assistantSeq = 0;
    for (let i = 0; i <= messageId; i += 1) {
        const item = messages[i];
        if (!item || item.is_system) continue;
        playableSeq += 1;
        if (!item.is_user) assistantSeq += 1;
    }
    return {
        messageId,
        playableSeq: message.is_system ? null : playableSeq,
        assistantSeq: (!message.is_system && !message.is_user) ? assistantSeq : null,
        isUser: Boolean(message.is_user),
        isAssistant: Boolean(!message.is_system && !message.is_user),
        isSystem: Boolean(message.is_system),
    };
}

async function repaintAndEmit(ctx, chat, idx, message) {
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, message); }
    catch (error) { console.warn('[剧情推进] 校正后重渲染失败：', error); }

    const eventTypes = ctx.eventTypes || ctx.event_types || {};
    if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
        try {
            await ctx.eventSource.emit(eventTypes.MESSAGE_EDITED || 'message_edited', idx, mutationMeta(idx, chat));
        } catch (error) { console.warn('[剧情推进] 校正后发送 MESSAGE_EDITED 失败：', error); }
        try {
            await ctx.eventSource.emit(eventTypes.MESSAGE_UPDATED || 'message_updated', idx);
        } catch (error) { console.warn('[剧情推进] 校正后发送 MESSAGE_UPDATED 失败：', error); }
    }
}

function restoreExtra(owner, hadExtra, original, snapshot) {
    if (!hadExtra) {
        delete owner.extra;
        return;
    }
    owner.extra = original;
    for (const key of Object.keys(original)) delete original[key];
    Object.assign(original, snapshot);
}

function captureBodyState(ctx, message, swipeInfo) {
    const swipeId = currentSwipeId(message);
    return {
        swipeId,
        swipeInfo,
        mes: message.mes,
        swipe: message.swipes[swipeId],
        topHadExtra: !!message.extra && typeof message.extra === 'object',
        topExtra: message.extra,
        topSnapshot: { ...(message.extra && typeof message.extra === 'object' ? message.extra : {}) },
        swipeHadExtra: !!swipeInfo.extra && typeof swipeInfo.extra === 'object',
        swipeExtra: swipeInfo.extra,
        swipeSnapshot: { ...(swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {}) },
        taintedHad: !!ctx.chatMetadata && Object.prototype.hasOwnProperty.call(ctx.chatMetadata, 'tainted'),
        tainted: ctx.chatMetadata?.tainted,
    };
}

function restoreBodyState(ctx, message, before) {
    message.mes = before.mes;
    message.swipes[before.swipeId] = before.swipe;
    restoreExtra(message, before.topHadExtra, before.topExtra, before.topSnapshot);
    restoreExtra(before.swipeInfo, before.swipeHadExtra, before.swipeExtra, before.swipeSnapshot);
    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
        if (before.taintedHad) ctx.chatMetadata.tainted = before.tainted;
        else delete ctx.chatMetadata.tainted;
    }
}

async function rollbackWrittenBody(ctx, chat, idx, message, before) {
    restoreBodyState(ctx, message, before);
    const currentIdx = chat.indexOf(message);
    await repaintAndEmit(ctx, chat, currentIdx >= 0 ? currentIdx : idx, message);
    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
    } catch (error) {
        console.warn('[剧情推进] 校正事务回滚后保存失败：', error);
    }
}

async function writeCurrentBody(idx, text, updateExtra, expectedMessage) {
    const ctx = getCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const message = chat[idx];
    if (!message || typeof message.mes !== 'string' || typeof text !== 'string') return false;
    if (expectedMessage && message !== expectedMessage) return false;
    const swipeInfo = ensureCurrentSwipe(message);
    if (!swipeInfo) return false;

    const before = captureBodyState(ctx, message, swipeInfo);

    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    if (!swipeInfo.extra || typeof swipeInfo.extra !== 'object') swipeInfo.extra = {};
    updateExtra(message.extra, swipeInfo.extra);
    delete message.extra.display_text;
    delete swipeInfo.extra.display_text;
    message.mes = text;
    message.swipes[message.swipe_id] = text;
    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') ctx.chatMetadata.tainted = true;

    await repaintAndEmit(ctx, chat, idx, message);

    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
    } catch (error) {
        console.warn('[剧情推进] 校正替换回复后保存失败，已恢复写入前内容：', error);
        restoreBodyState(ctx, message, before);
        await repaintAndEmit(ctx, chat, idx, message);
        return false;
    }
    return true;
}

function markerFor(binding, actionId) {
    return { version: FIX_RECORD_VERSION, actionId, binding: { ...binding } };
}

function recordFor(binding, actionId, before, after, applied, vars) {
    const record = { version: FIX_RECORD_VERSION, actionId, binding: { ...binding }, before, after, applied };
    if (Array.isArray(vars)) record.vars = normalizedRecordVars({ vars });
    return record;
}

function emptyVariableResult() {
    return { applied: [], skipped: [] };
}

function applyResult(ok, vars = emptyVariableResult(), reason) {
    return { ok, vars, ...(reason ? { reason } : {}) };
}

function updateRecordVars(message, swipeInfo, actionId, vars) {
    for (const extra of [message.extra, swipeInfo?.extra]) {
        const record = extra?.[FIX_UNDO_KEY];
        if (record && record.actionId === actionId) record.vars = normalizedRecordVars({ vars }) || [];
    }
}

export async function applyFixInPlace(idx, finalText, { varTextChanges = [] } = {}) {
    const ctx = getCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const message = chat[idx];
    const emptyVars = emptyVariableResult();
    if (!message || typeof message.mes !== 'string' || typeof finalText !== 'string') {
        return applyResult(false, emptyVars, 'invalid-target');
    }
    const swipeInfo = ensureCurrentSwipe(message);
    const binding = fixGenerationBinding(message);
    if (!swipeInfo || !binding) return applyResult(false, emptyVars, 'invalid-target');

    // 顺序是事务契约：正文必须先成功落盘，才允许碰 MVU。此时还不知道哪些路径真能命中，
    // 所以先持久化 vars:[]；变量写完后再把实际 applied 固化进同一条撤销记录。
    const transactionBefore = captureBodyState(ctx, message, swipeInfo);
    const before = message.mes;
    const actionId = newActionId();
    const marker = markerFor(binding, actionId);
    const record = recordFor(binding, actionId, before, finalText, true, []);
    const bodyWritten = await writeCurrentBody(idx, finalText, (topExtra, currentExtra) => {
        topExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, finalText, true, []);
        currentExtra[FIX_MARKER_KEY] = marker;
        currentExtra[FIX_UNDO_KEY] = record;
    }, message);
    if (!bodyWritten) return applyResult(false, emptyVars, 'text-write');

    let vars;
    try {
        vars = await applyVariableTextChanges(idx, varTextChanges);
    } catch (error) {
        console.warn('[剧情推进] 校正同步变量失败，已回滚正文：', error);
        try {
            await revertVariableTextChanges(idx, error?.variableTextResult?.applied || []);
        } catch (rollbackError) {
            console.warn('[剧情推进] 校正变量写入失败后的变量回滚也失败：', rollbackError);
        }
        await rollbackWrittenBody(ctx, chat, idx, message, transactionBefore);
        return applyResult(false, emptyVars, 'variable-write');
    }

    // replaceMvuData 已经成功后，撤销记录里的 concrete pointer 也必须单独落盘；这一步失败
    // 就按同一事务把变量和正文都换回 transactionBefore，不能留下“正文已改但撤销不知道变量”的半状态。
    if (vars.applied.length) {
        updateRecordVars(message, swipeInfo, actionId, vars.applied);
        try {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        } catch (error) {
            console.warn('[剧情推进] 校正变量记录保存失败，已回滚正文和变量：', error);
            try { await revertVariableTextChanges(idx, vars.applied); }
            catch (rollbackError) { console.warn('[剧情推进] 校正变量记录失败后的变量回滚也失败：', rollbackError); }
            await rollbackWrittenBody(ctx, chat, idx, message, transactionBefore);
            return applyResult(false, emptyVars, 'variable-record-write');
        }
    }
    return applyResult(true, vars);
}

export function fixActionForMessage(idx) {
    const ctx = getCtx();
    const message = (ctx.chat || [])[idx];
    const record = readFixUndo(message);
    if (!record) return null;
    return {
        version: FIX_RECORD_VERSION,
        chatId: chatIdentity(ctx),
        targetIdx: idx,
        actionId: record.actionId,
        binding: { ...record.binding },
    };
}

export function resolveFixAction(action) {
    if (!action || action.version !== FIX_RECORD_VERSION || !action.binding) return null;
    const ctx = getCtx();
    if (action.chatId !== chatIdentity(ctx)) return null;
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const matches = (message) => {
        const record = readFixUndo(message);
        return record && sameBinding(record.binding, action.binding)
            && (!action.actionId || action.actionId === record.actionId) ? record : null;
    };
    const direct = Number.isInteger(action.targetIdx) ? matches(chat[action.targetIdx]) : null;
    if (direct) return { idx: action.targetIdx, message: chat[action.targetIdx], record: direct };
    for (let idx = 0; idx < chat.length; idx += 1) {
        const record = matches(chat[idx]);
        if (record) return { idx, message: chat[idx], record };
    }
    return null;
}

function resolveTarget(target) {
    if (Number.isInteger(target)) {
        const message = (getCtx().chat || [])[target];
        const record = readFixUndo(message);
        return record ? { idx: target, message, record } : null;
    }
    return resolveFixAction(target);
}

// 确认框是异步的：等待期间可能切了聊天、删了楼（楼号错位）、换了分支，或后台又校正了一次。
// 确认后按同一个 target 重新解析，要求聊天、消息对象、本次记录与确认时看到的正文全都没变，否则放弃。
// 只认消息对象不认楼号：前面删了楼时同一条消息会挪到新楼号，写到它现在的位置才是对的。
function resolveUnchanged(target, seen) {
    if (chatIdentity(getCtx()) !== seen.chatId) return null;
    const again = resolveTarget(target);
    if (!again || again.message !== seen.message) return null;
    const { record } = again;
    if (record.actionId !== seen.record.actionId || record.applied !== seen.record.applied
        || record.before !== seen.record.before || record.after !== seen.record.after
        || !sameBinding(record.binding, seen.record.binding) || !sameRecordVars(record, seen.record)) return null;
    if (again.message.mes !== seen.body) return null;
    return again;
}

// wantApplied：撤销要求记录处于「已应用」，正文应等于 after；重新应用要求「已撤销」，正文应等于 before。
async function confirmedTarget(target, wantApplied, question, confirm) {
    const resolved = resolveTarget(target);
    if (!resolved || (resolved.record.applied !== false) !== wantApplied) return null;
    const vars = normalizedRecordVars(resolved.record) || [];
    const expectedKey = wantApplied ? 'newValue' : 'oldValue';
    let variableState;
    try {
        variableState = inspectVariableTextChanges(resolved.idx, vars, expectedKey);
    } catch (error) {
        console.warn('[剧情推进] 校正撤销前读取变量失败：', error);
        return null;
    }
    const seen = {
        ...resolved,
        chatId: chatIdentity(getCtx()),
        body: resolved.message.mes,
        variableState,
    };
    const expectedBody = wantApplied ? resolved.record.after : resolved.record.before;
    if (seen.body === expectedBody && variableState.matches) return resolved;
    if (!(await confirm(question))) return null;

    const unchanged = resolveUnchanged(target, seen);
    if (!unchanged) return null;
    let currentVariableState;
    try {
        currentVariableState = inspectVariableTextChanges(unchanged.idx, vars, expectedKey);
    } catch (error) {
        console.warn('[剧情推进] 校正确认后复核变量失败：', error);
        return null;
    }
    return sameVariableTextInspection(variableState, currentVariableState) ? unchanged : null;
}

export async function undoFix(target, options = {}) {
    const resolved = await confirmedTarget(target, true, '校正后这条回复或它的变量又被改过，撤销会丢掉这些改动。确定撤销？',
        options.confirm || uiConfirm);
    if (!resolved) return false;
    const ctx = getCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const swipeInfo = ensureCurrentSwipe(resolved.message);
    if (!swipeInfo) return false;
    const transactionBefore = captureBodyState(ctx, resolved.message, swipeInfo);
    const { actionId, binding, before, after } = resolved.record;
    const vars = normalizedRecordVars(resolved.record);
    const bodyWritten = await writeCurrentBody(resolved.idx, before, (topExtra, currentExtra) => {
        delete topExtra[FIX_MARKER_KEY];
        delete currentExtra[FIX_MARKER_KEY];
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, false, vars);
        currentExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, false, vars);
    }, resolved.message);
    if (!bodyWritten) return false;
    try {
        await revertVariableTextChanges(resolved.idx, vars || []);
    } catch (error) {
        console.warn('[剧情推进] 撤销校正变量失败，已恢复撤销前正文：', error);
        try { await reapplyVariableTextChanges(resolved.idx, error?.variableTextResult?.applied || []); }
        catch (rollbackError) { console.warn('[剧情推进] 撤销变量失败后的变量回滚也失败：', rollbackError); }
        await rollbackWrittenBody(ctx, chat, resolved.idx, resolved.message, transactionBefore);
        return false;
    }
    return true;
}

export async function reapplyFix(target, options = {}) {
    const resolved = await confirmedTarget(target, false, '撤销后这条回复或它的变量又被改过，重新应用会丢掉这些改动。确定重新应用？',
        options.confirm || uiConfirm);
    if (!resolved) return false;
    const ctx = getCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const swipeInfo = ensureCurrentSwipe(resolved.message);
    if (!swipeInfo) return false;
    const transactionBefore = captureBodyState(ctx, resolved.message, swipeInfo);
    const { actionId, binding, before, after } = resolved.record;
    const vars = normalizedRecordVars(resolved.record);
    const bodyWritten = await writeCurrentBody(resolved.idx, after, (topExtra, currentExtra) => {
        topExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        currentExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, true, vars);
        currentExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, true, vars);
    }, resolved.message);
    if (!bodyWritten) return false;
    try {
        await reapplyVariableTextChanges(resolved.idx, vars || []);
    } catch (error) {
        console.warn('[剧情推进] 重新应用校正变量失败，已恢复操作前正文：', error);
        try { await revertVariableTextChanges(resolved.idx, error?.variableTextResult?.applied || []); }
        catch (rollbackError) { console.warn('[剧情推进] 重新应用变量失败后的变量回滚也失败：', rollbackError); }
        await rollbackWrittenBody(ctx, chat, resolved.idx, resolved.message, transactionBefore);
        return false;
    }
    return true;
}
