import { soCallModel } from '../../bootstrap.js';
import { getSettings, save } from '../../core/settings.js';
import { sharedState } from '../../core/state.js';
import { addSystemNote } from '../advisor/cards.js';
import { BUILDER_VARIANTS, LB_SMART_MAX_ROUNDS, bldEntriesCountText, bldSelCollapses, bookNameMatchesQuery, buildLbCatalog, buildSmartSelectMessages, builderSelectedSections, builderVariantKey, builderVisibleSections, formatLbFetchResult, formatLbSearchResult, formatLbSizeEstimate, getActiveBookNames, getAllBookNames, getWiEditApi, lbEngineFetch, lbEngineSearch, lbEntryTokenCost, lbResolveSelectPlan, lbSizeIsHuge, lbSmartNextStep, parseLbFetchBlocks, parseLbSearchBlocks, parseLbSelectBlocks, resolveLbTargetNames, sumBldSelectedTokens, sumLbSelectedTokens } from './core.js';
import { ENABLE_LB_SMART_SELECT } from '../../prompts/builtins.js';

// Fill the book checklist: every known book as a checkbox (active ones marked ★).
/* ==== 角色工坊选书 / 选条目器（Task 4）====
 * 与世界书选条目器同构（★ 激活标记、失效 uid 剪除、Set/null 物化语义完全一致），只是
 * 用设置键 bldBooks、内存镜像 bldEntryFilter、`#so-bld-*` 元素 id，并去掉蓝 / 绿灯快捷键与
 * 内容预览开关（本模式只有 全选 / 全不选 + 文本筛选）。绝不改动任何 lb* 函数。 */

// chips：把 BUILDER_SECTIONS 渲染成一排可点亮的部分标签；点一下翻转选择、持久化、重画。
export function renderBuilderChips() {
    const wrap = sharedState.win?.querySelector('#so-bld-chips');
    if (!wrap) return;
    const s = getSettings();
    const v = BUILDER_VARIANTS[builderVariantKey(s)];
    const selected = new Set(builderSelectedSections(s).map((x) => x.id));
    wrap.innerHTML = '';
    let advTagShown = false;
    for (const sec of builderVisibleSections(v.sections)) {
        // 进阶三件（adv）前挂一条「简单/喜剧角色留空」标签——flex-basis:100% 另起一行，把进阶件视觉分组。
        if (sec.adv && !advTagShown) {
            const tag = document.createElement('span');
            tag.className = 'so-bld-chips-advtag';
            tag.textContent = '简单 / 喜剧调剂角色留空 ▸';
            wrap.appendChild(tag);
            advTagShown = true;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-bld-chip' + (sec.adv ? ' adv' : '') + (selected.has(sec.id) ? ' on' : '');
        b.textContent = sec.label;
        if (sec.desc) b.title = sec.desc;   // 桌面悬停说明；移动端走 ? 图例（toggleBuilderChipsLegend）
        b.addEventListener('click', () => {
            const s2 = getSettings();
            const v2 = BUILDER_VARIANTS[builderVariantKey(s2)];
            const cur = new Set(builderSelectedSections(s2).map((x) => x.id));
            if (cur.has(sec.id)) cur.delete(sec.id); else cur.add(sec.id);
            s2[v2.sectionsKey] = v2.sections.map((x) => x.id).filter((id) => cur.has(id));   // 写各变体自己的键（互不干扰）
            save();
            renderBuilderChips();
        });
        wrap.appendChild(b);
    }
}

// 章节图例：移动端没有 hover，「?」点开一份 label——desc 对照表（桌面也可用）。内容首次展开时才填。
export function toggleBuilderChipsLegend() {
    const box = sharedState.win?.querySelector('#so-bld-chips-legend');
    if (!box) return;
    if (box.style.display === 'none') {
        // 每次展开按当前变体重建（不同变体 chip 集不同——不能只填一次）。
        box.innerHTML = '';
        const v = BUILDER_VARIANTS[builderVariantKey(getSettings())];
        const advSecs = builderVisibleSections(v.sections).filter((x) => x.adv);
        if (advSecs.length) {
            // #2：进阶三件（adv）默认关——顶部给一条归组指引（persona 变体无 adv 件，这条自然不出现）。
            const advLabels = advSecs.map((x) => x.label).join(' / ');
            const guide = document.createElement('div');
            guide.className = 'so-bld-legend-guide';
            guide.textContent = `〔进阶三件〕${advLabels} 默认关——勾给有内在层次的角色（非喜剧调剂、非纯功能型）。简单直给的角色，一盘清爽的调色盘就够了；勾了进阶件，模型会照做、硬造出它本没有的复杂。`;
            box.appendChild(guide);
        }
        for (const sec of builderVisibleSections(v.sections)) {
            const row = document.createElement('div');
            row.className = 'so-bld-legend-row';
            row.innerHTML = `<b>${sec.label}</b>——${sec.desc || ''}`;
            box.appendChild(row);
        }
        box.style.display = '';
    } else {
        box.style.display = 'none';
    }
}

export async function populateBuilderBooks(announce) {
    renderBuilderChips();   // 每次进模式 / 刷新时也把 chips 对齐到当前设置
    // T12：本会话首次进入时，把 bldEntrySel 设置水合进内存镜像（书本身已由 bldBooks 持久化）。
    if (!sharedState.bldSelHydrated) {
        const saved = getSettings().bldEntrySel;
        if (saved && typeof saved === 'object') {
            for (const [book, arr] of Object.entries(saved)) {
                if (Array.isArray(arr)) sharedState.bldEntryFilter[book] = new Set(arr);
            }
        }
        sharedState.bldSelHydrated = true;
    }
    const listEl = sharedState.win.querySelector('#so-bld-book-list');
    if (!listEl) return;
    const s = getSettings();
    let active = [];
    let all = [];
    try {
        [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    } catch (e) { /* leave empty */ }

    // Prune selections that no longer exist on disk.
    if (Array.isArray(s.bldBooks) && s.bldBooks.length) {
        const allSet = new Set(all);
        const kept = s.bldBooks.filter((n) => allSet.has(n));
        if (kept.length !== s.bldBooks.length) { s.bldBooks = kept; save(); }
    }

    const chosen = new Set(Array.isArray(s.bldBooks) ? s.bldBooks : []);
    const activeSet = new Set(active);
    listEl.innerHTML = '';
    if (!all.length) {
        listEl.innerHTML = '<div class="so-lb-ent-empty">（没有找到任何世界书。）</div>';
    } else {
        for (const name of all) {
            const row = document.createElement('label');
            row.className = 'so-lb-book-opt';
            row.dataset.book = name;
            const star = activeSet.has(name) ? '★ ' : '';
            row.innerHTML = `<input type="checkbox"${chosen.has(name) ? ' checked' : ''}><span class="so-lb-book-name"></span>`;
            row.querySelector('.so-lb-book-name').textContent = star + name;
            listEl.appendChild(row);
        }
    }
    const bf = sharedState.win.querySelector('#so-bld-book-filter');
    if (bf && bf.value) filterBldBooks(bf.value);
    updateBldBookSummary();
    populateBuilderEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

// 选书器 <summary> 文案："世界书：当前激活的" 或 "世界书：已选 N 本"。
// 旧文案「全部激活」会被读成「选中全部世界书」（用户误读，Prince 转达，1.19.2）——语义其实是
// 「跟随当前激活的那些」，措辞改为 当前激活的。
function updateBldBookSummary() {
    const sum = sharedState.win.querySelector('#so-bld-bookpick-sum');
    if (!sum) return;
    const t = getSettings().bldBooks;
    sum.textContent = (Array.isArray(t) && t.length) ? `世界书：已选 ${t.length} 本` : '世界书：当前激活的';
}

// 从勾选的行重算 bldBooks；刷新依赖 UI（同 onLbBookSelectionChange）。
export function onBldBookSelectionChange() {
    const s = getSettings();
    const picked = [];
    for (const box of sharedState.win.querySelectorAll('#so-bld-book-list input[type="checkbox"]')) {
        if (box.checked) {
            const row = box.closest('.so-lb-book-opt');
            if (row && row.dataset.book) picked.push(row.dataset.book);
        }
    }
    s.bldBooks = picked;
    save();
    updateBldBookSummary();
    populateBuilderEntries();
}

// 角色工坊选书器的书名搜索（同 filterLbBooks，纯可见性，绝不改选择）。
export function filterBldBooks(q) {
    const list = sharedState.win.querySelector('#so-bld-book-list');
    if (!list) return;
    let anyRow = false, anyVisible = false;
    for (const row of list.querySelectorAll('.so-lb-book-opt')) {
        anyRow = true;
        const show = bookNameMatchesQuery(row.dataset.book, q);
        row.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
    }
    const empty = sharedState.win.querySelector('#so-bld-book-empty');
    if (empty) empty.hidden = !(anyRow && !anyVisible);
}

// 某本书当前渲染出的条目 uid。enabledOnly＝只收【启用】行（data-type !== 'off'）——从 null 态
// 材料化出一份 Set 时必须用它：null 的含义是「全部启用的」，材料化要还原的正是那一份，
// 否则用户第一次撤勾就会把整本的禁用条目一并变成「显式勾上」（1.82.0）。
function allBldEntryUidsForBook(book, enabledOnly) {
    const uids = [];
    for (const row of sharedState.win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        if ((row.dataset.book || '') !== (book || '')) continue;
        if (enabledOnly && row.dataset.type === 'off') continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (box) uids.push(Number(box.dataset.uid));
    }
    return uids;
}

// 当前渲染出的每一行 -> { book, uid, tok, enabled }。计数 / 折叠 / 体积求和共用这一份映射
// （1.82.0；体积读数照 1.62.0 的 lbShownEntryCosts 同款把成本挂在行上，勾选时不必重读整本书）。
function bldShownEntryRows() {
    const out = [];
    for (const row of sharedState.win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) continue;
        out.push({
            book: row.dataset.book || '', uid: Number(box.dataset.uid),
            tok: Number(row.dataset.tok) || 0, enabled: row.dataset.type !== 'off',
        });
    }
    return out;
}

// 跨所有已展示的书重算摘要。某书的 Set 恰好等于它的【启用集】时折回 null（＝跟随启用状态）；
// 多勾了禁用条目 / 少勾了启用条目都保持显式 —— 判据只有 bldSelCollapses 一处（1.82.0）。
function refreshBldEntriesSummary() {
    const rows = bldShownEntryRows();
    const totals = new Map();   // book -> { total, enabled: [uid] }
    for (const r of rows) {
        let t = totals.get(r.book);
        if (!t) { t = { total: 0, enabled: [] }; totals.set(r.book, t); }
        t.total++;
        if (r.enabled) t.enabled.push(r.uid);
    }
    let total = 0;
    let selected = 0;
    let anyFiltered = false;
    for (const [book, t] of totals) {
        if (bldSelCollapses(sharedState.bldEntryFilter[book], t.enabled)) sharedState.bldEntryFilter[book] = null;
        const now = sharedState.bldEntryFilter[book];
        total += t.total;
        if (now instanceof Set) { selected += now.size; anyFiltered = true; }
        else selected += t.enabled.length;
    }
    const summary = sharedState.win.querySelector('#so-bld-entries-sum');
    if (!summary) return;
    // 体积读数（1.82.0，照搬 1.62.0 的世界书汇总行）：**求和排在上面的折叠归一之后**，否则
    // 读数与条数各说各话。拆两个 span 只为让估算那一段能单独标红；两段都走 textContent。
    const tok = sumBldSelectedTokens(rows, sharedState.bldEntryFilter);
    const countEl = document.createElement('span');
    countEl.textContent = bldEntriesCountText(total, selected, anyFiltered) + ' · ';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'so-lb-size' + (lbSizeIsHuge(tok) ? ' so-lb-size-huge' : '');
    sizeEl.textContent = formatLbSizeEstimate(tok);
    summary.textContent = '';
    summary.appendChild(countEl);
    summary.appendChild(sizeEl);
}

// 纯函数：把工坊 / 世界书条目过滤器（书名 -> Set<uid> | null）序列化成可持久化的普通对象
// { [书名]: number[] }。只有 Set 值成为键（uid 升序）；null / 缺席跳过（= 发送整本）。
// 空 Set 保留成 []（＝显式一条不发）。见 tests/regressions.test.mjs。
function serializeEntrySel(filter) {
    const out = {};
    for (const [book, sel] of Object.entries(filter || {})) {
        if (sel instanceof Set) out[book] = [...sel].sort((a, b) => a - b);
    }
    return out;
}

// 把当前 bldEntryFilter 落进设置（跨重载保留选条目）。每个改动选择的地方都要调。
function persistBldEntrySel() {
    getSettings().bldEntrySel = serializeEntrySel(sharedState.bldEntryFilter);
    save();
}

function toggleBldEntry(book, uid, checked) {
    let sel = sharedState.bldEntryFilter[book];
    // null（＝全部启用的）→ 材料化成【启用集】，与屏幕上的勾选态逐条一致（1.82.0）
    if (!(sel instanceof Set)) sel = new Set(allBldEntryUidsForBook(book, true));
    if (checked) sel.add(uid); else sel.delete(uid);
    sharedState.bldEntryFilter[book] = sel;
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 全选 / 全不选，跨所有展示的书（每本书各自一份 filter 记录）。
// 「全选」把**每一行**（含禁用）都打上勾，所以它必须落成【显式全集】而不是 null——null 的含义已是
// 「全部启用的」，落 null 会让屏幕上勾着的禁用行不被发送（1.82.0 WYSIWYG）。无禁用条目的书里
// 显式全集恰等于启用集，refreshBldEntriesSummary 会自然把它折回 null，行为与从前一致。
export function setAllBldEntries(on) {
    const perBook = new Map();   // book -> Set of uids（on=false 时留空集 = 一条不发）
    for (const row of sharedState.win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        const b = row.dataset.book || '';
        if (!perBook.has(b)) perBook.set(b, new Set());
        if (on && box) perBook.get(b).add(Number(box.dataset.uid));
    }
    for (const [b, sel] of perBook) sharedState.bldEntryFilter[b] = sel;
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 只选中某一类灯的条目：'blue'（常驻）/ 'green'（关键词触发），跨所有展示的书，不含已禁用。
// 与 setLbEntriesByType 同构，作用于 bldEntryFilter + #so-bld-entry-list（无「仅禁用」按 Prince 指定）。
export function setBldEntriesByType(type) {
    const rows = [...sharedState.win.querySelectorAll('#so-bld-entry-list .so-lb-ent')];
    if (!rows.length) return;
    const perBook = new Map();   // book -> Set of matching uids
    for (const row of rows) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        if (box) box.checked = match;
        if (match) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) sharedState.bldEntryFilter[book] = sel;   // 空 Set -> 该书一条不发
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 「全选筛选」：把选择设为【当前筛选 / 搜索后仍可见】的那些条目（每本书各自计算）；被筛掉的一律不选。
// 与 selectFilteredLbEntries 同构，作用于 bldEntryFilter + #so-bld-entry-list。
export function selectFilteredBldEntries() {
    const perBook = new Map();   // book -> Set of visible uids
    for (const row of sharedState.win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) sharedState.bldEntryFilter[book] = sel;   // 恰好可见集（refresh 把整本折成 null）
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 「全选筛选」只在有搜索词时才有意义（否则等于「全选」）—— 没搜索词时禁用它。
export function updateBldFilteredBtn() {
    const btn = sharedState.win.querySelector('#so-bld-ent-filtered');
    if (!btn) return;
    const f = sharedState.win.querySelector('#so-bld-ent-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

export function filterBookEntries(listSelector, q, onFiltered) {
    const needle = (q || '').trim().toLowerCase();
    const list = sharedState.win.querySelector(listSelector);
    if (!list) return;
    for (const row of list.querySelectorAll('.so-lb-ent')) {
        row.style.display = (!needle || (row.dataset.hay || '').includes(needle)) ? '' : 'none';
    }
    // Hide a book header (+ its "empty" sub-line) when none of its rows are visible.
    for (const head of list.querySelectorAll('.so-lb-book-head, .so-lb-ent-empty-sub')) {
        if (!needle) { head.style.display = ''; continue; }
        const book = head.dataset.book || '';
        const headMatches = (head.dataset.hay || '').includes(needle);
        const anyRowVisible = [...list.querySelectorAll('.so-lb-ent')]
            .some((r) => (r.dataset.book || '') === book && r.style.display !== 'none');
        head.style.display = (headMatches || anyRowVisible) ? '' : 'none';
    }
    onFiltered();
}

// 填 / 刷条目清单：单本 -> 该书条目；多本（或选“全部激活”解析出多本）-> 每本一个书头分组。
// 语义同 populateLorebookEntries，只是无「内容预览」行、无 .shown 盒子（原生 <details> 折叠）。
async function populateBuilderEntries() {
    const list = sharedState.win.querySelector('#so-bld-entry-list');
    if (!list) return;
    const s = getSettings();
    let books;
    try {
        const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
        books = resolveLbTargetNames(s.bldBooks, allNames, activeNames);
    } catch (e) { books = []; }
    if (!books.length) { list.innerHTML = ''; refreshBldEntriesSummary(); return; }
    const grouped = books.length > 1;   // per-book headers whenever more than one book is shown

    list.innerHTML = '<div class="so-lb-ent-empty">读取条目中…</div>';
    const mod = await getWiEditApi();
    const loaded = [];   // [{ name, entries }]
    let selPruned = false;   // T12：真剪掉过失效 uid 时才回写设置（末尾折叠后一次）
    for (const name of books) {
        let entries = [];
        let loadOk = false;   // 【只有真读到了这本书】才敢按它剪除选择——见下（同 populateLorebookEntries，1.40.1）
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
                loadOk = true;
            }
        } catch (e) { /* leave empty */ }
        // Drop stale uids from a prior selection (entries may have changed since).
        // ⚠ 必须 loadOk 才剪（1.82.0 补）：读书失败 / 模块拿不到时 entries 是空数组，无条件剪会把整份
        // 选择削成【空 Set＝一条不发】。工坊的选择是持久化的（bldEntrySel）——多本书同屏时这一趟就会
        // 把坏掉那本写成 []，一次偶发读取失败便永久毁掉用户攒的选择。读不到就原样保留，下次读到再剪。
        if (loadOk && sharedState.bldEntryFilter[name] instanceof Set) {
            const valid = new Set(entries.map((e) => e.uid));
            const before = sharedState.bldEntryFilter[name];
            const kept = new Set([...before].filter((u) => valid.has(u)));
            if (kept.size !== before.size) selPruned = true;
            sharedState.bldEntryFilter[name] = kept;
        }
        loaded.push({ name, entries });
    }

    const totalEntries = loaded.reduce((n, b) => n + b.entries.length, 0);
    list.innerHTML = '';
    if (!totalEntries) {
        list.innerHTML = `<div class="so-lb-ent-empty">（${grouped ? '当前激活的世界书暂无条目' : '此世界书暂无条目'}。）</div>`;
        refreshBldEntriesSummary();
        return;
    }

    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'so-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="so-lb-book-name"></span>' +
                `<span class="so-lb-book-count">${entries.length}</span>`;
            head.querySelector('.so-lb-book-name').textContent = name;
            list.appendChild(head);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'so-lb-ent-empty so-lb-ent-empty-sub';
                empty.dataset.book = name;
                empty.dataset.hay = name.toLowerCase();
                empty.textContent = '（此书暂无条目）';
                list.appendChild(empty);
                continue;
            }
        }
        const sel = sharedState.bldEntryFilter[name];   // Set（显式选择）| null（= 全部启用的）
        for (const e of entries) {
            // 1.82.0：null 态下禁用条目渲染成【未勾选】——勾选框显示的就是发出去的（bldPickFedEntries 同一口径）。
            const checked = sel instanceof Set ? sel.has(e.uid) : !e.disable;
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const typeKey = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            const row = document.createElement('label');
            row.className = 'so-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = typeKey;
            // 体积读数（1.82.0）：这一条真发出去要多少 token，建行时算一次挂在行上（同 1.62.0 世界书选择器）。
            row.dataset.tok = String(lbEntryTokenCost(e));
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="so-lb-ent-type so-lb-type-${typeKey}"></span>` +
                `<span class="so-lb-ent-uid">#${e.uid}</span><span class="so-lb-ent-title"></span>`;
            row.querySelector('.so-lb-ent-title').textContent = title;
            row.querySelector('input').addEventListener('change', (ev) => toggleBldEntry(name, e.uid, ev.target.checked));
            list.appendChild(row);
        }
    }
    const f = sharedState.win.querySelector('#so-bld-ent-filter');
    if (f && f.value) filterBookEntries('#so-bld-entry-list', f.value, updateBldFilteredBtn);
    updateBldFilteredBtn();
    refreshBldEntriesSummary();
    if (selPruned) persistBldEntrySel();   // T12：把剪除失效 uid 后的干净选择落盘
}

export async function populateLorebookBooks(announce) {
    const listEl = sharedState.win.querySelector('#so-lb-book-list');
    if (!listEl) return;
    const s = getSettings();
    let active = [];
    let all = [];
    try {
        [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    } catch (e) { /* leave empty */ }

    // Prune selections that no longer exist on disk.
    if (Array.isArray(s.lorebookTargets) && s.lorebookTargets.length) {
        const allSet = new Set(all);
        const kept = s.lorebookTargets.filter((n) => allSet.has(n));
        if (kept.length !== s.lorebookTargets.length) { s.lorebookTargets = kept; save(); }
    }

    const chosen = new Set(Array.isArray(s.lorebookTargets) ? s.lorebookTargets : []);
    const activeSet = new Set(active);
    listEl.innerHTML = '';
    if (!all.length) {
        listEl.innerHTML = '<div class="so-lb-ent-empty">（没有找到任何世界书。）</div>';
    } else {
        for (const name of all) {
            const row = document.createElement('label');
            row.className = 'so-lb-book-opt';
            row.dataset.book = name;
            const star = activeSet.has(name) ? '★ ' : '';
            row.innerHTML = `<input type="checkbox"${chosen.has(name) ? ' checked' : ''}><span class="so-lb-book-name"></span>`;
            row.querySelector('.so-lb-book-name').textContent = star + name;
            listEl.appendChild(row);
        }
    }
    const bf = sharedState.win.querySelector('#so-lb-book-filter');
    if (bf && bf.value) filterLbBooks(bf.value);
    updateLbBookSummary();
    updateLbHint();
    populateLorebookEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

// Summary text on the picker's <summary>: "全部激活的世界书" or "已选 N 本".
function updateLbBookSummary() {
    const sum = sharedState.win.querySelector('#so-lb-bookpick-sum');
    if (!sum) return;
    const t = getSettings().lorebookTargets;
    sum.textContent = (Array.isArray(t) && t.length) ? `已选 ${t.length} 本世界书` : '全部激活的世界书';
}

// Recompute lorebookTargets from the checked rows; refresh dependent UI.
export function onLbBookSelectionChange() {
    const s = getSettings();
    const picked = [];
    for (const box of sharedState.win.querySelectorAll('#so-lb-book-list input[type="checkbox"]')) {
        if (box.checked) {
            const row = box.closest('.so-lb-book-opt');
            if (row && row.dataset.book) picked.push(row.dataset.book);
        }
    }
    s.lorebookTargets = picked;
    save();
    updateLbBookSummary();
    updateLbHint();
    populateLorebookEntries();
}

function updateLbHint() {
    const hint = sharedState.win.querySelector('#so-lb-hint');
    if (!hint) return;
    const t = getSettings().lorebookTargets;
    hint.textContent = (Array.isArray(t) && t.length)
        ? `将聊 / 编辑：已选 ${t.length} 本世界书（${t.join('、')}）。可在下方按条目精选以控制 token。`
        : '将聊 / 编辑：当前角色卡 / 聊天 / 全局所激活的全部世界书。可在下方按条目精选（含仅蓝灯 / 仅绿灯等快捷选择）以控制 token 消耗。';
}

// 世界书选书器的书名搜索（纯可见性筛选，绝不改选择 / 设置）：按书名子串隐藏 / 显示复选行；
// 有书但全被筛掉时亮出「没有匹配」提示。是条目搜索 filterBookEntries 的书本版孪生。
export function filterLbBooks(q) {
    const list = sharedState.win.querySelector('#so-lb-book-list');
    if (!list) return;
    let anyRow = false, anyVisible = false;
    for (const row of list.querySelectorAll('.so-lb-book-opt')) {
        anyRow = true;
        const show = bookNameMatchesQuery(row.dataset.book, q);
        row.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
    }
    const empty = sharedState.win.querySelector('#so-lb-book-empty');
    if (empty) empty.hidden = !(anyRow && !anyVisible);
}

/* ---- per-entry picker (single targeted book, OR every active book grouped) ----
 * Selection is keyed by book name in lbEntryFilter, so the same machinery serves
 * both: each rendered row carries data-book, and the buttons/summary fan out over
 * whatever books are currently shown (one book, or all active ones). */

// All entry uids of one book, from its rendered rows (regardless of checked state).
function allLbEntryUidsForBook(book) {
    const uids = [];
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        if ((row.dataset.book || '') !== (book || '')) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (box) uids.push(Number(box.dataset.uid));
    }
    return uids;
}

// 渲染好的条目行 → [{book, uid, tok}]，喂给 sumLbSelectedTokens。成本在建行时算好挂在
// data-tok 上（见 populateLorebookEntries），这里只做搬运——判断逻辑全在那个纯函数里。
function lbShownEntryCosts() {
    const out = [];
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) continue;
        out.push({ book: row.dataset.book || '', uid: Number(box.dataset.uid), tok: Number(row.dataset.tok) || 0 });
    }
    return out;
}

// Every book currently rendered in the picker -> its entry-row count.
function lbShownBookTotals() {
    const totals = new Map();
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const b = row.dataset.book || '';
        totals.set(b, (totals.get(b) || 0) + 1);
    }
    return totals;
}

// 把当前 lbEntryFilter 落进设置。挂在 refreshLbEntriesSummary 末尾＝所有改选路径的唯一咽喉，
// 且落的是【归一之后】的状态（全选已塌回 null＝不落键，于是日后新增的条目会自动被包含进来）。
function persistLbEntrySel() {
    getSettings().lbEntrySel = serializeEntrySel(sharedState.lbEntryFilter);
    save();
}

// Recompute the summary across EVERY book shown. A book whose Set covers all its
// shown entries collapses back to null ("all" — buildLorebookContext's untouched
// 整本 path), so re-checking everything reverts to "send the whole book".
function refreshLbEntriesSummary() {
    const totals = lbShownBookTotals();
    let total = 0;
    let selected = 0;
    let anyFiltered = false;
    for (const [book, t] of totals) {
        const sel = sharedState.lbEntryFilter[book];
        if (sel instanceof Set && t > 0 && sel.size >= t) sharedState.lbEntryFilter[book] = null;
        const now = sharedState.lbEntryFilter[book];
        total += t;
        if (now instanceof Set) { selected += now.size; anyFiltered = true; }
        else selected += t;
    }
    // 落盘放在【算完归一之后、DOM 早退之前】：五条改选路径全经这里，且 summary 元素不在时
    // （渲染时序）也照样要存，否则那一次改动会悄悄丢掉。
    persistLbEntrySel();
    const summary = sharedState.win.querySelector('#so-lb-entries-summary');
    if (!summary) return;
    // 体积读数（1.62.0）：**求和排在上面的归一之后**（Set 覆盖全部 → 塌回 null），否则
    // 读数与条数会各说各话。拆两个 span 是为了只让估算那一段能标红；两段都走 textContent。
    const tok = sumLbSelectedTokens(lbShownEntryCosts(), sharedState.lbEntryFilter);
    const countEl = document.createElement('span');
    countEl.textContent = (anyFiltered ? `条目：已选 ${selected} / ${total}` : `条目：全部（${total}）`) + ' · ';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'so-lb-size' + (lbSizeIsHuge(tok) ? ' so-lb-size-huge' : '');
    sizeEl.textContent = formatLbSizeEstimate(tok);
    summary.textContent = '';
    summary.appendChild(countEl);
    summary.appendChild(sizeEl);
}

function toggleLbEntry(book, uid, checked) {
    let sel = sharedState.lbEntryFilter[book];
    if (!(sel instanceof Set)) sel = new Set(allLbEntryUidsForBook(book)); // was "all" -> materialize
    if (checked) sel.add(uid); else sel.delete(uid);
    sharedState.lbEntryFilter[book] = sel;
    refreshLbEntriesSummary();
}

// 全选 / 全不选 across every book shown (each book is its own filter entry).
export function setAllLbEntries(on) {
    const books = new Set();
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        books.add(row.dataset.book || '');
    }
    for (const b of books) sharedState.lbEntryFilter[b] = on ? null : new Set();   // all | none, per book
    refreshLbEntriesSummary();
}

// Select exactly the entries of one lamp type: 'blue' (常驻), 'green' (关键词触发),
// or 'off' (已禁用), across every book shown. None include disabled except 'off'.
export function setLbEntriesByType(type) {
    const rows = [...sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')];
    if (!rows.length) return;
    const perBook = new Map();   // book -> Set of matching uids
    for (const row of rows) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        if (box) box.checked = match;
        if (match) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) sharedState.lbEntryFilter[book] = sel;   // empty Set -> sends none of that book
    refreshLbEntriesSummary();
}

// 「全选筛选」：把选择设为【当前筛选 / 搜索后仍可见】的那些条目（每本书各自计算）；
// 被筛掉（隐藏）的条目一律不选 —— 于是结果恰好等于你眼前筛出来的这些。无筛选时＝全选。
export function selectFilteredLbEntries() {
    const perBook = new Map();   // book -> Set of visible uids
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, sel] of perBook) sharedState.lbEntryFilter[book] = sel;   // exactly the visible set (refresh collapses full→null)
    refreshLbEntriesSummary();
}

// 「全选筛选」只在有筛选词时才有意义（否则就等于「全选」）—— 没筛选时禁用它。
export function updateLbFilteredBtn() {
    const btn = sharedState.win.querySelector('#so-lb-filtered');
    if (!btn) return;
    const f = sharedState.win.querySelector('#so-lb-entries-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

// 纯函数：把一条世界书条目的 raw content 压成选条目器里展示的一行短摘要——折叠所有空白
// （含换行 / 制表 / 全角空格）为单空格、首尾去空白、超过 cap 字裁断加省略号；空 / 纯空白回空串。
// 宏（{{user}} 等）字面保留——这是只读预览、不喂模型、不做锚点，遵循世界书模式的逐字原则。可单测。
export function entryPreviewText(content, cap = 200) {
    const s = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > cap ? s.slice(0, cap) + '…' : s;
}

// 把「内容预览」开关的当前状态映射到 DOM：给条目列加 / 去 .so-lb-show-preview（CSS 据此整列显隐预览行），
// 并同步顶部开关按钮的 .active 高亮。在渲染条目、点开关、初始化绑定时各调一次。
export function reflectLbPreview() {
    const on = !!getSettings().lbShowEntryPreview;
    const list = sharedState.win.querySelector('#so-lb-entries-list');
    const btn = sharedState.win.querySelector('#so-lb-preview-toggle');
    if (list) list.classList.toggle('so-lb-show-preview', on);
    if (btn) btn.classList.toggle('active', on);
}

// 点「👁 内容预览」：翻转设置、持久化、刷新 DOM。纯展示开关，不重建列表（预览行始终在 DOM 里、靠 CSS 显隐）。
export function toggleLbPreview() {
    const s = getSettings();
    s.lbShowEntryPreview = !s.lbShowEntryPreview;
    save();
    reflectLbPreview();
}

// Build / refresh the entry checklist. A specific target -> just that book's
// entries. "All active books" ('') -> every active book's entries, grouped under
// per-book headers (the same book set buildLorebookContext feeds in all-active
// mode); the shortcut buttons + filter then span all of them. Hidden entirely when
// there's nothing to show (no target picked AND no active book).
async function populateLorebookEntries() {
    const box = sharedState.win.querySelector('#so-lb-entries');
    const list = sharedState.win.querySelector('#so-lb-entries-list');
    if (!box || !list) return;
    const s = getSettings();
    // 1.40.1：本会话首次渲染时，把 lbEntrySel 设置水合进内存镜像（书本身已由 lorebookTargets 持久化）。
    // 只做一次——之后内存是唯一真相，否则用户「全选」塌成 null 后会被存档里的旧 Set 顶回来。
    if (!sharedState.lbSelHydrated) {
        const saved = s.lbEntrySel;
        if (saved && typeof saved === 'object') {
            for (const [book, arr] of Object.entries(saved)) {
                if (Array.isArray(arr)) sharedState.lbEntryFilter[book] = new Set(arr);
            }
        }
        sharedState.lbSelHydrated = true;
    }
    let books;
    try {
        const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
        books = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    } catch (e) { books = []; }
    if (!books.length) { box.classList.remove('shown'); return; }
    box.classList.add('shown');
    reflectLbPreview();   // 把「内容预览」开关状态贴到列表 + 按钮（每次渲染都对齐）
    const grouped = books.length > 1;   // per-book headers whenever more than one book is shown

    list.innerHTML = '<div class="so-lb-ent-empty">读取条目中…</div>';
    const mod = await getWiEditApi();
    const loaded = [];   // [{ name, entries }]
    for (const name of books) {
        let entries = [];
        let loadOk = false;   // 【只有真读到了这本书】才敢按它剪除选择——见下
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
                loadOk = true;
            }
        } catch (e) { /* leave empty */ }
        // Drop stale uids from a prior selection (entries may have changed since).
        // ⚠ 必须 loadOk 才剪：读书失败 / API 拿不到时 entries 是空数组，无条件剪会把整份选择
        // 削成【空 Set＝一条不发】。选择改为持久化后（lbEntrySel），这一下会被写进设置永久生效——
        // 一次偶发的读取失败就能悄悄毁掉用户攒的选择。读不到书时【原样保留】选择，下次读到再剪。
        if (loadOk && sharedState.lbEntryFilter[name] instanceof Set) {
            const valid = new Set(entries.map((e) => e.uid));
            sharedState.lbEntryFilter[name] = new Set([...sharedState.lbEntryFilter[name]].filter((u) => valid.has(u)));
        }
        loaded.push({ name, entries });
    }

    const totalEntries = loaded.reduce((n, b) => n + b.entries.length, 0);
    list.innerHTML = '';
    if (!totalEntries) {
        list.innerHTML = `<div class="so-lb-ent-empty">（${grouped ? '当前激活的世界书暂无条目' : '此世界书暂无条目'}。）</div>`;
        refreshLbEntriesSummary();
        return;
    }

    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'so-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="so-lb-book-name"></span>' +
                `<span class="so-lb-book-count">${entries.length}</span>`;
            head.querySelector('.so-lb-book-name').textContent = name;
            list.appendChild(head);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'so-lb-ent-empty so-lb-ent-empty-sub';
                empty.dataset.book = name;
                empty.dataset.hay = name.toLowerCase();
                empty.textContent = '（此书暂无条目）';
                list.appendChild(empty);
                continue;
            }
        }
        const sel = sharedState.lbEntryFilter[name];   // Set | null (= all)
        for (const e of entries) {
            const checked = !(sel instanceof Set) || sel.has(e.uid);
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const row = document.createElement('label');
            row.className = 'so-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            // 体积读数（1.62.0）：这一条真发出去要多少 token，建行时算一次挂在行上。
            // 汇总行按勾选态求和读它 —— 否则每次勾选都得重读整本书。
            row.dataset.tok = String(lbEntryTokenCost(e));
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="so-lb-ent-type so-lb-type-${e.disable ? 'off' : (e.constant ? 'blue' : 'green')}"></span>` +
                `<span class="so-lb-ent-uid">#${e.uid}</span><span class="so-lb-ent-title"></span>` +
                `<span class="so-lb-ent-preview"></span>`;
            row.querySelector('.so-lb-ent-title').textContent = title;
            // 内容预览（开关在 .so-lb-show-preview 上；textContent 不走 innerHTML —— raw lore 绝不当 HTML 解析）。
            const prevEl = row.querySelector('.so-lb-ent-preview');
            const prevText = entryPreviewText(e.content);
            prevEl.textContent = prevText || '（空条目）';
            if (!prevText) prevEl.classList.add('is-empty');
            row.querySelector('input').addEventListener('change', (ev) => toggleLbEntry(name, e.uid, ev.target.checked));
            list.appendChild(row);
        }
    }
    const f = sharedState.win.querySelector('#so-lb-entries-filter');
    if (f && f.value) filterBookEntries('#so-lb-entries-list', f.value, updateLbFilteredBtn);
    refreshLbEntriesSummary();
    updateLbFilteredBtn();
}

/* ==================== 世界书「智能选条」助手：UI + 编排（ENABLE_LB_SMART_SELECT，2026-08-08）====================
 * 引擎纯核在上方（buildLbCatalog / parseLb* / lbEngineSearch/Fetch / lbSmartNextStep / lbResolveSelectPlan）。
 * 这里是够不着单测的 DOM / 异步层：懒建 overlay（#so-smartsel，同 #so-fixsel 骨架 + ✕/点遮罩逃生）、回合编排
 * （soCallModel 非流式，至多 2 个额外来回，窗口里显式提示每一轮）、预检卡、应用（快照 → 经现有 toggle 机制落选
 * 择态）、一键还原。全程独立于侧聊：不进 convo、不碰〔世界书快照〕。 */

sharedState.smartSelState = null;   // { books, selMap, abort, restore, searched:[], searchHits:number }

// 载入本次范围内的书（与选择器同款：resolveLbTargetNames(s.lorebookTargets, all, active)）→ [{name, entries:[raw]}]。
async function loadSmartSelectBooks() {
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) return [];
    let names = [];
    try {
        const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
        names = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    } catch (e) { return []; }
    const books = [];
    for (const name of names) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        const entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        books.push({ name, entries });
    }
    return books;
}

// 当前选择态映射（{书名: Set|null}）——直接读内存镜像 lbEntryFilter（缺键 = 全勾）。
function currentLbSelMap(books) {
    const map = {};
    for (const b of books) map[b.name] = (sharedState.lbEntryFilter[b.name] !== undefined) ? sharedState.lbEntryFilter[b.name] : null;
    return map;
}

// 懒建 overlay + 一次性 wiring（复用 #so-fixsel 的 inset:0 骨架 + .so-warn-x 逃生 + 点遮罩关闭）。
function buildSmartSelCard() {
    let el = sharedState.win.querySelector('#so-smartsel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'so-smartsel';
    el.innerHTML =
        '<div id="so-smartsel-card">' +
        '<div id="so-smartsel-head"><span class="so-warn-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 🪄 智能选条</span>' +
        '<div class="so-iconbtn so-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>' +
        '<div id="so-smartsel-body"></div>' +
        '<div id="so-smartsel-btns"></div>' +
        '</div>';
    sharedState.win.appendChild(el);
    const close = () => closeSmartSelect();
    el.addEventListener('click', (e) => { if (e.target === el) close(); });   // 点遮罩关闭
    el.querySelector('.so-warn-x').addEventListener('click', close);
    return el;
}

function closeSmartSelect() {
    const el = sharedState.win.querySelector('#so-smartsel');
    if (!el) return;
    if (sharedState.smartSelState && sharedState.smartSelState.abort) { try { sharedState.smartSelState.abort.abort(); } catch (e) { /* ignore */ } }
    el.classList.remove('open');
}

// 打开：守卫旗 + 必须有范围内的书；预填输入态。
export async function openSmartSelect() {
    if (!ENABLE_LB_SMART_SELECT) return;
    const el = buildSmartSelCard();
    sharedState.smartSelState = { books: [], selMap: {}, abort: null, restore: null, searched: [], searchHits: 0 };
    el.classList.add('open');
    renderSmartSelInput('读取世界书条目中…', true);
    const books = await loadSmartSelectBooks();
    sharedState.smartSelState.books = books;
    sharedState.smartSelState.selMap = currentLbSelMap(books);
    if (!books.length) {
        renderSmartSelInput('（当前范围内没有可读取的世界书条目——请先在上方勾选某本书。）', true);
        return;
    }
    const total = books.reduce((n, b) => n + b.entries.length, 0);
    renderSmartSelInput('范围内 ' + books.length + ' 本书、共 ' + total + ' 条。用一句话说你想勾选 / 取消哪些条目，例如「把讲战争线的绿灯条目全勾上」「取消所有涉及感情戏的」。', false);
}

// —— 各状态渲染（重画 body + footer）——
function smartSelBody() { return sharedState.win.querySelector('#so-smartsel-body'); }
function smartSelBtns() { return sharedState.win.querySelector('#so-smartsel-btns'); }

function renderSmartSelInput(hintText, disabled) {
    const body = smartSelBody(); const btns = smartSelBtns();
    if (!body || !btns) return;
    body.innerHTML =
        '<textarea id="so-smartsel-input" rows="3" placeholder="用一句话描述要怎么勾选…"></textarea>' +
        '<div class="so-hint" id="so-smartsel-hint"></div>';
    body.querySelector('#so-smartsel-hint').textContent = hintText || '';
    const ta = body.querySelector('#so-smartsel-input');
    ta.disabled = !!disabled;
    btns.innerHTML =
        '<button type="button" class="so-smartsel-btn" id="so-smartsel-cancel">取消</button>' +
        '<button type="button" class="so-smartsel-btn so-smartsel-go" id="so-smartsel-go"' + (disabled ? ' disabled' : '') + '>开始</button>';
    btns.querySelector('#so-smartsel-cancel').addEventListener('click', () => closeSmartSelect());
    const go = btns.querySelector('#so-smartsel-go');
    const fire = () => { const v = (ta.value || '').trim(); if (v) runSmartSelect(v); };
    go.addEventListener('click', fire);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fire(); } });
    if (!disabled) setTimeout(() => { try { ta.focus(); } catch (e) { /* ignore */ } }, 0);
}

// 进度态：一行行累加「🪄 第 N 轮…」——多出的计费永不静默。
function renderSmartSelProgress(reset) {
    const body = smartSelBody(); const btns = smartSelBtns();
    if (!body || !btns) return;
    if (reset || !body.querySelector('#so-smartsel-log')) {
        body.innerHTML = '<div id="so-smartsel-log"></div>';
        btns.innerHTML = '<button type="button" class="so-smartsel-btn" id="so-smartsel-stop">中断</button>';
        btns.querySelector('#so-smartsel-stop').addEventListener('click', () => closeSmartSelect());
    }
}
function smartSelLog(text) {
    renderSmartSelProgress(false);
    const log = sharedState.win.querySelector('#so-smartsel-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = 'so-smartsel-logline';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

// —— 🪄 原文直播框（spec 2026-08-09）：AI 边写边看，Claude-Code 式。 ——
// 【恒 textContent，绝不 innerHTML】：模型原文里骑着世界书正文（未信任文本），且直播的就是「原样」。
// 【只在进度态里活】：body 里有 #so-smartsel-log 才建/找它 —— 输入态 / 预检卡 / 停止卡都是整体重画 body
// （innerHTML 覆盖），直播框随之消失，晚到的 delta 也只 no-op，不会把已渲染的界面搅乱。
// 【位置】：直播框 append 到 body，而进度日志全部落在 body 里【先建】的 #so-smartsel-log 容器内 →
// 日志恒在直播框【上方】，无须 insertBefore。
function smartSelLiveBox() {
    const body = smartSelBody();
    if (!body || !body.querySelector('#so-smartsel-log')) return null;
    let box = body.querySelector('.so-smartsel-live');
    if (!box) {
        box = document.createElement('div');
        box.className = 'so-smartsel-live';
        box.style.display = 'none';   // 空壳不占位；第一个 delta 到了才显（非流式一个 delta 都不来 → 永不出现）
        body.appendChild(box);
    }
    return box;
}
function smartSelLiveWrite(fullText) {
    const box = smartSelLiveBox();
    if (!box) return;
    box.style.display = '';
    // 贴底才自动滚——用户往上翻回去重读时绝不把他拽回底部。判据（40px 容差）与弧线实时输出查看器
    // 同款（renderArcLive 的 atBottom，见 #so-live-body 那段），行为在两处保持一致。
    // 必须在写 textContent【之前】量：写完 scrollHeight 就变了，量出来的「是否贴底」是错的。
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = fullText;
    if (atBottom) box.scrollTop = box.scrollHeight;
}
// 清空 = 只清【已存在】的框，绝不为了清空先造一个空壳（否则非流式连接会白出一个空框）。
function smartSelLiveClear() {
    const body = smartSelBody();
    const box = body && body.querySelector('.so-smartsel-live');
    if (!box) return;
    box.textContent = '';
    box.style.display = 'none';
}

// 回合编排：调用①（指令 + 目录）→ 有 Select 出预检；只请求则引擎应答后续发；上界 2；round=cap+1 仍不收敛则停。
async function runSmartSelect(userCommand) {
    if (!ENABLE_LB_SMART_SELECT || !sharedState.smartSelState || !sharedState.smartSelState.books.length) return;
    const s = getSettings();
    const ctl = new AbortController();
    sharedState.smartSelState.abort = ctl;
    const timer = setTimeout(() => ctl.abort(), 120000);
    const books = sharedState.smartSelState.books;
    const catalog = buildLbCatalog(books, sharedState.smartSelState.selMap);
    const scopeNames = books.map((b) => b.name);
    let priorResults = '';
    renderSmartSelProgress(true);
    try {
        for (let round = 1; round <= LB_SMART_MAX_ROUNDS + 1; round++) {
            smartSelLog(round === 1
                ? '🪄 正在请 AI 阅读目录、拟定勾选…'
                : '🪄 第 ' + round + ' 轮：AI 在核对正文（这是第 ' + (round - 1) + ' 次额外调用）…');
            smartSelLiveClear();   // 每轮从头直播（上一轮的原文已由引擎应答行接管，不再需要）
            // 有意【不】钉 stream —— 跟随用户的「流式输出」设置（soCallModel 的 opts.stream===undefined 分支）：
            // 开 → onDelta 逐块喂直播框；关 → onDelta 结构上一次都不会触发（emit 只在两条 stream 分支里被引用）。
            const reply = await soCallModel(buildSmartSelectMessages(userCommand, catalog, priorResults), {
                maxTokens: Math.max(Number(s.maxTokens) || 0, 4096),
                signal: ctl.signal,
                onDelta: (full) => smartSelLiveWrite(full),
            });
            const parsed = {
                selects: parseLbSelectBlocks(reply).selects,
                searches: parseLbSearchBlocks(reply).searches,
                fetches: parseLbFetchBlocks(reply).fetches,
            };
            const step = lbSmartNextStep(parsed, round, LB_SMART_MAX_ROUNDS);
            if (step.action === 'apply') { renderSmartSelPreview(parsed.selects, step.ignoredRequests); return; }
            if (step.action === 'stop') { renderSmartSelStop(step.reason, reply); return; }
            // action === 'search'：引擎侧应答，合并 Search 结果 + Fetch 全文，喂进下一轮
            const chunks = [];
            if (parsed.searches.length) {
                const kws = [];
                for (const sr of parsed.searches) for (const k of sr.keywords) if (!kws.includes(k)) kws.push(k);
                const scope = parsed.searches.map((x) => x.scope).find((x) => x && x.length) || null;
                const res = lbEngineSearch(books, kws, { scope });
                sharedState.smartSelState.searched = [...new Set([...sharedState.smartSelState.searched, ...res.keywords])];
                sharedState.smartSelState.searchHits += res.matchedCount;
                smartSelLog('　→ 搜索「' + res.keywords.join(' / ') + '」：命中 ' + res.matchedCount + ' 条');
                chunks.push(formatLbSearchResult(res));
            }
            if (parsed.fetches.length) {
                const res = lbEngineFetch(books, parsed.fetches);
                smartSelLog('　→ 取回 ' + res.items.length + ' 条全文' + (res.missing.length ? '（' + res.missing.length + ' 条未找到）' : ''));
                chunks.push(formatLbFetchResult(res));
            }
            priorResults = (priorResults ? priorResults + '\n\n' : '') + chunks.join('\n\n');
        }
    } catch (err) {
        if (ctl.signal.aborted) { renderSmartSelInput('已中断。可重新描述指令再试。', false); return; }
        renderSmartSelStop('error', (err && err.message) || String(err));
    } finally {
        clearTimeout(timer);
        sharedState.smartSelState.abort = null;
    }
}

// 停：把已有材料摆给用户（模型没能收敛 / 只闲聊 / 出错），不落任何选择。
function renderSmartSelStop(reason, detail) {
    const body = smartSelBody(); const btns = smartSelBtns();
    if (!body || !btns) return;
    const msg = reason === 'noconverge'
        ? 'AI 用完了 ' + LB_SMART_MAX_ROUNDS + ' 次额外查询仍没能给出勾选计划。请把指令说得更具体（点名某条线 / 灯色 / 组），或直接手动勾选。'
        : reason === 'error'
            ? '调用出错：' + (detail || '') + '。请检查连接设置后重试。'
            : 'AI 没有给出可执行的勾选计划。请把指令说得更具体一些，或直接手动勾选。';
    body.innerHTML = '<div class="so-smartsel-stop"></div><div class="so-smartsel-detail so-hint"></div>';
    body.querySelector('.so-smartsel-stop').textContent = msg;
    body.querySelector('.so-smartsel-detail').textContent = (reason !== 'error' && detail) ? ('AI 原话：' + String(detail).slice(0, 400)) : '';
    btns.innerHTML =
        '<button type="button" class="so-smartsel-btn" id="so-smartsel-close">关闭</button>' +
        '<button type="button" class="so-smartsel-btn so-smartsel-go" id="so-smartsel-retry">重新描述</button>';
    btns.querySelector('#so-smartsel-close').addEventListener('click', () => closeSmartSelect());
    btns.querySelector('#so-smartsel-retry').addEventListener('click', () => renderSmartSelInput('用一句话重新描述指令。', false));
}

// 预检卡：B5 同族行 UI（将勾选 N / 取消 M + 逐行 ✔/✖ uid 标题 — 理由）+ 搜索透明行 + 幻觉 uid 剔除注记 + [应用][取消]。
function renderSmartSelPreview(selects, ignoredRequests) {
    const body = smartSelBody(); const btns = smartSelBtns();
    if (!body || !btns) return;
    const plan = lbResolveSelectPlan(selects, sharedState.smartSelState.books, currentLbSelMap(sharedState.smartSelState.books));
    sharedState.smartSelState.plan = plan;
    body.innerHTML = '';
    // 透明行：AI 搜了什么
    if (sharedState.smartSelState.searched.length) {
        const t = document.createElement('div');
        t.className = 'so-smartsel-searched';
        t.textContent = '模型搜了：' + sharedState.smartSelState.searched.join(' / ') + '，命中 ' + sharedState.smartSelState.searchHits + ' 条';
        body.appendChild(t);
    }
    // 摘要
    const sum = document.createElement('div');
    sum.className = 'so-smartsel-summary';
    sum.textContent = '将勾选 ' + plan.willSelect + ' 条 / 取消 ' + plan.willDeselect + ' 条';
    body.appendChild(sum);
    // 逐行
    if (!plan.rows.length) {
        const none = document.createElement('div');
        none.className = 'so-hint';
        none.textContent = '（AI 给的计划里没有落到有效条目的动作。）';
        body.appendChild(none);
    }
    for (const r of plan.rows) {
        const row = document.createElement('div');
        row.className = 'so-ss-row ' + (r.action === 'select' ? 'so-ss-select' : 'so-ss-deselect');
        const main = document.createElement('div');
        main.className = 'so-ss-row-main';
        const mark = r.action === 'select' ? '✔ 勾选' : '✖ 取消';
        const who = r.all ? ('《' + r.book + '》整本条目') : ('《' + r.book + '》 uid=' + r.uid + '「' + r.title + '」');
        main.textContent = mark + ' ' + who;
        row.appendChild(main);
        if (r.reason) { const rn = document.createElement('div'); rn.className = 'so-ss-row-reason'; rn.textContent = '↳ ' + r.reason; row.appendChild(rn); }
        body.appendChild(row);
    }
    // 幻觉 uid / 找不到书 / 忽略请求 注记
    if (plan.dropped.length) {
        const d = document.createElement('div');
        d.className = 'so-smartsel-warn';
        d.textContent = '⚠ 已忽略目录里不存在的 uid：' + plan.dropped.map((x) => x.uid).join(', ') + '（AI 可能记错了编号）';
        body.appendChild(d);
    }
    if (plan.unresolvedBooks.length) {
        const u = document.createElement('div');
        u.className = 'so-smartsel-warn';
        u.textContent = '⚠ 找不到世界书：' + plan.unresolvedBooks.join('、');
        body.appendChild(u);
    }
    if (ignoredRequests) {
        const ir = document.createElement('div');
        ir.className = 'so-hint';
        ir.textContent = '（AI 在给计划的同时还想再搜索/取文，已按「出计划即终局」忽略。）';
        body.appendChild(ir);
    }
    const canApply = plan.perBook.length > 0 && (plan.willSelect + plan.willDeselect) > 0;
    btns.innerHTML =
        '<button type="button" class="so-smartsel-btn" id="so-smartsel-cancel2">取消</button>' +
        '<button type="button" class="so-smartsel-btn so-smartsel-go" id="so-smartsel-apply"' + (canApply ? '' : ' disabled') + '>应用</button>';
    btns.querySelector('#so-smartsel-cancel2').addEventListener('click', () => closeSmartSelect());
    if (canApply) btns.querySelector('#so-smartsel-apply').addEventListener('click', () => applySmartSelectPlan());
}

// 克隆当前选择态（Set 深拷、null 原样）——快照 / 还原用。
function cloneLbEntryFilter() {
    const out = {};
    for (const [k, v] of Object.entries(sharedState.lbEntryFilter)) out[k] = (v && typeof v.forEach === 'function') ? new Set(v) : v;
    return out;
}

// 应用：先整份快照当前选择态（书集合 + 全部 lbEntrySel）→ 经现有 toggle 机制写入选择器（复用「整本勾满 = 发整本」
// 与持久化规则）→ 出 [还原]（本次会话内一次性撤销）。
async function applySmartSelectPlan() {
    const plan = sharedState.smartSelState && sharedState.smartSelState.plan;
    if (!plan) return;
    const s = getSettings();
    // 快照：书集合 + 内存选择态 + 已落盘的 lbEntrySel
    const snap = {
        lorebookTargets: Array.isArray(s.lorebookTargets) ? [...s.lorebookTargets] : s.lorebookTargets,
        filter: cloneLbEntryFilter(),
        lbEntrySel: JSON.parse(JSON.stringify(s.lbEntrySel || {})),
    };
    // 确保条目 DOM 已渲染（toggle 机制靠已渲染的行；lbShownBookTotals / allLbEntryUidsForBook 读 DOM）。
    await populateLorebookEntries();
    // 逐书把选择驱到目标态：设 DOM 复选框 + 内存 Set（仅动计划里的书；其余原样）。
    const desired = new Map();
    for (const pb of plan.perBook) desired.set(pb.book, new Set(pb.finalUids));
    for (const row of sharedState.win.querySelectorAll('#so-lb-entries-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!desired.has(book)) continue;
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) continue;
        box.checked = desired.get(book).has(Number(box.dataset.uid));
    }
    for (const [book, set] of desired) sharedState.lbEntryFilter[book] = set;   // 满 Set 会被 refresh 塌回 null = 发整本
    refreshLbEntriesSummary();   // 唯一咽喉：归一（满→null）+ 落盘（persistLbEntrySel → save）
    sharedState.smartSelState.restore = snap;
    renderSmartSelDone(plan);
}

// 应用后：确认态 + [还原]（会话内一次性，语义同其它一次性撤销）。
function renderSmartSelDone(plan) {
    const body = smartSelBody(); const btns = smartSelBtns();
    if (!body || !btns) return;
    body.innerHTML = '<div class="so-smartsel-ok"></div>';
    body.querySelector('.so-smartsel-ok').textContent = '已应用：勾选 ' + plan.willSelect + ' 条 / 取消 ' + plan.willDeselect + ' 条。选择器已更新并保存。';
    btns.innerHTML =
        '<button type="button" class="so-smartsel-btn" id="so-smartsel-done">完成</button>' +
        '<button type="button" class="so-smartsel-btn" id="so-smartsel-restore"><i class="fa-solid fa-rotate-left"></i> 还原</button>';
    btns.querySelector('#so-smartsel-done').addEventListener('click', () => closeSmartSelect());
    btns.querySelector('#so-smartsel-restore').addEventListener('click', () => restoreSmartSelectSnapshot());
}

// 还原：把选择态整份复位（书集合 + lbEntryFilter + lbEntrySel），重渲选择器。
async function restoreSmartSelectSnapshot() {
    const snap = sharedState.smartSelState && sharedState.smartSelState.restore;
    if (!snap) return;
    const s = getSettings();
    s.lorebookTargets = snap.lorebookTargets;
    for (const k of Object.keys(sharedState.lbEntryFilter)) delete sharedState.lbEntryFilter[k];
    for (const [k, v] of Object.entries(snap.filter)) sharedState.lbEntryFilter[k] = (v && typeof v.forEach === 'function') ? new Set(v) : v;
    s.lbEntrySel = JSON.parse(JSON.stringify(snap.lbEntrySel || {}));
    save();
    await populateLorebookEntries();   // 从复位后的内存态重画复选框 + summary
    sharedState.smartSelState.restore = null;
    const body = smartSelBody(); const btns = smartSelBtns();
    if (body) { body.innerHTML = '<div class="so-smartsel-ok"></div>'; body.querySelector('.so-smartsel-ok').textContent = '已还原到应用前的选择态。'; }
    if (btns) { btns.innerHTML = '<button type="button" class="so-smartsel-btn" id="so-smartsel-done2">关闭</button>'; btns.querySelector('#so-smartsel-done2').addEventListener('click', () => closeSmartSelect()); }
}