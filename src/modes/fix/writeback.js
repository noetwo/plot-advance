import { getCtx, uiConfirm } from '../../core/settings.js';

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

export function readFixUndo(message) {
    const record = boundRecord(message);
    return record ? {
        version: record.version,
        actionId: typeof record.actionId === 'string' ? record.actionId : '',
        binding: { ...record.binding },
        before: record.before,
        after: record.after,
        applied: record.applied !== false,
    } : null;
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

async function writeCurrentBody(idx, text, updateExtra) {
    const ctx = getCtx();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const message = chat[idx];
    if (!message || typeof message.mes !== 'string' || typeof text !== 'string') return false;
    const swipeInfo = ensureCurrentSwipe(message);
    if (!swipeInfo) return false;

    const before = {
        mes: message.mes,
        swipe: message.swipes[message.swipe_id],
        topHadExtra: !!message.extra && typeof message.extra === 'object',
        topExtra: message.extra,
        topSnapshot: { ...(message.extra && typeof message.extra === 'object' ? message.extra : {}) },
        swipeHadExtra: !!swipeInfo.extra && typeof swipeInfo.extra === 'object',
        swipeExtra: swipeInfo.extra,
        swipeSnapshot: { ...(swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {}) },
        taintedHad: !!ctx.chatMetadata && Object.prototype.hasOwnProperty.call(ctx.chatMetadata, 'tainted'),
        tainted: ctx.chatMetadata?.tainted,
    };

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
        message.mes = before.mes;
        message.swipes[message.swipe_id] = before.swipe;
        restoreExtra(message, before.topHadExtra, before.topExtra, before.topSnapshot);
        restoreExtra(swipeInfo, before.swipeHadExtra, before.swipeExtra, before.swipeSnapshot);
        if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
            if (before.taintedHad) ctx.chatMetadata.tainted = before.tainted;
            else delete ctx.chatMetadata.tainted;
        }
        await repaintAndEmit(ctx, chat, idx, message);
        return false;
    }
    return true;
}

function markerFor(binding, actionId) {
    return { version: FIX_RECORD_VERSION, actionId, binding: { ...binding } };
}

function recordFor(binding, actionId, before, after, applied) {
    return { version: FIX_RECORD_VERSION, actionId, binding: { ...binding }, before, after, applied };

}
export async function applyFixInPlace(idx, finalText) {
    const ctx = getCtx();
    const message = (ctx.chat || [])[idx];
    if (!message || typeof message.mes !== 'string' || typeof finalText !== 'string') return false;
    ensureCurrentSwipe(message);
    const binding = fixGenerationBinding(message);
    if (!binding) return false;
    const before = message.mes;
    const actionId = newActionId();
    const marker = markerFor(binding, actionId);
    const record = recordFor(binding, actionId, before, finalText, true);
    return writeCurrentBody(idx, finalText, (topExtra, swipeExtra) => {
        topExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, finalText, true);
        swipeExtra[FIX_MARKER_KEY] = marker;
        swipeExtra[FIX_UNDO_KEY] = record;
    });
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

export async function undoFix(target, options = {}) {
    const resolved = resolveTarget(target);
    if (!resolved || resolved.record.applied === false) return false;
    const confirm = options.confirm || uiConfirm;
    if (resolved.message.mes !== resolved.record.after) {
        const accepted = await confirm('校正后这条回复又被改过，撤销会丢掉这些改动。确定撤销？');
        if (!accepted) return false;
    }
    const { actionId, binding, before, after } = resolved.record;
    return writeCurrentBody(resolved.idx, before, (topExtra, swipeExtra) => {
        delete topExtra[FIX_MARKER_KEY];
        delete swipeExtra[FIX_MARKER_KEY];
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, false);
        swipeExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, false);
    });
}

export async function reapplyFix(target, options = {}) {
    const resolved = resolveTarget(target);
    if (!resolved || resolved.record.applied !== false) return false;
    const confirm = options.confirm || uiConfirm;
    if (resolved.message.mes !== resolved.record.before) {
        const accepted = await confirm('撤销后这条回复又被改过，重新应用会丢掉这些改动。确定重新应用？');
        if (!accepted) return false;
    }
    const { actionId, binding, before, after } = resolved.record;
    return writeCurrentBody(resolved.idx, after, (topExtra, swipeExtra) => {
        topExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        swipeExtra[FIX_MARKER_KEY] = markerFor(binding, actionId);
        topExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, true);
        swipeExtra[FIX_UNDO_KEY] = recordFor(binding, actionId, before, after, true);
    });
}
