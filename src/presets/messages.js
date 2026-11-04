import { convoForPrompt, getSummary } from '../core/chat-metadata.js';
import { getCtx } from '../core/settings.js';

import { buildAdvisorPrompt, buildBbsHistorySection, buildChatWorldSection, buildFixPrompt, buildLorebookPrompt, buildLwbHistorySection, buildSummarySection, buildTranscriptTurns, getBbsHistoryText, getLwbSummaryText, lbSnapshotMsg, wiAfter, wiBefore } from '../modes/chat/context.js';
import { buildBuilderPrompt } from '../modes/builder/context.js';
import { ENABLE_OFFSTAGE_GUARD } from '../prompts/builtins.js';
import { buildPersonaBlock } from '../prompts/helpers.js';
import { P, buildChatStatSection } from '../prompts/registry.js';
import { getCuratedSnapshot } from '../ui/settings.js';

const PRESET_DEPENDENCIES = Object.freeze({
    getCtx,
    getCuratedSnapshot,
    convoForPrompt,
    getSummary,
    buildAdvisorPrompt,
    buildBbsHistorySection,
    buildChatWorldSection,
    buildFixPrompt,
    buildLorebookPrompt,
    buildLwbHistorySection,
    buildSummarySection,
    buildTranscriptTurns,
    getBbsHistoryText,
    getLwbSummaryText,
    lbSnapshotMsg,
    buildBuilderPrompt,
    buildPersonaBlock,
    P,
    buildChatStatSection,
    enableOffstageGuard: ENABLE_OFFSTAGE_GUARD,
    getWiBefore: () => wiBefore,
    getWiAfter: () => wiAfter,
});

/* ------------------------------------------------------------------ *
 * Faithful, marker-aware, role-preserving assembly from a curated preset.
 *
 * Walks the frozen snapshot in order. Text blocks become messages with their
 * own role; marker blocks expand IN PLACE with the Oracle's own context. The
 * chatHistory slot expands to story-context turns followed by the Oracle's own
 * Q&A turns (per the user's choice). Each text block runs through
 * substituteParams, so getvar/setvar resolve live (setvar self-heals on the
 * next main-chat turn). The built-in short prompt / textarea is never used here.
 * ------------------------------------------------------------------ */
export function subst(ctx, text) {
    try { return ctx.substituteParams(String(text || '')); } catch (e) { return String(text || ''); }
}

// 追加非空消息；保留文本原样，不合并相邻的同角色消息。
function pushMsg(out, role, content) {
    const c = (content == null) ? '' : String(content);
    if (!c.trim()) return;
    out.push({ role: role || 'system', content: c });
}

function expandMarker(out, identifier, ctx, s, deps = PRESET_DEPENDENCIES, worldInfo) {
    const {
        buildBbsHistorySection: buildBbs,
        buildChatStatSection: buildChatStat,
        buildChatWorldSection: buildChatWorld,
        buildLwbHistorySection: buildLwbHistory,
        buildSummarySection: buildSummary,
        buildTranscriptTurns: buildTurns,
        convoForPrompt: promptConvo,
        getBbsHistoryText: getBbsHistory,
        getLwbSummaryText: getLwbSummary,
        getSummary: readSummary,
        P: readPrompt,
    } = deps;
    let card = {};
    try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group / none */ }
    switch (identifier) {
        case 'personaDescription':
            pushMsg(out, 'system', subst(ctx, card.persona || (ctx.name1 ? `用户 / Persona：${ctx.name1}` : '')));
            break;
        case 'charDescription':
            pushMsg(out, 'system', subst(ctx, card.description || ''));
            break;
        case 'charPersonality':
            pushMsg(out, 'system', subst(ctx, card.personality || ''));
            break;
        case 'scenario':
            pushMsg(out, 'system', subst(ctx, card.scenario || ''));
            break;
        case 'worldInfoBefore':
            pushMsg(out, 'system', subst(ctx, worldInfo ? worldInfo.wiBefore : deps.getWiBefore()));
            break;
        case 'worldInfoAfter':
            pushMsg(out, 'system', subst(ctx, worldInfo ? worldInfo.wiAfter : deps.getWiAfter()));
            break;
        case 'dialogueExamples':
            pushMsg(out, 'system', subst(ctx, card.mesExamples || ''));
            break;
        case 'chatHistory': {
            // Authoritative variable state (or the honest-refusal caveat) rides
            // just ahead of the story context — same discipline as plain mode.
            pushMsg(out, 'system', buildChatStat());
            pushMsg(out, 'system', buildChatWorld());
            // 用户功能请求：运行概要紧贴故事记录之前（仅普通模式经此 marker；参谋
            // 预设走自己的 placeAdv，不经这里）。
            pushMsg(out, 'system', buildSummary(readSummary()));
            // 柏宝书记忆桥：预设路径不 substituteParams 概要块（宏方案在此失效）——桥文本已是成品，直接插。
            pushMsg(out, 'system', buildBbs(getBbsHistory()));
            pushMsg(out, 'system', buildLwbHistory(getLwbSummary()));   // 小白X 记忆桥（同 marker 位）
            // Story context first, then the Oracle's own Q&A — as real turns.
            let sawStoryTurns = false;
            for (const t of buildTurns(ctx, s)) {
                pushMsg(out, t.role, t.text);
                sawStoryTurns = true;
            }
            // 戏外守卫（1.32.1）：尾锚紧跟故事轮之后（「以上故事记录到此为止」的指代只有在
            // 这个位置才成立——终位版在预设 post-history 块之后指代错位，实测反而助跑偏）。
            if (deps.enableOffstageGuard && sawStoryTurns) pushMsg(out, 'system', readPrompt('chat.tail', null, s));
            for (const m of promptConvo()) pushMsg(out, m.role, m.content);
            break;
        }
        default:
            break;
    }
}

export function buildPresetMessages(s, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    // 戏外守卫（1.32.1）：预设路径的【顶部身份头】。预设组装完全替换了神谕自己的系统提示——
    // 组装里没有任何一处说明「这是侧聊分析窗口」，预设的写手/角色人设 + 正文格式契约（思考块/
    // 样式注释/assistant 预填）就成了唯一身份来源 → 挂预设时「continue」被当成正文续写指令
    // （Prince Opus 实况；本地电池 5/5 复现，终位单尾锚也压不住）。身份头立在预设块之前，把
    // 预设降为风格/语境参考；与故事轮后的尾锚构成与默认路径同款的「顶部身份 + 边界尾锚」夹心。
    if (deps.enableOffstageGuard) pushMsg(out, 'system', deps.P('chat.presetHeader', null, s));

    // Optional voice-persona layer, off by default in preset mode. When chosen,
    // it leads as a top-level voice directive; the preset still governs content.
    const personaBlock = deps.buildPersonaBlock(s.personaId, null, s);
    if (personaBlock) pushMsg(out, 'system', subst(ctx, personaBlock));

    let sawHistory = false;
    for (const it of items) {
        if (it.kind === 'marker') {
            if (it.identifier === 'chatHistory') sawHistory = true;
            expandMarker(out, it.identifier, ctx, s, deps);
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }

    // If the curation dropped the chatHistory slot, the Oracle still needs the
    // story + the question — append them so it never sends a question with no
    // context and no final user turn.
    if (!sawHistory) expandMarker(out, 'chatHistory', ctx, s, deps);

    return out.length ? out : [{ role: 'system', content: subst(ctx, deps.P('chat.presetEmpty', null, s)) }, ...deps.convoForPrompt()];
}

// 五种工具模式只放一次 chatHistory；普通聊天仍逐个展开，不走这里。
export function walkPresetItems(items, ctx, out, place, onMarker) {
    let placed = false;
    for (const it of items) {
        if (it.kind === 'marker') {
            if (it.identifier === 'chatHistory') {
                if (!placed) { place(); placed = true; }
            } else if (onMarker) onMarker(it.identifier);
        } else {
            pushMsg(out, it.role || 'system', subst(ctx, it.content));
        }
    }
    if (!placed) place();
}

/* ------------------------------------------------------------------ *
 * Lorebook mode THROUGH a curated preset (opt-in: s.lorebookUsePreset).
 *
 * We keep the preset's TEXT blocks (its jailbreak / formatting / framing) and
 * drop the RP-content markers (card / persona / world-info / examples) — those
 * are irrelevant to editing a world book and would pull attention onto the RP.
 * The lore-manager directive (LOREBOOK_SYSTEM_PROMPT + the current book content,
 * via buildLorebookPrompt) plus the side-chat Q&A go where the chat history would
 * sit, so a post-history jailbreak block still lands last.
 * ------------------------------------------------------------------ */
export function buildLorebookPresetMessages(s, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const loreBlock = deps.buildLorebookPrompt(ctx, s);  // directive (+ optional transcript)；书正文已移出、见下方尾部快照
    const placeLore = () => {
        pushMsg(out, 'system', loreBlock);
        for (const m of deps.convoForPrompt()) pushMsg(out, m.role, m.content);
    };
    walkPresetItems(items, ctx, out, placeLore);

    // F5：书正文快照钉在【全部内容之后】的末尾（与裸路径同规则，唯一权威、只出现这一次）。
    out.push(deps.lbSnapshotMsg());
    return out;
}

/* ------------------------------------------------------------------ *
 * 校正模式（手动 + 自动）THROUGH a curated preset（opt-in: fixM_/fixA_usePreset，各自独立；仅破限 / 越狱用）。
 * 保留预设的【文本块（含其角色——破限 / 框架 / 格式 / few-shot 都照旧）】，并【展开 RP 内容标记】（charDescription /
 * worldInfo / scenario / 示例 / 人格 照预设位置 expandMarker）——这样校正模型能看到角色卡 / 世界书（改对话 / 知不知道
 * 某事都用得上）。把校正调用塞到 chatHistory 位：system = buildFixPrompt（信封已 slim：仅 reply + 概要 + 前文 + 指令；
 * 卡 / 世界书不在此、由上面标记提供——captureFixContext 在预设模式已把信封的卡 / 世界书置空、免重复），紧跟 user =
 * directive（手动那句话 / 按目标 / 自动的指令）。directive 省略时（自由发挥手动经 buildMessages 进来）用 convoForPrompt()。
 * buildFixPrompt 仍按 fixContext.activeMode 选系统提示；captureFixContext 已先准备好 wiBefore/wiAfter 供 worldInfo 标记。
 * ------------------------------------------------------------------ */
export function buildFixPresetMessages(s, directive, fixContext, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const placeFix = () => {
        pushMsg(out, 'system', deps.buildFixPrompt(ctx, s, fixContext));
        if (directive != null) pushMsg(out, 'user', directive);
        else for (const m of deps.convoForPrompt()) pushMsg(out, m.role, m.content);
    };
    walkPresetItems(items, ctx, out, placeFix,
        (identifier) => expandMarker(out, identifier, ctx, s, deps, fixContext));

    return out.length ? out : (directive != null
        ? [{ role: 'system', content: deps.buildFixPrompt(ctx, s, fixContext) }, { role: 'user', content: directive }]
        : [{ role: 'system', content: deps.buildFixPrompt(ctx, s, fixContext) }, ...deps.convoForPrompt()]);
}


/* ------------------------------------------------------------------ *
 * Advisor mode THROUGH a curated preset (opt-in: s.advisorUsePreset).
 * Keep the preset's TEXT blocks
 * (jailbreak / formatting / framing), skip the RP markers (the advisor block
 * already carries card + WI + full transcript itself), and drop the advisor
 * directive + side-chat Q&A where the chat history would sit, so a post-history
 * jailbreak block still lands last.
 * ------------------------------------------------------------------ */
// over（可选）= { block, tail }：「到了再写」的单独调用用自己备好的参谋块，尾部换成那句请求（不带侧聊记录）。
export function buildAdvisorPresetMessages(s, over, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    // 戏外守卫（1.32.1）：顶部身份头（同 buildPresetMessages 的理由；advBlock 内部已带围栏+
    // 尾锚，头负责在预设人设/格式契约之前先立住窗口身份）。终位追加尾锚实测有害（「以上故事
    // 记录」的指代在预设示例块之后错位，把预设范文认成剧情）——不加。
    if (deps.enableOffstageGuard) pushMsg(out, 'system', deps.P('advisor.presetHeader', null, s));

    const advBlock = over ? over.block : deps.buildAdvisorPrompt(ctx, s);  // directive + plan + card + WI + full transcript
    const tail = over ? over.tail : deps.convoForPrompt();
    const placeAdv = () => {
        pushMsg(out, 'system', advBlock);
        for (const m of tail) pushMsg(out, m.role, m.content);
    };
    walkPresetItems(items, ctx, out, placeAdv);

    return out.length ? out : [{ role: 'system', content: advBlock }, ...tail];
}

/* ------------------------------------------------------------------ *
 * 诊断模式 THROUGH a curated preset（opt-in: s.diagnoseUsePreset，1.43.0）。
 * 骨架同 buildLorebookPresetMessages / buildAdvisorPresetMessages：保留预设的
 * 【文本块（含其角色——破限 / 框架 / 格式 都照旧）】，【跳过全部 RP 内容标记】，把诊断
 * 调用放进 chatHistory 位，好让 post-history 的破限块仍然落在最后。
 *
 * 标记一律跳过而不是像校正那样展开：buildDiagnosePromptFrom 自身已经带了角色卡 MVU
 * 规则（世界书）+ stat_data + 最新更新区块 + 可选角色卡 + 故事对话记录 —— 再展开
 * charDescription / worldInfo 就是重复投喂，还会把注意力从「机械核对变量」拽回 RP。
 *
 * systemPrompt 由调用方传入（不在函数内自建）：手动诊断走读模块级全局的
 * buildDiagnosePrompt(ctx, s)，自动诊断走 runAutoDiagnose 里本地构建的那一份
 * （它刻意不碰窗口共享的 worldInfoBlock / diagStatData / diagLatestUpdate）。
 * directive 省略（手动：用户那句话在 convoForPrompt() 里）／给出（自动：固定那句
 * 【自动诊断】指令），同 buildFixPresetMessages 的双形态。
 * ------------------------------------------------------------------ */
export function buildDiagnosePresetMessages(s, systemPrompt, directive, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const placeDiag = () => {
        pushMsg(out, 'system', systemPrompt);
        if (directive != null) pushMsg(out, 'user', directive);
        else for (const m of deps.convoForPrompt()) pushMsg(out, m.role, m.content);
    };
    walkPresetItems(items, ctx, out, placeDiag);

    return out.length ? out : (directive != null
        ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: directive }]
        : [{ role: 'system', content: systemPrompt }, ...deps.convoForPrompt()]);
}

/* ------------------------------------------------------------------ *
 * Builder（角色工坊）访谈 THROUGH a curated preset (opt-in: s.bldUsePreset).
 * Same skeleton as buildLorebookPresetMessages: keep the preset's TEXT blocks
 * (jailbreak / formatting / framing), skip the RP markers (the builder block
 * already carries card + WI + stat + summary + transcript itself), and drop the
 * builder directive + side-chat Q&A where the chat history would sit, so a
 * post-history jailbreak block still lands last. ONLY the 访谈 call goes through
 * the preset — the forge (runForge/buildForgeMessages) is NEVER preset-routed.
 * ------------------------------------------------------------------ */
export function buildBuilderPresetMessages(s, deps = PRESET_DEPENDENCIES) {
    const ctx = deps.getCtx();
    const snap = deps.getCuratedSnapshot(s, s.sysPromptPresetName);
    const items = (snap && snap.items) || [];
    const out = [];

    const bldBlock = deps.buildBuilderPrompt(ctx, s);  // 工序指令 + 卡 + WI + 变量 + 概要 + 对话记录
    const placeBld = () => {
        pushMsg(out, 'system', bldBlock);
        for (const m of deps.convoForPrompt()) pushMsg(out, m.role, m.content);
    };
    walkPresetItems(items, ctx, out, placeBld);

    return out.length ? out : [{ role: 'system', content: bldBlock }, ...deps.convoForPrompt()];
}