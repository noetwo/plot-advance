import { deserializeEntrySel, getDiagWiMeta } from '../../core/chat-metadata.js';
import { getCtx } from '../../core/settings.js';
import { activeUidsFromScan, mergeHybridUids } from '../fix/templates.js';
import { ENABLE_DIAG_WI_PICKER } from '../../prompts/builtins.js';
import { foldExtraScanText, getWiScanBudget, loadWorldInfoModule } from '../../st/adapters.js';

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

