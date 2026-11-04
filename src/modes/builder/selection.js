export let bldEntryFilter = {};

export function hydrateBuilderEntrySelection(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [book, uids] of Object.entries(saved)) {
        if (Array.isArray(uids)) bldEntryFilter[book] = new Set(uids);
    }
}

export function selectBuilderEntries(book, selection) {
    bldEntryFilter[book] = selection;
}

export function selectBuilderEntry(book, uid, checked, allUids) {
    let selected = bldEntryFilter[book];
    if (!(selected instanceof Set)) selected = new Set(allUids);
    if (checked) selected.add(uid); else selected.delete(uid);
    bldEntryFilter[book] = selected;
}

export function pruneBuilderEntrySelection(book, validUids) {
    const selected = bldEntryFilter[book];
    if (!(selected instanceof Set)) return false;
    const valid = new Set(validUids);
    const kept = new Set([...selected].filter((uid) => valid.has(uid)));
    if (kept.size === selected.size) return false;
    bldEntryFilter[book] = kept;
    return true;
}
/* ---- 🎭 角色工坊喂料口径（1.82.0）——纯函数层 -------------------------------
 * 用户报障：工坊「突然开始读取被禁用的世界书条目导致 token 爆炸」。属实——buildBuilderContext
 * 把目标书的每一条条目原样投喂（lbFormatEntry 对禁用条目照印，只多一行「- 类型：已禁用」），
 * 唯一的收窄是选条目器的 per-book Set，而「从没在选条目器里动过手」= 缺键 / null = 整本发送。
 * 1.82.0 起 **工坊这一路**（仅此一路）的 null 语义改成「该书当前【启用】的全部条目」：
 *   · 缺键 / null = 跟随启用状态（新增条目自动进、ST 里禁掉的自动出）
 *   · 显式 Set    = 恰好这些 uid，禁用也发（用户可能就是要喂一条禁用的「角色生成规则」——
 *                   与诊断选条目器同一理据）
 * 世界书模式（buildLorebookContext）与诊断精选的口径【一个字都不动】：那边有意投喂禁用条目。
 * 不变式：勾选框显示的就是发出去的（WYSIWYG）——选择规则、渲染勾选态、折叠判据必须共用这层。 */

// 一本书这一趟真正投喂哪些条目。sel = bldEntryFilter[书名]（Set = 显式选择 / null 缺席 = 全部启用的）。
export function bldPickFedEntries(entries, sel) {
    const list = Array.isArray(entries) ? entries : [];
    if (sel instanceof Set) return list.filter((e) => e && sel.has(e.uid));
    return list.filter((e) => e && !e.disable);
}

// 显式 Set 能不能折回 null（＝「全部启用的」）。判据是【恰好等于启用集】：多一条禁用的不折
// （那是用户特意加的），少一条启用的更不折（那是真筛选）。旧规则 `sel.size >= 全部行数` 只有在
// 「全选」时才成立，于是把「含禁用的全集」当成了整本——正是本次 bug 的放大器。
export function bldSelCollapses(sel, enabledUids) {
    if (!(sel instanceof Set)) return false;
    const src = (enabledUids && typeof enabledUids[Symbol.iterator] === 'function') ? enabledUids : [];
    const en = new Set(src);
    if (sel.size !== en.size) return false;
    for (const u of en) if (!sel.has(u)) return false;
    return true;
}

// 工坊汇总行的体积求和。rows = [{book, uid, tok, enabled}]（DOM 层负责映射）。与 sumLbSelectedTokens
// 同形，差别只在 null 分支：世界书模式整本全算，工坊只算启用的——读数必须与真发送量对得上。
export function sumBldSelectedTokens(rows, filter) {
    if (!Array.isArray(rows)) return 0;
    const f = filter || {};
    let sum = 0;
    for (const r of rows) {
        if (!r) continue;
        const sel = f[r.book || ''];
        if (sel instanceof Set ? !sel.has(r.uid) : !r.enabled) continue;
        sum += Number(r.tok) || 0;
    }
    return sum;
}

// 汇总行的计数段文案。selected 在 null 态下是【启用条数】、total 恒是渲染出的行数——
// 两数不等时明说「全部启用的」，免得用户按行数估体积。
export function bldEntriesCountText(total, selected, anyFiltered) {
    if (anyFiltered) return `条目：已选 ${selected} / ${total}`;
    if (!total) return '条目：全部发送';
    if (selected >= total) return `条目：全部（${total}）`;
    return `条目：全部启用的（${selected} / ${total}）`;
}
