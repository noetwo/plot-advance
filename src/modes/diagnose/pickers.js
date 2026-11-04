import { deserializeEntrySel, getDiagWiMeta, getWiCustomMeta, persistDiagSel, serializeDiagSel, setDiagWiMeta, setWiCustomMeta, wiCustomChatId } from '../../core/chat-metadata.js';
import { getSettings } from '../../core/settings.js';

import { addSystemNote } from '../advisor/cards.js';
import { refreshDiagPickerUI } from '../fix/ui.js';
import { formatLbSizeEstimate, lbSizeIsHuge, wiCustomEntryCost } from '../lorebook/entries.js';
import { filterBookEntries } from '../lorebook/selection.js';
import { bookNameMatchesQuery, getActiveBookNames, getActiveScanUids, getAllBookNames, getWiEditApi, resolveLbTargetNames } from '../lorebook/world-info.js';
import { ENABLE_WI_CUSTOM_PICK } from '../../prompts/builtins.js';
import { isMvuRuleEntry } from '../../st/adapters.js';
import { win } from '../../ui/refs.js';

/* ---- 诊断模式「精选世界书条目」选条目器（用户功能请求；ENABLE_DIAG_WI_PICKER）----
 * 复用世界书选条目器的视觉（.pad-lb-* 类），但语义不同：
 *   · 选择 diagEntrySel[书名] 始终是【显式 Set<uid>】（无「null = 全选」惯例）——勾了才发，没勾就不发；
 *   · 每次改动都【按聊天持久化】（persistDiagSel）；
 *   · 首开按 computeDiagSnapshot（当前激活＝蓝灯 + 命中绿灯）预选一份，之后随你增删。 */
let diagEntrySel = {};
let wiCustomRenderSeq = 0;


// 首开预选「当前快照」：蓝灯常驻（未禁用）+ 主聊天此刻命中的绿灯，不含禁用。-> { 书名: Set<uid> }。
// 蓝灯直接从【原始书】取（不依赖扫描预算——某些环境下 dry-run 扫描会因预算返回空），扫描只用来定「哪些绿灯当前命中」。
async function computeDiagSnapshot() {
    const mod = await getWiEditApi();
    if (!mod) return {};
    let books = [];
    try { books = await getActiveBookNames(); } catch (e) { books = []; }
    const active = await getActiveScanUids();   // { 书名: Set<uid> } 当前命中（含蓝 + 绿）
    const snap = {};
    for (const name of books) {
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const all = data && data.entries ? Object.values(data.entries) : [];
        const activeSet = active[name] || new Set();
        const set = new Set();
        for (const e of all) {
            if (!e || e.disable) continue;                                  // 禁用条目不进快照
            if (e.constant === true) set.add(Number(e.uid));                // 蓝灯常驻（原始书直取）
            else if (activeSet.has(Number(e.uid))) set.add(Number(e.uid));  // 当前命中的绿灯
        }
        if (set.size) snap[name] = set;
    }
    return snap;
}


/* ---- 🌐 世界书范围「自定义」：快照 / 混合绿灯 / 播种（1.81.0）----
 * 【每本成功读到的书都落键】（空快照也 []），读失败进 failed；
 * 非 ST 激活的书扫描扫不到其绿灯 → 快照只有蓝灯。规则条目（isMvuRuleEntry）永不进快照 / 清单。 */
async function computeWiCustomSnapshot(names, extraScanText) {
    const snap = Object.create(null);
    const failed = [];
    const list = Array.isArray(names) ? names : [];
    const mod = await getWiEditApi();
    if (!mod) return { snap, failed: [...list] };
    let active = {};
    try { active = await getActiveScanUids(extraScanText); } catch (e) { active = {}; }
    for (const name of list) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { data = null; }
        if (!data || !data.entries || typeof data.entries !== 'object') { failed.push(name); continue; }
        const hit = (active[name] instanceof Set) ? active[name] : new Set();
        const set = new Set();
        for (const e of Object.values(data.entries)) {
            if (!e || e.disable || isMvuRuleEntry(e)) continue;
            if (e.constant === true || hit.has(Number(e.uid))) set.add(Number(e.uid));
        }
        snap[name] = set;   // 空集合也落键 —— 否则「首次出现即播种」会每次渲染重播
    }
    return { snap, failed };
}

// 混合模式的绿灯：只在 names（解析出的范围）里取此刻命中的绿灯（Prince 2026-09-13 ⑤）。调用方的额外扫描文本照 'char' 折入。
export async function wiCustomGreens(names, extraScanText) {
    const out = Object.create(null);
    const mod = await getWiEditApi();
    if (!mod) return out;
    const active = await getActiveScanUids(extraScanText);
    for (const name of (Array.isArray(names) ? names : [])) {
        const hit = active[name];
        if (!(hit instanceof Set) || !hit.size) continue;
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const g = new Set();
        for (const e of Object.values((data && data.entries) || {})) {
            if (e && e.constant !== true && !e.disable && hit.has(Number(e.uid))) g.add(Number(e.uid));
        }
        if (g.size) out[name] = g;
    }
    return out;
}

// 播种：对 names 里【无键】的书写一次快照（清单首次渲染 / 首次喂料，谁先到谁播）。已有键绝不覆盖；chatId 变了 → 不写、回 null。
export async function ensureWiCustomSeeded(names, chatId, extraScanText, stillCurrent) {
    if (chatId !== wiCustomChatId()) return null;          // 调用方拿的 chatId 已不是当前聊天：不读不写
    const meta = getWiCustomMeta();
    if (!meta) return null;
    const list = Array.isArray(names) ? names : [];
    const missing = list.filter((n) => !Object.prototype.hasOwnProperty.call(meta.sel, n));
    if (!missing.length) return meta;
    const { snap } = await computeWiCustomSnapshot(missing, extraScanText);
    if (chatId !== wiCustomChatId()) return null;          // 聊天已切走：这一趟的结果不属于当前聊天
    if (typeof stillCurrent === 'function' && !stillCurrent()) return null;   // 已有更新一趟渲染：旧快照不落盘
    const cur = getWiCustomMeta();
    if (!cur) return null;
    const sel = Object.assign(Object.create(null), cur.sel);   // 无原型：书名叫 constructor / __proto__ 也只是普通键
    let changed = false;
    for (const [book, set] of Object.entries(snap)) {
        if (Object.prototype.hasOwnProperty.call(sel, book)) continue;   // 等待期间别处已写 → 不覆盖
        sel[book] = [...set].sort((a, b) => a - b);
        changed = true;
    }
    if (changed) setWiCustomMeta({ books: cur.books, hybrid: cur.hybrid, sel });
    return getWiCustomMeta();
}

// 填充诊断选条目器的书下拉（与 populateLorebookBooks 同构，但目标存元数据而非设置）。
export async function populateDiagWiBooks(announce) {
    const sel = win.querySelector('#pad-diag-book');
    if (!sel) return;
    let active = [];
    let all = [];
    try { [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]); } catch (e) { /* leave empty */ }
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = active.length ? `① 当前激活的全部世界书（${active.length} 本）` : '① 当前激活的全部世界书（无）';
    sel.appendChild(optAll);
    const activeSet = new Set(active);
    for (const name of all) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = activeSet.has(name) ? `★ ${name}` : name;
        sel.appendChild(opt);
    }
    const meta = getDiagWiMeta();
    if (meta.target && all.includes(meta.target)) {
        sel.value = meta.target;
    } else {
        if (meta.target) setDiagWiMeta({ use: meta.use, hybrid: meta.hybrid, target: '', sel: serializeDiagSel(diagEntrySel) });
        sel.value = '';
    }
    updateDiagHint();
    populateDiagWiEntries();
    if (announce) addSystemNote('已刷新世界书列表。');
}

export function updateDiagHint() {
    const hint = win.querySelector('#pad-diag-hint');
    if (!hint) return;
    const meta = getDiagWiMeta();
    hint.textContent = meta.target
        ? `从「${meta.target}」这一本里挑条目喂给诊断。`
        : '从当前激活的全部世界书里挑条目喂给诊断。勾选即覆盖默认扫描——只发你选中的（无视启用 / 禁用）。';
}
export function onDiagTargetChange(target) {
    const meta = getDiagWiMeta();
    setDiagWiMeta({ use: meta.use, hybrid: meta.hybrid, target, sel: serializeDiagSel(diagEntrySel) });
    updateDiagHint();
    populateDiagWiEntries();
}


// 当前显示的全部行里有多少被勾选 -> 更新条目摘要（直接数复选框，与显式 Set 模型一致）。
function refreshDiagEntriesSummary() {
    const rows = [...win.querySelectorAll('#pad-diag-entries-list .pad-lb-ent')];
    const total = rows.length;
    let selected = 0;
    for (const row of rows) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box && box.checked) selected++;
    }
    const summary = win.querySelector('#pad-diag-entries-summary');
    if (!summary) return;
    summary.textContent = (total && selected >= total) ? `条目：全部（${total}）` : `条目：已选 ${selected} / ${total}`;
}

// 勾 / 取消单条：显式 Set，缺省从空集合起（绝不「从全选物化」——精选模型默认不选）。
function toggleDiagEntry(book, uid, checked) {
    let sel = diagEntrySel[book];
    if (!(sel instanceof Set)) sel = new Set();
    if (checked) sel.add(Number(uid)); else sel.delete(Number(uid));
    diagEntrySel[book] = sel;
    refreshDiagEntriesSummary();
    persistDiagSel(diagEntrySel);
}

// 全选 / 全不选（仅作用于当前显示的书）。on -> 该书所有显示行的 uid；off -> 空集合。
export function setAllDiagEntries(on) {
    const perBook = new Map();
    for (const row of win.querySelectorAll('#pad-diag-entries-list .pad-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
        if (on && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel(diagEntrySel);
}

// 按灯型选：'blue'（常驻）/ 'green'（关键词）/ 'off'（已禁用），跨当前显示的每本书。
export function setDiagEntriesByType(type) {
    const rows = [...win.querySelectorAll('#pad-diag-entries-list .pad-lb-ent')];
    if (!rows.length) return;
    const perBook = new Map();
    for (const row of rows) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const match = row.dataset.type === type;
        if (box) box.checked = match;
        if (match && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel(diagEntrySel);
}

// 「全选筛选」：把选择设为当前筛选后仍可见的那些（每本书各自计算）。
export function selectFilteredDiagEntries() {
    const perBook = new Map();
    for (const row of win.querySelectorAll('#pad-diag-entries-list .pad-lb-ent')) {
        const book = row.dataset.book || '';
        if (!perBook.has(book)) perBook.set(book, new Set());
        const box = row.querySelector('input[type="checkbox"]');
        const visible = row.style.display !== 'none';
        if (box) box.checked = visible;
        if (visible && box) perBook.get(book).add(Number(box.dataset.uid));
    }
    for (const [book, set] of perBook) diagEntrySel[book] = set;
    refreshDiagEntriesSummary();
    persistDiagSel(diagEntrySel);
}

export function updateDiagFilteredBtn() {
    const btn = win.querySelector('#pad-diag-filtered');
    if (!btn) return;
    const f = win.querySelector('#pad-diag-entries-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

// 渲染条目清单：勾选态来自 diagEntrySel（显式 Set；未选即未勾）。单本目标 -> 仅该书；否则按激活书分组。
export async function populateDiagWiEntries() {
    const box = win.querySelector('#pad-diag-entries');
    const list = win.querySelector('#pad-diag-entries-list');
    if (!box || !list) return;
    const target = getDiagWiMeta().target;
    let books;
    if (target) books = [target];
    else { try { books = await getActiveBookNames(); } catch (e) { books = []; } }
    if (!books.length) { box.classList.remove('shown'); return; }
    box.classList.add('shown');
    const grouped = !target;

    list.innerHTML = '<div class="pad-lb-ent-empty">读取条目中…</div>';
    const mod = await getWiEditApi();
    const loaded = [];
    for (const name of books) {
        let entries = [];
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            }
        } catch (e) { /* leave empty */ }
        // 清理失效 uid（条目可能已变）。
        if (diagEntrySel[name] instanceof Set) {
            const valid = new Set(entries.map((e) => Number(e.uid)));
            diagEntrySel[name] = new Set([...diagEntrySel[name]].filter((u) => valid.has(Number(u))));
        }
        loaded.push({ name, entries });
    }

    const totalEntries = loaded.reduce((n, b) => n + b.entries.length, 0);
    list.innerHTML = '';
    if (!totalEntries) {
        list.innerHTML = `<div class="pad-lb-ent-empty">（${grouped ? '当前激活的世界书暂无条目' : '此世界书暂无条目'}。）</div>`;
        refreshDiagEntriesSummary();
        return;
    }

    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'pad-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="pad-lb-book-name"></span>' +
                `<span class="pad-lb-book-count">${entries.length}</span>`;
            head.querySelector('.pad-lb-book-name').textContent = name;
            list.appendChild(head);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.className = 'pad-lb-ent-empty pad-lb-ent-empty-sub';
                empty.dataset.book = name;
                empty.dataset.hay = name.toLowerCase();
                empty.textContent = '（此书暂无条目）';
                list.appendChild(empty);
                continue;
            }
        }
        const set = diagEntrySel[name];   // Set（精选模型：未选即未勾，无 null=全选惯例）
        for (const e of entries) {
            const checked = (set instanceof Set) && set.has(Number(e.uid));
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const row = document.createElement('label');
            row.className = 'pad-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="pad-lb-ent-type pad-lb-type-${e.disable ? 'off' : (e.constant ? 'blue' : 'green')}"></span>` +
                `<span class="pad-lb-ent-uid">#${e.uid}</span><span class="pad-lb-ent-title"></span>`;
            row.querySelector('.pad-lb-ent-title').textContent = title;
            row.querySelector('input').addEventListener('change', (ev) => toggleDiagEntry(name, Number(e.uid), ev.target.checked));
            list.appendChild(row);
        }
    }
    const f = win.querySelector('#pad-diag-entries-filter');
    if (f && f.value) filterBookEntries('#pad-diag-entries-list', f.value, updateDiagFilteredBtn, win);
    refreshDiagEntriesSummary();
    updateDiagFilteredBtn();
}

// L2 混合开关 + 选条目区只在 L1 开启后显示。
export function reflectDiagPickerVisible(on) {
    const bar = win && win.querySelector('#pad-diag-bar');
    if (bar) bar.classList.toggle('pad-diag-usesel-on', !!on);
}

// 🔁 重试子选项（次数 + 三枚分类）只在主开关开启后显示——照抄上面 reflectDiagPickerVisible
// 的 class 切换法（CSS 里 #pad-diag-bar.pad-diag-retry-on #pad-diag-retry-opts 才 display:flex）。
export function reflectDiagRetryVisible() {
    const bar = win && win.querySelector('#pad-diag-bar');
    if (bar) bar.classList.toggle('pad-diag-retry-on', !!getSettings().autoDiagnoseRetry);
}

// L1（用精选条目）切换：首开且无既有选择 -> 预选当前快照；否则载入既有。落元数据、刷新可见性、填充。
export async function onDiagUseSelToggle(on) {
    const meta = getDiagWiMeta();
    if (on && !Object.keys(meta.sel || {}).length) {
        try { (diagEntrySel = await computeDiagSnapshot()); } catch (e) { (diagEntrySel = {}); }
    } else {
        (diagEntrySel = deserializeEntrySel(meta.sel));
    }
    setDiagWiMeta({ use: on, hybrid: meta.hybrid, target: meta.target, sel: serializeDiagSel(diagEntrySel) });
    reflectDiagPickerVisible(on);
    if (on) await populateDiagWiBooks();
    addSystemNote(on
        ? '已开启「诊断精选世界书条目」。已按当前激活情况预选了一份——可在下方增删（含已禁用条目）；选择只影响喂给诊断的内容，且按【本聊天】记忆。'
        : '已关闭精选，诊断恢复默认世界书扫描（你的选择仍按本聊天保留，下次打开即恢复）。');
}

// L2（混合模式）切换：只改 hybrid 标志（影响喂料，不改选条目视图）。
export function onDiagHybridToggle(on) {
    const meta = getDiagWiMeta();
    setDiagWiMeta({ use: meta.use, hybrid: on, target: meta.target, sel: serializeDiagSel(diagEntrySel) });
    addSystemNote(on
        ? '已开启混合模式：除了你精选的条目，诊断还会带上主聊天此刻触发的绿灯条目。'
        : '已关闭混合模式：只喂你精选的条目。');
}

// 把本聊天保存的诊断选择载入内存 + 刷新选条目器 UI（在 onChatChanged 调用，随聊天切换）。
export function loadDiagSelForChat() {
    (diagEntrySel = deserializeEntrySel(getDiagWiMeta().sel));
    refreshDiagPickerUI();
}


/* ---- 🌐 世界书范围「自定义」选书 / 选条目器（1.81.0，ENABLE_WI_CUSTOM_PICK）----
 * 视觉复用 .pad-lb-*；状态只有 metadata（无镜像）。每个含 await 的函数起手取 chatId + 递增序号，await 后核对：
 * 不符 = 聊天已切走或有更新一趟 → 既不画 DOM 也不写 metadata。选书变化只改 meta.books；代码绝不改写它（已删的书只是解析不到）。 */


function updateWiCustomHint(state) {
    const hint = win && win.querySelector('#pad-wic-hint');
    if (!hint) return;
    hint.textContent = state === 'nochat' ? '当前没有打开聊天，无法记忆选择'
        : state === 'iofail' ? '世界书读取失败，选择未改动'
        : '';
}

function updateWiCustomBookSummary(meta) {
    const sum = win && win.querySelector('#pad-wic-bookpick-sum');
    if (!sum) return;
    const n = meta && Array.isArray(meta.books) ? meta.books.length : 0;
    sum.textContent = n ? `已选 ${n} 本世界书` : '全部激活的世界书';
}

function wiCustomHideEntries() {
    const box = win && win.querySelector('#pad-wic-entries');
    if (box) box.classList.remove('shown');
}

// 填清单（含 ★ 激活标记、勾选态、混合勾选框回填），再填条目。枚举失败：保留上次清单、只亮提示、不改 meta。
export async function populateWiCustomBooks(announce) {
    const listEl = win && win.querySelector('#pad-wic-book-list');
    if (!listEl) return;
    const chatId = wiCustomChatId();
    const seq = ++wiCustomRenderSeq;
    listEl.dataset.chat = '';   // 重画期间旧行不许写（onWiCustomBookChange 核对此戳）
    const meta = getWiCustomMeta();
    if (!meta) { listEl.innerHTML = ''; updateWiCustomBookSummary(null); updateWiCustomHint('nochat'); wiCustomHideEntries(); return; }
    const hyb = win.querySelector('#pad-wic-hybrid');
    if (hyb) hyb.checked = meta.hybrid;
    let active = [];
    let all = [];
    let ok = true;
    try {
        if (!(await getWiEditApi())) ok = false;   // 模块缺席：getActiveBookNames / getAllBookNames 只会静默回空，不能当「没有书」
        else [active, all] = await Promise.all([getActiveBookNames(), getAllBookNames()]);
    } catch (e) { ok = false; }
    if (seq !== wiCustomRenderSeq || chatId !== wiCustomChatId()) return;
    if (!ok) { updateWiCustomHint('iofail'); return; }
    const chosen = new Set(meta.books);
    const activeSet = new Set(active);
    listEl.innerHTML = '';
    if (!all.length) {
        listEl.innerHTML = '<div class="pad-lb-ent-empty">（没有找到任何世界书。）</div>';
    } else {
        for (const name of all) {
            const row = document.createElement('label');
            row.className = 'pad-lb-book-opt';
            row.dataset.book = name;
            row.innerHTML = `<input type="checkbox"${chosen.has(name) ? ' checked' : ''}><span class="pad-lb-book-name"></span>`;
            row.querySelector('.pad-lb-book-name').textContent = (activeSet.has(name) ? '★ ' : '') + name;
            row.querySelector('input').addEventListener('change', onWiCustomBookChange);
            listEl.appendChild(row);
        }
    }
    listEl.dataset.chat = String(chatId);
    const bf = win.querySelector('#pad-wic-book-filter');
    if (bf && bf.value) filterWiCustomBooks(bf.value);
    updateWiCustomBookSummary(meta);
    updateWiCustomHint('ok');
    await populateWiCustomEntries();   // 子渲染自己递增序号——这里只核聊天，不核序号
    if (announce && chatId === wiCustomChatId()) addSystemNote('已刷新世界书列表。');
}

// 勾选变化 → 只改 meta.books（sel / hybrid 原样），再重画条目。
function onWiCustomBookChange() {
    const meta = getWiCustomMeta();
    if (!meta) return;
    const listEl = win.querySelector('#pad-wic-book-list');
    if (!listEl || listEl.dataset.chat !== String(wiCustomChatId())) return;   // 清单还是别的聊天的 / 正在重画：旧行不许写
    const picked = [];
    for (const box of win.querySelectorAll('#pad-wic-book-list input[type="checkbox"]')) {
        if (box.checked) {
            const row = box.closest('.pad-lb-book-opt');
            if (row && row.dataset.book) picked.push(row.dataset.book);
        }
    }
    setWiCustomMeta({ books: picked, hybrid: meta.hybrid, sel: meta.sel });
    updateWiCustomBookSummary(getWiCustomMeta());
    populateWiCustomEntries();
}

// 全选只勾【可见】行（筛选后别把整库勾进来）；全不选 = [] = 跟随激活。
export function setAllWiCustomBooks(on) {
    for (const row of win.querySelectorAll('#pad-wic-book-list .pad-lb-book-opt')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) continue;
        if (on) { if (row.style.display !== 'none') box.checked = true; }
        else box.checked = false;
    }
    onWiCustomBookChange();
}

// 书名筛选：纯显隐，绝不改选择。
export function filterWiCustomBooks(q) {
    const list = win.querySelector('#pad-wic-book-list');
    if (!list) return;
    let anyRow = false;
    let anyVisible = false;
    for (const row of list.querySelectorAll('.pad-lb-book-opt')) {
        anyRow = true;
        const show = bookNameMatchesQuery(row.dataset.book, q);
        row.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
    }
    const empty = win.querySelector('#pad-wic-book-empty');
    if (empty) empty.hidden = !(anyRow && !anyVisible);
}

// 渲染条目清单：解析范围 → 播种无键的书 → 逐本读（读失败 = 该书行区显示「读取失败」、其键不动）→ 行带 data-book/uid/type/hay/tok。
async function populateWiCustomEntries() {
    const box = win && win.querySelector('#pad-wic-entries');
    const list = win && win.querySelector('#pad-wic-entries-list');
    if (!box || !list) return;
    const chatId = wiCustomChatId();
    const seq = ++wiCustomRenderSeq;
    list.dataset.chat = '';   // 重画期间勾选不许写（persistWiCustomSel 核对此戳）
    let meta = getWiCustomMeta();
    if (!meta) { box.classList.remove('shown'); return; }
    let names = [];
    try {
        const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
        names = resolveLbTargetNames(meta.books, allNames, activeNames);
    } catch (e) { names = []; }
    if (seq !== wiCustomRenderSeq || chatId !== wiCustomChatId()) return;
    if (!names.length) { box.classList.remove('shown'); list.innerHTML = ''; refreshWiCustomSummary(); return; }
    box.classList.add('shown');
    list.innerHTML = '<div class="pad-lb-ent-empty">读取条目中…</div>';
    meta = (await ensureWiCustomSeeded(names, chatId, undefined, () => seq === wiCustomRenderSeq)) || meta;
    if (seq !== wiCustomRenderSeq || chatId !== wiCustomChatId()) return;
    const mod = await getWiEditApi();
    const loaded = [];   // [{ name, entries | null }]（null = 读失败）
    for (const name of names) {
        let entries = null;
        try {
            const data = mod ? await mod.loadWorldInfo(name) : null;
            if (data && data.entries) {
                entries = Object.values(data.entries)
                    .filter((e) => e && !isMvuRuleEntry(e))
                    .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            }
        } catch (e) { entries = null; }
        loaded.push({ name, entries });
    }
    if (seq !== wiCustomRenderSeq || chatId !== wiCustomChatId()) return;
    // 成功读到的书：把已不存在的 uid 从选择里剪掉——ST 新建条目会复用最小空闲 uid，不剪就会把没勾过的新条目发出去（astra F3）；
    // 读失败的书不动；成功但空的书留显式 []。
    {
        const pruned = Object.assign(Object.create(null), meta.sel);
        let changed = false;
        for (const { name, entries } of loaded) {
            if (entries === null || !Object.prototype.hasOwnProperty.call(pruned, name)) continue;
            const valid = new Set(entries.map((e) => Number(e.uid)));
            const cur = Array.isArray(pruned[name]) ? pruned[name] : [];
            const next = cur.map(Number).filter((u) => valid.has(u));
            if (next.length !== cur.length) { pruned[name] = next; changed = true; }
        }
        if (changed && seq === wiCustomRenderSeq && chatId === wiCustomChatId()) {
            setWiCustomMeta({ books: meta.books, hybrid: meta.hybrid, sel: pruned });
            meta = getWiCustomMeta() || meta;
        }
    }
    const selMap = deserializeEntrySel(meta.sel);
    const grouped = names.length > 1;
    list.innerHTML = '';
    list.dataset.chat = String(chatId);
    for (const { name, entries } of loaded) {
        if (grouped) {
            const head = document.createElement('div');
            head.className = 'pad-lb-book-head';
            head.dataset.book = name;
            head.dataset.hay = name.toLowerCase();
            head.innerHTML = '<i class="fa-solid fa-book"></i><span class="pad-lb-book-name"></span>' +
                `<span class="pad-lb-book-count">${entries ? entries.length : '?'}</span>`;
            head.querySelector('.pad-lb-book-name').textContent = name;
            list.appendChild(head);
        }
        if (entries === null || !entries.length) {
            const sub = document.createElement('div');
            sub.className = 'pad-lb-ent-empty pad-lb-ent-empty-sub';
            sub.dataset.book = name;
            sub.dataset.hay = name.toLowerCase();
            sub.textContent = entries === null ? '（读取失败，选择未改动）' : '（此书暂无条目）';
            list.appendChild(sub);
            continue;
        }
        const set = selMap[name];
        for (const e of entries) {
            const checked = (set instanceof Set) && set.has(Number(e.uid));
            const title = (e.comment && e.comment.trim()) ? e.comment.trim() : '（无标题）';
            const keys = Array.isArray(e.key) ? e.key.filter(Boolean).join(', ') : '';
            const type = e.disable ? 'off' : (e.constant ? 'blue' : 'green');
            const row = document.createElement('label');
            row.className = 'pad-lb-ent';
            row.dataset.book = name;
            row.dataset.hay = `${grouped ? name + ' ' : ''}${e.uid} ${title} ${keys}`.toLowerCase();
            row.dataset.type = type;
            row.dataset.tok = String(wiCustomEntryCost(e));
            row.innerHTML = `<input type="checkbox" data-uid="${e.uid}"${checked ? ' checked' : ''}>` +
                `<span class="pad-lb-ent-type pad-lb-type-${type}"></span>` +
                `<span class="pad-lb-ent-uid">#${e.uid}</span><span class="pad-lb-ent-title"></span>`;
            row.querySelector('.pad-lb-ent-title').textContent = title;
            row.querySelector('input').addEventListener('change', toggleWiCustomEntry);
            list.appendChild(row);
        }
    }
    const f = win.querySelector('#pad-wic-entries-filter');
    if (f && f.value) filterBookEntries('#pad-wic-entries-list', f.value, updateWiCustomFilteredBtn, win);
    refreshWiCustomSummary();
    updateWiCustomFilteredBtn();
}

// 已渲染的行 → { 书名: Set<uid> }（只含【显示中】的书；未显示的书键在持久化时原样保留）。
function wiCustomSelFromRows() {
    const out = Object.create(null);
    for (const row of win.querySelectorAll('#pad-wic-entries-list .pad-lb-ent')) {
        const book = row.dataset.book || '';
        const box = row.querySelector('input[type="checkbox"]');
        if (!box) continue;
        if (!out[book]) out[book] = new Set();
        if (box.checked) out[book].add(Number(box.dataset.uid));
    }
    return out;
}

// 持久化 = 把显示中各书的勾选【合并】进 metadata（读失败 / 未显示的书键不动）；chatId 不符不写。
function persistWiCustomSel(chatId) {
    if (chatId !== wiCustomChatId()) return false;
    const meta = getWiCustomMeta();
    if (!meta) return false;
    const sel = Object.assign(Object.create(null), meta.sel);
    for (const [book, set] of Object.entries(wiCustomSelFromRows())) sel[book] = [...set].sort((a, b) => a - b);
    return setWiCustomMeta({ books: meta.books, hybrid: meta.hybrid, sel });
}

// 摘要：已选 n / N · 约 X token（只按勾选行的正文成本求和；超 10 万标红）。
function refreshWiCustomSummary() {
    const summary = win && win.querySelector('#pad-wic-entries-summary');
    if (!summary) return;
    const rows = [...win.querySelectorAll('#pad-wic-entries-list .pad-lb-ent')];
    let selected = 0;
    let tok = 0;
    for (const row of rows) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box && box.checked) { selected++; tok += Number(row.dataset.tok) || 0; }
    }
    const countEl = document.createElement('span');
    countEl.textContent = `条目：已选 ${selected} / ${rows.length} · `;
    const sizeEl = document.createElement('span');
    sizeEl.className = 'pad-lb-size' + (lbSizeIsHuge(tok) ? ' pad-lb-size-huge' : '');
    sizeEl.textContent = formatLbSizeEstimate(tok);
    summary.textContent = '';
    summary.appendChild(countEl);
    summary.appendChild(sizeEl);
}

// 渲染时钉在清单上的聊天 id（改选路径用它做归属钉，不重新读——读到的可能已是别的聊天）。
function wiCustomListChatId() {
    const list = win && win.querySelector('#pad-wic-entries-list');
    return list && list.dataset.chat ? list.dataset.chat : null;
}

function toggleWiCustomEntry() {
    refreshWiCustomSummary();
    persistWiCustomSel(wiCustomListChatId());
}

export function setAllWiCustomEntries(on) {
    for (const row of win.querySelectorAll('#pad-wic-entries-list .pad-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = on;
    }
    toggleWiCustomEntry();
}

// 按灯型：'blue' / 'green' / 'off'——替换当前显示各书的选择。
export function setWiCustomEntriesByType(type) {
    for (const row of win.querySelectorAll('#pad-wic-entries-list .pad-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = row.dataset.type === type;
    }
    toggleWiCustomEntry();
}

// 全选筛选：选择 = 当前筛选后仍可见的行（被筛掉的一律不选）。
export function selectFilteredWiCustomEntries() {
    for (const row of win.querySelectorAll('#pad-wic-entries-list .pad-lb-ent')) {
        const box = row.querySelector('input[type="checkbox"]');
        if (box) box.checked = row.style.display !== 'none';
    }
    toggleWiCustomEntry();
}

export function updateWiCustomFilteredBtn() {
    const btn = win.querySelector('#pad-wic-filtered');
    if (!btn) return;
    const f = win.querySelector('#pad-wic-entries-filter');
    btn.disabled = !(f && f.value && f.value.trim());
}

// 切聊天 / 开设置面板：下拉是「自定义」就按【当前聊天】重画（清单自己读 metadata）。
export function refreshWiCustomUI() {
    if (!win || !ENABLE_WI_CUSTOM_PICK) return;
    const sel = win.querySelector('#pad-wi');
    if (sel && sel.value === 'custom') populateWiCustomBooks(false);
}