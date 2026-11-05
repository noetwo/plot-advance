import { persistConvo } from '../../core/chat-metadata.js';
import { getCtx, getSettings } from '../../core/settings.js';

import { addBriefControls, addPathCards, addSystemNote, modeEntryNote, parseStoryPlans, peekNoteOpts, registerNoteOpts, showTyping } from '../advisor/cards.js';
import { activeDraftContent, draftWithPatchedActive, getBuilderState, setBuilderState } from '../advisor/metadata.js';
import { applyOutputRegex, assembleExternalWorld, buildMessages, renderAdvisorReplyHtml, renderMarkdownOnly, renderReplyHtml, replaceAdvisorStatData, replaceChatStatData, replaceChatWorldData, replacePresetWorldInfo, replaceWorldInfoBlock, stripMechanismBlocks, stripReasoningTags, warmLwbSummaryIfCold, worldInfoBlock } from './context.js';
import { autoGrowInput, scrollToBottom } from './history.js';
import { diagStatKey } from '../diagnose/patch.js';
import { captureManualDiagnoseContext, extractUpdateBlock, getLatestAiMessage, getLatestAiMessageText, getMvuStatData } from '../diagnose/mvu.js';
import { captureFixContext, renderFixCard } from '../fix/capture.js';
import { isFixedReply } from '../fix/writeback.js';
import { diagSelHasRules } from '../fix/templates.js';
import { buildBuilderContext, captureBuilderStatData, clearBuilderStatData } from '../builder/context.js';
import { applyDraftPatchOps, builderVariantKey, classifyBuilderReply, renderBuilderReplyHtml, sanitizePersonaDraft } from '../builder/model.js';
import { buildLorebookContext } from '../lorebook/context.js';
import { parseLorebookBlocks } from '../lorebook/operations.js';
import { buildDiagSelectedWi, diagPickerActive } from '../lorebook/world-info.js';
import { ENABLE_DIAG_BODY_INJECT, ENABLE_DRAFT_CONDENSE, ENABLE_SCHEMA_DIAG, ENABLE_WI_EJS_RENDER } from '../../prompts/builtins.js';
import { fixEffMaxTokens } from '../../prompts/helpers.js';
import { buildWorldInfo, buildWorldInfoSplit, collectMvuUpdateRules, loadRegexEngine, sideChatScanBlob, wiContextMode } from '../../st/adapters.js';
import { callDirect, callProfile, callProfileStream, explainProviderError, gemini3MaxTokensFloor, isEmptyLengthReply, resolveEndpointUrl, streamDirect } from '../../transport/direct.js';
import { addApplyControls, addLorebookApplyControls, addMessage, addRetryControl, diagSchemaAfterManualReply, soFollowStream } from '../../ui/messages.js';
import { refreshDraftCard } from '../../ui/mode-shell.js';
import { presetCurationActive } from '../../ui/settings.js';
import { appendConvo, convoStreamKey, nextCid } from '../../core/conversation-store.js';
import { beginGeneration, finishGeneration, isGenerating, stopGeneration } from '../../core/generation.js';
import { advisorMode, builderMode, diagnoseMode, fixMode, lorebookMode } from '../../core/oracle-modes.js';
import { recordLastPrompt } from '../../core/recent-prompt.js';

import { getLastFinishReason, resetLastFinishReason } from '../../transport/direct.js';
import { inputEl, win } from '../../ui/refs.js';

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
export async function onSend() {
    if (isGenerating) { stopGeneration(); return; }
    const s = getSettings();
    const text = inputEl.value.trim();
    if (!text) return;

    // validate config
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) {
        addSystemNote('请先在设置（齿轮图标）中填写端点 URL 和模型。');
        return;
    }
    if (s.mode === 'profile' && !s.profileId) {
        addSystemNote('请先在设置（齿轮图标）中选择一个连接配置文件。');
        return;
    }

    inputEl.value = '';
    autoGrowInput();                                        // #4 清空后把输入框收回下限高度
    const entry = { id: nextCid(), role: 'user', content: text };
    appendConvo(entry);
    persistConvo();
    entry._el = addMessage('user', text, entry);
    await generateReply();
}

// 纯判定：这次生成失败算不算用户主动「停止」（AbortError）。是 → 不给「重试」按钮（中止是有意的）；
// 其余错误（429 限流 / 网络 / 空回复传 null）都不是中止 → 给重试。容错：无错误对象按非中止处理。
export function isUserAbort(err) {
    return err?.name === 'AbortError';
}

// 把错误的 cause 链拍成一句人话。存在的理由：profile（连接配置）模式走酒馆的
// ConnectionManagerRequestService.sendRequest，而它把【任何】底层失败重新包装成
//     throw new Error('API request failed', { cause: error })
// （public/scripts/extensions/shared.js）。只印 err.message 的话，profile 模式下每一种
// 失败——上下文超长、密钥不对、中转 413——都长成同一句废话，用户只能猜（真实报告：
// 一位用户的大世界书发不出去，一直以为是酒馆配置问题）。直连模式不受影响，那边抛的是
// 带状态码和响应体的 HTTP 错误。
// 容错要求：cause 可能是裸字符串、可能自引用成环、可能没有 message。深度设上限，
// 不把整条链倒给用户。
function errChainMessage(err) {
    const parts = [];
    const seen = new Set();
    let cur = err;
    while (cur != null && parts.length < 4) {
        if (typeof cur === 'object' || typeof cur === 'function') {
            if (seen.has(cur)) break;          // 成环 → 到此为止
            seen.add(cur);
        }
        const m = (typeof cur === 'string')
            ? cur
            : (cur && typeof cur.message === 'string' ? cur.message : '');
        const t = m.trim();
        if (t && parts[parts.length - 1] !== t) parts.push(t);   // 相邻重复的同一句只留一份
        cur = (cur && typeof cur === 'object') ? cur.cause : undefined;
    }
    if (!parts.length) return String(err == null ? '' : err);
    return parts.length === 1 ? parts[0] : `${parts[0]}（详细：${parts.slice(1).join(' / ')}）`;
}

// Generate one assistant reply for the current tail of `convo` (which must already
// end with the user turn being answered). Shared by send / edit / regenerate.
export async function generateReply(options = {}) {
    if (isGenerating) return;
    const s = options.settings || getSettings();
    // 🩺 陈旧印章的取样槽（Task 5，审计簇 F）：诊断分支建提示词时算一次状态指纹，定稿时钉到卡片上。
    // 取样点【必须】是这里而不是回复回来之后：补丁是模型对着【喂进去的那一份】算的，等回复回来再取
    // 一次，会把这次调用期间发生的变化算成「没变过」= 正是这道闸要防的那一类。与自动诊断的
    // captured.statKey 同源同时刻（runAutoDiagnose）。
    let diagStampKey = null;
    let fixContext = null;
    if (!options.messages) {
    if (s.applyRegex) await loadRegexEngine(); // ensure engine is ready before building context
    await warmLwbSummaryIfCold();   // 小白X 记忆桥(b)：缓存空且开关开时，建提示词前破例暖一份（受保护自降级）

    if (diagnoseMode) {
        if (diagPickerActive()) {
            // 精选模式（用户功能请求）：只喂【本聊天挑选】的世界书条目（无视启用 / 禁用；L2 混合再并入主聊天
            // 此刻命中的绿灯）。所见即所得——不自动补 [mvu_update] 规则；若一条规则都没选，给个温和提醒。
            const picked = await buildDiagSelectedWi();
            replaceWorldInfoBlock(picked.block);
            if (!diagSelHasRules(picked.selectedEntries)) {
                addSystemNote('⚠ 当前精选里没有选中任何变量规则（[mvu_update]）条目，诊断可能不准确——可在上方选条目栏勾选规则条目（含已禁用的）。');
            }
        } else {
            // 原行为：强制一次世界书扫描（保留 'all' 选择），再从原始书补回 [mvu_update] 规则——buildWorldInfo
            // 按设计会剥掉它们（聊天 / 参谋不想要），且 MVU 额外模型解析模式还会把它们从扫描里藏掉，而诊断正需要它们。
            replaceWorldInfoBlock(await buildWorldInfo(wiContextMode(s)));
            const mvuRules = await collectMvuUpdateRules(worldInfoBlock);
            if (mvuRules.length) {
                replaceWorldInfoBlock([worldInfoBlock, ...mvuRules].filter(Boolean).join('\n\n'));
            }
        }
        const stat = await getMvuStatData();
        captureManualDiagnoseContext(
            stat ? JSON.stringify(stat, null, 2) : '',
            extractUpdateBlock(getLatestAiMessageText()),
        );
        diagStampKey = diagStatKey(stat);   // 🩺 陈旧印章：这一轮诊断是按【这一份】状态算的
    } else if (lorebookMode) {
        // Read the selected world book(s) fresh so the model sees the current
        // state, and remember which books are in scope for the apply step.
        await buildLorebookContext();
    } else if (advisorMode) {
        // 参谋现在遵循设置面板的「世界书」选择，包括「关」——不传 forceMode = 用
        // s.worldInfoMode，'off' 返回空串（与普通聊天分支同款）。剧情概要仍在 buildAdvisorPrompt 里默认读取，
        // 对话记录也改为遵循「上下文深度」设置（见 buildAdvisorPrompt）。侧聊最近问答参与绿灯扫描（1.31.0）。
        replaceWorldInfoBlock(await buildWorldInfo(undefined, await sideChatScanBlob(), { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs }));   // 参谋 = READ 家族，opt-in 时执行世界书 EJS
        // Live MVU variable state (好感度 / 时间 / 资源…) — hard story facts the
        // proposed beats must not contradict. Silently absent for non-MVU cards.
        const stat = await getMvuStatData();
        replaceAdvisorStatData(stat ? JSON.stringify(stat, null, 2) : '');
    } else if (fixMode) {
        // 校正模式（手动 / 引导式：在输入框直接说要改什么）：抓待校正回复 + 手动那套上下文（卡 / 世界书 / 概要 / 全部前文）。
        // wholeFloor:true = 整篇手动（思考块保护 W1 只在这条分支生效；✂️ 选段家族同以 mode:'manual' 调用但不传）。
        fixContext = await captureFixContext(s, { mode: 'manual', wholeFloor: true });
        if (fixContext.manualScopeMissed) addSystemNote(`这条回复里没找到 <${fixContext.manualScopeMissed}> 标签，本次按整条回复校正。`);
        // 手动重复校正继续允许，但会覆盖消息里上一层单步撤销记录。
        if (isFixedReply((getCtx().chat || [])[fixContext.targetIdx])) addSystemNote('这条回复当前显示的已是一次校正结果；继续应用会覆盖上一层撤销记录。');
    } else if (builderMode) {
        // 角色工坊：读勾选的世界书条目（原样投喂），并按需取权威变量状态（与普通聊天 chatStatData 同源）。
        await buildBuilderContext();
        clearBuilderStatData();
        if (s.bldIncludeStat) {
            const st = await getMvuStatData();
            captureBuilderStatData(st ? JSON.stringify(st, null, 2) : '');
        }
    } else if (presetCurationActive(s)) {
        // Faithful assembly needs WI split into the Before/After-Char-Defs slots.
        const split = await buildWorldInfoSplit(undefined, await sideChatScanBlob(), { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs });   // 侧聊问答参与绿灯扫描（1.31.0）；普通聊天 = READ 家族，opt-in 时执行世界书 EJS
        replacePresetWorldInfo(split.before, split.after);
        replaceWorldInfoBlock(''); // legacy single-block path unused while preset is active
    } else {
        replaceWorldInfoBlock(await buildWorldInfo(undefined, await sideChatScanBlob(), { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs })); // 'off' 时仍空串；侧聊问答参与绿灯扫描（1.31.0）；普通聊天 = READ 家族，opt-in 时执行世界书 EJS
    }

    // Normal chat mode only: fetch the authoritative variable state (or leave ''
    // so the prompt builders emit the honest-refusal caveat instead).
    replaceChatStatData('');
    if (!diagnoseMode && !lorebookMode && !advisorMode && !fixMode && s.chatIncludeStat) {
        const st = await getMvuStatData();
        replaceChatStatData(st ? JSON.stringify(st, null, 2) : '');
    }

    // 外部扩展世界信息（世界引擎等）——普通聊天与剧情参谋两种模式都附带（用户功能请求）；
    // 诊断 / 世界书模式不需要。无相关扩展时 assembleExternalWorld() 返回 ''，整段省略。
    replaceChatWorldData('');
    if (!diagnoseMode && !lorebookMode && !fixMode && s.chatIncludeWorld) {
        replaceChatWorldData(assembleExternalWorld());
    }
    }

    const messages = options.messages || buildMessages(fixContext);
    // Snapshot the exact prompt for the debug viewer (both modes).
    const promptSnapshot = messages.map((m) => ({ role: m.role, content: m.content }));
    recordLastPrompt(promptSnapshot, {
        mode: diagnoseMode ? '诊断' : (lorebookMode ? '世界书' : (advisorMode ? '参谋' : (fixMode ? '校正' : (builderMode ? '角色工坊' : '聊天')))),
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: promptSnapshot.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    });
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = options.assistantEl || addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = (options.showTyping || showTyping)(contentEl);
    const generation = beginGeneration();

    try {
        let finalText = '';
        const transport = options.transport || {};
        resetLastFinishReason();   // FIX 4：每轮复位，防上一轮 finish_reason 漏进本轮空回复判据
        // Diagnose audits are long, and reasoning models spend part of the budget
        // "thinking" before any visible output — too small a cap yields an empty
        // reply (budget gone during thinking) or a patch cut off mid-token. Give
        // Diagnose a generous floor so a full 审计 has room to finish.
        // Tier 0 ③：校正走专属预算 fixEffMaxTokens（可被 fixMaxTokens 顶高，救长楼层截断）；诊断保持 4096 地板。
        const effMaxTokens = fixMode ? fixEffMaxTokens(s) : (diagnoseMode ? Math.max(Number(s.maxTokens) || 0, 4096) : s.maxTokens);
        if (s.mode === 'direct') {
            const url = resolveEndpointUrl(s);
            const body = {
                model: s.model,
                messages,
                // FIX 4（cause D）：gemini-3 系把思考记进 max_tokens，用户手动调到 <4096 会被思考吃光→空回复。
                // 只对 gemini-3 且本次有效值 <4096 抬到 4096（只升不降、不落盘）。其余模型/值原样。
                max_tokens: gemini3MaxTokensFloor(s.model, effMaxTokens),
            };
            if (s.sendTemperature) body.temperature = s.temperature;
            if (s.stream) {
                contentEl.classList.add('pad-streaming');
                finalText = await (transport.streamDirect || streamDirect)(url, s.apiKey, body, generation.signal, (delta) => {
                    clearTyping();
                    contentEl.textContent += delta;
                    if (soFollowStream) scrollToBottom();   // #1 只在用户跟随到底部时才自动滚
                });
                contentEl.classList.remove('pad-streaming');
            } else {
                finalText = await (transport.callDirect || callDirect)(url, s.apiKey, body, generation.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            if (s.stream) {
                contentEl.classList.add('pad-streaming');
                finalText = await (transport.callProfileStream || callProfileStream)(s.profileId, messages, effMaxTokens, override, generation.signal, (full) => {
                    clearTyping();
                    contentEl.textContent = full;
                    if (soFollowStream) scrollToBottom();   // #1 只在用户跟随到底部时才自动滚
                });
                contentEl.classList.remove('pad-streaming');
            } else {
                finalText = await (transport.callProfile || callProfile)(s.profileId, messages, effMaxTokens, override, generation.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        }

        clearTyping();
        if (!finalText) {
            // 空回复先列常见原因；下方再用直连返回的 finish_reason 补充预算耗尽提示。
            // 此处不读取 usage，不能只凭空正文断言原因。换行按 .pad-content 的 pre-wrap 显示。
            let emptyNote = diagnoseMode
                ? '(空回复) — 审计可能把 token 预算用光了（推理也算在内）。调大设置里的「最大 token 数」，或问得更聚焦一点（比如只审某一类变量）。'
                : '(空回复) — 端点收下了请求，但没有返回正文。常见三因：\n' +
                  '① 「最大 token 数」太小，或被模型思考占满 → 到设置里调大它再试。\n' +
                  '② 触发了 Gemini 安全过滤 → 换个说法，或开破限 / 换个模型再试。\n' +
                  '③ 公益站 PvP';
            // FIX 4（cause D）：直连路已读到 finish_reason；若确证是「思考吃光输出预算」就给一句明确提示，压在通用三因之前
            //（配置文件路读不到 finish_reason，传输层 finish reason 恒空 → 判据为假 → 仍走通用三因，不误报）。
            if (isEmptyLengthReply(finalText, getLastFinishReason())) {
                // 文案待 Prince 否决权
                emptyNote = '本次输出额度被模型的思考过程吃光了（finish_reason=length）——请把设置里的「最大 token 数」调到 4096 以上再试。\n\n' + emptyNote;
            }
            contentEl.textContent = emptyNote;
            contentEl.classList.add('pad-error');
            addRetryControl(assistantEl, aEntry);   // 空回复也给「↻ 重试」（与真实失败一致）
        } else {
            // Strip main-chat mechanism blocks (<UpdateVariable>) the preset's
            // output contract may have coaxed out of the model — display AND
            // history, chat/advisor modes only (see stripMechanismBlocks).
            const mechStrip = !diagnoseMode && !lorebookMode;
            let cleanText = finalText;
            if (mechStrip) {
                cleanText = stripMechanismBlocks(finalText);
                // Backstop for CoT leakage: some custom presets / reasoning models
                // emit visible <think>/<thinking> blocks the oracle has no pipeline
                // to hide (the main chat does). Strip them from display AND history
                // so an imperfect — or absent — thinking-strip regex can't leave
                // them on screen, and they never re-feed into the next turn.
                cleanText = stripReasoningTags(cleanText);
                if (!cleanText) {
                    // The whole reply was hidden content — show why instead of a
                    // blank bubble, and keep history non-empty (some APIs reject
                    // empty message content on the next turn).
                    cleanText = '（这条回复只剩被自动隐藏的内容——主聊天机制区块（如 <UpdateVariable>）或思维链（如 <think>）。）';
                }
                if (cleanText !== finalText) contentEl.textContent = cleanText;
            }
            // When a curated preset drives the output AND regex is on, mirror main
            // chat: RENDER the reply through ST's own formatter (so display-stage
            // regex, markdown, and HTML/CSS widgets actually render instead of
            // showing as raw text), and STORE the prompt-stage regex'd copy in
            // history (clean text for re-feeding — no widget markup looping back).
            // Never for the plain textarea prompt, never in Diagnose mode (which
            // needs the raw <UpdateVariable> block intact).
            // 普通聊天定稿渲染（#2 Markdown）：开「应用正则」→ 走 ST 自己的 messageFormatting（正则=全局+当前角色+
            // 当前选中预设 + Markdown + HTML 挂件，与主聊天一致）；关正则 → 只渲染 Markdown（showdown+DOMPurify，不碰
            // 正则引擎）。历史仍存干净文本（仅精选预设+正则时存 prompt 阶段正则后的拷贝，与原行为一致）。诊断/世界书/校正 不在此渲染
            //（诊断/世界书要原样看 <UpdateVariable>/<LorebookEdit> 块）。
            // 参谋（1.18.2）：散文段渲 Markdown（只走 renderMarkdownOnly，不碰正则引擎），<StoryPlan> 块进
            // <pre class="pad-plan-raw"> 转义原样——渲染只动 DOM；下面的 parseStoryPlans/历史用的是 cleanText
            // 【字符串】，采纳卡与再喂完全不受影响。库缺失 → null → 维持纯文本（与 1.17.18 同一回退契约）。
            const isPlainChat = !diagnoseMode && !lorebookMode && !advisorMode && !fixMode && !builderMode;
            const useOutputRegex = isPlainChat && presetCurationActive(s) && s.applyRegex;
            let historyText = cleanText;
            if (useOutputRegex) historyText = applyOutputRegex(cleanText, /*forPrompt*/ true);
            if (isPlainChat) {
                const html = s.applyRegex ? renderReplyHtml(cleanText) : renderMarkdownOnly(cleanText);
                if (html != null) {
                    contentEl.innerHTML = html;
                    contentEl.classList.add('pad-rendered');
                    contentEl.style.whiteSpace = 'normal';
                } else {
                    contentEl.textContent = cleanText;
                }
            } else if (advisorMode) {
                const html = renderAdvisorReplyHtml(cleanText);
                if (html != null) {
                    contentEl.innerHTML = html;
                    contentEl.classList.add('pad-rendered');
                    contentEl.style.whiteSpace = 'normal';
                }
            } else if (builderMode) {
                const html = renderBuilderReplyHtml(cleanText);
                if (html != null) {
                    contentEl.innerHTML = html;
                    contentEl.classList.add('pad-rendered');
                    contentEl.style.whiteSpace = 'normal';
                }
            }
            aEntry.content = historyText;
            // 🩺 陈旧印章（Task 5，审计簇 F）：把「这份诊断是按【哪个聊天】、按【哪份状态】算的」钉在
            // 条目上——应用按钮据此判断「诊断之后世界又变过没有」。必须钉在 appendConvo / persistConvo
            // 【之前】：它跟着这条记录同一次写入落盘，重载后那道闸才有依据（serializeConvo 会带上它）。
            // 指纹取【建提示词时】那一份（diagStampKey）；那一份缺席（模式在生成途中被切进来）→ 现取
            // 一次兜底，绝不留空。
            const block = diagnoseMode ? extractUpdateBlock(finalText) : '';
            if (block) {
                aEntry.diagStamp = {
                    chatKey: chatIdentityKey(),
                    statKey: diagStampKey != null ? diagStampKey : diagStatKey(await getMvuStatData()),
                    time: Date.now(),
                };
                // 🩺 正文注入靶子（Task 6，审计簇 I）：记下「这轮诊断读的是【哪一楼】、当时正文长什么样」，
                // 供手动「应用」把修正折成绝对值补丁插回那条回复（与自动路同一味药，见 addApplyControls）。
                // 【有意只活在会话注册表里、不落盘】——与撤销按钮同半径：重载后注册表为空 → 不注入，行为
                // 与今天逐字相同；而 injectDiagPatchIntoMessage 的 expectText 守卫让任何陈旧尝试都只是一次
                // 静默跳过，所以「跨重载留着」既没有收益也不安全。写在 appendConvo / addApplyControls 之前
                // （注册表按 房间::记录id + 内容 校验，aEntry.content 上面刚定稿）。
                // ⚠ 跨聊天由注册表自身兜住：onChatChanged 的 clearNoteOpts() 会连靶子一起作废，所以
                // aiIdx 绝不可能落到【另一个聊天】的同号楼上（与撤销快照同一条不变量）。
                // 取【此刻最新那一楼】而不是建提示词时那一楼：折出来的是【绝对值】补丁，落在最后被重放的
                // 区块里，replace 语义恒赢；钉在更早的楼上反而会被后面的楼盖掉。
                if (ENABLE_DIAG_BODY_INJECT) {
                    const injT = getLatestAiMessage();
                    registerNoteOpts(convoStreamKey, aEntry, Object.assign({}, peekNoteOpts(convoStreamKey, aEntry) || {}, {
                        diagTarget: injT.idx >= 0 ? { aiIdx: injT.idx, aiText: injT.text } : null,
                    }));
                }
            }
            appendConvo(aEntry);
            persistConvo();
            if (diagnoseMode) {
                // 第 4 参 finalText（1.68.0）：双区块闸要数「MVU 会执行几块」，而 block 只是最早那一个
                // 包装块 —— 模型甩两个包装块时，第二块的指令会被静默丢掉。
                if (block) {
                    addApplyControls(assistantEl, block, aEntry, finalText);
                    // 🩺 1.89.0：应用键上方先说清这张卡不会接受哪几处；必要时自动发一次重写请求（spec §4.2/§4.3）。
                    if (ENABLE_SCHEMA_DIAG) diagSchemaAfterManualReply(assistantEl, finalText, aEntry);
                }
            } else if (lorebookMode) {
                const parsed = parseLorebookBlocks(finalText);
                if (parsed.ops.length || parsed.errors.length) addLorebookApplyControls(assistantEl, parsed, aEntry);
            } else if (advisorMode) {
                const plans = parseStoryPlans(cleanText);
                if (plans.length) addPathCards(assistantEl, plans);
            } else if (fixMode) {
                // 失败时 .pad-content 已显示剥离机制/思维链后的 cleanText，不覆盖它——只补一条说明 note。
                const fixStatus = renderFixCard(assistantEl, contentEl, aEntry, finalText, fixContext);
                if (fixStatus === 'truncated') {
                    addSystemNote('校正稿似乎被截断了（模型没写完就断了）——把设置里的「最大 token 数」调大些，或点 ↻ 重试。');
                } else if (fixStatus !== 'ok') {
                    addSystemNote('没能从模型回复里解析出校正稿，已原样保留。请检查连接/模型，或换一句指令重试。');
                }
            } else if (builderMode) {
                // 角色工坊：分流本轮回复——汇总（brief）→ 存状态 + 挂「🔨 生成」卡；修改区块（patch）→
                // 对当前草稿做外科手术式拼接、回存、刷新常驻卡，并如实汇报命中数。用 cleanText（与 renderBuilderReplyHtml 同源）。
                const cls = classifyBuilderReply(cleanText);
                if (cls.kind === 'draft') {
                    // 访谈轮里模型直接给出【整稿】——用户要「重置版」这类全篇改写时，<DraftPatch> 的锚点表达不了，
                    // 模型改发 <CharDraft> 是合理选择。此前这条路无人接手：状态不写、卡不刷、也不报错，用户只看见
                    // 草稿印在聊天里、常驻卡永远停在「草稿还未生成」（1.43.1 用户上报）。照锻造成功路径入坞。
                    const cur = getBuilderState();
                    const draft = { ...cls.draft };
                    if (draft.content) draft.content = sanitizePersonaDraft(draft.content, builderVariantKey(getSettings()));
                    setBuilderState({ ...cur, draft, forgedAt: Date.now() });
                    refreshDraftCard();
                    // 与 runForge 成功分支同款：卡在收起的面板里等于没出现，替用户展开。
                    const bldCollapse = win?.querySelector('#pad-bld-collapse');
                    if (bldCollapse && !bldCollapse.open) bldCollapse.open = true;
                    modeEntryNote('这轮回复里带了完整草稿，已收进窗口顶部「角色工坊」面板的常驻卡'
                        + (cur?.draft ? '（替换了原来那份——想要旧的就再说一次原来的写法）' : '')
                        + '。想改哪里直接说；满意就点「写入」。');
                } else if (cls.kind === 'brief') {
                    const cur = getBuilderState();
                    setBuilderState({ brief: cls.brief, draft: cur?.draft || null, forgedAt: cur?.forgedAt || null });
                    addBriefControls(assistantEl, cls.brief);
                } else if (cls.kind === 'patch') {
                    const cur = getBuilderState();
                    if (!cur || !cur.draft) {
                        modeEntryNote('收到修改区块，但当前没有草稿——先「🔨 生成」一稿。');
                    } else {
                        // ✂️ 精简变体：修订落在【当前激活变体】上；打完补丁两变体已分叉，只留补丁版为唯一真相。
                        const hadCond = ENABLE_DRAFT_CONDENSE && typeof cur.draft.condensed === 'string';
                        const { result, results } = applyDraftPatchOps(activeDraftContent(cur.draft), cls.ops);
                        setBuilderState({ ...cur, draft: draftWithPatchedActive(cur.draft, result) });
                        refreshDraftCard();
                        const ok = results.filter((r) => r.ok).length;
                        const misses = results.filter((r) => !r.ok).map((r) => `「${r.anchor.slice(0, 24)}…」${r.reason}`);
                        modeEntryNote(`草稿已更新：${ok} / ${results.length} 处改动生效。` + (misses.length ? ' 未生效：' + misses.join('；') + ' ——可以再说一遍要改哪句，或让它改用「起始 || 结尾」两端锚点再试。' : '') + (hadCond ? '（修订落在当前显示的版本上；原稿/精简稿切换已收起，以修订后这份为准）' : ''));
                    }
                } else if (cls.draftError) {
                    // 有 <CharDraft> 但没解析成（多半是临时起意写整稿、漏了 target 这类机器读的头部键）。
                    // 静默丢弃会让用户以为草稿已经收下了——如实说一声，并给两条出路。
                    modeEntryNote(`这轮回复里的 <CharDraft> 没能收下（${cls.draftError}）——正文已原样留在上面。`
                        + '可以让它「把刚才那版重发一次，头部带上 target」，或直接点常驻卡上的「🔨 生成」由锻造工序出稿。');
                }
            }
        }
    } catch (err) {
        clearTyping();
        const aborted = isUserAbort(err);
        // errChainMessage 而不是裸 err.message：profile 模式下酒馆把一切失败包成
        // 'API request failed'，真原因埋在 .cause 里（见该函数的注释）。
        contentEl.textContent = aborted ? '(已停止)' : `错误：${explainProviderError(errChainMessage(err))}`;   // FIX 5：确定性 400 追加中文提示
        if (!aborted) {
            contentEl.classList.add('pad-error');
            addRetryControl(assistantEl, aEntry);   // 失败（429 等）→ 常显「↻ 重试」，点它重发那一轮（不用重打）
        }
        console.error('[剧情推进]', err);
    } finally {
        finishGeneration();
        if (soFollowStream) scrollToBottom();   // #1 定稿后只在用户跟随到底部时才滚；否则保持固定顶部（从头读）
    }
}


// 运行时薄封装（读 getCtx；导出以便测试 stub SillyTavern.getContext）：聊天身份键 groupId::chatId。
// 【排除 characterId】（R4）——群聊生成中它被改写成应答成员，纳入会在同一群聊里误判成换了聊天。getContext
// 不可用 / 抛错 → 退化成 '::'（空键；前后两次取值一致时仍相等，不假性判陈旧）。
export function chatIdentityKey() {
    try {
        const ctx = getCtx();
        return String((ctx && ctx.groupId) || '') + '::' + String((ctx && ctx.chatId) || '');
    } catch (e) {
        return '::';
    }
}