import { deserializeEntrySel, getDiagWiMeta, getSummary } from '../../core/chat-metadata.js';
import { getCtx, getSettings } from '../../core/settings.js';
import { sharedState } from '../../core/state.js';
import { builderDraftRefBlock, getBuilderState } from '../advisor/metadata.js';
import { buildBbsHistorySection, buildCardSection, buildLwbHistorySection, buildSummarySection, buildTranscript, getBbsHistoryText, getLwbSummaryText, renderMarkdownOnly } from '../chat/context.js';
import { activeUidsFromScan, mergeHybridUids } from '../fix/templates.js';
import { entryPreviewText } from './ui.js';
import { ENABLE_BUILTIN_JAILBREAK, SO_JB_SENTINEL } from '../../presets/builtin-jailbreak.js';
import { ENABLE_BUILDER_PERSONA_STYLES, ENABLE_DIAG_WI_PICKER } from '../../prompts/builtins.js';
import { buildPersonaBlock, builderForgePromptFor, builderInterviewPromptFor, builderTargetLabel } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { foldExtraScanText, getWiScanBudget, isMvuRuleEntry, loadWorldInfoModule, sideChatScanBlob } from '../../st/adapters.js';
import { locateTagOpen } from '../../ui/messages.js';
import { escapeHtml } from '../../ui/mode-shell.js';
import { presetCurationActive } from '../../ui/settings.js';

/* ------------------------------------------------------------------ *
 * 诊断模式「精选世界书条目」喂料（用户功能请求；总开关 ENABLE_DIAG_WI_PICKER）。
 * 与世界书扫描（buildWorldInfo）分开：精选直接从【原始世界书】按本聊天保存的 uid 选择取条目，
 * 无视 ST 的启用 / 禁用状态——这正是要点（被禁用的变量规则条目也能喂给诊断）。
 * ------------------------------------------------------------------ */
// 诊断「精选条目」当前是否生效：总开关开 + 本聊天 L1（use）已勾选。两处喂料点用它决定走精选还是原行为。
export function diagPickerActive() {
    return ENABLE_DIAG_WI_PICKER && getDiagWiMeta().use;
}


// 跑一次 ST 的 dry-run 世界书扫描（与 buildWorldInfo('st') 同输入），取当前【真正被激活】的条目，
// 整理成 { 书名: Set<uid> }。用于「仅角色相关世界书」、「自定义」范围（快照 / 混合绿灯）、
// 工坊关键词补充、诊断精选两处（首开快照 / 混合模式）。
//
// ⚠ 入口必须是 world-info.js 的 checkWorldInfo，不能是 ctx.getWorldInfoPrompt：
// getWorldInfoPrompt 只转发【装配好的插入位字符串】（worldInfoBefore/After/anBefore/…），
// 带 world+uid 的 allActivatedEntries 从来只出现在内层 checkWorldInfo 的返回里（ST 历来如此，
// 非新版回归）。读 getWorldInfoPrompt(...).allActivatedEntries 恒为 undefined → 本函数恒回 {}
// → 「仅角色相关世界书」永远发不出任何世界书（2026-07-26 live 用户报障的真因）。
// 老版本 ST 未导出 checkWorldInfo 时回 {}（= 修复前的行为，调用方自然退化）。
export async function getActiveScanUids(extraScanText) {
    const ctx = getCtx();
    try {
        const wiMod = await loadWorldInfoModule();
        if (!wiMod || typeof wiMod.checkWorldInfo !== 'function') return {};
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse();
        foldExtraScanText(chatForWI, extraScanText);   // 额外扫描文本（侧聊折叠文本；不传 = 原样）
        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };
        const budget = await getWiScanBudget();
        // isDryRun=true —— 与 buildWorldInfo('st') 同款：不动主聊天的 sticky / cooldown 状态。
        const res = await wiMod.checkWorldInfo(chatForWI, budget, /*isDryRun*/ true, globalScanData);
        return activeUidsFromScan(res && res.allActivatedEntries);
    } catch (e) {
        console.warn('[Story Oracle] Active WI scan failed:', e);
        return {};
    }
}

// 诊断精选喂料。选择从【元数据】读（无状态——自动诊断窗口关着也对），按选中 uid 从原始书取条目，逐条
// substituteParams（诊断只读不编辑，故可展开宏，与 collectMvuRuleContents 一致）。混合模式（L2）再并入主聊天
// 当前命中的【绿灯】（蓝灯不并——要么已选、要么用户有意不选）。返回 { block, selectedEntries }：block 拼进
// 诊断的 worldInfoBlock，selectedEntries 供 diagSelHasRules 判断是否含变量规则条目。无选择 / 无法访问模块时回空。
export async function buildDiagSelectedWi() {
    const ctx = getCtx();
    const meta = getDiagWiMeta();
    const mod = await getWiEditApi();
    if (!mod) return { block: '', selectedEntries: [] };

    // 选择映射（书名 -> Set<uid>），只留非空选择。
    let selMap = {};
    for (const [b, s] of Object.entries(deserializeEntrySel(meta.sel))) if (s.size) selMap[b] = s;

    // 混合模式：把主聊天当前命中的绿灯 uid 并进选择。
    if (meta.hybrid) {
        try {
            const active = await getActiveScanUids();           // { 书名: Set<uid> }（含蓝 + 绿）
            const greens = {};
            for (const name of Object.keys(active)) {
                let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
                const all = data && data.entries ? Object.values(data.entries) : [];
                const g = new Set();
                for (const e of all) {
                    if (e && active[name].has(Number(e.uid)) && e.constant !== true) g.add(Number(e.uid)); // 仅绿灯
                }
                if (g.size) greens[name] = g;
            }
            selMap = mergeHybridUids(selMap, greens);
        } catch (e) { /* 混合失败就只用精选 */ }
    }

    const books = Object.keys(selMap);
    if (!books.length) return { block: '', selectedEntries: [] };

    const subst = (v) => { try { return ctx.substituteParams(String(v == null ? '' : v)); } catch (_) { return String(v == null ? '' : v); } };
    const blocks = [];
    const selectedEntries = [];
    for (const name of books) {
        let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        const want = selMap[name];
        const entries = Object.values(data.entries)
            .filter((e) => e && want.has(Number(e.uid)) && typeof e.content === 'string' && e.content.trim())
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        if (!entries.length) continue;
        for (const e of entries) selectedEntries.push(e);
        const body = entries.map((e) => subst(e.content).trim()).join('\n\n');
        blocks.push(`=== 世界书：${name}（精选 ${entries.length} 条）===\n${body}`);
    }
    return { block: blocks.join('\n\n'), selectedEntries };
}


/* ------------------------------------------------------------------ *
 * 世界书模块访问（原版供世界书模式读写；精简版只用它读书）。
 *
 * Reuses the same world-info.js module loaded for the 'all'/'st' scans, but
 * needs its editing exports too (loadWorldInfo / saveWorldInfo / create+delete
 * entry / reloadEditor / world_names). Returns the module only when those are
 * present, so a stripped-down ST build degrades gracefully instead of throwing.
 * ------------------------------------------------------------------ */
export async function getWiEditApi() {
    const mod = await loadWorldInfoModule();
    if (mod && typeof mod.loadWorldInfo === 'function' && typeof mod.saveWorldInfo === 'function') {
        return mod;
    }
    return null;
}

// Names of every book that's currently active for this character/chat/global.
export async function getActiveBookNames() {
    const mod = await loadWorldInfoModule();
    if (!mod || typeof mod.getSortedEntries !== 'function') return [];
    try {
        const sorted = await mod.getSortedEntries();
        return [...new Set((sorted || []).map((e) => e && e.world).filter(Boolean))];
    } catch (e) {
        console.warn('[Story Oracle] Could not enumerate active world books:', e);
        return [];
    }
}

// All known world-book names (every file, active or not).
export async function getAllBookNames() {
    const mod = await loadWorldInfoModule();
    const names = mod && Array.isArray(mod.world_names) ? mod.world_names : [];
    return [...names].filter(Boolean);
}

// 「角色 + 对话相关」书名（纯）：卡内嵌 ∪ charLore 绑定 ∪ 对话绑定，再 ∩ 现存书；去重、保序。
// 全局多选 / 人设书靠调用方根本不传进来而排除。
function pickCharChatBooks(cardWorld, charLoreExtra, chatWorldNames, allBookNames) {
    const all = new Set(allBookNames || []);
    const out = [];
    const seen = new Set();
    const add = (n) => { if (n && all.has(n) && !seen.has(n)) { seen.add(n); out.push(n); } };
    add(cardWorld);
    (Array.isArray(charLoreExtra) ? charLoreExtra : []).forEach(add);
    (Array.isArray(chatWorldNames) ? chatWorldNames : []).forEach(add);
    return out;
}

// 从 ST 收集原始来源、归一化，交给纯选择器。组聊 / 无角色 / 老版本 ST 时各来源自然退化为空。
export async function getCharChatBookNames() {
    const ctx = getCtx();
    const mod = await loadWorldInfoModule();
    let cardWorld = null;
    const charLoreExtra = [];
    const chatWorldNames = [];
    try {
        const chid = ctx.characterId;
        const ch = (ctx.characters || [])[chid];
        cardWorld = (ch && ch.data && ch.data.extensions && ch.data.extensions.world) || null;
        const charLore = mod && mod.world_info ? mod.world_info.charLore : null;
        if (Array.isArray(charLore) && ch) {
            const fname = typeof ctx.getCharaFilename === 'function'
                ? ctx.getCharaFilename(chid)
                : (ch.avatar ? String(ch.avatar).replace(/\.[^.]+$/, '') : null);
            const rec = fname ? charLore.find((e) => e && e.name === fname) : null;
            if (rec && Array.isArray(rec.extraBooks)) rec.extraBooks.forEach((b) => b && charLoreExtra.push(b));
        }
    } catch (e) { /* group chat / no character */ }
    try {
        const cw = (ctx.chatMetadata || {}).world_info;
        if (typeof cw === 'string') chatWorldNames.push(cw);
        else if (Array.isArray(cw)) cw.forEach((b) => b && chatWorldNames.push(b));
        else if (cw && typeof cw === 'object') {
            if (cw.primary) chatWorldNames.push(cw.primary);
            if (Array.isArray(cw.additional)) cw.additional.forEach((b) => b && chatWorldNames.push(b));
        }
    } catch (e) { /* no chat-bound book */ }
    const all = await getAllBookNames();
    return pickCharChatBooks(cardWorld, charLoreExtra, chatWorldNames, all);
}

// 世界书多选：把「选中集合」解析成实际操作的书名列表。空 = 跟随当前激活（动态）；
// 否则取选中里仍存在于磁盘的那些（去重、保序）。纯函数，便于单测。
export function resolveLbTargetNames(targets, allBookNames, activeBookNames) {
    if (!Array.isArray(targets) || targets.length === 0) return (activeBookNames || []).slice();
    const all = new Set(allBookNames || []);
    const out = [];
    const seen = new Set();
    for (const n of targets) {
        if (n && all.has(n) && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

// 世界书选书器的书名搜索：查询按大小写不敏感的子串匹配书名；空 / 空白查询＝全部匹配。
// 纯函数，「自定义」范围的选书器在用，可单测。
export function bookNameMatchesQuery(name, query) {
    const needle = String(query || '').trim().toLowerCase();
    return !needle || String(name || '').toLowerCase().includes(needle);
}

// 工坊「写入」目标世界书回退判定（纯函数）：picked = resolveLbTargetNames(s.bldBooks, all, active) 的结果
//（与选书器「已选 N 本」读数同源、已滤掉磁盘上不存在的书）。恰一本 → {book}；零本 → {err:'none'}；
// 多本 → {err:'multi',count}。draft 自带 book 时调用方直接用、不进这里。可单测（builder-book-target.test.mjs）。
export function resolveBuilderTargetBook(picked) {
    const list = Array.isArray(picked) ? picked : [];
    if (list.length === 1) return { book: list[0] };
    if (!list.length) return { err: 'none' };
    return { err: 'multi', count: list.length };
}

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

function lbFormatEntry(e) {
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
function estimateTokensForText(text) {
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
function bldPickFedEntries(entries, sel) {
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

/**
 * Build the structured "book -> entries" listing for lorebook mode, and record
 * which books it covers (lbBookNames). Honors s.lorebookTarget: a specific book
 * name, or '' for every active book. Stores nothing by reference — apply re-reads
 * the books fresh — so this is purely a read for context.
 */
export async function buildLorebookContext() {
    sharedState.lbContextText = '';
    sharedState.lbBookNames = [];
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) {
        sharedState.lbContextText = '（无法访问世界书模块 —— 当前 ST 版本可能不支持。）';
        return;
    }

    const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
    const names = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    if (!names.length) {
        sharedState.lbContextText = (Array.isArray(s.lorebookTargets) && s.lorebookTargets.length)
            ? '（选中的世界书都找不到了。请在上方重新勾选，或点刷新。）'
            : '（当前没有激活任何世界书。可在上方勾选某一本来编辑。）';
        return;
    }

    const ctx = getCtx();
    const blocks = [];
    for (const name of names) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        sharedState.lbBookNames.push(name);
        let entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        const total = entries.length;
        // Per-entry selection works in BOTH single-book and all-active mode — the
        // filter is keyed by book name either way. A Set (even empty) means "send
        // exactly these"; null/absent means "send all". Apply still re-reads the
        // whole book, so editing any uid keeps working.
        const sel = sharedState.lbEntryFilter[name];
        const filtered = (sel instanceof Set);
        if (filtered) entries = entries.filter((e) => sel.has(e.uid));
        const body = entries.length
            ? entries.map(lbFormatEntry).join('\n\n')
            : (filtered ? '（未选择任何条目——请在上方勾选要发送给我的条目。）' : '（此世界书暂无条目。）');
        const head = filtered
            ? `=== 世界书：${name}（已选 ${entries.length} / 共 ${total} 条）===`
            : `=== 世界书：${name}（共 ${total} 条）===`;
        blocks.push(`${head}\n${body}`);
    }

    sharedState.lbContextText = blocks.join('\n\n') || '（未能读取到任何世界书条目。）';
    // Show entry content VERBATIM — do NOT substituteParams it. The lore manager EDITS
    // these books, and macros ({{user}}/{{char}} …) are stored literally. The old
    // behavior expanded them "for readability", so the model anchored on the persona /
    // char NAME (e.g. "Chris") while storage still held "{{user}}" → patch 锚点未找到 on
    // apply (lbFuzzyReplace matches the literal content loadWorldInfo returns), and it
    // risked baking the name into the book. Instead, keep it literal and prepend a small
    // legend giving the macro values, so chat stays readable without touching content.
    if (sharedState.lbContextText.indexOf('{{') !== -1) {
        const pairs = [];
        try {
            const u = ctx.substituteParams('{{user}}');
            const c = ctx.substituteParams('{{char}}');
            if (u && u !== '{{user}}') pairs.push(`{{user}} = 「${u}」`);
            if (c && c !== '{{char}}') pairs.push(`{{char}} = 「${c}」`);
        } catch (e) { /* no ctx — skip the name mapping, keep the literal-macro note */ }
        const names = pairs.length ? `当前 ${pairs.join('、')}。` : '';
        sharedState.lbContextText = P('lb.macroLegend', { names }, s) + '\n\n' + sharedState.lbContextText;
    }
}

// 角色工坊上下文：勾选的世界书条目【原样】投喂 + 宏说明（与世界书模式同规则，不 substituteParams——
// 补丁锚点要对上字面 {{user}}/{{char}}）。自成一份、不动 buildLorebookContext；选书走 s.bldBooks、选条目走 bldEntryFilter。
export async function buildBuilderContext() {
    sharedState.bldContextText = '';
    sharedState.bldScanWiText = '';
    sharedState.bldBookNames = [];
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) { sharedState.bldContextText = '（无法访问世界书模块。）'; return; }
    const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
    const names = resolveLbTargetNames(s.bldBooks, allNames, activeNames);
    const blocks = [];
    for (const name of names) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        sharedState.bldBookNames.push(name);
        let entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        const total = entries.length;
        // 1.82.0：唯一的选择规则（缺键 / null = 全部【启用】的；显式 Set = 恰好这些，禁用也发）。
        // 抬头的「共 M 条」仍报全书条数——收窄了多少一眼可见。
        entries = bldPickFedEntries(entries, sharedState.bldEntryFilter[name]);
        if (!entries.length) continue;
        blocks.push(`=== 世界书：${name}（已选 ${entries.length} / 共 ${total} 条）===\n` + entries.map(lbFormatEntry).join('\n\n'));
    }
    sharedState.bldContextText = blocks.join('\n\n');
    sharedState.bldScanWiText = await buildBldScanWiText(s);   // opt-in（bldScanWi 关时空串）
    // 宏未替换说明：两块（选条目 + 关键词命中）合并判定，注在第一块非空块头上（原样投喂共同的说明）。
    if ((sharedState.bldContextText + sharedState.bldScanWiText).indexOf('{{') !== -1) {
        const macroNote = P('bld.macroNote', null, s) + '\n\n';
        if (sharedState.bldContextText) sharedState.bldContextText = macroNote + sharedState.bldContextText;
        else sharedState.bldScanWiText = macroNote + sharedState.bldScanWiText;
    }
}

// 工坊 opt-in（bldScanWi）：关键词命中的补充世界书条目。跑 ST 真实扫描（蓝灯 + 主聊天 / 卡 / 工坊侧聊
// 命中的绿灯——侧聊窗口同 sideChatScanBlob），剔除【选条目器已投喂】的条目（bldBookNames + bldEntryFilter
// 语义：无 Set = 全部启用的已喂；本函数本来就只收启用条目，故整块剔除仍然精确，1.82.0）与 [mvu_update] 机制规则（诊断专属，镜像 MVU 的 UPDATE_REGEX），lbFormatEntry
// 原样格式与 bldContextText 一致。选条目器仍是唯一的「角色生成规则」权威——这块只是参考补充。
async function buildBldScanWiText(s) {
    if (!s.bldScanWi) return '';
    const mod = await getWiEditApi();
    if (!mod) return '';
    try {
        const active = await getActiveScanUids(await sideChatScanBlob());   // { 书名: Set<uid> }
        const blocks = [];
        for (const name of Object.keys(active)) {
            let data; try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
            if (!data || !data.entries) continue;
            const fedWholeBook = sharedState.bldBookNames.includes(name) && !(sharedState.bldEntryFilter[name] instanceof Set);
            const sel = sharedState.bldBookNames.includes(name) ? sharedState.bldEntryFilter[name] : null;
            const entries = Object.values(data.entries)
                .filter((e) => e && active[name].has(Number(e.uid)) && !e.disable && typeof e.content === 'string' && e.content.trim())
                .filter((e) => !(fedWholeBook || (sel instanceof Set && sel.has(e.uid))))          // 已在 bldContextText 里 → 剔除
                .filter((e) => !/\[mvu_update\]/i.test(String(e.comment || '')))                   // 机制规则不进工坊
                .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            if (entries.length) blocks.push(`=== 世界书：${name}（关键词命中 ${entries.length} 条）===\n` + entries.map(lbFormatEntry).join('\n\n'));
        }
        return blocks.join('\n\n').trim();
    } catch (e) {
        console.warn('[Story Oracle] 工坊关键词扫描失败：', e);
        return '';
    }
}

// 角色工坊访谈的系统提示：访谈师提示 + 三区块格式契约 + 当前目标/部分 + 人格皮肤 + 卡/世界书/变量/概要/对话记录。
// 上下文块用 buildBuilderContext 预填的 bldContextText/bldStatData（generateReply 里发送前刷新）。
// 用 { ...s, contextDepth: s.bldDepth } 的浅拷贝喂 buildTranscript（它读 contextDepth/applyRegex/includeHiddenFloors），
// 让「应用剧情正则」自动生效——绝不原地改 s（引用稳定性）。
export function buildBuilderPrompt(ctx, s) {
    const variantKey = builderVariantKey(s);
    const parts = [builderInterviewPromptFor(variantKey), P('bld.protocol', null, s)];
    parts.push(P('bld.target', { target: builderTargetLabel(s) }, s));
    parts.push(builderSectionsLine(s));
    // 外貌必问行只进访谈（锻造有自己的 look 块）；未勾外貌时行不存在 = 物理门控。
    const lookAsk = builderLookAskLine(s);
    if (lookAsk) parts.push(lookAsk);
    const personaBlock = buildPersonaBlock(s.personaId, 'builder', s);
    if (personaBlock) parts.push(personaBlock);
    // 修订：把当前草稿（激活变体）作为【权威现文】喂入——DraftPatch 锚点从它逐字复制（见 builderDraftRefBlock）。
    // 访谈阶段（无草稿）此块为空 = filter(Boolean) 滤掉，行为不变。
    parts.push(builderDraftRefBlock(getBuilderState()?.draft));
    parts.push(buildCardSection(ctx));
    if (sharedState.bldContextText) parts.push(P('bld.wi', { wi: sharedState.bldContextText }, s));
    if (sharedState.bldScanWiText) parts.push(P('bld.scanWi', { wi: sharedState.bldScanWiText }, s));
    if (sharedState.bldStatData) parts.push(P('bld.stat', { stat: sharedState.bldStatData }, s));
    if (s.bldIncludeSummary) {
        const sum = buildSummarySection(getSummary());
        if (sum) parts.push(sum);
        const bbs = buildBbsHistorySection(getBbsHistoryText());   // 柏宝书记忆桥（沿用概要开关）
        if (bbs) parts.push(bbs);
        const lwb = buildLwbHistorySection(getLwbSummaryText());   // 小白X 记忆桥（同位柏宝书）
        if (lwb) parts.push(lwb);
    }
    const transcript = buildTranscript(ctx, { ...s, contextDepth: s.bldDepth });
    if (transcript) parts.push(P('bld.transcript', { transcript }, s));
    return parts.filter(Boolean).join('\n\n');
}

// 锻造调用的完整消息组：system = 工序提示 + 区块契约 + 目标 / 部分 + 卡 / 世界书 / 变量 / 概要 / 对话记录
//（与访谈 buildBuilderPrompt 同一套上下文块，但不叠人格皮肤——锻造是机械工序，不是聊天）；user = brief 原文。
// 上下文块用 buildBuilderContext 预填的 bldContextText/bldStatData（runForge 发送前刷新）。
// buildTranscript 同款浅拷贝喂 { ...s, contextDepth: s.bldDepth }——绝不原地改 s（引用稳定性）。
export function buildForgeMessages(ctx, s, brief) {
    // #3：发送前对 FORGE_PROMPT 段施加 chip 物理门控——未勾件从提示词里物理删除/重写（所见即所得）。
    const variantKey = builderVariantKey(s);
    const v = BUILDER_VARIANTS[variantKey];
    const gatedForge = gateForgePrompt(builderForgePromptFor(variantKey), builderSelectedSections(s).map((x) => x.id), v.chipHeaders, v.assemblyOrder, v.assemblyTail);
    const parts = [gatedForge, P('bld.protocol', null, s)];
    parts.push(P('bld.target', { target: builderTargetLabel(s) }, s));
    parts.push(builderSectionsLine(s));
    if (s.bldDlgRich) parts.push(P('bld.dlgRich', null, s));
    parts.push(buildCardSection(ctx));
    if (sharedState.bldContextText) parts.push(P('bld.forgeWi', { wi: sharedState.bldContextText }, s));
    if (sharedState.bldScanWiText) parts.push(P('bld.forgeScanWi', { wi: sharedState.bldScanWiText }, s));
    if (sharedState.bldStatData) parts.push(P('bld.stat', { stat: sharedState.bldStatData }, s));
    if (s.bldIncludeSummary) {
        const sum = buildSummarySection(getSummary());
        if (sum) parts.push(sum);
        const bbs = buildBbsHistorySection(getBbsHistoryText());   // 柏宝书记忆桥（沿用概要开关）
        if (bbs) parts.push(bbs);
        const lwb = buildLwbHistorySection(getLwbSummaryText());   // 小白X 记忆桥（同位柏宝书）
        if (lwb) parts.push(lwb);
    }
    const transcript = buildTranscript(ctx, { ...s, contextDepth: s.bldDepth });
    if (transcript) parts.push(P('bld.transcript', { transcript }, s));
    return [
        { role: 'system', content: parts.filter(Boolean).join('\n\n') },
        { role: 'user', content: P('bld.forgeAsk', { brief: brief.raw }, s) },
    ];
}

// 访谈回复的显示渲染（与参谋 renderAdvisorReplyHtml 同构）：散文段渲 Markdown（只走 renderMarkdownOnly，不碰正则引擎），
// <CharBrief>/<CharDraft>/<DraftPatch> 区块进 <pre class="so-plan-raw"> 转义原样（区块解析走 classifyBuilderReply 从
// 【字符串】读，与这里的 DOM 渲染无关）。库缺失（无 showdown/DOMPurify）→ 返回 null，调用方回退纯文本。
export function renderBuilderReplyHtml(text) {
    const segs = splitBuilderSegments(String(text || ''));
    if (!segs.some((x) => x.type === 'block')) return renderMarkdownOnly(String(text || ''));
    let html = '';
    for (const seg of segs) {
        if (seg.type === 'block') {
            html += '<pre class="so-plan-raw">' + escapeHtml(seg.text) + '</pre>';
        } else if (seg.text.trim()) {
            const h = renderMarkdownOnly(seg.text);
            if (h == null) return null;   // 库缺失 → 整条回退纯文本（不出半渲染的杂拼）
            html += h;
        }
    }
    return html;
}

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
const lbToStrArray = (v) => (Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter(Boolean)
    : String(v == null ? '' : v).split(/[,，、]/).map((x) => x.trim()).filter(Boolean));

// Whitelist of editable fields and their coercions. Values arrive as strings (from
// "key: value" header lines), so coercions are string-aware — a stray field the
// model invents can never write garbage into a book.
const LB_FIELD_COERCE = {
    content: (v) => String(v == null ? '' : v),
    comment: (v) => String(v == null ? '' : v),
    key: lbToStrArray,
    keysecondary: lbToStrArray,
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

// 喂给模型的指令提示词。中文、家规口吻；【绝不含反引号】（本身是模板字符串，内嵌反引号 = SyntaxError），
// 内联字面一律用「」。三块文法与引擎解析器（parseLbSearch/Fetch/SelectBlocks）逐字对齐。
export const LB_SMART_SELECT_PROMPT = [
    '你是《剧情推进》世界书选择器里的「智能选条」助手。用户会用自然语言下一条勾选指令（例如「把讲战争线的绿灯条目全勾上」',
    '「取消所有涉及感情戏的」「勾上包含某某设定的那几本书」）。你的唯一职责：产出一份【勾选计划】，指明每本书要勾选 / 取消勾选',
    '哪些条目。',
    '',
    '【硬边界】你只能【改动勾选状态】，绝不编辑、新增、删除任何条目内容。「删掉讲 X 的条目」这类指令不在你职责内——请在计划外',
    '用一句话告诉用户「这是内容编辑，请到世界书聊天模式正常提改动」，不要试图用勾选去实现它。',
    '',
    '【你拿到的目录】下方〔条目目录〕按书分组，每条一行，含：uid、当前勾选态（✔已勾 / ✖未勾）、灯色（🔵蓝灯·常驻 /',
    '🟢绿灯 / ⚫已禁用）、组、标题、关键词、正文首约 120 字。表头「已勾 X / 共 N 条」告诉你这本书当前的精选状态。',
    '「取消勾选所有…」类指令要靠这里的✔/✖来判断动谁。',
    '',
    '【两个免费原语——不确定时先用，别硬猜】目录只给正文开头，若判断某条「到底讲不讲某事」需要看更多，你可以先发下面的块',
    '（一次回复可发多个；发了就【本轮先不出勾选计划】，引擎会把结果回给你，你下一轮再定）：',
    '',
    '· 机械扫描正文（免费、瞬时）：',
    '<LorebookSearch>',
    'keywords: 战争, 联赛, 兽潮',
    'scope: 雨宫家, 学园',
    '</LorebookSearch>',
    'keywords 是逗号分隔的【字面子串】（大小写 / 全半角不敏感；【不接受正则】——普通词就够）。scope 可选、限定在哪些书里搜，',
    '缺省 = 全部范围内的书。引擎回你「哪些条目命中了、每条几段带上下文的摘录」。',
    '',
    '· 取整条原文（当摘录仍拿不准时，点名要几条全文）：',
    '<LorebookFetch>',
    'uid: 12, 13',
    'book: 雨宫家',
    '</LorebookFetch>',
    'uid 逗号分隔（必填）；book 可选（缺省时引擎按持有该 uid 的书自己找）。引擎回你这几条的【逐字原文】。',
    '',
    '【最终动作——勾选计划】想清楚后，用下面的块给出计划（一本书一块，可多块）：',
    '<LorebookSelect>',
    'book: 雨宫家',
    'select: 12, 17, 24',
    'deselect: 5, 8',
    'reason-12: 正文直述战争线主将',
    'reason-5: 纯感情戏支线',
    '</LorebookSelect>',
    'select / deselect 至少给一个，值是 uid 列表；要整本勾满 / 整本取消用「select: 全部」/「deselect: 全部」。',
    'reason-<uid> 可选，一行简短理由（会显示在给用户的预检卡上，帮用户判断你选得对不对）。只用目录里真实存在的 uid。',
    '',
    '【收敛纪律】能一轮出计划就别绕：目录通常已经够判断。至多 2 个额外来回（Search / Fetch）——一旦你发出 <LorebookSelect>',
    '就是终局，引擎不再问你。若同一条回复里既有 <LorebookSelect> 又有 Search/Fetch，后者会被忽略。',
    '直接输出上述块，不要包在代码围栏里，块外可以用一两句中文说明你的判断。',
].join('\n');

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
    const uids = lbToStrArray(raw).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
    return uids.length ? { uids } : null;
}

// <LorebookSearch>：keywords（逗号分隔【字面】子串，必填）+ 可选 scope 书名列表。缺 keywords = 错误。纯 → 单测。
export function parseLbSearchBlocks(text) {
    const searches = [];
    const errors = [];
    lbSmartEachBlock(text, 'LorebookSearch', (inner) => {
        const h = lbSmartHeaders(inner);
        const keywords = lbToStrArray(h.keywords);
        if (!keywords.length) { errors.push({ error: 'LorebookSearch 缺少 keywords' }); return; }
        const scope = ('scope' in h) ? lbToStrArray(h.scope) : [];
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
        const uids = lbToStrArray(h.uid != null ? h.uid : h.uids).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n));
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
    const kws = (Array.isArray(keywords) ? keywords : lbToStrArray(keywords)).map((k) => String(k).trim()).filter(Boolean);
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

// ===== 角色工坊：区块解析（CharBrief / CharDraft / DraftPatch）=====
// 与世界书区块同族：键值头 + <<<tag … tag>>> 围栏，绝不使用 JSON。
const BLD_TARGETS = ['persona-update', 'persona-new', 'npc-new', 'npc-edit'];

// 角色工坊：可勾选的草稿部分。id 进设置，label 是 chip 文案（锻造提示词按 label 引用——改label要同步）。
// def = 默认开：默认集 = 写卡教室的必修层 + 防误读；默认关 = 教程自己标注「视角色而定」的进阶件
// （多副面孔/言行反差/点睛比喻）+ 可选清单项（弱点缺陷/能力技能——2026-07-08 Prince 裁定默认关、
// 排到普通 chip 行末尾）。adv:true = 进阶三件（默认关、UI 归一组给指引）。
// #2 reframe：勾选=要求锻造工序做出来（用户说了算，工序不再自判适用性——不合适是用户的责任，UI 指引兜底）。
const BUILDER_SECTIONS = [
    { id: 'basics',      label: '基本信息', def: true,  desc: '姓名、年龄、性别、身份，以及和你的关系定位' },
    { id: 'appearance',  label: '外貌特征', def: true,  desc: '只写认得出TA的特征——遮住名字也知道是谁' },
    { id: 'backstory',   label: '背景经历', def: true,  desc: '改变过TA的关键事件（因果链），不堆生平流水账' },
    { id: 'relations',   label: '人际关系', def: true,  desc: '和重要人物的具体相处画面，不写抽象总结' },
    { id: 'personality', label: '性格画像', def: true,  desc: '三层颜色（底色/主色调/点缀）+ 具体场景衍生，不贴标签' },
    { id: 'speech',      label: '说话方式', def: true,  desc: 'TA怎么开口——语气、口癖、台词示例' },
    { id: 'goals',       label: '目标动机', def: true,  desc: 'TA现在想要什么、被什么驱动' },
    { id: 'depth',       label: '深层人格', def: true,  desc: 'AI推导的决策层：TA真正缺什么、怕什么、底线在哪（默认开，简单角色可关）' },
    { id: 'antimisread', label: '防误读提示', def: true,  desc: '提前拦住AI最容易演歪的方向（比如把安静演成冷漠、把拒绝演成傲娇）' },
    // retired（2026-07-08 Prince 裁定）：行为逻辑 chip 从面板退役——UI 不显示、老存档选择由 getSettings
    // 迁移滤掉；提示词 ■ 块 / 门控 / 调优 rig 全保留（rig 喂显式 id 数组、不经 UI 闸）。复活 = 删掉此旗。
    { id: 'habits',      label: '行为逻辑', def: false, retired: true, desc: '日常琐事里TA会怎么做——吃亏/尴尬/求助时的具体反应画面（可选，勾了才生成）' },
    // 可选两件（2026-07-08 Prince：默认关、排在普通 chip 行末尾——想要就勾，锻造才会写）。
    { id: 'flaws',       label: '弱点缺陷', def: false, desc: '短板、软肋，以及TA保护自己的方式（可选，勾了才生成）' },
    { id: 'abilities',   label: '能力技能', def: false, desc: '会什么、擅长什么、边界在哪（可选，默认不写，勾了才生成）' },
    // 进阶三件（adv）排在最末、UI 前面挂一条「简单/喜剧角色留空」标签——门控已移交用户（#2 reframe）。
    { id: 'faces',       label: '多副面孔', def: false, adv: true, desc: '〔进阶·按需〕同一个人在压力场景间判若两人才勾——性格始终如一的角色不必勾' },
    { id: 'mix',         label: '言行反差', def: false, adv: true, desc: '〔进阶·按需〕内心有拉扯、嘴上身体不一致的角色才勾——实心眼直性子不必勾' },
    { id: 'imagery',     label: '点睛比喻', def: false, adv: true, desc: '〔进阶·按需〕用一个总比喻收束整个角色（如「冬天窗台上那一小格阳光」）——功能型/喜剧型可跳过' },
];

// 面板可见的 chips（retired 件不出现）。UI 渲染 / 图例都从这里取——retired 的死角由它 + getSettings
// 迁移兜住；builderSelectedSections 本身对显式 id 数组保持透明（调优 rig 契约，ALL15 feeds 不受影响）。
export function builderVisibleSections(table = BUILDER_SECTIONS) {
    return table.filter((x) => !x.retired);
}

// 存档迁移（Tier 0 ④，1.25.0，Prince 定案「重置 + 告知」）：1.24.0 把手动校正默认改成精简上下文，但 getSettings
// 只补【缺失】键——老档里已落盘的旧默认（-1 全部前文 / 世界书开 / 概要开）会永远保留，而他们正是高上下文投诉高发
// 人群。只翻【仍等于旧默认值】的键（用户自定义的 30 层等不动）；fixLeanMigrated 打标防重跑；想全量的用户在
// 「校正设置」把前文条数改回 -1 即可（迁移提示里写明）。init 里在 buildWindow 之前调用一次 + 弹一次告知。纯函数、可单测。
export function migrateFixLeanDefaults(s) {
    if (!s || typeof s !== 'object' || s.fixLeanMigrated) return { migrated: false, hit: [] };
    s.fixLeanMigrated = true;
    const hit = [];
    if (s.fixM_contextDepth === -1) { s.fixM_contextDepth = 0; hit.push('前文'); }
    if (s.fixM_includeWorld === true) { s.fixM_includeWorld = false; hit.push('世界书'); }
    if (s.fixM_includeSummary === true) { s.fixM_includeSummary = false; hit.push('剧情概要'); }
    return { migrated: hit.length > 0, hit };
}


/* 一次性迁移（1.40.0）：把「没选任何预设」的用户预选到内置破限。Prince 2026-07-26 定案：
 *   · 新装 / 从没设过预设 / 选了但没策展完 → 预选内置破限（普通聊天即刻生效）
 *   · 已选了预设【且】真的策展过 → 完全不动（选择不碰、开关不碰）
 * 参谋的开关（advisorUsePreset）【不动】＝ 保持 opt-in，所以本函数只碰 sysPromptPresetName 一个键。
 *
 * 【不能靠改默认值实现】：getSettings 只补 undefined 的键，而老用户的 sysPromptPresetName
 * 已经显式落盘成 ''，永远轮不到默认值。必须显式迁移。
 *
 * 「选了但没策展完」归入第一类：那种半选状态本就 presetCurationActive()===false ＝ 等于没生效，
 * 设置行还会显红字报错，不是「有效且已策展的预设」。
 *
 * ⚠ 时序陷阱见 populateSysPromptPresets：预设被删 / 改名的用户，名字要到【开窗时】才被清成 ''，
 * 那时本迁移早已跑完并打了标记，他们会被漏掉——所以那边清空时会补判一次。
 * 纯函数、可单测。
 */
export function migrateBuiltinJbDefault(s) {
    if (!ENABLE_BUILTIN_JAILBREAK) return { migrated: false };
    if (!s || typeof s !== 'object' || s.builtinJbMigrated) return { migrated: false };
    s.builtinJbMigrated = true;
    // 「有效且已策展」＝ 名字非空【且】快照里真有内容。只有这一类完全不动。
    if (s.sysPromptPresetName && presetCurationActive(s)) return { migrated: false };
    s.sysPromptPresetName = SO_JB_SENTINEL;
    return { migrated: true };
}

// 存档迁移（getSettings 调用）：把 retired chip 从已保存的显式选择里滤掉——不然老存档会隐形续用
// 一个面板上已不存在、也无法取消的件。null / 非数组原样放行。纯函数、可单测。
export function sanitizeBldSections(sel) {
    if (!Array.isArray(sel)) return sel;
    const retired = new Set(BUILDER_SECTIONS.filter((x) => x.retired).map((x) => x.id));
    return sel.some((id) => retired.has(id)) ? sel.filter((id) => !retired.has(id)) : sel;
}

// 打造目标归一（纯函数、可单测）：旧档 'persona' → 'persona-nosteal'；不认识的值回默认。
// 只在 ENABLE_BUILDER_PERSONA_STYLES 开启时由 getSettings 调用——关着时旧值原样保留（回退零损伤）。
export function normalizeBldTarget(v) {
    if (v === 'persona') return 'persona-nosteal';
    if (v === 'npc' || v === 'persona-steal' || v === 'persona-nosteal') return v;
    return 'persona-nosteal';
}

// 把设置里的 chip 选择解析成 section 对象数组：变体自 builderVariantKey 定，各读自己的 sectionsKey
// （null = 该变体表里 def:true 的那些；否则显式 id 数组），顺序恒按该变体 sections 表，未知 id 丢弃。
// 对显式 id 数组保持透明（调优 rig 契约：ALL15 feeds 点名 card 块，不经 UI/存档闸）。纯函数、可单测。
export function builderSelectedSections(s) {
    const v = BUILDER_VARIANTS[builderVariantKey(s)];
    const sel = Array.isArray(s[v.sectionsKey]) ? s[v.sectionsKey] : null;
    if (!sel) return v.sections.filter((x) => x.def);
    return v.sections.filter((x) => sel.includes(x.id));
}

// 生成喂给锻造模型的中文提示行：列出本次草稿要覆盖的部分，并禁止生成 / 追问未列出的部分。
function builderSectionsLine(s) {
    const labels = builderSelectedSections(s).map((x) => x.label);
    return P('bld.sections', { list: labels.join('、') });
}

// 访谈师「外貌素材·必问」（2026-07-08；验证收据 tests/unit/_bld-tuning/polish4/interview/）：
// 只在勾了外貌特征时由代码注入这行——GM 不跑提示词内的条件自判（未勾场景实测照问不误），
// 物理门控是唯一可靠闸；BUILDER_INTERVIEW_PROMPT 本体字节不动。已知接受项：GM ~1/4 把警告里
// 的「老茧」回收成建议例子——只影响访谈措辞，卡面的真围栏在锻造 look 块。
export const BUILDER_LOOK_MUSTASK = '【外貌素材·必问】已有材料（用户描述、世界书、对话记录、角色卡）里还没有「一眼认得出TA」的外貌素材时，必须问过一次外貌特征才可以交付 CharBrief；问时顺带提醒用户：不给真素材，AI 写外貌爱给谁都安上伤疤、老茧这类通用件，TA 的日子留在身上的痕迹（常年做的活、常待的地方、打理自己的习惯）才认得出TA。不必第一轮就问、也别为它挤掉更要紧的缺口；用户答不上来或让你随意，就不再追问，在 desc 里记一句「外貌交给锻造从TA的经历推导」。';

function builderLookAskLine(s) {
    if (builderVariantKey(s) !== 'card') return '';   // 外貌必问是 card 访谈的专属注入；persona 变体有自己的外貌话术
    return builderSelectedSections(s).some((x) => x.id === 'appearance') ? P('bld.lookMustAsk', null, s) : '';
}

// —— chip 物理门控（lessons-pass ■ 块版；前身 #3 Tier 2 行前缀门控）：未勾的部分从锻造提示词里
// 【物理删除/重写】——所见即所得（勾选=送进模型）。BUILDER_FORGE_PROMPT 保持字节冻结；这里按选择后处理。
// 工序三里每个 chip 小节 = 一个以「■ <label>：」起头的整块，块到下一个「■ 」行或工序头（一、~五、）
// 为止——未勾就整块删除（块内允许多行：junior 打磨后的块可能带子行）。块头逐字取自冻结提示词 +
// BUILDER_SECTIONS 的 label——tests/unit/builder-gating.test.mjs 的漂移守卫钉住两边：提示词/label
// 一改动、门控就红（而非静默错删）。buildForgeMessages 发送前施加，选择 = builderSelectedSections(s) 的 id。可单测。
const CHIP_BLOCK_HEADER = {
    basics:      '■ 基本信息',
    appearance:  '■ 外貌特征',
    backstory:   '■ 背景经历',
    relations:   '■ 人际关系',
    personality: '■ 性格画像',
    faces:       '■ 多副面孔',
    mix:         '■ 言行反差',
    depth:       '■ 深层人格',
    speech:      '■ 说话方式',
    goals:       '■ 目标动机',
    flaws:       '■ 弱点缺陷',
    habits:      '■ 行为逻辑',
    abilities:   '■ 能力技能',
    antimisread: '■ 防误读提示',
    imagery:     '■ 点睛比喻',
};
// 工序五组装顺序（lessons 6 A7 裁定；≠ BUILDER_SECTIONS 的 chip 排列）——防误读提示/点睛比喻 恒为最后两节。
const FORGE_ASSEMBLY_ORDER = ['basics', 'appearance', 'backstory', 'relations', 'personality', 'faces', 'mix', 'depth', 'speech', 'goals', 'flaws', 'habits', 'abilities', 'antimisread', 'imagery'];

/* ==== 用户角色分家（1.25.0）：三变体数据表 ====
 * 设计：docs/superpowers/specs/2026-07-08-builder-persona-split-design.md。
 * card = NPC 卡（沿用冻结的 BUILDER_SECTIONS / CHIP_BLOCK_HEADER / FORGE_ASSEMBLY_ORDER）；
 * steal = 用户角色·抢话（AI 也扮演{{user}}：简化卡 + 禁止说明 + 边界）；
 * nosteal = 用户角色·不抢话（AI 只回应：行为翻译手册，无调色盘——教程错误二）。
 * label 与各自锻造提示词的 ■ 块头逐字同步（builder-gating.test.mjs 漂移守卫钉三方）。 */
const BUILDER_SECTIONS_STEAL = [
    { id: 'basics',     label: '基本信息',   def: true, desc: '姓名、年龄、身份、家境、住处——写满的硬事实表（AI 演你，知道越具体演得越准）' },
    { id: 'appearance', label: '外貌特征',   def: true, desc: '两三个特化特征，每个都带「禁止说明」——不写，AI 会把你的白发翻来覆去地提' },
    { id: 'backstory',  label: '背景设定',   def: true, desc: '只写影响你现在行为的关键经历，一到三件' },
    { id: 'goals',      label: '目标动机',   def: true, desc: 'AI 根据材料和世界观推导你当前所求——只写有依据的，无台词' },
    { id: 'palette',    label: '性格调色盘', def: true, desc: '底色/主色调/点缀 + 少量衍生——AI 要演你，需要知道你的质地' },
    { id: 'boundary',   label: '边界',       def: true, desc: '关键剧情允许 AI 演出超出日常的反应——要惊喜就勾，要完全可控就关' },
];
const BUILDER_SECTIONS_NOSTEAL = [
    { id: 'basics',      label: '基础设定', def: true, desc: '姓名、身份、家境、关键经历、和角色的关系——写满的客观信息表' },
    { id: 'goals',       label: '目标动机', def: true, desc: 'AI 根据材料和世界观推导你当前所求——知道你图什么，才不会把手段误读成动机' },
    { id: 'touch',       label: '肢体接触', def: true, desc: '你的触碰方式和真实含义——拦住「揉脸=占有」这类误读' },
    { id: 'speech',      label: '说话方式', def: true, desc: '命令口气/沉默/短回复/损人的真实含义——最容易被 AI 读歪的部分' },
    { id: 'emotion',     label: '情绪表达', def: true, desc: '开心/生气/难过/紧张时你的可见表现——AI 靠这个判断你当下心情' },
    { id: 'interaction', label: '互动模式', def: true, desc: '你和当前角色之间的专属习惯——「不反驳=包容不是认怂」' },
];
const CHIP_BLOCK_HEADER_STEAL = {
    basics: '■ 基本信息', appearance: '■ 外貌特征', backstory: '■ 背景设定',
    goals: '■ 目标动机', palette: '■ 性格调色盘', boundary: '■ 边界',
};
const CHIP_BLOCK_HEADER_NOSTEAL = {
    basics: '■ 基础设定', goals: '■ 目标动机', touch: '■ 肢体接触',
    speech: '■ 说话方式', emotion: '■ 情绪表达', interaction: '■ 互动模式',
};
const FORGE_ASSEMBLY_ORDER_STEAL = ['basics', 'appearance', 'backstory', 'goals', 'palette', 'boundary'];
const FORGE_ASSEMBLY_ORDER_NOSTEAL = ['basics', 'goals', 'touch', 'speech', 'emotion', 'interaction'];

// 变体解析（纯函数）：设置 → card/steal/nosteal。开关关闭一律 card（= 现状行为）。
export function builderVariantKey(s) {
    if (!ENABLE_BUILDER_PERSONA_STYLES) return 'card';
    const t = normalizeBldTarget(s && s.bldTarget);
    return t === 'npc' ? 'card' : (t === 'persona-steal' ? 'steal' : 'nosteal');
}

// 变体资料束（提示词字段在 builderInterviewPromptFor / builderForgePromptFor——两张 map 分开，
// 避免本表与提示词常量互相前置）。assemblyTail = 工序组装顺序里强制收尾的 id 对（card 专属）。
export const BUILDER_VARIANTS = {
    card:    { sections: BUILDER_SECTIONS,         chipHeaders: CHIP_BLOCK_HEADER,         assemblyOrder: FORGE_ASSEMBLY_ORDER,         assemblyTail: ['antimisread', 'imagery'], sectionsKey: 'bldSections',        streamKey: 'bld_card' },
    steal:   { sections: BUILDER_SECTIONS_STEAL,   chipHeaders: CHIP_BLOCK_HEADER_STEAL,   assemblyOrder: FORGE_ASSEMBLY_ORDER_STEAL,   assemblyTail: [],                         sectionsKey: 'bldSectionsSteal',   streamKey: 'bld_steal' },
    nosteal: { sections: BUILDER_SECTIONS_NOSTEAL, chipHeaders: CHIP_BLOCK_HEADER_NOSTEAL, assemblyOrder: FORGE_ASSEMBLY_ORDER_NOSTEAL, assemblyTail: [],                         sectionsKey: 'bldSectionsNosteal', streamKey: 'bld_nosteal' },
};
function gateForgePrompt(sys, selectedIds, headers = CHIP_BLOCK_HEADER, order = FORGE_ASSEMBLY_ORDER, tailIds = ['antimisread', 'imagery']) {
    const sel = new Set(selectedIds || []);
    const label = (id) => headers[id].slice(2);   // 「■ 」后即 chip label
    const out = [];
    let dropping = false;   // 正在删除某个未勾 ■ 块的行
    for (const line of String(sys).split('\n')) {
        // ■ 块边界：新「■ 」行或工序头结束上一块的删除态。
        if (line.startsWith('■ ')) {
            const hit = Object.entries(headers).find(([, h]) => line.startsWith(h + '：'));
            dropping = !!hit && !sel.has(hit[0]);
            if (dropping) continue;
        } else if (/^[一二三四五]、/.test(line)) {
            dropping = false;
        } else if (dropping) {
            continue;
        }
        // Op C：工序五组装顺序行——按选择重生成（order 参数过滤 → label 连接；tailIds 非空则钉收尾节）。
        if (line.startsWith('- 只覆盖勾选的部分，按 ')) {
            const o = order.filter((id) => sel.has(id)).map(label).join('→');
            let l = '- 只覆盖勾选的部分，按 ' + o + ' 的顺序组装';
            const lastTwo = tailIds.filter((id) => sel.has(id)).map(label);
            if (lastTwo.length === 2) l += '——' + lastTwo[0] + '与' + lastTwo[1] + '永远是最后两节';
            else if (lastTwo.length === 1) l += '——' + lastTwo[0] + '永远是最后一节';
            out.push(l + '。');
            continue;
        }
        // Op D：成稿规矩·外貌/关系——未勾就删对应从句（派生：拆分号从句），通用「写行为不贴标签」恒留。
        if (line.startsWith('- 外貌只写')) {
            const cl = line.replace(/^- /, '').replace(/。$/, '').split('；');
            const kept = [];
            if (sel.has('appearance')) kept.push(cl[0]);
            if (sel.has('relations')) kept.push(cl[1]);
            kept.push(cl[cl.length - 1]);   // 通用从句恒留
            out.push('- ' + kept.join('；') + '。');
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

// —— v4 探针兜底（HANDOFF-V4 §3D，2026-07-09）：锻造稿入坞前的机械地板 ——
// 三轮调优 + v4 探针（DS-nosteal ×8：7/8 稿在带类型槽里照样编造「我知道」类引号台词）实锤：
// 散文禁令/自检对 DeepSeek 不可靠、提示词已到天花板 → 提示词管质量、这里管下限（仿校正器的
// 机械块处理惯例）。只动 persona 变体，card 原样回；GM 稿本来干净＝无操作。纯函数、幂等。
// ① nosteal：原话/禁止误读 行之外的成对引号只剥【引号标记】、内容保留——「抢着说"我知道"」
//    →「抢着说我知道」＝转述形，不删字（含义格语法不伤）；steal 不剥（教程允许 ≤3 句台词）。
// ② 绝对词软化（两变体）：从不/绝不→一般不、极度→很、每次…都→多数时候…都、一定会→多半会、
//    永远→一直；「不一定会」「永远的」「拒绝不了」「服从不了」有负向断言护着不误伤。
// ③ ⟨…⟩ 与 （依据：…） 跨段占位护住（⟦SO_EV_n⟧，同校正器 ⟦SO_KEEP_n⟧ 惯例）——依据是
//    一字未改的引文，一个字节不动。
export function sanitizePersonaDraft(content, variantKey) {
    if (variantKey !== 'steal' && variantKey !== 'nosteal') return String(content ?? '');
    const guarded = [];
    let s = String(content ?? '').replace(/（依据：[^）]*）|⟨[^⟩]*⟩/g, (m) => {
        guarded.push(m);
        return '⟦SO_EV_' + (guarded.length - 1) + '⟧';
    });
    const soften = (t) => t
        .replace(/(?<![拒谢婉回])绝不/g, '一般不')
        .replace(/(?<![服听遵屈盲跟])从不/g, '一般不')
        .replace(/极度/g, '很')
        .replace(/每次([^\n，。；]{0,6})都/g, '多数时候$1都')
        .replace(/(?<!不)一定会/g, '多半会')
        .replace(/永远(?!的)/g, '一直');
    s = s.split('\n').map((line) => {
        const t = line.trimStart();
        if (t.startsWith('原话') || t.startsWith('禁止误读')) return line;
        let out = line;
        if (variantKey === 'nosteal') {
            out = out.replace(/「([^」\n]+)」|“([^”\n]+)”|"([^"\n]+)"/g, (_, a, b, c) => a ?? b ?? c);
        }
        // Prince 裁决 2026-07-09（v4.1 R2）：范畴式含义格是拦截的牙——「含义：」整行、
        // 对偶行「＝ 意思：」右半 豁免软化；引号剥离照旧。原话行整行豁免在上面已优先。
        if (/^含义[:：]/.test(t)) return out;
        const pair = out.match(/[＝=]\s*意思[:：]/);
        if (pair) return soften(out.slice(0, pair.index)) + out.slice(pair.index);
        return soften(out);
    }).join('\n');
    return s.replace(/⟦SO_EV_(\d+)⟧/g, (m, i) => guarded[Number(i)] ?? m);
}

function bldExtractFence(body, tag) {
    // 闭合行宽容 </tag>>> 变体（XML 反射滑手，评估轮 A.1 真实 DeepSeek 稿 1/10 出现）；
    // 教学语法（BUILDER_PROTOCOL）不变，仍只教 tag>>>。
    const m = body.match(new RegExp('<<<' + tag + '\\n([\\s\\S]*?)\\n(?:</)?' + tag + '>>>'));
    return m ? m[1] : null;
}

function bldParseHeaders(body) {
    const headers = {};
    for (const line of body.split('\n')) {
        if (line.startsWith('<<<')) break;
        const m = line.match(/^(target|name|book|uid|entry|key|comment)\s*[:：]\s*(.*)$/);
        if (m) headers[m[1]] = m[2].trim();
    }
    return headers;
}

function parseCharBrief(text) {
    const m = String(text || '').match(/<CharBrief>([\s\S]*?)<\/CharBrief>/i);
    if (!m) return { brief: null, error: '' };
    const h = bldParseHeaders(m[1]);
    const desc = bldExtractFence(m[1], 'desc');
    if (!BLD_TARGETS.includes(h.target)) return { brief: null, error: 'target 缺失或不合法' };
    if (desc == null || !desc.trim()) return { brief: null, error: '缺少 <<<desc 围栏' };
    const uid = /^\d+$/.test(h.uid || '') ? parseInt(h.uid, 10) : null;
    if (h.target === 'npc-edit' && uid == null && !(h.entry || '').trim()) {
        return { brief: null, error: 'npc-edit 需要 uid 或 entry' };
    }
    if (h.target === 'persona-new' && !(h.name || '').trim()) return { brief: null, error: 'persona-new 需要 name' };
    return { brief: { target: h.target, name: h.name || '', book: h.book || '', uid, entry: h.entry || '', desc: desc.trim(), raw: m[0] } };
}

export function parseCharDraft(text) {
    const src = String(text || '');
    // 开锚防劫持（1.29.0，locateTagOpen/1.25.0 同族）：思考里【提到】字面 <CharDraft> 会劫持
    // 首次出现匹配（polish-5 合并电池 cp-ds2 实证、基线 rand-ds-02 前兆）——行首出现取最后一个，
    // 无行首出现再取最后任意（真区块按输出格式独占一行）。
    const open = locateTagOpen(src, 'CharDraft');
    if (!open) return { draft: null, error: '' };
    const rest = src.slice(open.index + open.length);
    const closeM = rest.match(/<\/CharDraft>/i);
    // 收尾滑手容错：</CharDraft> 缺失时取到文末（评估轮 A.1；polish-5 基线 rand-ds-01 真丢稿实证）。
    const body = closeM ? rest.slice(0, closeM.index) : rest;
    const h = bldParseHeaders(body);
    if (!BLD_TARGETS.includes(h.target)) return { draft: null, error: 'target 缺失或不合法' };
    let content = bldExtractFence(body, 'content');
    if (content == null) {
        const fenceM = body.match(/^<<<content\b[^\n]*\n?/m);
        if (fenceM) {
            // 围栏开了没关（rand-ds-01 实证：稿其实完整，DS 只是忘了 content>>> 和 </CharDraft>）——
            // 围栏行之后全部当正文。真截断的残稿也会被救成【可见的】半稿坞进草稿卡，由用户审改/
            // 重锻——好过整锻白跑（1.29.0；同批 16384 地板让真截断本身更难发生）。bldExtractFence
            // 语义未动（persona-pass 的 </content> 容忍待办不受影响）。
            content = body.slice(fenceM.index + fenceM[0].length);
        } else {
            // 围栏整个缺失（头部照写、正文裸奔）：头部行之后全部当正文兜底。
            const lines = body.split('\n');
            let i = 0;
            while (i < lines.length && (!lines[i].trim() || /^(target|name|book|uid|entry|key|comment)\s*[:：]/.test(lines[i]))) i++;
            const bare = lines.slice(i).join('\n');
            if (bare.trim()) content = bare;
        }
    }
    if (content == null || !content.trim()) return { draft: null, error: '缺少 <<<content 围栏' };
    if (h.target === 'persona-new' && !(h.name || '').trim()) return { draft: null, error: 'persona-new 需要 name' };
    const uid = /^\d+$/.test(h.uid || '') ? parseInt(h.uid, 10) : null;
    const rawEnd = closeM ? open.index + open.length + closeM.index + closeM[0].length : src.length;
    return { draft: { target: h.target, name: h.name || '', book: h.book || '', uid, key: h.key || '', comment: h.comment || '', content: content.trim(), raw: src.slice(open.index, rawEnd) } };
}

export function parseDraftPatch(text) {
    const m = String(text || '').match(/<DraftPatch>([\s\S]*?)<\/DraftPatch>/i);
    if (!m) return { ops: [], errors: [] };
    const ops = []; const errors = [];
    // 每个单元：anchor: 行（吸收到 <<<replace 为止的多行锚点）+ replace 围栏。
    // 收尾 \n 设为可选（\n?）：删除 op 空替换体常被模型写成 `<<<replace\nreplace>>>`（无空行），
    // 缺那个换行会让逐字正确的锚点也解析失败（2026-07-19 真 DS 高上下文电池）；`\n\nreplace>>>`
    // 与 `\nreplace>>>` 现在等价 = 空删除。正常替换体行为不变（非贪婪体仍在收尾换行处收束）。
    const unitRe = /anchor\s*[:：]\s*([\s\S]*?)\n<<<replace\n([\s\S]*?)\n?(?:<\/)?replace>>>/g;
    let u;
    while ((u = unitRe.exec(m[1])) !== null) {
        const anchor = u[1].replace(/\s*\n\s*/g, ' ').trim();
        if (!anchor) { errors.push('空锚点'); continue; }
        ops.push({ anchor, replace: u[2] });
    }
    const anchorCount = (m[1].match(/^anchor\s*[:：]/gm) || []).length;
    if (anchorCount > ops.length) errors.push(`有 ${anchorCount - ops.length} 个 anchor 缺少 <<<replace 围栏`);
    if (!ops.length && !errors.length) errors.push('DraftPatch 内没有可解析的修改');
    return { ops, errors };
}

function splitBuilderSegments(text) {
    const src = String(text || '');
    const re = /<(CharBrief|CharDraft|DraftPatch)>[\s\S]*?<\/\1>|<(CharBrief|CharDraft|DraftPatch)>[\s\S]*$/gi;
    const out = []; let last = 0; let m;
    while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push({ type: 'prose', text: src.slice(last, m.index) });
        out.push({ type: 'block', text: m[0] });
        last = m.index + m[0].length;
    }
    if (last < src.length) out.push({ type: 'prose', text: src.slice(last) });
    return out;
}

export function classifyBuilderReply(text) {
    const d = parseCharDraft(text);
    if (d.draft) return { kind: 'draft', draft: d.draft };
    const p = parseDraftPatch(text);
    if (p.ops.length || p.errors.length) return { kind: 'patch', ops: p.ops, errors: p.errors };
    const b = parseCharBrief(text);
    if (b.brief) return { kind: 'brief', brief: b.brief };
    // draftError 非空 ⟺ 有 <CharDraft> 开标签但没解析成（parseCharDraft 无开标签时恒返回 ''）——
    // 调用方靠它把「整稿没落地」说出口，而不是把一整篇改写静默丢掉（1.43.1）。
    return { kind: 'none', draftError: d.error || '' };
}

// 外科手术式改稿：逐条用世界书同款模糊锚点替换；未命中的记录原因、不阻断后续。
export function applyDraftPatchOps(draftText, ops) {
    let cur = String(draftText || '');
    const results = [];
    for (const op of (ops || [])) {
        const { result, matched } = lbFuzzyReplace(cur, op.anchor, op.replace);
        if (matched) { cur = result; results.push({ ok: true, anchor: op.anchor }); }
        else results.push({ ok: false, anchor: op.anchor, reason: '锚点未找到' });
    }
    return { result: cur, results };
}

// 纯函数：把「锻造阶段误发的 <DraftPatch>」当作对现有 NPC 条目正文的补丁应用，产出可入坞的 npc-edit 草稿。
// 背景（FINDINGS Round B）：npc-edit 目标下 DeepSeek ~3/5 会从锻造直接吐 <DraftPatch>（把「改已有条目」
// 读成外科补丁）而非完整 <CharDraft>——runForge 只认 CharDraft，故 live 报「锻造没产出草稿」＝Prince 的
// 「编辑经常失败」。这里用现有条目正文吃下补丁、合成 target=npc-edit 的完整草稿正文，让 🔨 生成路径照常入坞。
// ops 空 → 无补丁可救（空 error，调用方退回常规提示）；锚点全未命中 → 不硬塞（返回 error，多半锚的不是这条目）。可单测。
export function forgePatchToDraft(existingContent, ops, brief, resolvedUid) {
    if (!ops || !ops.length) return { draft: null, error: '' };
    const base = String(existingContent == null ? '' : existingContent);
    if (!base.trim()) return { draft: null, error: '找不到要改的条目正文——请让访谈师在汇总里带上 uid 或准确的条目标题' };
    const { result, results } = applyDraftPatchOps(base, ops);
    const matched = results.filter((r) => r.ok).length;
    if (!matched) return { draft: null, error: '锻造给的是补丁，但锚点都没对上现有条目正文' };
    const b = brief || {};
    const draft = {
        target: 'npc-edit',
        name: b.name || '',
        book: b.book || '',
        uid: (resolvedUid != null) ? resolvedUid : (b.uid != null ? b.uid : null),
        key: '',
        comment: b.entry || b.name || '',
        content: result,
        raw: '',
    };
    return { draft, note: `锻造直接给了补丁（${matched}/${results.length} 处命中），已套用到现有条目上`, matched, total: results.length };
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
function lbFuzzyReplace(content, anchor, replace) {
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
        console.warn('[Story Oracle] patch anchor match failed:', e);
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
function resolveBookName(opBook, scope) {
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
        const hasKey = !!(op.fields && op.fields.key != null && lbToStrArray(op.fields.key).length > 0);
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
        const { result, matched, spanStart, spanEnd, multi } = lbFuzzyReplace(entry.content || '', op.anchor, op.replace);
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
// cls：通过=so-lb-ok（带 warn 时 so-lb-warn）、未通过=so-lb-skip（灰）。
export function lbVerdictRow(v) {
    if (!v) return { ok: false, cls: 'so-lb-skip', line: '', note: '', warn: '' };
    return {
        ok: !!v.ok,
        cls: v.ok ? (v.warn ? 'so-lb-warn' : 'so-lb-ok') : 'so-lb-skip',
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

    const scope = Array.isArray(sharedState.lbBookNames) ? sharedState.lbBookNames.slice() : [];
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
    const scope = Array.isArray(sharedState.lbBookNames) ? sharedState.lbBookNames.slice() : [];
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