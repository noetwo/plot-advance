import { MVU_BLOCK_DIALECTS } from '../../prompts/builtins.js';
import { mvuBlockRegex, mvuDialectInnerOk } from '../../prompts/helpers.js';

const DIALECT_PARTS = Object.freeze({
    updatevariable: Object.freeze({ analysis: 'Analysis', patch: 'JSONPatch' }),
    update: Object.freeze({ analysis: 'update_analysis', patch: 'json_patch' }),
});

function dialectMatches(text, dialect) {
    if (!mvuDialectInnerOk(text, dialect)) return [];
    return [...String(text).matchAll(mvuBlockRegex(dialect.wrapper, 'gi'))];
}

// 与 extractUpdateBlock 相同：跨 MVU_BLOCK_DIALECTS，取文本里最早出现的一块。
export function locateVariableBlock(text) {
    const source = String(text == null ? '' : text);
    let best = null;
    for (const dialect of MVU_BLOCK_DIALECTS) {
        for (const match of dialectMatches(source, dialect)) {
            const found = {
                block: match[0],
                start: match.index,
                end: match.index + match[0].length,
                dialect,
            };
            if (!best || found.start < best.start) best = found;
        }
    }
    return best;
}

function countVariableBlocks(text) {
    const source = String(text == null ? '' : text);
    let count = 0;
    for (const dialect of MVU_BLOCK_DIALECTS) count += dialectMatches(source, dialect).length;
    return count;
}

function tagParts(block, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('<' + escaped + '\\b[^>]*>([\\s\\S]*?)<\\/' + escaped + '\\s*>', 'gi');
    return [...String(block).matchAll(regex)].map((match) => {
        const openEnd = match.index + match[0].indexOf('>') + 1;
        const closeOffset = match[0].lastIndexOf('</');
        return {
            start: match.index,
            end: match.index + match[0].length,
            contentStart: openEnd,
            contentEnd: match.index + closeOffset,
            content: match[1],
        };
    });
}

function blockParts(block, dialect) {
    const names = DIALECT_PARTS[String(dialect.wrapper || '').toLowerCase()];
    if (!names) return { error: '不支持的变量块方言' };
    const analysis = tagParts(block, names.analysis);
    const patch = tagParts(block, names.patch);
    if (analysis.length > 1 || patch.length > 1) return { error: '摘要或 JSONPatch 区域重复' };
    return { analysis: analysis[0] || null, patch: patch[0] || null };
}

function blockSkeleton(block, parts) {
    const ranges = [];
    if (parts.analysis) ranges.push({ start: parts.analysis.contentStart, end: parts.analysis.contentEnd, token: '\u0000ANALYSIS\u0000' });
    if (parts.patch) ranges.push({ start: parts.patch.contentStart, end: parts.patch.contentEnd, token: '\u0000JSONPATCH\u0000' });
    ranges.sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const range of ranges) {
        out += block.slice(cursor, range.start) + range.token;
        cursor = range.end;
    }
    return out + block.slice(cursor);
}

function parseJsonDocument(source) {
    const text = String(source);
    let cursor = 0;
    const skipSpace = () => { while (/\s/.test(text[cursor] || '')) cursor += 1; };
    const fail = (message) => { throw new Error(message); };

    const parseString = () => {
        const start = cursor;
        if (text[cursor] !== '"') fail('字符串缺少开引号');
        cursor += 1;
        while (cursor < text.length) {
            const ch = text[cursor];
            if (ch === '"') {
                cursor += 1;
                const raw = text.slice(start, cursor);
                let value;
                try { value = JSON.parse(raw); } catch { fail('字符串转义无效'); }
                return { type: 'string', start, end: cursor, value };
            }
            if (ch === '\\') {
                cursor += 1;
                if (cursor >= text.length) fail('字符串转义不完整');
                if (text[cursor] === 'u') {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(cursor + 1, cursor + 5))) fail('Unicode 转义无效');
                    cursor += 5;
                } else {
                    if (!/["\\/bfnrt]/.test(text[cursor])) fail('字符串转义无效');
                    cursor += 1;
                }
                continue;
            }
            if (ch.charCodeAt(0) < 0x20) fail('字符串含控制字符');
            cursor += 1;
        }
        fail('字符串未闭合');
    };

    const parseValue = () => {
        skipSpace();
        const start = cursor;
        const ch = text[cursor];
        if (ch === '"') return parseString();
        if (ch === '[') {
            cursor += 1;
            const children = [];
            const value = [];
            skipSpace();
            if (text[cursor] === ']') { cursor += 1; return { type: 'array', start, end: cursor, value, children }; }
            while (cursor < text.length) {
                const node = parseValue();
                children.push(node);
                value.push(node.value);
                skipSpace();
                if (text[cursor] === ']') { cursor += 1; return { type: 'array', start, end: cursor, value, children }; }
                if (text[cursor] !== ',') fail('数组缺少逗号');
                cursor += 1;
            }
            fail('数组未闭合');
        }
        if (ch === '{') {
            cursor += 1;
            const properties = [];
            const value = Object.create(null);
            const keys = new Set();
            skipSpace();
            if (text[cursor] === '}') { cursor += 1; return { type: 'object', start, end: cursor, value, properties }; }
            while (cursor < text.length) {
                skipSpace();
                const keyNode = parseString();
                const key = keyNode.value;
                if (keys.has(key)) fail('对象字段重复');
                keys.add(key);
                skipSpace();
                if (text[cursor] !== ':') fail('对象字段缺少冒号');
                cursor += 1;
                const node = parseValue();
                properties.push({ key, keyNode, node });
                value[key] = node.value;
                skipSpace();
                if (text[cursor] === '}') { cursor += 1; return { type: 'object', start, end: cursor, value, properties }; }
                if (text[cursor] !== ',') fail('对象缺少逗号');
                cursor += 1;
            }
            fail('对象未闭合');
        }
        const tail = text.slice(cursor);
        const number = tail.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (number) {
            cursor += number[0].length;
            return { type: 'number', start, end: cursor, value: JSON.parse(number[0]) };
        }
        for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
            if (tail.startsWith(literal)) {
                cursor += literal.length;
                return { type: literal === 'null' ? 'null' : 'boolean', start, end: cursor, value };
            }
        }
        fail('JSON 值无效');
    };

    const root = parseValue();
    skipSpace();
    if (cursor !== text.length) fail('JSON 末尾还有其它内容');
    return root;
}

function objectProperty(node, key) {
    return node && node.type === 'object' ? node.properties.find((property) => property.key === key) || null : null;
}

function deepEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => deepEqual(value, right[index]));
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

function validateAndMergePatch(originalSource, rewrittenSource) {
    let original;
    let rewritten;
    try {
        original = parseJsonDocument(originalSource);
        rewritten = parseJsonDocument(rewrittenSource);
    } catch (error) {
        return { error: 'JSONPatch 不是合法 JSON：' + error.message };
    }
    if (original.type !== 'array' || rewritten.type !== 'array') return { error: 'JSONPatch 必须是数组' };
    if (original.children.length !== rewritten.children.length) return { error: 'JSONPatch 条目数量发生变化' };

    const changes = [];
    const replacements = [];
    for (let index = 0; index < original.children.length; index += 1) {
        const oldEntry = original.children[index];
        const newEntry = rewritten.children[index];
        if (oldEntry.type !== 'object' || newEntry.type !== 'object') return { error: `JSONPatch 第 ${index + 1} 条不是对象` };
        const oldKeys = oldEntry.properties.map((property) => property.key);
        const newKeys = newEntry.properties.map((property) => property.key);
        if (!deepEqual(oldKeys, newKeys)) return { error: `JSONPatch 第 ${index + 1} 条结构发生变化` };

        for (const property of oldEntry.properties) {
            const next = objectProperty(newEntry, property.key);
            if (!next) return { error: `JSONPatch 第 ${index + 1} 条结构发生变化` };
            if (property.key === 'value' && property.node.type === 'string') {
                if (next.node.type !== 'string') return { error: `JSONPatch 第 ${index + 1} 条 value 类型发生变化` };
                if (property.node.value !== next.node.value) {
                    const op = objectProperty(oldEntry, 'op')?.node.value;
                    const path = objectProperty(oldEntry, 'path')?.node.value;
                    changes.push({
                        index,
                        op: typeof op === 'string' ? op : '',
                        path: typeof path === 'string' ? path : '',
                        oldValue: property.node.value,
                        newValue: next.node.value,
                    });
                    replacements.push({ start: property.node.start, end: property.node.end, text: JSON.stringify(next.node.value) });
                }
            } else if (!deepEqual(property.node.value, next.node.value)) {
                const label = ['op', 'path', 'from'].includes(property.key) ? property.key : `字段 ${property.key}`;
                return { error: `JSONPatch 第 ${index + 1} 条的 ${label} 发生变化` };
            }
        }
    }

    let patch = originalSource;
    replacements.sort((a, b) => b.start - a.start);
    for (const replacement of replacements) {
        patch = patch.slice(0, replacement.start) + replacement.text + patch.slice(replacement.end);
    }
    return { patch, changes };
}

function replaceRanges(source, replacements) {
    let out = source;
    for (const replacement of replacements.slice().sort((a, b) => b.start - a.start)) {
        out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
    }
    return out;
}

function fallback(original, reason) {
    return { block: original, changes: [], fellBack: true, reason };
}

// 只接受摘要正文与 JSONPatch 各条字符串 value 的改写；其它内容一律从原块保留。
export function mergeRewrittenVariableBlock(originalBlock, rewrittenBlock) {
    const originalText = String(originalBlock == null ? '' : originalBlock);
    const rewrittenText = String(rewrittenBlock == null ? '' : rewrittenBlock);
    const originalLocated = locateVariableBlock(originalText);
    if (!originalLocated) return fallback(originalText, '原回复里没有完整的变量更新块');
    const original = originalLocated.block;
    if (!rewrittenText.trim()) return fallback(original, '模型没有返回变量更新块');
    const rewrittenLocated = locateVariableBlock(rewrittenText);
    if (!rewrittenLocated || countVariableBlocks(rewrittenText) !== 1) return fallback(original, '模型丢失或重复了变量更新块');
    if (String(originalLocated.dialect.wrapper).toLowerCase() !== String(rewrittenLocated.dialect.wrapper).toLowerCase()) {
        return fallback(original, '变量更新块方言发生变化');
    }

    const rewritten = rewrittenLocated.block;
    const originalParts = blockParts(original, originalLocated.dialect);
    const rewrittenParts = blockParts(rewritten, rewrittenLocated.dialect);
    if (originalParts.error) return fallback(original, originalParts.error);
    if (rewrittenParts.error) return fallback(original, rewrittenParts.error);
    if (!!originalParts.analysis !== !!rewrittenParts.analysis || !!originalParts.patch !== !!rewrittenParts.patch) {
        return fallback(original, '摘要或 JSONPatch 区域被添加或删除');
    }
    if (blockSkeleton(original, originalParts) !== blockSkeleton(rewritten, rewrittenParts)) {
        return fallback(original, '变量更新块中不允许改动的结构或内容发生变化');
    }

    let patch = originalParts.patch ? originalParts.patch.content : '';
    let changes = [];
    if (originalParts.patch) {
        const mergedPatch = validateAndMergePatch(originalParts.patch.content, rewrittenParts.patch.content);
        if (mergedPatch.error) return fallback(original, mergedPatch.error);
        patch = mergedPatch.patch;
        changes = mergedPatch.changes;
    }

    const replacements = [];
    if (originalParts.analysis) {
        replacements.push({
            start: originalParts.analysis.contentStart,
            end: originalParts.analysis.contentEnd,
            text: rewrittenParts.analysis.content,
        });
    }
    if (originalParts.patch) {
        replacements.push({ start: originalParts.patch.contentStart, end: originalParts.patch.contentEnd, text: patch });
    }
    return { block: replaceRanges(original, replacements), changes, fellBack: false };
}
