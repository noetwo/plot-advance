import { getCtx, getSettings } from '../../core/settings.js';
import { P } from '../../prompts/registry.js';
import { lbFormatEntry } from './entries.js';
import { lbEntryFilter } from './selection.js';
import { getActiveBookNames, getAllBookNames, getWiEditApi, resolveLbTargetNames } from './world-info.js';

export let lbContextText = '';
export let lbBookNames = [];

/**
 * Build the structured "book -> entries" listing for lorebook mode, and record
 * which books it covers (lbBookNames). Honors s.lorebookTarget: a specific book
 * name, or '' for every active book. Stores nothing by reference — apply re-reads
 * the books fresh — so this is purely a read for context.
 */
export async function buildLorebookContext() {
    lbContextText = '';
    lbBookNames = [];
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) {
        lbContextText = '（无法访问世界书模块 —— 当前 ST 版本可能不支持。）';
        return;
    }

    const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
    const names = resolveLbTargetNames(s.lorebookTargets, allNames, activeNames);
    if (!names.length) {
        lbContextText = (Array.isArray(s.lorebookTargets) && s.lorebookTargets.length)
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
        lbBookNames.push(name);
        let entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        const total = entries.length;
        // Per-entry selection works in BOTH single-book and all-active mode — the
        // filter is keyed by book name either way. A Set (even empty) means "send
        // exactly these"; null/absent means "send all". Apply still re-reads the
        // whole book, so editing any uid keeps working.
        const sel = lbEntryFilter[name];
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

    lbContextText = blocks.join('\n\n') || '（未能读取到任何世界书条目。）';
    // Show entry content VERBATIM — do NOT substituteParams it. The lore manager EDITS
    // these books, and macros ({{user}}/{{char}} …) are stored literally. The old
    // behavior expanded them "for readability", so the model anchored on the persona /
    // char NAME (e.g. "Chris") while storage still held "{{user}}" → patch 锚点未找到 on
    // apply (lbFuzzyReplace matches the literal content loadWorldInfo returns), and it
    // risked baking the name into the book. Instead, keep it literal and prepend a small
    // legend giving the macro values, so chat stays readable without touching content.
    if (lbContextText.indexOf('{{') !== -1) {
        const pairs = [];
        try {
            const u = ctx.substituteParams('{{user}}');
            const c = ctx.substituteParams('{{char}}');
            if (u && u !== '{{user}}') pairs.push(`{{user}} = 「${u}」`);
            if (c && c !== '{{char}}') pairs.push(`{{char}} = 「${c}」`);
        } catch (e) { /* no ctx — skip the name mapping, keep the literal-macro note */ }
        const names = pairs.length ? `当前 ${pairs.join('、')}。` : '';
        lbContextText = P('lb.macroLegend', { names }, s) + '\n\n' + lbContextText;
    }
}
