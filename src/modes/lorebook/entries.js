import { isMvuRuleEntry } from '../../st/adapters.js';

const LB_POSITION_LABEL = {
    0: '角色定义之前',
    1: '角色定义之后',
    2: '作者注释之上',
    3: '作者注释之下',
    4: '@D（按深度插入）',
    5: '示例对话之前',
    6: '示例对话之后',
};

function lbEntryType(e) {
    if (e.disable) return '已禁用';
    if (e.constant) return '常驻（蓝灯）';
    return '关键词触发（绿灯）';
}

export function lbFormatEntry(e) {
    const uid = e.uid;
    const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
    const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
    const keys2 = Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean).join(', ') : '';
    const pos = LB_POSITION_LABEL[Number(e.position)] || String(e.position ?? '');
    const lines = [];
    lines.push(`【条目 uid=${uid}】${title}`);
    lines.push(`- 类型：${lbEntryType(e)}`);
    if (keys) lines.push(`- 关键词(key)：${keys}`);
    if (keys2) lines.push(`- 次要关键词(keysecondary)：${keys2}`);
    lines.push(`- 位置(position)：${pos} ｜ 顺序(order)：${e.order ?? 100}` + (Number(e.position) === 4 ? ` ｜ 深度(depth)：${e.depth ?? ''}` : ''));
    const content = typeof e.content === 'string' ? e.content : '';
    lines.push(`- 内容(content)：\n${content.trim() || '（空）'}`);
    return lines.join('\n');
}


// 估算一段文本的 token 数。CJK / 全角宽字符各记 1 枚，其余每 4 字符记 1 枚——只需量级正确
// 到够判红绿，故不走酒馆真 tokenizer（那要在每次勾选时 tokenize ~88 万字符）。文案里的
// 「约」就是为此。按【码点】遍历：扩展 B 汉字是代理对，数 UTF-16 单元会把一个字数成两个半。
export function estimateTokensForText(text) {
    if (typeof text !== 'string' || !text) return 0;
    let wide = 0;
    let rest = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0);
        const isWide =
            (c >= 0x1100 && c <= 0x11FF) ||     // 韩文字母
            (c >= 0x2E80 && c <= 0xA4CF) ||     // CJK 部首 / 假名 / CJK 统一表意
            (c >= 0xAC00 && c <= 0xD7A3) ||     // 韩文音节
            (c >= 0xF900 && c <= 0xFAFF) ||     // CJK 兼容表意
            (c >= 0xFE30 && c <= 0xFE4F) ||     // CJK 兼容形式
            (c >= 0xFF00 && c <= 0xFF60) ||     // 全角形式（含全角标点）
            (c >= 0xFFE0 && c <= 0xFFE6) ||     // 全角符号
            (c >= 0x20000 && c <= 0x3FFFD);     // 扩展 B 及以后
        if (isWide) wide++; else rest++;
    }
    return Math.round(wide + rest / 4);
}

// 一条条目的成本：按【真正发出去的那份格式化文本】度量（lbFormatEntry 的产出，含标题 /
// 关键词 / 位置这些元数据），而不是裸 content —— 读数要对得上真实发送量。
export function lbEntryTokenCost(e) {
    return estimateTokensForText(lbFormatEntry(e));
}


// 读数文案（Prince 从三档候选里选定的「最简」档）：不足一万给取整到百位的原数，
// 一万以上换万为单位（十万以下留一位小数、`.0` 省略；十万以上取整）。
export function formatLbSizeEstimate(tok) {
    const n = Math.max(0, Math.round(Number(tok) || 0));
    if (n < 10000) {
        const r = Math.round(n / 100) * 100;
        if (r < 10000) return `约 ${r} token`;   // 9950 这类会进位到 10000 的落到万档，不印半吊子
    }
    const wan = n / 10000;
    const s = wan >= 10 ? String(Math.round(wan)) : String(Math.round(wan * 10) / 10);
    return `约 ${s} 万 token`;
}

// 过线标红。阈值 10 万卡在主流模型 128k 上下文之下 —— 红＝「这一发有相当概率被拒」，
// 而精选出来的十几条（几千到几万）保持常色。故意写成字面量而不单开 ALL_CAPS 常量：
// 仓里的 meta-test 要求每个顶层 ALL_CAPS 至少被引用两次，这个阈值只有这一处真实引用。
// 边界两侧由 tests/unit/lb-size-readout.test.mjs 钉住。
export function lbSizeIsHuge(tok) {
    return Number(tok) >= 100000;
}

// 按当前筛选态求和。rows = [{book, uid, tok}]，filter = lbEntryFilter（Set＝只发这些，
// null / 缺键＝整本发送）。DOM 层只负责把渲染好的行映射成这个形状——真选择器够不着单测，
// 判断逻辑抠到这里才钉得住（与 1.49.0 立的「纯函数 + smoke」分工同款）。
export function sumLbSelectedTokens(rows, filter) {
    if (!Array.isArray(rows)) return 0;
    const f = filter || {};
    let sum = 0;
    for (const r of rows) {
        if (!r) continue;
        const sel = f[r.book || ''];
        if (sel instanceof Set && !sel.has(r.uid)) continue;
        sum += Number(r.tok) || 0;
    }
    return sum;
}



// 🌐 自定义范围的纯收集器（1.81.0）：selMap = { 书名: Set<uid> }（显式模型：缺键 / 空集合 = 这本一条不发），
// orderedBooks = [{ name, entries }] 有序数组（书序由调用方按 resolveLbTargetNames 定）。
// 书内按 displayIndex ?? uid；剔空正文；剔 [mvu_update] 规则（它们一律不进神谕提示词——且必须在 renderWiEjs 之前按条目剔，
// stripMvuRuleContents 只认宏展开后的规则文本，对原始 {{user}} 规则不管用）；disable 无视（勾了就发）。
export function collectWiCustomEntries(selMap, orderedBooks) {
    const out = [];
    const sel = (selMap && typeof selMap === 'object') ? selMap : {};
    for (const book of (Array.isArray(orderedBooks) ? orderedBooks : [])) {
        if (!book || typeof book.name !== 'string') continue;
        const want = sel[book.name];
        if (!(want instanceof Set) || !want.size) continue;
        const entries = (Array.isArray(book.entries) ? book.entries : [])
            .filter((e) => e && want.has(Number(e.uid)) && typeof e.content === 'string' && e.content.trim())
            .filter((e) => !isMvuRuleEntry(e))
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        for (const e of entries) out.push(e);
    }
    return out;
}

// 自定义清单的单条体积：只按【正文 trim 后】估算（自定义喂的就是正文，带标题 / 关键词的编辑格式会高估）。
export function wiCustomEntryCost(e) {
    const c = e && typeof e.content === 'string' ? e.content.trim() : '';
    return c ? estimateTokensForText(c) : 0;
}

// 纯函数：把一条世界书条目的 raw content 压成选条目器里展示的一行短摘要。
export function entryPreviewText(content, cap = 200) {
    const s = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > cap ? s.slice(0, cap) + '…' : s;
}
