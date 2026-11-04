import { P } from '../../prompts/registry.js';
import { entryPreviewText } from './entries.js';
import { resolveBookName, toStringArray } from './operations.js';

/* ==================== 世界书「智能选书/选条」助手：引擎纯核（ENABLE_LB_SMART_SELECT，2026-08-08）====================
 * 全部纯函数、可单测（lb-smart-select.test.mjs）：派生目录 + 三块解析（Search/Fetch/Select）+ 引擎侧机械搜索 /
 * 取整条全文 + 回合状态机 + 勾选计划（含幻觉 uid 剔除）。恒 RAW——目录切片、搜索摘录、取文全文一律【原始条目
 * 文本】，绝不 substituteParams、绝不经 wiRenderEjs（与 buildLorebookContext 同款铁律 + 同款钉测试）。
 * 只读输入条目字段、只算勾选，绝不改书内容——本功能「零风险」定位的根。 */

// 可调上限（no silent caps——凡截断都要在回包里注明）。
export const LB_SMART_MAX_ROUNDS = 2;            // 额外来回上界（强模型 0 轮收敛；弱模型至多 Search + Fetch 各一轮）
const LB_SMART_SEARCH_ENTRY_CAP = 80;     // 搜索回包最多列多少条命中条目
const LB_SMART_SEARCH_EXCERPT_CAP = 3;    // 每条目最多几段摘录
const LB_SMART_CATALOG_SLICE = 120;       // 目录里「正文起始」切片字数
const LB_SMART_EXCERPT_PAD = 20;          // 搜索摘录：命中词两侧各取多少字


// 灯色判定（禁用优先于常驻；无键即绿灯）。纯 → 单测。
function lbEntryLamp(e) {
    if (e && e.disable) return { key: 'off', label: '⚫已禁用' };
    if (e && e.constant) return { key: 'blue', label: '🔵蓝灯·常驻' };
    return { key: 'green', label: '🟢绿灯' };
}

// 选择态判定（duck-type，避开 cross-realm instanceof Set 陷阱）：sel 为 Set/数组 = 精选、null/缺省 = 全勾。
function lbSelFiltered(sel) { return !!(sel && (typeof sel.has === 'function' || Array.isArray(sel))); }
function lbSelHas(sel, uid) { return Array.isArray(sel) ? sel.includes(uid) : sel.has(uid); }

// 派生目录（随首次调用直接喂给模型）。books = [{ name, entries: [raw 条目] }]；selMap = { 书名: Set|数组|null }
//（缺键 = 全勾，同 lbEntryFilter 语义）。每条一行：uid / ✔已勾|✖未勾 / 灯色 / 组 / 标题(comment) / 关键词(key) /
// 正文首 ~slice 字 RAW（entryPreviewText 折叠空白、保留 {{宏}} 字面）。当场从字段派生、无存储、无从漂移。纯 → 单测。
export function buildLbCatalog(books, selMap, opts) {
    const slice = (opts && opts.slice) || LB_SMART_CATALOG_SLICE;
    const map = selMap || {};
    const out = ['〔条目目录〕'];
    for (const b of (books || [])) {
        const entries = Array.isArray(b.entries) ? b.entries : [];
        const sel = map[b.name];
        const filtered = lbSelFiltered(sel);
        let checked = 0;
        const lines = [];
        for (const e of entries) {
            const on = !filtered || lbSelHas(sel, e.uid);
            if (on) checked++;
            const lamp = lbEntryLamp(e).label;
            const group = (e.group != null && String(e.group).trim()) ? String(e.group).trim() : '—';
            const title = (e.comment && String(e.comment).trim()) ? String(e.comment).trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(',') : '';
            const body = entryPreviewText(e.content, slice) || '（空）';
            lines.push('    · uid=' + e.uid + ' ' + (on ? '✔已勾' : '✖未勾') + ' ' + lamp +
                ' 组:' + group + ' 标题「' + title + '」 关键词:' + (keys || '—') + ' 正文起始: ' + body);
        }
        out.push('  书《' + b.name + '》（已勾 ' + checked + ' / 共 ' + entries.length + ' 条）');
        for (const l of lines) out.push(l);
    }
    return out.join('\n');
}

// —— 三块解析：与 parseOneLorebookBlock 同族（键值头 + 全半角冒号宽容 + 逗号列表），绝不 JSON ——
// 逐块回调 <Tag>…</Tag>（大小写不敏感、要求闭合）。
function lbSmartEachBlock(text, tag, cb) {
    const re = new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(String(text || ''))) !== null) cb(m[1]);
}
// 键值头解析：^(key)\s*[:：]\s*(value)$，全半角冒号宽容；key 允许 reason-<uid> 形态；键归一小写、保序取末值。
function lbSmartHeaders(inner) {
    const h = {};
    for (const raw of String(inner || '').split('\n')) {
        const line = raw.trim();
        const mm = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/);
        if (mm) h[mm[1].toLowerCase()] = mm[2];
    }
    return h;
}
// select/deselect 值 → { all:true } | { uids:[...] } | null。「全部」/「all」哨兵落到「整本勾满 = 发整本」语义。
function lbSmartUidSpec(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return null;
    if (/^(全部|all)$/i.test(raw)) return { all: true };
    const uids = toStringArray(raw).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
    return uids.length ? { uids } : null;
}

// <LorebookSearch>：keywords（逗号分隔【字面】子串，必填）+ 可选 scope 书名列表。缺 keywords = 错误。纯 → 单测。
export function parseLbSearchBlocks(text) {
    const searches = [];
    const errors = [];
    lbSmartEachBlock(text, 'LorebookSearch', (inner) => {
        const h = lbSmartHeaders(inner);
        const keywords = toStringArray(h.keywords);
        if (!keywords.length) { errors.push({ error: 'LorebookSearch 缺少 keywords' }); return; }
        const scope = ('scope' in h) ? toStringArray(h.scope) : [];
        searches.push({ keywords, scope: scope.length ? scope : null });
    });
    return { searches, errors };
}

// <LorebookFetch>：uid 逗号列表（必填）+ 可选 book（缺省时按持有 uid 的书推断）。文法与 B2 §4.2 逐字兼容。纯 → 单测。
export function parseLbFetchBlocks(text) {
    const fetches = [];
    const errors = [];
    lbSmartEachBlock(text, 'LorebookFetch', (inner) => {
        const h = lbSmartHeaders(inner);
        const uids = toStringArray(h.uid != null ? h.uid : h.uids).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
        if (!uids.length) { errors.push({ error: 'LorebookFetch 缺少有效 uid' }); return; }
        fetches.push({ uids, book: (h.book || '').trim() });
    });
    return { fetches, errors };
}

// <LorebookSelect>：一本书一块；select/deselect uid 列表（至少其一）；「全部」哨兵；可选 reason-<uid> 一行理由。纯 → 单测。
export function parseLbSelectBlocks(text) {
    const selects = [];
    const errors = [];
    lbSmartEachBlock(text, 'LorebookSelect', (inner) => {
        const h = lbSmartHeaders(inner);
        const select = ('select' in h) ? lbSmartUidSpec(h.select) : null;
        const deselect = ('deselect' in h) ? lbSmartUidSpec(h.deselect) : null;
        if (!select && !deselect) { errors.push({ error: 'LorebookSelect 至少需要 select 或 deselect' }); return; }
        const reasons = {};
        for (const [k, val] of Object.entries(h)) {
            const rm = k.match(/^reason-(\d+)$/);
            if (rm) reasons[rm[1]] = String(val).trim();
        }
        selects.push({ book: (h.book || '').trim(), select, deselect, reasons });
    });
    return { selects, errors };
}

// —— 引擎侧原语（浏览器里免费算，不发模型）——
// 全半角折叠 + ASCII 大写→小写（逐字符 1:1、长度不变 → 折叠串索引与 RAW 原文对齐，摘录才切得准）。
function lbSmartFold(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s)) {
        let c = ch.codePointAt(0);
        if (c >= 0xFF01 && c <= 0xFF5E) c -= 0xFEE0;   // 全角 ASCII → 半角
        else if (c === 0x3000) c = 0x20;               // 全角空格 → 半角
        if (c >= 0x41 && c <= 0x5A) c += 0x20;         // A-Z → a-z（仅 ASCII，保 1:1）
        out += String.fromCodePoint(c);
    }
    return out;
}
// scope（书名列表）→ 过滤到范围内的书（经 resolveBookName 容错）；空 scope = 全部书。
function lbSmartScopeBooks(books, scope) {
    if (!Array.isArray(scope) || !scope.length) return books;
    const names = books.map((b) => b.name);
    const allow = new Set();
    for (const sc of scope) { const r = resolveBookName(sc, names); if (r) allow.add(r); }
    return books.filter((b) => allow.has(b.name));
}

// 引擎搜索（纯）：books + keywords（字面子串）→ 按条目聚合命中，每命中给 ±pad 字 RAW 摘录（保留宏字面）。
// 总量截断：≤entryCap 条目 × ≤excerptCap 摘录，超出 truncated 记剩余数（no silent caps）。大小写 / 全半角宽容。
export function lbEngineSearch(books, keywords, opts) {
    const o = opts || {};
    const entryCap = o.entryCap || LB_SMART_SEARCH_ENTRY_CAP;
    const excerptCap = o.excerptCap || LB_SMART_SEARCH_EXCERPT_CAP;
    const pad = (o.pad != null) ? o.pad : LB_SMART_EXCERPT_PAD;
    const kws = (Array.isArray(keywords) ? keywords : toStringArray(keywords)).map((k) => String(k).trim()).filter(Boolean);
    const folded = kws.map((k) => ({ raw: k, fold: lbSmartFold(k) })).filter((k) => k.fold);
    const scoped = lbSmartScopeBooks(books || [], o.scope);
    const matchedEntries = [];
    for (const b of scoped) {
        for (const e of (Array.isArray(b.entries) ? b.entries : [])) {
            const content = String(e.content == null ? '' : e.content);
            if (!content) continue;
            const hay = lbSmartFold(content);
            const matched = [];
            const excerpts = [];
            for (const k of folded) {
                let from = 0, idx, found = false;
                while ((idx = hay.indexOf(k.fold, from)) !== -1) {
                    found = true;
                    if (excerpts.length < excerptCap) {
                        const start = Math.max(0, idx - pad);
                        const end = Math.min(content.length, idx + k.fold.length + pad);
                        let text = content.slice(start, end).replace(/\s+/g, ' ').trim();
                        if (start > 0) text = '…' + text;
                        if (end < content.length) text = text + '…';
                        excerpts.push({ keyword: k.raw, text });
                    }
                    from = idx + Math.max(1, k.fold.length);
                    if (excerpts.length >= excerptCap) break;
                }
                if (found) matched.push(k.raw);
            }
            if (matched.length) {
                matchedEntries.push({
                    book: b.name, uid: e.uid,
                    title: (e.comment && String(e.comment).trim()) ? String(e.comment).trim() : '（无标题）',
                    matched, excerpts,
                });
            }
        }
    }
    const shown = matchedEntries.slice(0, entryCap);
    return { keywords: kws, entries: shown, matchedCount: matchedEntries.length, truncated: Math.max(0, matchedEntries.length - shown.length) };
}
// 搜索回包 → 喂回模型的文本（含截断注记 / 空命中提示）。纯 → 单测。
export function formatLbSearchResult(res) {
    if (!res) return '';
    const lines = ['〔搜索结果·关键词：' + ((res.keywords || []).join(' / ') || '（无）') + '〕'];
    if (!res.entries.length) { lines.push('（没有任何条目命中这些关键词。）'); return lines.join('\n'); }
    for (const e of res.entries) {
        lines.push('  书《' + e.book + '》 uid=' + e.uid + '「' + e.title + '」 命中：' + e.matched.join(' / '));
        for (const ex of e.excerpts) lines.push('    · ' + ex.keyword + '：' + ex.text);
    }
    if (res.truncated > 0) lines.push('（另有 ' + res.truncated + ' 条命中未列出——请缩小关键词或用 scope 限定书。）');
    return lines.join('\n');
}

// 引擎取文（纯）：fetches = [{ uids, book }] → 逐条取整条【RAW 原文】。book 缺省时按持有该 uid 的唯一书推断；
// 定位不到列 missing。(book|uid) 去重。纯 → 单测。
export function lbEngineFetch(books, fetches) {
    const list = books || [];
    const names = list.map((b) => b.name);
    const byName = {};
    for (const b of list) byName[b.name] = b;
    const holders = (uid) => list.filter((b) => (b.entries || []).some((e) => Number(e.uid) === uid));
    const items = [];
    const missing = [];
    const seen = new Set();
    for (const f of (fetches || [])) {
        const book = (f.book || '').trim();
        for (const uid of (f.uids || [])) {
            let target = null;
            if (book) {
                const nm = resolveBookName(book, names);
                if (nm && byName[nm] && (byName[nm].entries || []).some((e) => Number(e.uid) === uid)) target = byName[nm];
            }
            if (!target) { const h = holders(uid); if (h.length === 1) target = h[0]; }
            if (!target) { missing.push({ book: book || '', uid }); continue; }
            const key = target.name + '|' + uid;
            if (seen.has(key)) continue;
            seen.add(key);
            const e = (target.entries || []).find((x) => Number(x.uid) === uid);
            items.push({
                book: target.name, uid,
                title: (e && e.comment && String(e.comment).trim()) ? String(e.comment).trim() : '（无标题）',
                content: String(e && e.content != null ? e.content : ''),
            });
        }
    }
    return { items, missing };
}
// 取文回包 → 喂回模型的文本（RAW 原文逐字 + 缺失注记）。纯 → 单测。
export function formatLbFetchResult(res) {
    if (!res) return '';
    const lines = ['〔取回全文（RAW 原文，逐字）〕'];
    for (const it of (res.items || [])) {
        lines.push('  书《' + it.book + '》 uid=' + it.uid + '「' + it.title + '」：');
        lines.push(it.content);
    }
    for (const m of (res.missing || [])) lines.push('  （uid=' + m.uid + (m.book ? ' @《' + m.book + '》' : '') + ' 未找到）');
    return lines.join('\n');
}

// 回合状态机（无持久态；每轮 = 指令 + 目录 + 此前回包 的重放）。round 从 1 起（调用①）；cap = 额外来回上界。
// Select 即终局 → apply（同回复带 Search/Fetch → ignoredRequests 标记，忽略并在预检卡注明）；
// 只请求 → round≤cap 续发 search，round=cap+1 仍只请求 → stop noconverge；既无 Select 又无请求 → stop norequest。纯 → 单测。
export function lbSmartNextStep(parsed, round, maxRounds) {
    const cap = (maxRounds != null) ? maxRounds : LB_SMART_MAX_ROUNDS;
    const selects = (parsed && parsed.selects) || [];
    const searches = (parsed && parsed.searches) || [];
    const fetches = (parsed && parsed.fetches) || [];
    const hasReq = (searches.length + fetches.length) > 0;
    if (selects.length) return { action: 'apply', ignoredRequests: hasReq };
    if (hasReq) return (round <= cap) ? { action: 'search' } : { action: 'stop', reason: 'noconverge' };
    return { action: 'stop', reason: 'norequest' };
}

// 勾选计划（纯）：把 <LorebookSelect> 块解析成【每本书的最终选择态】+ 预检行 + 幻觉 uid 剔除。
// selects = parseLbSelectBlocks().selects；books = 目录同款；currentSel = { 书名: Set|数组|null }（当前选择态）。
// 返回：perBook[{ book, finalUids, fullBook, addedUids, removedUids }]、rows[{ action, book, uid, all?, title, reason }]、
// dropped[{ book, uid }]（超出目录的幻觉 uid）、unresolvedBooks[书名]、willSelect / willDeselect（净增净减计数）。纯 → 单测。
export function lbResolveSelectPlan(selects, books, currentSel) {
    const list = books || [];
    const names = list.map((b) => b.name);
    const byName = {};
    for (const b of list) {
        const uids = (b.entries || []).map((e) => Number(e.uid));
        const titles = {};
        for (const e of (b.entries || [])) titles[Number(e.uid)] = (e.comment && String(e.comment).trim()) ? String(e.comment).trim() : '（无标题）';
        byName[b.name] = { uids, titles };
    }
    const cur = currentSel || {};
    const curSelected = (book) => {
        const all = byName[book].uids;
        const sel = cur[book];
        if (!lbSelFiltered(sel)) return new Set(all);   // null/缺省 = 全勾
        const s = new Set();
        for (const u of all) if (lbSelHas(sel, u)) s.add(u);
        return s;
    };
    const perBook = [];
    const rows = [];
    const dropped = [];
    const unresolvedBooks = [];
    let willSelect = 0, willDeselect = 0;
    for (const blk of (selects || [])) {
        const nm = resolveBookName(blk.book, names);
        if (!nm || !byName[nm]) { unresolvedBooks.push(blk.book || ''); continue; }
        const allUids = byName[nm].uids;
        const validSet = new Set(allUids);
        const before = curSelected(nm);
        const final = new Set(before);
        const applySpec = (spec, action) => {
            if (!spec) return;
            if (spec.all) {
                if (action === 'select') { for (const u of allUids) final.add(u); }
                else { final.clear(); }
                rows.push({ action, book: nm, uid: null, all: true, title: '（整本条目）', reason: '' });
                return;
            }
            for (const u of spec.uids) {
                if (!validSet.has(u)) { dropped.push({ book: nm, uid: u }); continue; }
                if (action === 'select') final.add(u); else final.delete(u);
                rows.push({ action, book: nm, uid: u, title: byName[nm].titles[u] || '', reason: (blk.reasons && blk.reasons[u] != null) ? blk.reasons[u] : '' });
            }
        };
        applySpec(blk.select, 'select');
        applySpec(blk.deselect, 'deselect');
        for (const u of final) if (!before.has(u)) willSelect++;
        for (const u of before) if (!final.has(u)) willDeselect++;
        const finalUids = [...final].sort((a, b) => a - b);
        perBook.push({
            book: nm, finalUids,
            fullBook: finalUids.length === allUids.length && allUids.length > 0,
            addedUids: [...final].filter((u) => !before.has(u)).sort((a, b) => a - b),
            removedUids: [...before].filter((u) => !final.has(u)).sort((a, b) => a - b),
        });
    }
    return { perBook, rows, dropped, unresolvedBooks, willSelect, willDeselect };
}

// 喂给模型的指令提示词（家规：中文用户面、English identifiers；下方为一次性组装）。首次调用 = 指令 + 目录；
// 续发 = 再拼上此前引擎回包。personas 不参与、不走预设——由调用方经 soCallModel 直发（同 persona 扩写一次性调用）。
export function buildSmartSelectMessages(userCommand, catalog, priorResults) {
    const sys = P('lb.smartSelect') + '\n\n' + String(catalog || '') + (priorResults ? '\n\n' + String(priorResults) : '');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: String(userCommand || '') },
    ];
}
