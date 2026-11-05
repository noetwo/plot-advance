import { refreshMessageBar } from '../../core/post-reply.js';
import { getLoadedMvu } from '../../st/adapters.js';

const SUPPORTED_OPS = new Set(['replace', 'add', 'insert']);

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function decodePointerSegment(segment) {
    if (/~(?:[^01]|$)/.test(segment)) return null;
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(pointer) {
    if (pointer === '') return [];
    if (typeof pointer !== 'string' || pointer.charAt(0) !== '/') return null;
    const segments = pointer.slice(1).split('/');
    const out = [];
    for (const segment of segments) {
        const decoded = decodePointerSegment(segment);
        if (decoded == null) return null;
        out.push(decoded);
    }
    return out;
}

function encodePointer(segments) {
    return '/' + segments.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

function arrayIndex(segment, length) {
    if (!/^(?:0|[1-9]\d*)$/.test(segment)) return null;
    const index = Number(segment);
    return Number.isSafeInteger(index) && index < length ? index : null;
}

function own(container, key) {
    return Object.prototype.hasOwnProperty.call(container, key);
}

function childAt(container, segment) {
    if (Array.isArray(container)) {
        const index = arrayIndex(segment, container.length);
        return index == null ? { found: false } : { found: true, key: index, value: container[index] };
    }
    if (!container || typeof container !== 'object' || !own(container, segment)) return { found: false };
    return { found: true, key: segment, value: container[segment] };
}

function locate(root, segments) {
    if (!segments.length) return { found: false };
    let container = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const child = childAt(container, segments[i]);
        if (!child.found) return { found: false };
        container = child.value;
    }
    const leaf = childAt(container, segments[segments.length - 1]);
    return leaf.found ? { found: true, container, key: leaf.key, value: leaf.value } : { found: false };
}

function skipAll(changes, reason) {
    return (Array.isArray(changes) ? changes : []).map((change) => ({ change, reason }));
}

function mvuFloor(idx) {
    const Mvu = getLoadedMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function') {
        return { Mvu: null, data: null, reason: '未检测到 MVU' };
    }
    const data = Mvu.getMvuData({ type: 'message', message_id: idx });
    if (!data || !data.stat_data || typeof data.stat_data !== 'object') {
        return { Mvu, data: null, reason: '这一楼没有 MVU 变量' };
    }
    return { Mvu, data, reason: '' };
}

function locateChange(stat, change) {
    if (!change || !SUPPORTED_OPS.has(change.op)) return { reason: '不支持的更新操作' };
    if (typeof change.oldValue !== 'string' || typeof change.newValue !== 'string') return { reason: '更新值不是文字' };
    if (change.oldValue === change.newValue) return { reason: '文字没有变化' };
    const segments = parsePointer(change.path);
    if (!segments || !segments.length) return { reason: '变量路径无效' };

    const appending = segments[segments.length - 1] === '-';
    if (appending) {
        if (change.op !== 'add' && change.op !== 'insert') return { reason: '变量路径无效' };
        let target = stat;
        for (const segment of segments.slice(0, -1)) {
            const child = childAt(target, segment);
            if (!child.found) return { reason: '变量路径不存在' };
            target = child.value;
        }
        if (!Array.isArray(target)) return { reason: '追加目标不是数组' };
        for (let index = target.length - 1; index >= 0; index -= 1) {
            if (target[index] === change.oldValue) {
                const concrete = [...segments.slice(0, -1), String(index)];
                return { container: target, key: index, pointer: encodePointer(concrete) };
            }
        }
        return { reason: '数组中找不到原文字' };
    }

    const found = locate(stat, segments);
    if (!found.found) return { reason: '变量路径不存在' };
    if (found.value !== change.oldValue) return { reason: '变量路径当前不是原文字' };
    return { container: found.container, key: found.key, pointer: encodePointer(segments) };
}

function syncDisplay(display, applied, valueKey) {
    if (!display || typeof display !== 'object') return display;
    for (const change of applied) {
        const segments = parsePointer(change.pointer);
        const found = segments && locate(display, segments);
        if (found?.found) found.container[found.key] = change[valueKey];
    }
    return display;
}

async function replaceFloor(Mvu, idx, data) {
    await Mvu.replaceMvuData(data, { type: 'message', message_id: idx });
    refreshMessageBar(idx);
}

/**
 * 把变量更新块中真正改过的字符串同步到目标楼当前 swipe 的 MVU 状态。
 * 找不到 MVU、该楼没有变量或单条路径不再匹配时均安全跳过；实际写入异常会抛给正文事务回滚。
 */
export async function applyVariableTextChanges(idx, changes) {
    const list = Array.isArray(changes) ? changes : [];
    const result = { applied: [], skipped: [] };
    if (!list.length) return result;

    const floor = mvuFloor(idx);
    if (!floor.data) {
        result.skipped = skipAll(list, floor.reason);
        return result;
    }

    const next = cloneJson(floor.data);
    const stat = next.stat_data;
    for (const change of list) {
        const target = locateChange(stat, change);
        if (target.reason) {
            result.skipped.push({ change, reason: target.reason });
            continue;
        }
        target.container[target.key] = change.newValue;
        result.applied.push({ pointer: target.pointer, oldValue: change.oldValue, newValue: change.newValue });
    }
    if (!result.applied.length) return result;

    if (next.display_data && typeof next.display_data === 'object') {
        syncDisplay(next.display_data, result.applied, 'newValue');
    }
    try {
        await replaceFloor(floor.Mvu, idx, next);
    } catch (error) {
        if (error && typeof error === 'object') error.variableTextResult = result;
        throw error;
    }
    return result;
}

// 撤销 / 重应用已经由 writeback 做过漂移确认；这里不再要求现值等于 expected，
// 只要求 concrete pointer 仍存在。这样用户确认“会丢掉改动”后才能按契约真正覆盖回来。
async function writeAppliedVariableText(idx, changes, valueKey) {
    const list = Array.isArray(changes) ? changes : [];
    const result = { applied: [], skipped: [] };
    if (!list.length) return result;

    const floor = mvuFloor(idx);
    if (!floor.data) {
        result.skipped = skipAll(list, floor.reason);
        return result;
    }

    const next = cloneJson(floor.data);
    for (const change of list) {
        const segments = parsePointer(change?.pointer);
        const found = segments && locate(next.stat_data, segments);
        if (!found?.found) {
            result.skipped.push({ change, reason: segments ? '变量路径不存在' : '变量路径无效' });
            continue;
        }
        found.container[found.key] = change[valueKey];
        result.applied.push({ pointer: encodePointer(segments), oldValue: change.oldValue, newValue: change.newValue });
    }
    if (!result.applied.length) return result;

    if (next.display_data && typeof next.display_data === 'object') {
        syncDisplay(next.display_data, result.applied, valueKey);
    }
    try {
        await replaceFloor(floor.Mvu, idx, next);
    } catch (error) {
        if (error && typeof error === 'object') error.variableTextResult = result;
        throw error;
    }
    return result;
}

export function revertVariableTextChanges(idx, changes) {
    return writeAppliedVariableText(idx, changes, 'oldValue');
}

export function reapplyVariableTextChanges(idx, changes) {
    return writeAppliedVariableText(idx, changes, 'newValue');
}

function inspectedValue(value) {
    if (value === undefined) return { kind: 'undefined' };
    try { return { kind: 'value', value: cloneJson(value) }; }
    catch { return { kind: 'unreadable', value: String(value) }; }
}

/** 读取撤销记录中各 concrete pointer 的现值，供确认前后的漂移保护使用。 */
export function inspectVariableTextChanges(idx, changes, expectedKey) {
    const list = Array.isArray(changes) ? changes : [];
    if (!list.length) return { matches: true, entries: [] };

    const floor = mvuFloor(idx);
    if (!floor.data) {
        return {
            matches: false,
            entries: list.map((change) => ({ pointer: change.pointer, found: false, reason: floor.reason })),
        };
    }

    const entries = list.map((change) => {
        const segments = parsePointer(change?.pointer);
        const found = segments && locate(floor.data.stat_data, segments);
        if (!found?.found) return { pointer: change?.pointer, found: false };
        return { pointer: encodePointer(segments), found: true, current: inspectedValue(found.value) };
    });
    const matches = entries.every((entry, index) => entry.found
        && entry.current.kind === 'value'
        && entry.current.value === list[index]?.[expectedKey]);
    return { matches, entries };
}

export function sameVariableTextInspection(left, right) {
    try { return JSON.stringify(left?.entries || []) === JSON.stringify(right?.entries || []); }
    catch { return false; }
}
