import { getSettings, save } from '../../core/settings.js';
import { addSystemNote } from '../advisor/cards.js';
import { formatLbSizeEstimate, lbEntryTokenCost, lbSizeIsHuge } from '../lorebook/entries.js';
import { bldEntriesCountText, bldSelCollapses, bldEntryFilter, hydrateBuilderEntrySelection, pruneBuilderEntrySelection, selectBuilderEntries, selectBuilderEntry, sumBldSelectedTokens } from './selection.js';
import { filterBookEntries, serializeEntrySel } from '../lorebook/selection.js';
import { bookNameMatchesQuery, getActiveBookNames, getAllBookNames, getWiEditApi, resolveLbTargetNames } from '../lorebook/world-info.js';
import { win } from '../../ui/refs.js';
import { BUILDER_VARIANTS, builderSelectedSections, builderVariantKey, builderVisibleSections } from './model.js';


let bldSelHydrated = false;

// Fill the book checklist: every known book as a checkbox (active ones marked ★).
/* ==== 角色工坊选书 / 选条目器（Task 4）====
 * 与世界书选条目器同构（★ 激活标记、失效 uid 剪除、Set/null 物化语义完全一致），只是
 * 用设置键 bldBooks、内存镜像 bldEntryFilter、`#so-bld-*` 元素 id，并去掉蓝 / 绿灯快捷键与
 * 内容预览开关（本模式只有 全选 / 全不选 + 文本筛选）。绝不改动任何 lb* 函数。 */

// chips：把 BUILDER_SECTIONS 渲染成一排可点亮的部分标签；点一下翻转选择、持久化、重画。
export function renderBuilderChips() {
    const wrap = win?.querySelector('#so-bld-chips');
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
    const box = win?.querySelector('#so-bld-chips-legend');
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
    if (!bldSelHydrated) {
        hydrateBuilderEntrySelection(getSettings().bldEntrySel);
        bldSelHydrated = true;
    }
    const listEl = win.querySelector('#so-bld-book-list');
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
    const bf = win.querySelector('#so-bld-book-filter');
    if (bf && bf.value) filterBldBooks(bf.value);
    updateBldBookSummary();
    populateBuilderEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

// 选书器 <summary> 文案："世界书：当前激活的" 或 "世界书：已选 N 本"。
// 旧文案「全部激活」会被读成「选中全部世界书」（用户误读，Prince 转达，1.19.2）——语义其实是
// 「跟随当前激活的那些」，措辞改为 当前激活的。
function updateBldBookSummary() {
    const sum = win.querySelector('#so-bld-bookpick-sum');
    if (!sum) return;
    const t = getSettings().bldBooks;
    sum.textContent = (Array.isArray(t) && t.length) ? `世界书：已选 ${t.length} 本` : '世界书：当前激活的';
}

// 从勾选的行重算 bldBooks；刷新依赖 UI（同 onLbBookSelectionChange）。
export function onBldBookSelectionChange() {
    const s = getSettings();
    const picked = [];
    for (const box of win.querySelectorAll('#so-bld-book-list input[type="checkbox"]')) {
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
    const list = win.querySelector('#so-bld-book-list');
    if (!list) return;
    let anyRow = false, anyVisible = false;
    for (const row of list.querySelectorAll('.so-lb-book-opt')) {
        anyRow = true;
        const show = bookNameMatchesQuery(row.dataset.book, q);
        row.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
    }
    const empty = win.querySelector('#so-bld-book-empty');
    if (empty) empty.hidden = !(anyRow && !anyVisible);
}

// 某本书当前渲染出的条目 uid。enabledOnly＝只收【启用】行（data-type !== 'off'）——从 null 态
// 材料化出一份 Set 时必须用它：null 的含义是「全部启用的」，材料化要还原的正是那一份，
// 否则用户第一次撤勾就会把整本的禁用条目一并变成「显式勾上」（1.82.0）。
function allBldEntryUidsForBook(book, enabledOnly) {
    const uids = [];
    for (const row of win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
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
    for (const row of win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
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
        if (bldSelCollapses(bldEntryFilter[book], t.enabled)) selectBuilderEntries(book, null);
        const now = bldEntryFilter[book];
        total += t.total;
        if (now instanceof Set) { selected += now.size; anyFiltered = true; }
        else selected += t.enabled.length;
    }
    const summary = win.querySelector('#so-bld-entries-sum');
    if (!summary) return;
    // 体积读数（1.82.0，照搬 1.62.0 的世界书汇总行）：**求和排在上面的折叠归一之后**，否则
    // 读数与条数各说各话。拆两个 span 只为让估算那一段能单独标红；两段都走 textContent。
    const tok = sumBldSelectedTokens(rows, bldEntryFilter);
    const countEl = document.createElement('span');
    countEl.textContent = bldEntriesCountText(total, selected, anyFiltered) + ' · ';
    const sizeEl = document.createElement('span');
    sizeEl.className = 'so-lb-size' + (lbSizeIsHuge(tok) ? ' so-lb-size-huge' : '');
    sizeEl.textContent = formatLbSizeEstimate(tok);
    summary.textContent = '';
    summary.appendChild(countEl);
    summary.appendChild(sizeEl);
}


// 把当前 bldEntryFilter 落进设置（跨重载保留选条目）。每个改动选择的地方都要调。
function persistBldEntrySel() {
    getSettings().bldEntrySel = serializeEntrySel(bldEntryFilter);
    save();
}

function toggleBldEntry(book, uid, checked) {
    selectBuilderEntry(book, uid, checked, allBldEntryUidsForBook(book, true));
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 全选 / 全不选，跨所有展示的书（每本书各自一份 filter 记录）。
// 「全选」把**每一行**（含禁用）都打上勾，所以它必须落成【显式全集】而不是 null——null 的含义已是
// 「全部启用的」，落 null 会让屏幕上勾着的禁用行不被发送（1.82.0 WYSIWYG）。无禁用条目的书里
// 显式全集恰等于启用集，refreshBldEntriesSummary 会自然把它折回 null，行为与从前一致。
export function setAllBldEntries(on) {
    const perBook = new Map();   // book -> Set of uids（on=false 时留空集 = 一条不发）
    for (const row of win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        const b = row.dataset.book || '';
        if (!perBook.has(b)) perBook.set(b, new Set());
        if (on && box) perBook.get(b).add(Number(box.dataset.uid));
    }
    for (const [book, selection] of perBook) selectBuilderEntries(book, selection);
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 只选中某一类灯的条目：'blue'（常驻）/ 'green'（关键词触发），跨所有展示的书，不含已禁用。
// 与 setLbEntriesByType 同构，作用于 bldEntryFilter + #so-bld-entry-list（无「仅禁用」按 Prince 指定）。
export function setBldEntriesByType(type) {
    const rows = [...win.querySelectorAll('#so-bld-entry-list .so-lb-ent')];
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
    for (const [book, selection] of perBook) selectBuilderEntries(book, selection);   // 空 Set -> 该书一条不发
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 「全选筛选」：把选择设为【当前筛选 / 搜索后仍可见】的那些条目（每本书各自计算）；被筛掉的一律不选。
// 与 selectFilteredLbEntries 同构，作用于 bldEntryFilter + #so-bld-entry-list。
export function selectFilteredBldEntries() {
    const perBook = new Map();   // book -> Set of visible uids
    for (const row of win.querySelectorAll('#so-bld-entry-list .so-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, selection] of perBook) selectBuilderEntries(book, selection);   // 恰好可见集（refresh 把整本折成 null）
    refreshBldEntriesSummary();
    persistBldEntrySel();
}

// 「全选筛选」只在有搜索词时才有意义（否则等于「全选」）—— 没搜索词时禁用它。
export function updateBldFilteredBtn() {
    const btn = win.querySelector('#so-bld-ent-filtered');
    if (!btn) return;
    const f = win.querySelector('#so-bld-ent-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}


// 填 / 刷条目清单：单本 -> 该书条目；多本（或选“全部激活”解析出多本）-> 每本一个书头分组。
// 语义同 populateLorebookEntries，只是无「内容预览」行、无 .shown 盒子（原生 <details> 折叠）。
async function populateBuilderEntries() {
    const list = win.querySelector('#so-bld-entry-list');
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
        if (loadOk && pruneBuilderEntrySelection(name, entries.map((entry) => entry.uid))) {
            selPruned = true;
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
        const sel = bldEntryFilter[name];   // Set（显式选择）| null（= 全部启用的）
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
    const f = win.querySelector('#so-bld-ent-filter');
    if (f && f.value) filterBookEntries('#so-bld-entry-list', f.value, updateBldFilteredBtn, win);
    updateBldFilteredBtn();
    refreshBldEntriesSummary();
    if (selPruned) persistBldEntrySel();   // T12：把剪除失效 uid 后的干净选择落盘
}
