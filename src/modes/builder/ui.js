import { buildImportedTurns, confirmModeSwitch, convoForPrompt, convoMetaKeyFor, getConvoMeta, persistConvo, roomHasDiscussion, saveChatMetadata } from '../../core/chat-metadata.js';
import { getCtx, getSettings, uiConfirm } from '../../core/settings.js';

import { addNoteMessage, modeEntryNote, showTyping } from '../advisor/cards.js';
import { activeDraftContent, applyCondenseOps, condenseAssemble, condenseGuards, condenseSplitSections, condenseStyleFlagged, draftToLorebookOp, getBuilderState, getChatMetadataSafe, getPath, parseCondenseOps, parseCondenseReply, resolveEntryUidByTitle, setBuilderState } from '../advisor/metadata.js';
import { stripReasoningTags } from '../chat/context.js';
import { scrollToBottom, soBulkRender } from '../chat/history.js';
import { isUserAbort, onSend } from '../chat/send.js';
import { getMvuStatData } from '../diagnose/mvu.js';
import { buildBuilderContext, buildForgeMessages, bldBookNames, captureBuilderStatData, clearBuilderStatData } from './context.js';
import { builderVariantKey, forgePatchToDraft, parseCharDraft, parseDraftPatch, renderBuilderReplyHtml, resolveBuilderTargetBook, sanitizePersonaDraft } from './model.js';
import { applyLorebookOps, undoLorebookOps } from '../lorebook/operations.js';
import { getActiveBookNames, getAllBookNames, getWiEditApi, resolveLbTargetNames } from '../lorebook/world-info.js';
import { ENABLE_DRAFT_CONDENSE, ENABLE_LIGHT_CONDENSE, ENABLE_MODE_ROOMS } from '../../prompts/builtins.js';
import { P } from '../../prompts/registry.js';
import { createPersonaWithAvatar, deletePersonaById, personaNameExists, restorePersonaDesc, writeActivePersonaDesc } from '../../st/adapters.js';
import { dispatchBuilderRequest } from './request.js';
import { addMessage, soFollowStream } from '../../ui/messages.js';
import { currentOracleMode, focusOracleInput, modeReturnNote, refreshDraftCard, setOracleMode } from '../../ui/mode-shell.js';
import { appendConvo, convoStreamKey, nextCid } from '../../core/conversation-store.js';
import { beginGeneration, clearLiveCondense, clearLiveForge, finishGeneration, isGenerating, liveCondense, liveForge, registerLiveCondense, registerLiveForge } from '../../core/generation.js';
import { advisorMode, priorOracleMode, rememberPriorOracleMode, resetPriorOracleMode } from '../../core/oracle-modes.js';
import { recordLastPrompt } from '../../core/recent-prompt.js';
import { inputEl, messagesEl, win } from '../../ui/refs.js';

// 锻造：一次完整调用（brief + 全上下文）→ <CharDraft> 草稿。复用统一生成控制器——
// beginGeneration() 已把发送键变成「停止」键，点它经 onSend → stopGeneration 中断当前控制器；
// 另加 arc 同款 180s 超时兜底，到点自动 abort。
// 工序要求显式 CoT（<thinking>）——展示 / 历史 / 解析前用 stripReasoningTags 统一剥离。
// keep-forging 辅助①：把累积文本画进保活运行（liveForge / liveCondense 同形描述子）气泡的 .pad-content
//（仅当它当前挂在 DOM 上——离房时气泡被 loadConvoForChat 清掉，此时静默跳过；回房会由 loadConvoForChat
// 重挂气泡并接上后续增量）。深度精简保活（1.36.0）复用本函数。
function paintForge(f) {
    const el = f && f.entry && f.entry._el;
    const c = el && typeof el.querySelector === 'function' ? el.querySelector('.pad-content') : null;
    if (c && c.isConnected) c.textContent = f.text;
}

// keep-forging 辅助②：把锻造成稿 / 停止桩按【原始房间】归位落盘。正看着该房 → 推进 convo + persistConvo
//（气泡已在 DOM）；已切走 → 只往那房的元数据补一条（不惊动当前可见房），回房时 loadConvoForChat 读出重画。
// 深度精简保活（1.36.0）复用本函数归位（同为工坊房间的 assistant 回复）。
// role 保成 'assistant'（区别于 appendNoteToRoom 强制 'note'）→ 回房走 renderBuilderReplyHtml 而非注记样式。
// getChatMetadataSafe 兜 null → fail-open 不抛。可单测（builder-forge-bg.test.mjs）。
function routeForgeReply(roomKey, entry) {
    if (roomKey === convoStreamKey) {
        appendConvo(entry);
        persistConvo();
        return;
    }
    const md = getChatMetadataSafe();
    if (!md) return;
    const mk = convoMetaKeyFor(roomKey);
    const arr = Array.isArray(md[mk]) ? md[mk].slice() : [];
    arr.push({ id: entry.id, role: entry.role, content: entry.content });
    md[mk] = arr;
    saveChatMetadata();
}

export async function runForge() {
    if (isGenerating) return;
    const s = getSettings();
    const st = getBuilderState();
    if (!st || !st.brief) { modeEntryNote('还没有 <CharBrief> 汇总——先聊到访谈师给出汇总为止。'); return; }
    const ctx = getCtx();
    // 与 generateReply 的 builder 分支同款：发送前重读世界书选段 + 权威变量状态。
    await buildBuilderContext();
    clearBuilderStatData();
    if (s.bldIncludeStat) {
        const stat = await getMvuStatData();
        captureBuilderStatData(stat ? JSON.stringify(stat, null, 2) : '');
    }
    const messages = buildForgeMessages(ctx, s, st.brief);
    // 调试提示词查看器快照（与 generateReply 同一形状）。
    const prompt = messages.map((m) => ({ role: m.role, content: m.content }));
    recordLastPrompt(prompt, {
        mode: '工坊锻造',
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: prompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    });
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = showTyping(contentEl);
    // keep-forging：把这次锻造登记为「后台可续」——记住它属于哪个工坊房间(streamKey)、气泡 entry、累积
    // 文本(text)。切模式时不中断（见 loadConvoForChat 的 !liveForge 守卫），完成/失败按此房归位（routeForgeReply）。
    const myForge = { streamKey: convoStreamKey, entry: aEntry, text: '' };
    registerLiveForge(myForge);
    const ctl = beginGeneration();
    // 锻造超时看门狗（T13）：旧版是平坦的墙钟——会误杀仍在正常流式输出的长锻造（Prince 实测中招），
    // 且中止提示与手动停止无从区分。改为【空闲】看门狗：流式路径每收到一段增量就把 180s 计时重置；
    // 非流式路径没有进度信号，只能用一个 600s 的平坦兜底。超时触发时先置 forgeTimedOut=true 再 abort，
    // 好在 catch 里与「用户手动停止」区分开、给出不同措辞 + 可操作提示。
    let forgeTimedOut = false;
    let killTimer = null;
    const armWatchdog = (ms) => {
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => { forgeTimedOut = true; try { ctl.abort(); } catch (e) { /* ignore */ } }, ms);
    };
    try {
        let finalText = '';
        // 锻造 = 显式 CoT + 全上下文的重活。下限 16384（1.29.0 起；1.23.0 起曾 12288）：polish-5
        // 合并电池实测，新骨架下 DS 全 15 章节锻造 8 roll 有 3 roll 触到或压过 12288（最高 14612），
        // 且顶棚 roll 纪律全面劣化（标签漏/衍生引号/解释尾）；16384 覆盖全部实测峰值。
        // 老下限 12288 来自 lessons-pass 实测（DS 思考双峰、最重 ~10k）、8192 来自 T9 冷模型验证。
        // T13：用户可用「锻造回复上限」(bldMaxTokens) 在下限之上再顶（超大世界书致思考+成稿被截时）。
        const effMaxTokens = Math.max(s.maxTokens, Number(s.bldMaxTokens) || 0, 16384);
        const streaming = !!s.stream;
        if (streaming) {
            contentEl.classList.add('pad-streaming');
            armWatchdog(180000);
        } else {
            armWatchdog(600000);
        }
        finalText = await dispatchBuilderRequest(s, messages, effMaxTokens, ctl.signal, (chunk, cumulative) => {
            armWatchdog(180000);
            clearTyping();
            myForge.text = cumulative ? chunk : myForge.text + chunk;
            paintForge(myForge);
            if (soFollowStream && convoStreamKey === myForge.streamKey) scrollToBottom();
        });
        if (streaming) contentEl.classList.remove('pad-streaming');
        clearTyping();
        // 剥掉工序写出的 <thinking> CoT——剥完为空 = 预算多半被思考占满（或真空回复），如实提示。
        const cleanText = stripReasoningTags(String(finalText || ''));
        // keep-forging：若期间切了【聊天】(onChatChanged 会置空 liveForge)，这条锻造属于旧聊天——丢弃 DOM
        // 与落盘，绝不写进新聊天；finally 仍会释放 isGenerating。
        if (liveForge !== myForge) return;
        const originKey = myForge.streamKey;                                       // 锻造起跑时所在的工坊房间
        const viewing = (convoStreamKey === originKey);                            // 用户此刻是否正看着该房
        const forgeContentEl = viewing && aEntry._el && aEntry._el.isConnected ? aEntry._el.querySelector('.pad-content') : null;
        if (!cleanText) {
            aEntry.content = '(空回复) — 多半是「最大 token 数」太小、被工序的 <thinking> 思考占满了。到设置里调大它，再点一次「🔨 生成」。';
            if (forgeContentEl) { forgeContentEl.textContent = aEntry.content; forgeContentEl.classList.remove('pad-streaming'); forgeContentEl.classList.add('pad-error'); }
            routeForgeReply(originKey, aEntry);
            return;
        }
        aEntry.content = cleanText;
        if (forgeContentEl) {
            forgeContentEl.classList.remove('pad-streaming');
            const html = renderBuilderReplyHtml(cleanText);
            if (html != null) {
                forgeContentEl.innerHTML = html;
                forgeContentEl.classList.add('pad-rendered');
                forgeContentEl.style.whiteSpace = 'normal';
            } else {
                forgeContentEl.textContent = cleanText;
            }
        }
        routeForgeReply(originKey, aEntry);
        let { draft, error } = parseCharDraft(cleanText);
        let rescueNote = '';
        // #1 救援：npc-edit 时模型 ~3/5 从锻造直接吐 <DraftPatch>（FINDINGS Round B）。parseCharDraft 认不得 →
        // 用现有条目正文吃下补丁、合成完整草稿入坞，别误报「没产出草稿」（＝Prince 的「编辑经常失败」）。
        if (!draft && st.brief?.target === 'npc-edit') {
            const { ops } = parseDraftPatch(cleanText);
            if (ops.length) {
                const found = await fetchNpcEntryForBrief(st.brief);
                if (found) {
                    const r = forgePatchToDraft(found.content, ops, st.brief, found.uid);
                    if (r.draft) { draft = r.draft; rescueNote = r.note; }
                    else if (r.error) error = r.error;
                } else {
                    error = '锻造给的是补丁，但找不到要改的条目——让访谈师在汇总里带上 uid 或准确的条目标题';
                }
            }
        }
        if (draft) {
            const bldVariant = builderVariantKey(getSettings());
            // v4 探针兜底（Phase D）：入坞前剥编造引号台词/软化绝对词——persona 变体专属，card 原样回。
            if (draft.content) draft.content = sanitizePersonaDraft(draft.content, bldVariant);
            setBuilderState({ ...getBuilderState(), draft, forgedAt: Date.now() });
            refreshDraftCard();
            // 草稿卡在「角色工坊」面板里（窗口顶部）——用户常把面板收起省聊天空间，锻造成功就替 TA 展开；
            // 只在成功分支做，不动重载 / 切聊时的折叠偏好。
            const bldCollapse = win?.querySelector('#pad-bld-collapse');
            if (bldCollapse && !bldCollapse.open) bldCollapse.open = true;
            // keep-forging：只在用户正看着工坊时报「锻造完成」——已切走则静默（Prince：不要提示），草稿卡与房间
            // 历史已就位，回工坊自见（注记若发去当前房 = 落进别的模式，故必须 gate）。
            if (viewing && convoStreamKey === originKey) {
                modeEntryNote((rescueNote ? rescueNote + '。' : '') + '锻造完成——草稿在窗口顶部「角色工坊」面板的常驻卡里（面板收起时，点「角色工坊」标题展开）。想改哪里直接说；满意就点「写入」。');
            }
            // ✂️ 锻造后自动精简（1.30.0，读点 2/3）：opt-in + npc-* + ≥2500字 + 风格门点火才补一发轻精简
            //（terse 稿【进不了】这里——gm-v01 电池教训：模型对干净卡会凑量误删，入口必须代码侧把关）。
            // setTimeout(0)：等本函数 finally 释放 isGenerating 后再起跑。
            if (ENABLE_LIGHT_CONDENSE && ENABLE_DRAFT_CONDENSE && s.bldAutoCondense && String(draft.target || '').startsWith('npc')
                && String(draft.content || '').length >= 2500 && condenseStyleFlagged(draft.content)) {
                setTimeout(() => runCondense({ auto: true }), 0);
            }
        } else {
            if (viewing) modeEntryNote('这次锻造没有产出可解析的 <CharDraft>' + (error ? `（${error}）` : '') + '——可以直接再点一次「🔨 生成」。');
        }
    } catch (err) {
        clearTyping();
        console.error('[剧情推进]', err);
        // keep-forging：切了聊天(liveForge 被 onChatChanged 置空) → 这条属于旧聊天，丢弃不落盘。
        if (liveForge !== myForge) return;
        const stopped = isUserAbort(err);
        const originKey = myForge.streamKey;
        const viewing = (convoStreamKey === originKey);
        const forgeContentEl = viewing && aEntry._el && aEntry._el.isConnected ? aEntry._el.querySelector('.pad-content') : null;
        let msg;
        if (stopped && forgeTimedOut) {
            // 超时中止（看门狗触发的 abort）——与用户手动停止用不同措辞，并给一条可操作提示。
            msg = '（锻造超时——长时间无响应，已中止）';
            if (viewing) modeEntryNote('锻造超时。可以直接再点一次「🔨 生成」重试；若反复超时，试试调低上下文深度或减少勾选的世界书条目。');
        } else {
            msg = stopped ? '（已停止）' : ('锻造调用失败：' + (err?.message || err));
        }
        aEntry.content = msg;
        if (forgeContentEl) {
            forgeContentEl.textContent = msg;
            forgeContentEl.classList.remove('pad-streaming');
            if (!stopped) forgeContentEl.classList.add('pad-error');
        }
        routeForgeReply(originKey, aEntry);
    } finally {
        if (killTimer) clearTimeout(killTimer);
        clearLiveForge(myForge);   // 只注销自己这次（若已被切聊天置空/替换则不动）
        finishGeneration();
        if (soFollowStream && convoStreamKey === myForge.streamKey) scrollToBottom();
    }
}

// ✂️ 轻精简（1.30.0）：对当前草稿的【原稿】跑一次 DRAFT_CONDENSE_PROMPT（v0.2 冻结件），守卫全绿
// 才挂上精简稿变体；任何失败 = 原稿原样保留 + 如实说明（fail-open，spec §4.1/§4.3）。
// auto=true 是锻造后的静默触发：不弹确认、失败降为一行注记。精简永远从原稿起跑（幂等，重跑覆盖旧精简稿）。
export async function runCondense(opts = {}) {
    if (!ENABLE_DRAFT_CONDENSE || !ENABLE_LIGHT_CONDENSE || isGenerating) return;   // 轻精简 2026-07-19 起全员关闭
    const s = getSettings();
    const st = getBuilderState();
    const draft = st?.draft;
    if (!draft || !String(draft.target || '').startsWith('npc')) return;   // v1 只做 npc-*（persona 归分家项目）
    const rawC = draft.content;
    if (!opts.auto && !condenseStyleFlagged(rawC)) {
        // 风格门没点火 = 原稿本就精炼（DS/GM 常态）。手动仍可执行，但先确认（条款来自 gm-v01 电池教训：模型会凑量误删）。
        if (!(await uiConfirm('这张卡本就精炼，精简收益不大——仍要执行？'))) return;
    }
    // 自动路径先自报家门（1.17.4 后台调用要可见可中断的老规矩）：不然锻造刚完又冒出第二个流式
    // 气泡，像「又在重新生成」。手动路径不用——按钮是用户自己点的。
    if (opts.auto) modeEntryNote('✂️ 自动精简启动（设置里开着「锻造后自动精简」）——正在精简这份草稿；点 ⏹ 可中断，中断/失败都不影响原稿。');
    const messages = [
        { role: 'system', content: P('bld.condense', null, s) },
        { role: 'user', content: P('bld.condenseAsk', { draft: rawC }, s) },
    ];
    recordLastPrompt(messages.map((m) => ({ role: m.role, content: m.content })), {
        mode: '工坊精简', target: s.mode === 'direct' ? (s.model || '直连') : '配置文件', chars: rawC.length, time: new Date().toLocaleTimeString(),
    });
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = showTyping(contentEl);
    const ctl = beginGeneration();
    let condTimedOut = false, killTimer = null;
    const armWatchdog = (ms) => { if (killTimer) clearTimeout(killTimer); killTimer = setTimeout(() => { condTimedOut = true; try { ctl.abort(); } catch (e) { /* ignore */ } }, ms); };
    try {
        // 下限 16384（spec §4.2）：Gemini 类连接把隐藏推理计进 max_tokens，8192 必截断→守卫回落=白花钱（真 API 电池实测）。
        const effMaxTokens = Math.max(s.maxTokens, Number(s.bldMaxTokens) || 0, 16384);
        let finalText = '';
        const streaming = !!s.stream;
        if (streaming) {
            contentEl.classList.add('pad-streaming');
            armWatchdog(180000);
        } else {
            armWatchdog(600000);
        }
        finalText = await dispatchBuilderRequest(s, messages, effMaxTokens, ctl.signal, (chunk, cumulative) => {
            armWatchdog(180000);
            clearTyping();
            contentEl.textContent = cumulative ? chunk : contentEl.textContent + chunk;
            if (soFollowStream) scrollToBottom();
        });
        if (streaming) contentEl.classList.remove('pad-streaming');
        clearTyping();
        const { content: cond, error: parseErr } = parseCondenseReply(String(finalText || ''));
        contentEl.textContent = cond ? '✂️ 精简完成（正文见草稿卡）' : String(finalText || '(空回复)').slice(0, 400);
        aEntry.content = contentEl.textContent;
        appendConvo(aEntry); persistConvo();
        if (!cond) { condenseFailNote(opts, 'G1', parseErr); return; }
        const g = condenseGuards(rawC, cond);
        if (!g.pass) { condenseFailNote(opts, g.fails.join('+'), `守卫未过（${g.fails.join('、')}）`); return; }
        const cur = getBuilderState();
        if (!cur?.draft || cur.draft.content !== rawC) { condenseFailNote(opts, 'stale', '精简期间草稿已变，本次结果作废'); return; }   // 陈旧守卫（fixTargetStale 同思路）
        setBuilderState({ ...cur, draft: { ...cur.draft, condensed: cond, activeVariant: 'condensed' } });
        refreshDraftCard();
        modeEntryNote(`✂️ 精简完成：${rawC.replace(/\s/g, '').length} → ${cond.replace(/\s/g, '').length} 字（比原稿 ${(g.ratio * 100).toFixed(0)}%）。卡上可在「原稿 ⇄ 精简稿」间切换；写入以当前显示的版本为准。`);
    } catch (err) {
        clearTyping();
        const stopped = isUserAbort(err);
        contentEl.textContent = stopped ? (condTimedOut ? '（精简超时，已中止——原稿不受影响）' : '（已停止）') : ('精简调用失败：' + (err?.message || err));
        if (!stopped) contentEl.classList.add('pad-error');
        aEntry.content = contentEl.textContent;
        appendConvo(aEntry); persistConvo();
        if (!stopped) console.error('[剧情推进]', err);
    } finally {
        if (killTimer) clearTimeout(killTimer);
        finishGeneration();
        if (soFollowStream) scrollToBottom();
    }
}
// 精简失败的统一措辞：手动 → 显眼注记；auto → 低调一行（原稿本来就在，无损）。code 供反馈定位。
function condenseFailNote(opts, code, msg) {
    modeEntryNote((opts.auto ? '（自动精简未采纳：' : '✂️ 精简未采纳：') + msg + (opts.auto ? '——原稿保持不变）' : '。原稿保持不变，可直接再试。') + ` [${code}]`);
}

// ✂️✂️ 深度精简（1.30.0）：3 份并行分节（各带全卡只读参考）→ 装置重组（章节头核对）→ 1 份手术单
// → 装置逐刀核验执行（功能件禁飞区——2026-07-11 掏空事故的修复形态）→ 守卫全绿才挂变体。
// 5 次调用但分节并行，墙钟≈一次；全程非流式（并行流式会在侧聊里互相穿插）。产出与轻精简同形状。
export async function runCondenseDepth() {
    if (!ENABLE_DRAFT_CONDENSE || isGenerating) return;
    const s = getSettings();
    const st = getBuilderState();
    const draft = st?.draft;
    if (!draft || !String(draft.target || '').startsWith('npc')) return;
    const rawC = draft.content;
    if (!condenseStyleFlagged(rawC)) {
        if (!(await uiConfirm('这张卡本就精炼，深度精简收益不大——仍要执行？'))) return;
    }
    const groups = condenseSplitSections(rawC);
    if (groups.length !== 3 || groups.some((g) => !g.text)) { modeEntryNote('✂️✂️ 深度精简未采纳：章节太少，直接用「✂️ 精简全稿」即可。'); return; }
    const aEntry = { id: nextCid(), role: 'assistant', content: '✂️✂️ 深度精简中（3 份分节并行 + 1 份手术单）…' };
    const assistantEl = addMessage('assistant', aEntry.content, aEntry);
    aEntry._el = assistantEl;
    // 保活（1.36.0，keep-forging 同款）：登记这次深度精简——切模式不中断（loadConvoForChat 守卫放行），
    // 离房时气泡被清、回房由 loadConvoForChat 重挂并接上后续流；完成/失败按原始房间归位（routeForgeReply）。
    // 起跑后一切气泡写入都走 myRun.text + paintForge（重挂会换 entry._el，起跑时捕获的元素会失效）。
    const myRun = { streamKey: convoStreamKey, entry: aEntry, text: aEntry.content };
    registerLiveCondense(myRun);
    const runContentEl = () => {
        const el = myRun.entry && myRun.entry._el;
        const c = el && typeof el.querySelector === 'function' ? el.querySelector('.pad-content') : null;
        return c && c.isConnected ? c : null;
    };
    const setStreamingCls = (on) => { const c = runContentEl(); if (c) c.classList.toggle('pad-streaming', on); };
    const ctl = beginGeneration();
    // 平坦兜底（非流式无进度信号）：每【阶段】各给 600s 预算——串行 4 连跑会超单一预算，并行=分节
    // 一份预算、手术单再一份。
    let killTimer = null;
    const armDepthWatchdog = () => { if (killTimer) clearTimeout(killTimer); killTimer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, 600000); };
    armDepthWatchdog();
    const effMaxTokens = Math.max(s.maxTokens, Number(s.bldMaxTokens) || 0, 16384);
    // 深度精简【恒串行 + 流式】（Prince 2026-07-19：逐份串行开关移除，统一走这条）：任一时刻只有一个
    // 请求在天上（限速站 2 次/分钟不再被并发撞穿），且流式的持续字节流能扛过 api.navy 这类 ~100s
    // Cloudflare 硬超时代理（非流式深度精简在这类代理上必 524——上游用户实证）。onProgress 把流实时
    // 铺进气泡；流式每收到一段都重置深度看门狗（空闲判定，活跃流式中不会误触）。
    const useStream = true;
    const callOnce = async (system, user, onProgress) => {
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
        return dispatchBuilderRequest(s, messages, effMaxTokens, ctl.signal, (chunk, cumulative) => {
            armDepthWatchdog();
            if (onProgress) onProgress(chunk, cumulative);
        }, { stream: useStream });
    };
    // 流式实时铺进气泡：direct 回调给增量（+=），profile 回调给累计全文（=）；acc 收敛成「当前阶段全文」。
    // 保活版：写进描述子再经 paintForge 上屏（离房静默、回房重挂后继续画）；只在正看着原房时跟随滚动。
    const streamInto = (header) => { let acc = ''; return (chunk, cumulative) => { acc = cumulative ? chunk : acc + chunk; myRun.text = header + acc; paintForge(myRun); if (soFollowStream && convoStreamKey === myRun.streamKey) scrollToBottom(); }; };
    // 失败收尾（保活版）：气泡定格失败文案并按原始房间落盘（在场/离场都留下如实记录，回房可见）；
    // 打扰型注记只在正看着该房时发（keep-forging 的 Prince 定案：离场静默）。
    const failFinish = (code, msg) => {
        aEntry.content = '✂️✂️ 精简未采纳：' + msg + '。原稿保持不变，可直接再试。 [' + code + ']';
        myRun.text = aEntry.content; paintForge(myRun); setStreamingCls(false);
        routeForgeReply(myRun.streamKey, aEntry);
        if (convoStreamKey === myRun.streamKey) condenseFailNote({}, code, msg);
    };
    try {
        const sectUser = (g) => P('bld.condenseSectAsk', { full: rawC, names: g.names.join('、'), text: g.text }, s);
        // 恒串行：3 份分节一份接一份跑，每份把流实时铺进气泡；每份各续一份看门狗预算。
        const partReplies = [];
        for (let i = 0; i < groups.length; i++) {
            setStreamingCls(true);
            armDepthWatchdog();
            partReplies.push(await callOnce(P('bld.condenseSect', null, s), sectUser(groups[i]), streamInto(`✂️✂️ 深度精简（串行·流式）分节 ${i + 1}/3：\n\n`)));
            setStreamingCls(false);
        }
        if (liveCondense !== myRun) return;   // 切聊天已由 onChatChanged 中断注销——这条属于旧聊天，丢弃
        myRun.text = '✂️✂️ 分节 3/3 已返回，正在开手术单…'; paintForge(myRun);
        const parts = partReplies.map((r) => parseCondenseReply(String(r || '')));
        const bad = parts.findIndex((p) => !p.content);
        if (bad >= 0) { failFinish('sect-G1', `第 ${bad + 1} 份分节没有有效围栏`); return; }
        const asm = condenseAssemble(parts.map((p) => p.content), rawC);
        if (!asm.content) { failFinish('assemble', asm.error); return; }
        armDepthWatchdog();   // 手术单阶段自带一份新预算
        setStreamingCls(true);
        const opsReply = await callOnce(P('bld.condenseOps', null, s), P('bld.condenseOpsAsk', { draft: asm.content }, s), streamInto('✂️✂️ 手术单（串行·流式）：\n\n'));
        setStreamingCls(false);
        if (liveCondense !== myRun) return;   // 手术单期间切了聊天 → 同上丢弃（身份校验在 setBuilderState 之前）
        const { ops } = parseCondenseOps(String(opsReply || ''));
        const applied = applyCondenseOps(asm.content, ops);
        const g = condenseGuards(rawC, applied.content);
        if (!g.pass) { failFinish(g.fails.join('+'), `守卫未过（${g.fails.join('、')}）`); return; }
        const cur = getBuilderState();
        if (!cur?.draft || cur.draft.content !== rawC) { failFinish('stale', '精简期间草稿已变，本次结果作废'); return; }
        setBuilderState({ ...cur, draft: { ...cur.draft, condensed: applied.content, activeVariant: 'condensed' } });
        refreshDraftCard();
        aEntry.content = '✂️✂️ 深度精简完成（正文见草稿卡）';
        myRun.text = aEntry.content; paintForge(myRun);
        routeForgeReply(myRun.streamKey, aEntry);
        if (convoStreamKey === myRun.streamKey) modeEntryNote(`✂️✂️ 深度精简完成：${rawC.replace(/\s/g, '').length} → ${applied.content.replace(/\s/g, '').length} 字（比原稿 ${(g.ratio * 100).toFixed(0)}%；手术单 ${ops.length} 刀，采 ${applied.applied}、装置否决 ${applied.vetoed.length}）。卡上可切换「原稿 ⇄ 精简稿」。`);
    } catch (err) {
        if (liveCondense !== myRun) return;   // 切聊天（onChatChanged 中断并注销）→ 属旧聊天，丢弃不落盘
        const stopped = isUserAbort(err);
        aEntry.content = stopped ? '（已停止——原稿不受影响）' : ('深度精简失败：' + (err?.message || err));
        myRun.text = aEntry.content; paintForge(myRun); setStreamingCls(false);
        if (!stopped) {
            const c = runContentEl();
            if (c) c.classList.add('pad-error');
            console.error('[剧情推进]', err);
        }
        routeForgeReply(myRun.streamKey, aEntry);
    } finally {
        clearTimeout(killTimer);
        clearLiveCondense(myRun);
        finishGeneration();
    }
}

// #1 救援用：读出 npc-edit brief 指认的现有条目正文（+ 落到的 uid）。找不到书 / 条目 → null。
// 复用 applyBuilderDraft 同款反查（getWiEditApi→loadWorldInfo→resolveEntryUidByTitle），供 forgePatchToDraft 吃补丁。
async function fetchNpcEntryForBrief(brief) {
    try {
        const book = brief.book || (bldBookNames.length === 1 ? bldBookNames[0] : '');
        if (!book) return null;
        const mod = await getWiEditApi();
        if (!mod) return null;
        const data = await mod.loadWorldInfo(book);
        if (!data || !data.entries) return null;
        let uid = (brief.uid != null) ? brief.uid : null;
        if (uid == null) uid = resolveEntryUidByTitle(data, brief.entry) ?? resolveEntryUidByTitle(data, brief.name);
        if (uid == null) return null;
        const entry = data.entries[uid] ?? data.entries[String(uid)];
        if (!entry || entry.content == null) return null;
        return { content: String(entry.content), uid };
    } catch (e) { return null; }
}

// 角色工坊 Task 8：草稿「写入」——按 target 分派（改当前 Persona 描述 / 新建 Persona / 写 NPC 世界书条目），
// 每种都在同一颗按钮上做 写入↔撤销 toggle（undo 闭包挂在按钮上，重载 / 卡片重建前有效——沿用世界书卡片同款）。
export async function applyBuilderDraft(btn) {
    const st = getBuilderState();
    if (!st || !st.draft) return;
    const d = { ...st.draft, content: activeDraftContent(st.draft) };   // ✂️ 写入以激活变体为准（无精简稿时 = 原稿，字节不变）
    if (btn._undo) {   // 撤销分支
        btn.disabled = true;
        try {
            await btn._undo();
            btn._undo = null;
            btn.textContent = '写入';
            modeEntryNote('已撤销写入。');
        } catch (e) { modeEntryNote('撤销失败：' + (e?.message || e)); } finally { btn.disabled = false; }
        return;
    }
    btn.disabled = true;
    try {
        if (d.target === 'persona-update') {
            const snap = await writeActivePersonaDesc(d.content);
            btn._undo = async () => { await restorePersonaDesc(snap.avatarId, snap.prevText); };
            modeEntryNote('已写入当前 Persona 的描述。');
        } else if (d.target === 'persona-new') {
            if (personaNameExists(d.name)) {
                if (!(await uiConfirm(`已存在同名 Persona「${d.name}」。仍要再建一个吗？`))) return;
            }
            const avatarId = await createPersonaWithAvatar(d.name, d.content);
            btn._undo = async () => { await deletePersonaById(avatarId); };
            modeEntryNote(`已创建新 Persona「${d.name}」（默认头像，可在 Persona 面板换）。`);
        } else {
            // 选书回退按【点击此刻】的持久化勾选解析（s.bldBooks，与选书器「已选 N 本」读数同源），不再读
            // 模块级 bldBookNames——那只在发访谈消息 / 锻造时刷新，重载后是空的、改勾选后是旧的（小鱼报
            // 「已选 1 本却提示勾选不止一本」的根因）。resolveLbTargetNames：空选 = 跟随当前激活；选中里已从
            // 磁盘消失的书名会被滤掉（改名 / 删除边缘，故 0 本时提示「重新勾一次」）。
            let book = d.book;
            if (!book) {
                const [allNames, activeNames] = await Promise.all([getAllBookNames(), getActiveBookNames()]);
                const r = resolveBuilderTargetBook(resolveLbTargetNames(getSettings().bldBooks, allNames, activeNames));
                if (r.book) book = r.book;
                else if (r.err === 'none') { modeEntryNote('草稿没写目标世界书，而当前没有勾选任何世界书——请在下方选书器勾选目标书（若书刚改过名，重新勾一次），或让访谈师在草稿里补上 book。'); return; }
                else { modeEntryNote('草稿没写目标世界书，且当前勾选了 ' + r.count + ' 本——只勾一本目标书，或让访谈师在草稿里补上 book。'); return; }
            }
            // 复审修复 1：npc-edit 草稿没带 uid 时，先按条目标题反查目标 uid（comment/name → brief.entry 兜底）。
            // 用与 applyLorebookOps 同款的 loadWorldInfo 机制现场读书，且必须在下方 lbBookNames 换挡之外/之前做。
            let editUid = d.uid;
            if (d.target === 'npc-edit' && editUid == null) {
                const wiMod = await getWiEditApi();
                let bookData = null;
                if (wiMod) { try { bookData = await wiMod.loadWorldInfo(book); } catch (e) { bookData = null; } }
                editUid = bookData ? resolveEntryUidByTitle(bookData, d.comment || d.name) : null;
                if (editUid == null && bookData) editUid = resolveEntryUidByTitle(bookData, getBuilderState()?.brief?.entry);
                if (editUid == null) {
                    modeEntryNote('找不到要更新的条目——请告诉访谈师条目的准确标题，或让它在草稿里带上 uid。');
                    return;
                }
            }
            const op = draftToLorebookOp({ ...d, book }, editUid);
            // 世界书应用显式接收工坊范围，不再临时改写世界书模式状态。
            const scope = bldBookNames.length ? bldBookNames.slice() : [];
            if (book && !scope.includes(book)) scope.push(book);
            // noCollapse：工坊写入不套用 B4 create→edit 折叠，保持其原有写入行为字节不变（世界书📖模式才折叠）。
            const res = await applyLorebookOps([op], { noCollapse: true, scope });
            const r = res.results[0];
            if (!r || r.ok === false) { modeEntryNote('写入世界书失败：' + (r?.reason || '未知原因')); return; }
            btn._undo = async () => { await undoLorebookOps(res.snapshots); };
            modeEntryNote(`已写入世界书「${book}」（${op.action === 'create' ? '新建条目' : `更新 uid=${op.uid}`}）。`);
        }
        btn.textContent = '撤销';
    } catch (e) {
        modeEntryNote('写入失败：' + (e?.message || e));
    } finally {
        btn.disabled = false;
    }
}


export async function toggleAdvisor() {
    if (advisorMode) {
        const back = priorOracleMode || 'chat';
        if (!(await confirmModeSwitch(back))) return;   // 1.36.0 中断确认
        resetPriorOracleMode();
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        focusOracleInput();
        return;
    }
    if (!(await confirmModeSwitch('advisor'))) return;   // 1.36.0 中断确认
    rememberPriorOracleMode(currentOracleMode());
    setOracleMode('advisor');
    // 「当前已有引导在进行」的判据：进门提示与下面的「导入」chip 共用同一个 const，免得日后漂移。
    const hasGuidingConstruct = !!getPath();
    modeEntryNote('剧情参谋模式已开启。我会通读整段对话，和你一起构思剧情接下来可以怎么走。讨论出具体方案后，我会把它列成卡片：一个目标的方案，或分几个节点的剧情脉络——点「开始引导」并选择推进速度（慢推 / 正常 / 快推），主聊天的 AI 就会被悄悄引导着把剧情推向那个方向。引导随时可在上方的方案条里查看、调整或停止。'
        + (hasGuidingConstruct ? '\n当前已有一个方案在引导中——可以问我「检查进度」。' : ''));
    // 每模式独立房间：参谋房间现独立于普通聊天。普通聊天已有讨论、且参谋房间尚空（避免重复导入）→ 提供一键「导入」。
    // （此时 setOracleMode('advisor') 已 syncConvoStream，convo 即参谋房间。）
    const offerImport = ENABLE_MODE_ROOMS
        ? (roomHasDiscussion(getConvoMeta('main')) && convoForPrompt().length === 0 && !hasGuidingConstruct)
        : (convoForPrompt().length > 0 && !hasGuidingConstruct);
    if (offerImport) addBridgeChip();
    focusOracleInput();
}

// One-tap chip (每模式独立房间): imports the Normal-chat room's QA turns into the (now separate)
// advisor room — a divider note then the user/assistant turns — then sends the canned formalize
// request so the advisor turns that informal discussion into adoptable <StoryPlan> cards.
// Offered only into a fresh advisor room (see the openAdvisor trigger), so it never double-imports.
function addBridgeChip() {
    const wrap = document.createElement('div');
    wrap.className = 'pad-note pad-bridge';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pad-bridge-chip';
    btn.innerHTML = '<i class="fa-solid fa-compass"></i> 导入普通聊天的讨论并整理成方案';
    btn.addEventListener('click', () => {
        if (isGenerating) return;
        wrap.remove();
        // 每模式独立房间：把普通聊天房间的问答轮导入当前参谋房间（分隔线在前），随后发起整理请求。
        if (ENABLE_MODE_ROOMS) {
            const turns = buildImportedTurns(getConvoMeta('main'));
            soBulkRender(() => {   // 1.85.3 批量导入不逐条滚，下面统一滚一次
                for (const t of turns) {
                    const e = { id: nextCid(), role: t.role, content: t.content };
                    appendConvo(e);
                    e._el = (t.role === 'note') ? addNoteMessage(e) : addMessage(t.role, t.content, e);
                }
            });
            if (turns.length) { persistConvo(); scrollToBottom(); }
        }
        inputEl.value = P('advisor.importAsk');
        onSend();
    });
    wrap.appendChild(btn);
    messagesEl.appendChild(wrap);
    scrollToBottom();
}