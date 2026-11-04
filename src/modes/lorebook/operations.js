import { lbBookNames } from './context.js';
import { getWiEditApi } from './world-info.js';

// Convert a fenced body the model wrote with literal "\n" (out of JSON habit)
// back into real line breaks. Only fires when there are NO real newlines yet, so
// legitimately single-line content is untouched.
function lbBackstopNewlines(s) {
    if (typeof s !== 'string') return s;
    if (s.indexOf('\n') === -1 && /\\n/.test(s)) {
        return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return s;
}

// Pull one fenced body out of a block: <<<name … name>>> (markers at line start).
// Returns { body, rest }: body is the inner text with exactly one boundary newline
// trimmed each side (internal indentation preserved), or null if absent; rest is
// the block with that fence removed so header parsing won't see it.
function extractFence(text, name) {
    const re = new RegExp('(^|\\n)[ \\t]*<<<' + name + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*' + name + '>>>[ \\t]*(?=\\n|$)');
    const m = text.match(re);
    if (!m) return { body: null, rest: text };
    const rest = text.slice(0, m.index) + '\n' + text.slice(m.index + m[0].length);
    return { body: m[2], rest };
}

const lbToBool = (v) => (v === true) || /^(true|1|yes|on|是|开|启用|常驻)$/i.test(String(v == null ? '' : v).trim());
export const toStringArray = (v) => (Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : String(v == null ? '' : v).split(/[,，、]/).map((x) => x.trim()).filter(Boolean));

// Whitelist of editable fields and their coercions. Values arrive as strings (from
// "key: value" header lines), so coercions are string-aware — a stray field the
// model invents can never write garbage into a book.
const LB_FIELD_COERCE = {
    content: (v) => String(v == null ? '' : v),
    comment: (v) => String(v == null ? '' : v),
    key: toStringArray,
    keysecondary: toStringArray,
    constant: lbToBool,
    disable: lbToBool,
    selective: lbToBool,
    excludeRecursion: lbToBool,
    preventRecursion: lbToBool,
    order: (v) => Number(String(v).trim()),
    position: (v) => Number(String(v).trim()),
    depth: (v) => Number(String(v).trim()),
};

const LB_SCALAR_KEYS = ['comment', 'key', 'keysecondary', 'constant', 'disable', 'selective', 'excludeRecursion', 'preventRecursion', 'order', 'position', 'depth'];

function applyFieldsToEntry(entry, fields) {
    if (!fields || typeof fields !== 'object') return;
    for (const [k, raw] of Object.entries(fields)) {
        if (!(k in LB_FIELD_COERCE)) continue;            // ignore unknown fields
        const val = LB_FIELD_COERCE[k](raw);
        if ((k === 'order' || k === 'position' || k === 'depth') && Number.isNaN(val)) continue;
        entry[k] = val;
    }
}

// Parse ONE <LorebookEdit> block's inner text into an op, or an error.
// Returns { op } or { error }.
function parseOneLorebookBlock(inner) {
    let text = String(inner || '');
    const cFence = extractFence(text, 'content'); text = cFence.rest;
    const rFence = extractFence(text, 'replace'); text = rFence.rest;

    const headers = {};
    // 多行 anchor：弱模型常把跨行的一段原文【整段照抄】进 anchor（而不用 start || end）。
    // 把 anchor: 之后紧跟的续行【一路吸收到下一个真正的「键: 值」header 行或文本结束】并入
    // anchor，好让 lbFuzzyReplace 拿到完整片段、整段命中，而不是只取首行（首行只换一半 =
    // 静默的部分替换）。
    // 【空行不终止 anchor 吸收】：真实事故——模型把「一段散文 + 空行 + 自主推进节点列表」整段
    // 塞进单个 anchor:；旧「空行即终止」规则只吸到首段散文 → 引擎命中首段、用整块新文替换、
    // 旧列表原样残留 = 重复内容却报 ✓（absorb 的初衷正是防这个，空行规则却重开了这个洞）。
    // 空行本身不并入 anchor（lbFuzzyRegex 的 SEP 吸收正文侧的换行 / 空行串，锚点跨空行照样命中）。
    // 【仅限 anchor】：真正的「键: 值」header 行仍终止吸收（绝不吞掉任何字段）；非 anchor 字段
    // 后面的自由文本仍按原样丢弃（空行照旧把 absorb 归零）。
    let absorb = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        const mm = line.match(/^([A-Za-z_]+)\s*[:：]\s*(.*)$/);
        if (mm) { headers[mm[1]] = mm[2]; absorb = (mm[1] === 'anchor') ? 'anchor' : null; continue; }
        if (!line) { if (absorb !== 'anchor') absorb = null; continue; }
        if (absorb) headers[absorb] += '\n' + line;
    }

    const action = (headers.action || '').trim().toLowerCase();
    const uidRaw = headers.uid != null ? String(headers.uid).trim() : '';
    const op = {
        action,
        book: (headers.book || '').trim(),
        uid: uidRaw !== '' ? parseInt(uidRaw, 10) : null,
        anchor: headers.anchor != null ? String(headers.anchor) : '',
        replace: rFence.body != null ? lbBackstopNewlines(rFence.body) : null,
        fields: {},
    };
    for (const k of LB_SCALAR_KEYS) {
        if (headers[k] == null) continue;
        const hv = String(headers[k]).trim();
        if (hv === '') continue;   // 空值＝该字段留空不改（既有行为：空 key 行被丢弃，绝不清空原键）
        // B3 保持原键哨兵：模型显式写 `key: 保持不变`（keysecondary 同）＝【有意不动】该字段（区别于"想清空"）→
        // 应用前整行丢弃，绝不把关键词整体替换成字面「保持不变」。省略这两行本就保持原键，此哨兵只兜底"写了却想留白"。
        if ((k === 'key' || k === 'keysecondary') && hv === '保持不变') continue;
        op.fields[k] = headers[k];
    }
    if (cFence.body != null) op.fields.content = lbBackstopNewlines(cFence.body);

    const ALLOWED = ['create', 'edit', 'patch', 'delete', 'prepend', 'append'];
    if (!ALLOWED.includes(action)) return { error: `未知或缺失的 action：「${(headers.action || '').trim()}」` };
    // book is resolved at apply time (against the books actually in scope), so a
    // mangled or omitted name no longer hard-fails here.
    if (action === 'create') {
        if (op.fields.content == null || !String(op.fields.content).trim()) return { error: 'create 缺少 content 正文' };
    } else if (op.uid == null || Number.isNaN(op.uid)) {
        return { error: `${action} 缺少有效的 uid` };
    }
    if (action === 'prepend' || action === 'append') {
        if (op.fields.content == null || !String(op.fields.content).trim()) return { error: `${action} 缺少要插入的 content 正文` };
    }
    if (action === 'edit') {
        const hasContent = op.fields.content != null;
        const hasScalar = LB_SCALAR_KEYS.some((k) => k in op.fields);
        if (!hasContent && !hasScalar) return { error: 'edit 没有任何要修改的字段' };
    }
    if (action === 'patch') {
        if (!op.anchor || !op.anchor.trim()) return { error: 'patch 缺少 anchor 锚点' };
        if (op.replace == null) return { error: 'patch 缺少 replace 区块' };
    }
    return { op };
}

// Parse every <LorebookEdit> block in a reply. Each block is independent: one bad
// block becomes an error entry, the rest still parse. Returns { ops, errors }.
export function parseLorebookBlocks(text) {
    const ops = [];
    const errors = [];
    const re = /<LorebookEdit>([\s\S]*?)<\/LorebookEdit>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const res = parseOneLorebookBlock(m[1]);
        if (res.op) ops.push(res.op);
        else errors.push({ error: res.error || '无法解析' });
    }
    return { ops, errors };
}

/* ---- patch anchor matching (fuzzy, tolerant of whitespace / tags / quote style) ---- */
function lbEscapeRegex(s) {
    let out = '';
    const special = '.*+?^${}()|[]\\';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (special.indexOf(ch) !== -1) out += '\\';
        out += ch;
    }
    return out;
}
function lbNormQuotes(s) {
    // 仅用于匹配（norm 副本 / 分词），替换永远回写原文——所以把 CJK 引号也归一进来是安全的：
    // 模型引用原句时经常换引号风格（「」↔“”↔"），字面比对会白白未命中（2026-07-05 加固轮）。
    return String(s).replace(/['"“”‘’`「」『』〝〞]/g, '"');
}
function lbFuzzyRegex(str) {
    // 分词也按标点切开：模型转述锚点时 、↔，、丢个句号之类的漂移很常见，让 SEP 把标点差异吸收掉。
    // 引号【不当分隔符】——只走 lbNormQuotes 归一：当分隔符会让匹配跨度停在配对引号之前，
    // 替换后正文里留下孤儿 」（守卫测试会红）。
    const normed = lbNormQuotes(str);
    const tokens = normed.trim().split(/[\s\-—_~*，。；：！？、,.;:!?…]+/).filter(Boolean).map(lbEscapeRegex);
    if (!tokens.length) return new RegExp('\\b\\B', 'i');   // 纯符号锚点（零 token）：永不命中（守卫，行为不变）
    // SEP 必须能吸收分词器切掉的每一种字符（split 类 ⊆ SEP 类）：分词按 — 切开锚点，正文里的 ——
    // 就得由 SEP 消化，否则锚点一跨中文破折号就永远未命中（1.19.x 评估轮 A 的真实补丁复现——
    // 逐字相同也匹配失败）。不对称就是那类 bug 的根源，改这几行前先跑 lb-fuzzy-replace 的守卫测试。
    const SEP = '(?:\\s|<[^>]+>|[*_~.,;:!?，。；：！？、—…-])*';
    // 边缘符号吸收（2026-08-03，GLM-5.2 逐字照抄整行 `- xxx。` → 补丁每次多出 `-`/`。。`）：分词把锚点
    // 【两端】的分隔符切掉，join 又不在两端补 glue，于是逐字照抄的首 `- `/尾 `。` 落在替换跨度【之外】
    // 而残留，replace 文本再供一遍 → 重复。故某端的边缘符号串若含非空白符，就在正则该端加一个「同符号
    // 可选吸收组」，把正文侧的【同类】符号（含中间空格/制表符）纳入跨度。铁律：绝不跨换行（WS 不含
    // CR/LF）；LEAD 至少含 1 个符号（不吃孤立空格），可吃末符号之后的空格；TRAIL 必以符号收尾（不吃尾部
    // 纯空白）；只吸收锚点该端真的写过的符号——异类符号即刹车（尾类只 `。` 时正文侧 ` - ` 原封不动）；
    // 无边缘符号时 LEAD/TRAIL 皆为空串，正则与旧版字节一致（安全钉：`红色斗篷` 决不吞相邻 `。`）。
    // edgeCls：边缘串里去重的【非空白】符号 → 正则字符类；无非空白符则 ''。char class 里唯一危险的 `-`
    // 单独转成 `\-`；其余分隔符只来自 split 集，lbEscapeRegex 的 `\.`/`\*`/`\?` 在字符类内亦合法。
    const edgeCls = (run) => {
        if (!run) return '';
        const uniq = [...new Set(run[0].split('').filter((c) => !/\s/.test(c)))];
        if (!uniq.length) return '';
        return '[' + uniq.map((c) => (c === '-' ? '\\-' : lbEscapeRegex(c))).join('') + ']';
    };
    const leadCls = edgeCls(normed.match(/^[\s\-—_~*，。；：！？、,.;:!?…]+/));
    const trailCls = edgeCls(normed.match(/[\s\-—_~*，。；：！？、,.;:!?…]+$/));
    const WS = '[^\\S\\r\\n]';   // 空白但排除 CR/LF——吸收绝不跨行
    const LEAD = leadCls ? `(?:(?:${leadCls}|${WS})*${leadCls}${WS}*)?` : '';
    const TRAIL = trailCls ? `(?:(?:${trailCls}|${WS})*${trailCls})?` : '';
    return new RegExp(LEAD + tokens.join(SEP) + TRAIL, 'i');
}
// Replace the span identified by a "start || end" anchor (or a single anchor) with
// `replace`. Quote-normalize a same-length copy for matching so indices map back to
// the original. Returns { result, matched }.
// 加性返回（F2）：命中时【额外】带上 spanStart / spanEnd（被替换片段在【原文】content 里的字符区间，
// 供 apply 层算「替换 X 字 → Y 字」）与 multi（同一锚点在命中之后还能再命中一次＝定位不唯一，供多命中
// 守卫）。这些字段【只在 matched:true 时出现】——未命中仍回 { result, matched:false } 原样两字段，
// 既有调用方（applyDraftPatchOps / 工坊 / lb-fuzzy-replace 守卫测试的 deepEqual）字节不变。
export function fuzzyReplace(content, anchor, replace) {
    const src = String(content == null ? '' : content);
    const norm = lbNormQuotes(src);              // 1:1 char map -> indices align with src
    const a = String(anchor == null ? '' : anchor);
    const repl = String(replace == null ? '' : replace);

    let sep = a.indexOf(' || '); let sl = 4;
    if (sep === -1) { sep = a.indexOf('||'); sl = 2; }
    if (sep === -1) { sep = a.indexOf('...'); sl = 3; }

    try {
        if (sep > 0 && a.length - sep - sl > 0) {
            const startA = a.slice(0, sep).trim();
            const endA = a.slice(sep + sl).trim();
            if (startA && endA) {
                const sM = norm.match(lbFuzzyRegex(startA));
                if (!sM) return { result: src, matched: false };
                const afterIdx = sM.index + sM[0].length;
                // Primary: the end segment lies strictly AFTER the start match (a normal
                // disjoint span). Fallback: models frequently write a degenerate or
                // overlapping span — start === end ("桜丘也不例外 || 桜丘也不例外"), end a
                // suffix of start ("…入读桜丘 || 入读桜丘"), or a shared run between the two
                // ("特待生身份入读 || 入读桜丘"). The strict search can never find such an end
                // (its chars were already consumed by the start match) → 锚点未找到. So
                // re-search the end from the START of the start match, then clamp the span
                // to cover at least the start anchor (never shorter than start matched).
                let eM = norm.slice(afterIdx).match(lbFuzzyRegex(endA));
                let end;
                if (eM) {
                    end = afterIdx + eM.index + eM[0].length;
                } else {
                    eM = norm.slice(sM.index).match(lbFuzzyRegex(endA));
                    if (!eM) return { result: src, matched: false };
                    end = Math.max(afterIdx, sM.index + eM.index + eM[0].length);
                }
                // 区间锚点的多命中＝【起始】锚点在被替换片段之后还能再命中（终点段照旧只锚一次）。
                const multi = lbFuzzyRegex(startA).test(norm.slice(end));
                return { result: src.slice(0, sM.index) + repl + src.slice(end), matched: true, spanStart: sM.index, spanEnd: end, multi };
            }
        }
        const m = norm.match(lbFuzzyRegex(a));
        if (m) {
            const spanStart = m.index;
            const spanEnd = m.index + m[0].length;
            // 单锚点的多命中＝同一锚点在首个命中【之后】仍能再命中一次（非全局正则、每次新建，无 lastIndex 副作用）。
            const multi = lbFuzzyRegex(a).test(norm.slice(spanEnd));
            return { result: src.slice(0, spanStart) + repl + src.slice(spanEnd), matched: true, spanStart, spanEnd, multi };
        }
    } catch (e) {
        console.warn('[剧情推进] patch anchor match failed:', e);
    }
    return { result: src, matched: false };
}

// F3b「已完成」探测（纯函数、可单测）：patch 报「锚点未找到」时，判断它的 replace 文本是不是【已经】
// 躺在条目正文里（多半是先前一版补丁已经改好了这处，模型只是拿着过期原文在瞎猜锚点、反复重试）。
// 归一：两侧都过 lbNormQuotes（引号风格无关）+ 把所有空白串压成单空格 + trim，再做子串包含判定。
// 地板：归一后的 replace 长度 < 20 字不判（太短的片段到处都是，避免误报把该改的当成已改）。
function lbReplaceAlreadyPresent(content, replace) {
    const norm = (t) => lbNormQuotes(String(t == null ? '' : t)).replace(/\s+/g, ' ').trim();
    const r = norm(replace);
    if (r.length < 20) return false;
    return norm(content).indexOf(r) !== -1;
}

// F3c 应用结果单行格式化（纯函数、可单测）：UI 逐条结果 + 快照〔上次应用结果〕共用这一份，绝不各写一份。
// 形状 = applyLorebookOps 产出的 result（或其压缩快照 op）：{ ok, label, reason?, chars? }。
// ✓ 带 chars → 附「· 替换 X 字 → Y 字」（原片段长 → 替换文本长）；⤫ → 「跳过：<原因>」。
export function lbFormatApplyLine(r) {
    if (!r) return '';
    if (r.ok) {
        const c = r.chars;
        const size = (c && Number.isFinite(c.from) && Number.isFinite(c.to)) ? `· 替换 ${c.from} 字 → ${c.to} 字` : '';
        return `✓ ${r.label || ''}${size}`;
    }
    return `⤫ ${r.label || ''} 跳过：${r.reason || ''}`;
}

function lbOpLabel(op) {
    if (!op) return '(无效操作)';
    const a = ({ create: '新增', edit: '改', patch: '补丁', delete: '删除', prepend: '前插', append: '追加' })[op.action] || op.action || '?';
    if (op.action === 'create') return `${a}「${(op.fields && op.fields.comment) || '(无标题)'}」`;
    return `${a} uid=${op.uid}`;
}
export function lbSummaryOf(list) {
    const c = { create: 0, edit: 0, patch: 0, delete: 0, prepend: 0, append: 0 };
    for (const x of list) if (x && x.action in c) c[x.action]++;
    const bits = [];
    if (c.create) bits.push(`新增 ${c.create}`);
    if (c.edit) bits.push(`改 ${c.edit}`);
    if (c.patch) bits.push(`补丁 ${c.patch}`);
    if (c.prepend) bits.push(`前插 ${c.prepend}`);
    if (c.append) bits.push(`追加 ${c.append}`);
    if (c.delete) bits.push(`删除 ${c.delete}`);
    return bits.join(' · ') || '无改动';
}

/**
 * Apply parsed ops to the books, grouped by book. Each touched book is re-loaded
 * FRESH, deep-cloned for undo, mutated, then saved immediately. Per-op outcomes are
 * collected for the UI; an op never half-applies (patch validates its anchor first).
 * Returns { snapshots, results, summary, applied }.
 */
// Models often retype a book name imperfectly when it contains brackets/quotes
// (《》「」【】<> …) — dropping them, or a stray letter. Normalize away the bits
// models tend to mangle so we can still recognise the intended book.
function lbNormalizeName(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/[\s《》「」『』【】〈〉«»()（）\[\]<>{}"'“”‘’`·・|/\\]/g, '');
}

// Resolve op.book to one of the books actually in scope (lbBookNames). Exact match
// first, then bracket/quote-insensitive match, then loose containment, and finally
// — since the picker usually targets a single book — fall back to the only book in
// scope. Returns the real name, or null if it genuinely can't be pinned down.
export function resolveBookName(opBook, scope) {
    if (!Array.isArray(scope) || !scope.length) return null;
    const raw = (opBook == null ? '' : String(opBook)).trim();
    if (scope.includes(raw)) return raw;                       // exact
    const nb = lbNormalizeName(raw);
    if (nb) {
        const exactNorm = scope.filter((n) => lbNormalizeName(n) === nb);
        if (exactNorm.length === 1) return exactNorm[0];
        const loose = scope.filter((n) => {
            const nn = lbNormalizeName(n);
            return nn && (nn.includes(nb) || nb.includes(nn));
        });
        if (loose.length === 1) return loose[0];
    }
    if (scope.length === 1) return scope[0];                   // only one book shown → it must be that one
    return null;
}

// 纯函数：把 op 目标解析到【本次范围内已加载的某本书】。先按书名（resolveBookName）；uid 不在该书时，
// 跨范围找持有该 uid 的书——恰好一本持有 → 改锚到它（B5 auto-retarget，附提示）。dry-run 预检与真应用共用，
// 保证「预检落点」＝「实际落点」。booksMap: { [realName]: data(含 .entries) }；scope: 范围内书名数组。
// 命中 → { book, note }；未定位 → { book:null, reason }。create 不走这里（无 uid）。可单测。
function lbResolveOpTarget(op, booksMap, scope) {
    const scopeArr = Array.isArray(scope) ? scope : Object.keys(booksMap || {});
    const named = resolveBookName(op.book, scopeArr);
    const uid = op.uid;
    const hasUid = (n) => { const d = booksMap[n]; return !!(d && d.entries && uid != null && (uid in d.entries)); };
    if (named && hasUid(named)) return { book: named, note: '' };
    const holders = scopeArr.filter(hasUid);
    if (holders.length === 1) {
        const book = holders[0];
        return { book, note: (book !== named) ? `已改锚到《${book}》` : '' };
    }
    if (named) {
        if (!booksMap[named]) return { book: null, reason: `无法读取世界书「${named}」` };
        return { book: null, reason: `uid=${uid} 不存在` };
    }
    return { book: null, reason: op.book ? `世界书「${op.book}」不在本次范围内` : '未指定世界书，且无法自动判定' };
}

// 纯函数（可单测）：判定单个 op 会怎样落地——【dry-run 预检】与【真应用】共用的【唯一】判定源，绝不各写一份。
// 覆盖：解析目标书 + uid（含跨书改锚）、存在性校验、patch 现场【只读】试跑锚点（多命中守卫 / 幽灵锚点探测 /
// 尺寸回声）、create 同名转编辑（B4）、无键自动常驻 + 显式暗条目警告（B6）、改动常驻条目警告（T2-lite）。
// booksMap: { [realName]: data(含 .entries) }，本次范围内已加载的书（真应用传【进行中被就地改的】工作副本，
//   故顺序补丁能看到前序结果；dry-run 传只读副本、并把已判定通过的正文改动落到内存里同样喂给后续 op）。
// 返回（lbFormatApplyLine 兼容 + 落地所需字段）：
//   { ok, action, label, reason?, chars?, note?, warn?, book?, uid?, kind?, patchResult?, setConstant? }
// kind = 落地时真正要执行的操作（create 折叠成 edit 时 kind='edit'、action 仍是原始 'create'）。
// opts.noCollapse=true 关掉 B4 create→edit 折叠（工坊写入走此，保持其写入行为字节不变；世界书📖模式默认开）。
function lbOpVerdict(op, booksMap, scope, opts) {
    if (!op || !op.action) return { ok: false, action: op && op.action, label: lbOpLabel(op), reason: '操作不完整' };
    const action = op.action;
    const collapseCreate = !(opts && opts.noCollapse);
    const fail = (reason, extra) => Object.assign({ ok: false, action, label: lbOpLabel(op), reason }, extra || {});
    const constWarnText = '目标为常驻条目（通常是用户核心设定），请确认后再应用';

    if (action === 'create') {
        const scopeArr = Array.isArray(scope) ? scope : Object.keys(booksMap || {});
        const named = resolveBookName(op.book, scopeArr);
        if (!named) return fail(op.book ? `世界书「${op.book}」不在本次范围内` : '未指定世界书，且无法自动判定');
        const data = booksMap[named];
        if (!data || !data.entries) return fail(`无法读取世界书「${named}」`);
        const comment = String((op.fields && op.fields.comment) || '').trim();
        // B4 同名转编辑（精确同标题、trim 归一、不模糊）：目标书已有同名条目 → 转成对该 uid 的 edit，避免建重复条目。
        if (collapseCreate && comment) {
            for (const [uidKey, e] of Object.entries(data.entries)) {
                if (e && String(e.comment || '').trim() === comment) {
                    const uid = e.uid != null ? e.uid : Number(uidKey);
                    const cm = String(e.comment || '').trim();
                    return { ok: true, action, kind: 'edit', book: named, uid,
                        label: `改 uid=${uid}${cm ? `「${cm}」` : ''}`,
                        note: `同名条目已存在，已转为编辑 uid=${uid}`,
                        warn: e.constant ? constWarnText : '' };
                }
            }
        }
        // B6 无键条目：没给 key 且没显式写 constant → 自动常驻（否则永不注入）；显式 constant:false + 无键 → 暗条目警告（尊重但示警）。
        const hasKey = !!(op.fields && op.fields.key != null && toStringArray(op.fields.key).length > 0);
        const constantExplicit = !!(op.fields && ('constant' in op.fields));
        const constantVal = constantExplicit ? lbToBool(op.fields.constant) : undefined;
        let note = '';
        let warn = '';
        let setConstant = false;
        if (!hasKey) {
            if (!constantExplicit) { setConstant = true; note = '无触发键，已自动设为常驻（否则该条目永不注入）'; }
            else if (constantVal === false) { warn = '该条目无触发键且被设为非常驻，将永不注入（暗条目）'; }
        }
        return { ok: true, action, kind: 'create', book: named,
            label: `新增「${comment || '(无标题)'}」`, note, warn, setConstant };
    }

    // uid 类操作：edit / patch / delete / prepend / append —— 统一先解析目标书（含跨书改锚）
    const tgt = lbResolveOpTarget(op, booksMap, scope);
    if (!tgt.book) return fail(tgt.reason);
    const data = booksMap[tgt.book];
    const uid = op.uid;
    const entry = data.entries[uid];
    const cm = String((entry && entry.comment) || '').trim();
    const retargetNote = tgt.note || '';
    const constWarn = (entry && entry.constant) ? constWarnText : '';   // T2-lite：改动常驻条目示警（不禁用、只提醒）

    if (action === 'delete') {
        return { ok: true, action, kind: 'delete', book: tgt.book, uid,
            label: `删除 uid=${uid}${cm ? `「${cm}」` : ''}`, note: retargetNote, warn: constWarn };
    }
    if (action === 'prepend' || action === 'append') {
        const insert = (op.fields && op.fields.content != null) ? String(op.fields.content) : '';
        if (!insert) return fail(`${action} 没有要插入的正文`, { note: retargetNote });
        const a = action === 'prepend' ? '前插' : '追加';
        return { ok: true, action, kind: action, book: tgt.book, uid,
            label: `${a} uid=${uid}${cm ? `「${cm}」` : ''}`, note: retargetNote, warn: constWarn };
    }
    if (action === 'patch') {
        const { result, matched, spanStart, spanEnd, multi } = fuzzyReplace(entry.content || '', op.anchor, op.replace);
        // F3a 多命中守卫：锚点在正文里不止一处命中 → 不知道该改哪一处，宁可不动、请模型换更独特的锚点。
        if (matched && multi) return fail('锚点在条目中命中多处，请改用更长或 start || end 更独特的锚点', { note: retargetNote });
        if (!matched) {
            // F3b 幽灵锚点：锚点未找到，但 replace 文本已在条目里（多半先前补丁已改好）→ 明说无需重试。
            if (lbReplaceAlreadyPresent(entry.content || '', op.replace))
                return fail('锚点未找到——但替换文本已在条目中（可能已由先前补丁完成，无需重试）', { note: retargetNote });
            return fail(`锚点未找到：「${String(op.anchor || '').slice(0, 40)}」`, { note: retargetNote });
        }
        // F3c 尺寸回声：原片段长（spanEnd-spanStart）→ 替换文本长。patchResult 供落地方直接写回（预检＝应用同一结果）。
        const chars = { from: (spanEnd - spanStart), to: String(op.replace == null ? '' : op.replace).length };
        return { ok: true, action, kind: 'patch', book: tgt.book, uid,
            label: `补丁 uid=${uid}${cm ? `「${cm}」` : ''}`, chars, patchResult: result,
            note: retargetNote, warn: constWarn };
    }
    // edit（整条 / 元信息）
    return { ok: true, action, kind: 'edit', book: tgt.book, uid,
        label: `改 uid=${uid}${cm ? `「${cm}」` : ''}`, note: retargetNote, warn: constWarn };
}

// 纯函数（可单测）：把 lbOpVerdict 判定压成一条预检行模型，供 DOM 薄接线渲染。line 复用 lbFormatApplyLine
// （✓/⤫ 与应用结果同款）；note = 信息附注（改锚 / 同名转编辑 / 自动常驻）；warn = 警示附注（暗条目 / 常驻目标）。
// cls：通过=pad-lb-ok（带 warn 时 pad-lb-warn）、未通过=pad-lb-skip（灰）。
export function lbVerdictRow(v) {
    if (!v) return { ok: false, cls: 'pad-lb-skip', line: '', note: '', warn: '' };
    return {
        ok: !!v.ok,
        cls: v.ok ? (v.warn ? 'pad-lb-warn' : 'pad-lb-ok') : 'pad-lb-skip',
        line: lbFormatApplyLine({ ok: v.ok, label: v.label, reason: v.reason, chars: v.chars }),
        note: v.note || '',
        warn: v.warn || '',
    };
}

// 应用改动：一次性加载范围内所有书（跨书改锚需要跨书可见性），逐 op 用 lbOpVerdict 判定后就地落地，
// 只保存真被改过的书，pristine 深克隆留作撤销快照。判定逻辑不在此复述——只此一份、由 lbOpVerdict 提供。
// 返回 { snapshots, results, summary, applied }（形状与旧版一致；ok 结果附 note/warn，供 UI 二级行，
// 快照压缩器 compactLbApplyResults / 单行格式化器 lbFormatApplyLine 都会忽略它们，字节兼容）。
export async function applyLorebookOps(ops, opts) {
    const mod = await getWiEditApi();
    if (!mod) throw new Error('世界书模块不可用');

    const scope = Array.isArray(opts?.scope) ? opts.scope.slice() : (Array.isArray(lbBookNames) ? lbBookNames.slice() : []);
    const booksMap = {};        // 工作副本（会被就地修改）
    const pristine = {};        // 撤销快照（改动前深克隆）
    for (const name of scope) {
        let data = null;
        try { data = await mod.loadWorldInfo(name); } catch (e) { data = null; }
        if (data && data.entries) { booksMap[name] = data; pristine[name] = structuredClone(data); }
    }

    const results = [];
    const touched = new Set();
    for (const op of ops) {
        const v = lbOpVerdict(op, booksMap, scope, opts);
        if (!v.ok) { results.push({ ok: false, action: v.action, label: v.label, reason: v.reason }); continue; }
        const data = booksMap[v.book];
        if (v.kind === 'create') {
            let entry;
            if (typeof mod.createWorldInfoEntry === 'function') entry = mod.createWorldInfoEntry(v.book, data);
            if (!entry) { results.push({ ok: false, action: 'create', label: lbOpLabel(op), reason: '无法新建条目' }); continue; }
            entry.excludeRecursion = true;          // house defaults (overridable by fields)
            entry.preventRecursion = true;
            applyFieldsToEntry(entry, op.fields);
            if (v.setConstant) entry.constant = true;   // B6 无键自动常驻（判定在 lbOpVerdict）
            results.push({ ok: true, action: 'create', label: `新增「${entry.comment || '(无标题)'}」(uid=${entry.uid})`, note: v.note, warn: v.warn });
            touched.add(v.book);
        } else if (v.kind === 'delete') {
            if (typeof mod.deleteWorldInfoEntry === 'function') await mod.deleteWorldInfoEntry(data, v.uid, { silent: true });
            else delete data.entries[v.uid];
            results.push({ ok: true, action: 'delete', label: v.label, note: v.note, warn: v.warn });
            touched.add(v.book);
        } else if (v.kind === 'patch') {
            const entry = data.entries[v.uid];
            entry.content = v.patchResult;          // lbOpVerdict 已算好（预检＝应用同一 lbFuzzyReplace 结果）
            applyFieldsToEntry(entry, op.fields);   // optional scalar tweaks alongside
            results.push({ ok: true, action: 'patch', label: v.label, chars: v.chars, note: v.note, warn: v.warn });
            touched.add(v.book);
        } else if (v.kind === 'prepend' || v.kind === 'append') {
            const entry = data.entries[v.uid];
            const insert = op.fields.content != null ? String(op.fields.content) : '';
            const cur = entry.content || '';
            entry.content = v.kind === 'prepend' ? insert + cur : cur + insert;   // verbatim concat, no auto separator
            const rest = { ...op.fields }; delete rest.content;   // don't let content overwrite via applyFieldsToEntry
            applyFieldsToEntry(entry, rest);                      // optional scalar tweaks alongside
            results.push({ ok: true, action: v.kind, label: v.label, note: v.note, warn: v.warn });
            touched.add(v.book);
        } else { // edit（含 B4 create→edit 折叠）
            applyFieldsToEntry(data.entries[v.uid], op.fields);
            results.push({ ok: true, action: 'edit', label: v.label, note: v.note, warn: v.warn });
            touched.add(v.book);
        }
    }

    const snapshots = [];
    for (const name of touched) {
        snapshots.push({ name, data: pristine[name] });
        await mod.saveWorldInfo(name, booksMap[name], /*immediately*/ true);
        try { if (typeof mod.reloadEditor === 'function') mod.reloadEditor(name); } catch (e) { /* editor not open */ }
    }

    const okResults = results.filter((r) => r.ok);
    return { snapshots, results, summary: lbSummaryOf(okResults), applied: okResults.length };
}

export async function undoLorebookOps(snapshots) {
    const mod = await getWiEditApi();
    if (!mod) throw new Error('世界书模块不可用');
    for (const snap of snapshots) {
        await mod.saveWorldInfo(snap.name, snap.data, /*immediately*/ true);
        try { if (typeof mod.reloadEditor === 'function') mod.reloadEditor(snap.name); } catch (e) { /* ignore */ }
    }
}

// B5 应用前预检（dry-run）：严格【只读】地跑一遍判定，供 UI 在【点应用前】逐条显示每个 op 会怎样落地。
// 加载书、绝不 save、绝不动真条目；把已判定通过的【正文类】改动落到内存副本，让后续补丁看到前序结果
// （与真应用同序、同一个 lbOpVerdict，但不落盘）。返回 verdict 数组（与 ops 同序）；模块不可用 → null。
// 应用时仍以【当时的真书】重新判定为准（书可能在渲染到点击之间被改），本预检只是提前、可修正的提示。
export async function lbDryRunOps(ops) {
    const mod = await getWiEditApi();
    if (!mod) return null;
    const scope = Array.isArray(lbBookNames) ? lbBookNames.slice() : [];
    const booksMap = {};
    for (const name of scope) {
        try { const d = await mod.loadWorldInfo(name); if (d && d.entries) booksMap[name] = d; } catch (e) { /* 读不到的书跳过 */ }
    }
    const verdicts = [];
    for (const op of (ops || [])) {
        const v = lbOpVerdict(op, booksMap, scope);
        verdicts.push(v);
        // 顺序可见性：把通过的正文类改动落到内存副本（绝不 save），让同条目的后续补丁按真实前序命中。
        if (v.ok && v.book && booksMap[v.book] && booksMap[v.book].entries) {
            const data = booksMap[v.book];
            if (v.kind === 'patch' && (v.uid in data.entries)) {
                data.entries[v.uid].content = v.patchResult;
            } else if ((v.kind === 'prepend' || v.kind === 'append') && (v.uid in data.entries)) {
                const insert = (op.fields && op.fields.content != null) ? String(op.fields.content) : '';
                const cur = data.entries[v.uid].content || '';
                data.entries[v.uid].content = v.kind === 'prepend' ? insert + cur : cur + insert;
            } else if (v.kind === 'edit' && (v.uid in data.entries)) {
                applyFieldsToEntry(data.entries[v.uid], op.fields);
            } else if (v.kind === 'delete' && (v.uid in data.entries)) {
                delete data.entries[v.uid];
            }
            // kind==='create'：预检不真建条目（避免任何 mod 副作用；后续 op 不可能引用未知新 uid）
        }
    }
    return verdicts;
}
