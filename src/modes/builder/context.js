import { getSummary } from '../../core/chat-metadata.js';
import { getSettings } from '../../core/settings.js';
import { builderDraftRefBlock, getBuilderState } from '../advisor/metadata.js';
import { buildBbsHistorySection, buildCardSection, buildLwbHistorySection, buildSummarySection, buildTranscript, getBbsHistoryText, getLwbSummaryText } from '../chat/context.js';
import { buildPersonaBlock, builderForgePromptFor, builderInterviewPromptFor, builderTargetLabel } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { sideChatScanBlob } from '../../st/adapters.js';
import { lbFormatEntry } from '../lorebook/entries.js';
import { getActiveBookNames, getActiveScanUids, getAllBookNames, getWiEditApi, resolveLbTargetNames } from '../lorebook/world-info.js';
import { bldEntryFilter, bldPickFedEntries } from './selection.js';
import { BUILDER_VARIANTS, builderLookAskLine, builderSectionsLine, builderSelectedSections, builderVariantKey, gateForgePrompt } from './model.js';

export let bldContextText = '';
export let bldScanWiText = '';
export let bldBookNames = [];
export let bldStatData = '';

export function clearBuilderStatData() {
    bldStatData = '';
}

export function captureBuilderStatData(value) {
    bldStatData = value;
}

// 角色工坊上下文：勾选的世界书条目【原样】投喂 + 宏说明（与世界书模式同规则，不 substituteParams——
// 补丁锚点要对上字面 {{user}}/{{char}}）。自成一份、不动 buildLorebookContext；选书走 s.bldBooks、选条目走 bldEntryFilter。
export async function buildBuilderContext() {
    bldContextText = '';
    bldScanWiText = '';
    bldBookNames = [];
    const s = getSettings();
    const mod = await getWiEditApi();
    if (!mod) { bldContextText = '（无法访问世界书模块。）'; return; }
    const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
    const names = resolveLbTargetNames(s.bldBooks, allNames, activeNames);
    const blocks = [];
    for (const name of names) {
        let data;
        try { data = await mod.loadWorldInfo(name); } catch (e) { continue; }
        if (!data || !data.entries) continue;
        bldBookNames.push(name);
        let entries = Object.values(data.entries)
            .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
        const total = entries.length;
        // 1.82.0：唯一的选择规则（缺键 / null = 全部【启用】的；显式 Set = 恰好这些，禁用也发）。
        // 抬头的「共 M 条」仍报全书条数——收窄了多少一眼可见。
        entries = bldPickFedEntries(entries, bldEntryFilter[name]);
        if (!entries.length) continue;
        blocks.push(`=== 世界书：${name}（已选 ${entries.length} / 共 ${total} 条）===\n` + entries.map(lbFormatEntry).join('\n\n'));
    }
    bldContextText = blocks.join('\n\n');
    bldScanWiText = await buildBldScanWiText(s);   // opt-in（bldScanWi 关时空串）
    // 宏未替换说明：两块（选条目 + 关键词命中）合并判定，注在第一块非空块头上（原样投喂共同的说明）。
    if ((bldContextText + bldScanWiText).indexOf('{{') !== -1) {
        const macroNote = P('bld.macroNote', null, s) + '\n\n';
        if (bldContextText) bldContextText = macroNote + bldContextText;
        else bldScanWiText = macroNote + bldScanWiText;
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
            const fedWholeBook = bldBookNames.includes(name) && !(bldEntryFilter[name] instanceof Set);
            const sel = bldBookNames.includes(name) ? bldEntryFilter[name] : null;
            const entries = Object.values(data.entries)
                .filter((e) => e && active[name].has(Number(e.uid)) && !e.disable && typeof e.content === 'string' && e.content.trim())
                .filter((e) => !(fedWholeBook || (sel instanceof Set && sel.has(e.uid))))          // 已在 bldContextText 里 → 剔除
                .filter((e) => !/\[mvu_update\]/i.test(String(e.comment || '')))                   // 机制规则不进工坊
                .sort((a, b) => (Number(a.displayIndex ?? a.uid) - Number(b.displayIndex ?? b.uid)));
            if (entries.length) blocks.push(`=== 世界书：${name}（关键词命中 ${entries.length} 条）===\n` + entries.map(lbFormatEntry).join('\n\n'));
        }
        return blocks.join('\n\n').trim();
    } catch (e) {
        console.warn('[剧情推进] 工坊关键词扫描失败：', e);
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
    if (bldContextText) parts.push(P('bld.wi', { wi: bldContextText }, s));
    if (bldScanWiText) parts.push(P('bld.scanWi', { wi: bldScanWiText }, s));
    if (bldStatData) parts.push(P('bld.stat', { stat: bldStatData }, s));
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
    if (bldContextText) parts.push(P('bld.forgeWi', { wi: bldContextText }, s));
    if (bldScanWiText) parts.push(P('bld.forgeScanWi', { wi: bldScanWiText }, s));
    if (bldStatData) parts.push(P('bld.stat', { stat: bldStatData }, s));
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

