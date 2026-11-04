import { convoExportAllowed, convoStreamKeyForMode, getConvoMeta, persistConvo, serializeConvo, streamCueLabel } from '../../core/chat-metadata.js';
import { getSettings, uiConfirm } from '../../core/settings.js';

import { getPath } from './metadata.js';
import { adoptPath, wantAutoDetail } from './story-path.js';
import { runForge } from '../builder/ui.js';
import { renderAdvisorReplyHtml, renderFixResultHtml, renderMarkdownOnly } from '../chat/context.js';
import { importConvo, rehangFixApply, scrollToBottom, soBulkRender } from '../chat/history.js';
import { extractUpdateBlock } from '../diagnose/mvu.js';
import { addSaveHealthControls } from '../diagnose/diagnostics.js';
import { addAutoFixControls, addFullReplyControls, addMvuedUndoControls, addNoteUndoControls } from '../diagnose/schema.js';
import { parseLorebookBlocks } from '../lorebook/operations.js';
import { renderBuilderReplyHtml } from '../builder/model.js';
import { ADVISOR_SPEEDS, ENABLE_SCHEMA_DIAG } from '../../prompts/builtins.js';
import { addApplyControls, addLorebookApplyControls, addMessage, diagSchemaAfterManualReply } from '../../ui/messages.js';
import { MODE_EMPTY, currentOracleMode } from '../../ui/mode-shell.js';
import { abortCtl, clearLiveGenerations, isGenerating, liveCondense, liveForge, stopGeneration } from '../../core/generation.js';
import { cidSeq, convo, convoStreamKey, ensureCidSeqAtLeast, replaceConvo, selectConvoStream } from '../../core/conversation-store.js';
import { inputEl, messagesEl } from '../../ui/refs.js';

/* ------------------------------------------------------------------ *
 * 参谋方案区块 <StoryPlan>（2.5.0 剧情脉络）的解析与卡片。
 * 单节点：「标题：」+「目标：」；多节点：「标题：」+「整体目标：」+「1. 节点名：关键词」行，节点下面可以带
 * 「详细：」（可续行；没写「详细：」直接接着写也认）。中英键名、全角冒号都认。标签容错 <story_plan>/<story-plan>
 * 与 <StorySequence>；未闭合的尾块（截断回复）救援到文末——与 splitStoryPlanSegments 的配对规则一致。
 * 解析不出节点的区块忽略：气泡里照原样显示，不出卡。2.5.0 之前的旧序列格式（beat: 行）不再认。
 * ------------------------------------------------------------------ */
export function parseStoryPlanBlock(inner) {
    const text = String(inner || '');
    if (/^\s*beat\s*[:：]/mi.test(text)) return null;
    const key = (line, keys) => {
        for (const k of keys) {
            const mm = line.match(new RegExp('^' + k + '\\s*[:：]\\s*(.*)$', 'i'));
            if (mm) return mm[1].trim();
        }
        return null;
    };
    const append = (a, b) => (a ? a + '\n' + b : b);
    let title = '';
    let overall = '';
    let target = '';
    const nodes = [];
    let cur = null;
    let sink = null;   // 续行接到哪：'overall' | 'target' | 'detail'
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const nm = line.match(/^(\d{1,2})\s*[.．、)）]\s*(.+)$/);
        if (nm) {
            const body = nm[2].trim();
            const at = body.search(/[:：]/);
            cur = { name: (at >= 0 ? body.slice(0, at) : body).trim(), keywords: at >= 0 ? body.slice(at + 1).trim() : '', detail: '' };
            nodes.push(cur);
            sink = null;
            continue;
        }
        let v;
        if (cur && (v = key(line, ['详细', 'detail', '目标', 'goal'])) !== null) { cur.detail = v; sink = 'detail'; continue; }
        if (!cur && (v = key(line, ['标题', 'title'])) !== null) { if (!title) title = v; sink = null; continue; }
        if (!cur && (v = key(line, ['整体目标', 'overall'])) !== null) { overall = v; sink = 'overall'; continue; }
        if (!cur && (v = key(line, ['目标', 'goal'])) !== null) { target = v; sink = 'target'; continue; }
        if (sink === 'detail') cur.detail = append(cur.detail, line);
        else if (sink === 'overall') overall = append(overall, line);
        else if (sink === 'target') target = append(target, line);
        else if (cur && !cur.detail) { cur.detail = line; sink = 'detail'; }
    }
    const valid = nodes.filter((n) => n.name);
    if (valid.length) return { title, overall: valid.length > 1 ? overall : '', nodes: valid };
    if (target) return { title, overall: '', nodes: [{ name: title || '方案', keywords: '', detail: target }] };
    return null;
}
export function parseStoryPlans(text) {
    const out = [];
    const re = /<Story[_-]?(?:Plan|Sequence)>([\s\S]*?)<\/Story[_-]?(?:Plan|Sequence)>|<Story[_-]?(?:Plan|Sequence)>([\s\S]*)$/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const plan = parseStoryPlanBlock(m[1] !== undefined ? m[1] : (m[2] || ''));
        if (plan) out.push(plan);
    }
    return out;
}

// 角色工坊：访谈汇总（<CharBrief>）回复下方的「🔨 生成」卡——点它把汇总连同全部上下文交给锻造工序。
export function addBriefControls(assistantEl, brief) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-apply-btn';
    btn.textContent = '🔨 生成';
    btn.title = '把这份汇总连同全部上下文交给锻造工序（一次完整调用）';
    btn.addEventListener('click', () => runForge());
    bar.appendChild(btn);
    assistantEl.querySelector('.so-bubble').appendChild(bar);
}

// 这张卡是不是当前在跑的那条脉络的来源（重画时恢复「已采用」高亮）：卡里的节点名恰好是在场脉络的末尾一段。
// 全新采用 ⇒ 节点就是这张卡；替换剩余部分 ⇒ 历史在前、这张卡的节点在后。推进不改节点，所以走到哪都认得出。
function pathCardIsAdopted(path, card) {
    const live = (path && path.nodes) || [];
    const want = (card && card.nodes) || [];
    if (!want.length || want.length > live.length) return false;
    const tail = live.slice(live.length - want.length);
    return tail.every((n, i) => n.name === String(want[i].name || '').trim());
}

// 参谋卡：单节点 =「方案 · 标题」+ 可以改的目标；多节点 =「剧情脉络 · 标题（N 个节点）」+ 整体目标 + 各节点
// （展开可以改详细）。都带推进速度，点按钮采用；采用时用框里改过的文字。卡挂在【气泡】里而不是消息行上
// （.so-msg 是 flex 行，挂到行上会变成挤在气泡旁边的第三个 flex 项）。
export function addPathCards(assistantEl, plans) {
    if (!plans.length) return;
    const bubble = assistantEl.querySelector('.so-bubble') || assistantEl;
    let wrap = bubble.querySelector('.so-plan-cards');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'so-plan-cards';
        bubble.appendChild(wrap);
    }
    const grow = (box) => { box.style.height = 'auto'; box.style.height = (box.scrollHeight + 4) + 'px'; };
    const detailBox = (value) => {
        const box = document.createElement('textarea');
        box.className = 'so-seq-canon-box';
        box.rows = 3;
        box.spellcheck = false;
        box.value = value;
        box.addEventListener('input', () => grow(box));
        return box;
    };
    const live = getPath();
    for (const p of plans) {
        const multi = p.nodes.length > 1;
        const card = document.createElement('div');
        card.className = 'so-plan-card' + (multi ? ' so-seq-card' : '');
        if (pathCardIsAdopted(live, p)) card.classList.add('so-plan-adopted');
        const head = document.createElement('div');
        head.className = 'so-plan-card-title';
        head.textContent = multi ? `剧情脉络 · ${p.title || '未命名'}（${p.nodes.length} 个节点）` : `方案 · ${p.title || '未命名'}`;
        card.appendChild(head);
        const boxes = [];   // 每个节点的详细输入框；参谋没写详细的节点为 null
        if (multi) {
            if (p.overall) {
                const line = document.createElement('div');
                line.className = 'so-plan-card-line';
                line.textContent = '整体目标：' + p.overall;
                card.appendChild(line);
            }
            p.nodes.forEach((n, i) => {
                const row = document.createElement('details');
                row.className = 'so-seq-card-beat';
                row.open = i === 0;
                const sum = document.createElement('summary');
                sum.textContent = `${i + 1}. ${n.name}`;
                if (n.keywords) {
                    const kw = document.createElement('span');
                    kw.className = 'so-path-kw';
                    kw.textContent = ' · ' + n.keywords;
                    sum.appendChild(kw);
                }
                row.appendChild(sum);
                if (n.detail) {
                    const box = detailBox(n.detail);
                    row.appendChild(box);
                    row.addEventListener('toggle', () => { if (row.open) grow(box); });
                    boxes.push(box);
                } else {
                    const hint = document.createElement('div');
                    hint.className = 'so-seq-card-beatbody';
                    hint.textContent = wantAutoDetail()
                        ? '到这个节点时，参谋看着已经演出来的剧情再写详细。'
                        : '参谋没写详细：到这个节点时先按关键词引导，可以在方案条上补写，或点「让参谋写」。';
                    row.appendChild(hint);
                    boxes.push(null);
                }
                card.appendChild(row);
            });
        } else {
            const box = detailBox(p.nodes[0].detail);
            card.appendChild(box);
            boxes.push(box);
        }
        // 推进速度默认沿用正在进行的那条脉络（替换剩下的部分时不会悄悄把速度改回「正常」），没有才是「正常」。
        let speed = (live && ADVISOR_SPEEDS[live.speed]) ? live.speed : 'normal';
        const seg = document.createElement('div');
        seg.className = 'so-plan-intensity';
        const caption = document.createElement('div');
        caption.className = 'so-hint so-plan-card-caption';
        const renderSeg = () => {
            seg.innerHTML = '';
            for (const [key, I] of Object.entries(ADVISOR_SPEEDS)) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'so-plan-int' + (speed === key ? ' active' : '');
                b.textContent = I.label;
                b.addEventListener('click', () => { speed = key; renderSeg(); });
                seg.appendChild(b);
            }
            caption.textContent = ADVISOR_SPEEDS[speed].caption;
        };
        renderSeg();
        card.appendChild(seg);
        card.appendChild(caption);
        const actions = document.createElement('div');
        actions.className = 'so-plan-card-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'so-apply-btn';
        btn.innerHTML = multi ? '<i class="fa-solid fa-list-ol"></i> 按脉络开始引导' : '<i class="fa-solid fa-compass"></i> 开始引导';
        btn.addEventListener('click', async () => {
            const edited = { ...p, nodes: p.nodes.map((n, i) => ({ ...n, detail: boxes[i] ? boxes[i].value.trim() : n.detail })) };
            if (!(await adoptPath(edited, speed))) return;
            wrap.querySelectorAll('.so-plan-card').forEach((c) => c.classList.remove('so-plan-adopted'));
            card.classList.add('so-plan-adopted');
        });
        actions.appendChild(btn);
        card.appendChild(actions);
        wrap.appendChild(card);
    }
    requestAnimationFrame(() => wrap.querySelectorAll('textarea.so-seq-canon-box').forEach((b) => { if (b.offsetParent) grow(b); }));
    scrollToBottom();
}

// Typing-dots indicator placed inside an assistant bubble until the first token.
export function showTyping(contentEl) {
    const dots = document.createElement('span');
    dots.className = 'so-typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    contentEl.appendChild(dots);
    let cleared = false;
    return () => {
        if (cleared) return;
        cleared = true;
        dots.remove();
    };
}

export function addSystemNote(text) {
    const wrap = document.createElement('div');
    wrap.className = 'so-note';
    wrap.textContent = text;
    messagesEl.appendChild(wrap);
    scrollToBottom();
}

// 模式进入 / 退出的说明：仅在侧聊已有内容时才作为系统记录追加。侧聊为空时，落地模式
// 专属的空状态（引导语 + 示例 chip）已充当介绍，再叠一段说明反而冗余（用户选择方案 A）。
export function modeEntryNote(text) {
    if (convo.length) addSystemNote(text);
}

// 持久化的「系统记录」气泡（自动诊断 / 自动校正的记录、导入分隔线等）。带 entry（写进 convo → 持久化 → 重载可
// 重建），左对齐、补丁可滚动。opts.{snapshot,patch} 挂「撤销 / 重新应用」按钮、opts.{fix} 挂「用原文 /
// 看改动」、opts.{mvued} 挂 🎛 手动编辑的整份快照撤销——仅改动型记录、仅本会话：opts 走内存注册表
// （registerNoteOpts），本会话内重画由
// loadConvoForChat 凭 peekNoteOpts 重挂；重载后注册表为空 → 记录变只读（重放旧补丁不安全，与手动
// 诊断回复重载后失去按钮一致）。
export function addNoteMessage(entry, opts) {
    const empty = messagesEl.querySelector('.so-empty');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'so-note so-note-record';
    if (entry) wrap.dataset.cid = entry.id;
    const txt = document.createElement('div');
    txt.className = 'so-note-record-text';
    txt.textContent = entry ? entry.content : '';
    wrap.appendChild(txt);
    if (opts && opts.snapshot && opts.patch) addNoteUndoControls(wrap, opts);   // info 形状：{snapshot, applied, patch, writeBack, undone?}
    else if (opts && opts.fix) addAutoFixControls(wrap, opts.fix);
    else if (opts && opts.health) addSaveHealthControls(wrap, opts.health);   // 🩺 1.89.0 存档检查：跳格按钮 + 技术细节
    else if (opts && opts.mvued) addMvuedUndoControls(wrap, opts.mvued);   // 🎛 手动编辑记录：整份快照互换的撤销
    else if (opts && opts.fullReply) addFullReplyControls(wrap, opts.fullReply);   // 1.71.1 unparsed 记录：查看完整回复
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
}

export function renderEmptyState() {
    if (convo.length || messagesEl.children.length) return;
    const m = MODE_EMPTY[currentOracleMode()] || MODE_EMPTY.chat;
    const wrap = document.createElement('div');
    wrap.className = 'so-empty';
    let html = `<i class="fa-solid ${m.icon} so-empty-icon"></i>` +
        `<div class="so-empty-line">${m.lead}</div>`;
    if (m.sub) html += `<div class="so-empty-sub">${m.sub}</div>`;
    wrap.innerHTML = html;
    // 示例问题 chip：每种模式一组（见 MODE_EMPTY）。点一下把问题填进输入框并聚焦，直接回车即可
    // 发送，由该模式的发送管线处理。chip 是真正的 <button>，键盘可达（与 Tier 1 一致）。
    const chips = document.createElement('div');
    chips.className = 'so-empty-chips';
    for (const q of m.chips) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'so-empty-chip';
        chip.textContent = q;
        chip.addEventListener('click', () => {
            inputEl.value = q;
            inputEl.dispatchEvent(new Event('input'));   // 触发自动高度 / 发送键状态
            inputEl.focus();
        });
        chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    appendConvoImportEntry(wrap);
    messagesEl.appendChild(wrap);
}

/* 📤 空页的「导入对话」入口（1.61.0）。导出 / 导入的常规入口是 AI 气泡行上那对按钮 —— 空页一条气泡
   都没有，入口就够不着了，所以空页补这一枚（导出在空页无意义，只补导入）。
   ⚠ 为什么单独成函数、而不是写死在 renderEmptyState 里：带房间提示线的房间（诊断 / 世界书 / 参谋 /
   校正 / 工坊）里 renderEmptyState 会被提示线挡掉 —— 它开头就是「messagesEl 已有子节点则早返」，而
   loadConvoForChat 是【先挂提示线、再叫空态】。那是 1.28.0 起的既有行为（本次不动它），代价是空的
   参谋房根本没有空态可挂 —— 而参谋恰恰是允许导入的两房之一。于是两处各调一次：renderEmptyState 里
   挂进空态卡片，loadConvoForChat 里挂进消息区本体，保证「凡是空的、且模式允许的房间」都有入口。
   幂等（host 里已有就不再加）；另挂 `.so-convio-btn` 让 soApplyConvoIoVisual 扫得到（不换房、
   不重画的模式过渡只有那一扫够得着）。 */
export function appendConvoImportEntry(host) {
    if (!host || typeof host.querySelector !== 'function') return;
    if (host.querySelector('.so-empty-import-btn')) return;              // 幂等
    if (!convoExportAllowed(currentOracleMode())) return;                // 与气泡按钮同一道模式闸
    const ioRow = document.createElement('div');
    ioRow.className = 'so-empty-chips so-empty-io';
    const impBtn = document.createElement('button');
    impBtn.type = 'button';
    impBtn.className = 'so-empty-chip so-convio-btn so-empty-import-btn';
    impBtn.title = '导入对话 —— 把导出的 Markdown 文件读回这一页';
    impBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 导入对话';
    impBtn.addEventListener('click', importConvo);
    ioRow.appendChild(impBtn);
    host.appendChild(ioRow);
}

export async function clearConversation() {
    // 清空会连带删除本聊天已保存的侧聊历史（含自动诊断记录），无法撤销——与本扩展其它破坏性
    // 操作（清空概要 / 重置提示词 / 放弃序列）保持一致，先确认再执行。空对话则无需打扰直接返回。
    const where = convoStreamKey === 'main' ? '本聊天（普通聊天）的侧聊记录' : (streamCueLabel(convoStreamKey, getSettings()) || '本模式的侧聊记录');
    if (convo.length && !(await uiConfirm(`确定清空${where}吗？此操作会删除已保存的记录，无法撤销。`))) return;
    // 保活：若正有后台锻造 / 深度精简流进【本房间】，清空即中断它并清两槽（用户主动清本房记录）；保活
    // 运行在别的房间则不动（下面 loadConvoForChat 的守卫也据此放它继续）。
    const liveRun = liveForge || liveCondense;
    if (isGenerating && abortCtl && liveRun && liveRun.streamKey === convoStreamKey) {
        stopGeneration();
        clearLiveGenerations();
    }
    replaceConvo([]);
    persistConvo();   // 用户功能请求：手动清空也清掉本聊天保存的历史（删元数据键）
    messagesEl.innerHTML = '';
    loadConvoForChat();   // 重载空流：主流走空态，工坊房间重画头部提示线
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：per-chat 侧聊历史的载入端 + 运行概要编辑器的 UI 刷新。
 *
 * 重画保真（1.33.1 掉格式修复）：loadConvoForChat 此前对所有 AI 气泡一律
 * renderMarkdownOnly（1.20.0 F5 补渲）且从不重挂动作卡。1.28.0 每模式独立房间让
 * 【每次切模式都重画】：参谋 <StoryPlan> 被 DOMPurify 剥标签、采纳卡消失（用户报的
 * 「掉格式」），诊断/世界书/校正的按钮同批阵亡。修复 = 重画按【房间】分道，向定稿
 * 路径看齐——房间与模式一一对应（convoStreamKeyForMode），比看当前模式旗标更稳。
 * ENABLE_MODE_ROOMS 关 → 全部住 main → 维持老行为（kill-switch 语义不变）。
 * ------------------------------------------------------------------ */
// PURE：按房间选与【定稿路径】同源的渲染器。null = 保持纯文本（诊断/世界书定稿本就不渲染，
// <UpdateVariable>/<LorebookEdit> 要原样可读）；库缺失时各渲染器自己回退 null，调用方同样落纯文本。
function repaintHtmlForRoom(streamKey, content) {
    const t = String(content || '');
    if (streamKey === 'advisor') return renderAdvisorReplyHtml(t);
    if (streamKey && String(streamKey).startsWith('bld_')) return renderBuilderReplyHtml(t);
    if (streamKey === 'diagnose' || streamKey === 'lorebook') return null;
    if (streamKey === 'fix') return renderFixResultHtml(t);
    return renderMarkdownOnly(t);   // main 房：1.20.0 F5 补渲行为不变
}
// PURE：按房间算重画后该重挂哪些动作卡。参谋采纳卡（单拍 / 序列）/ 世界书应用控件从【字符串】可完整导出 →
// 全记录重挂（采用 = 元数据 + 注入、应用 = 现读整本书，各自带守卫）；诊断补丁 / 校正应用只挂
// 【最新一条 AI 回复】（Prince 定案 2026-07-16：旧补丁对着已前进的状态回放不安全——校正另有
// 陈旧守卫，但最新一条已覆盖全部真实价值）。校正材料在会话注册表里，这里只标记候选；挂载端凭
// id+内容取材料，取不到（重载过 / 内容不符）= 保持只读（1.31.1 契约）。
function repaintControlPlan(streamKey, list) {
    const arr = Array.isArray(list) ? list : [];
    const out = [];
    const isReply = (m) => m && m.role === 'assistant' && typeof m.content === 'string';
    if (streamKey === 'advisor') {
        for (const m of arr) {
            if (!isReply(m)) continue;
            const plans = parseStoryPlans(m.content);
            if (plans.length) out.push({ id: m.id, kind: 'plans', plans });
        }
    } else if (streamKey === 'lorebook') {
        for (const m of arr) {
            if (!isReply(m)) continue;
            const parsed = parseLorebookBlocks(m.content);
            if (parsed.ops.length || parsed.errors.length) out.push({ id: m.id, kind: 'lorebook', parsed });
        }
    } else if (streamKey === 'diagnose') {
        const latest = [...arr].reverse().find(isReply);
        const block = latest ? extractUpdateBlock(latest.content) : '';
        if (block) out.push({ id: latest.id, kind: 'diagPatch', block });
    } else if (streamKey === 'fix') {
        const latest = [...arr].reverse().find(isReply);
        if (latest) out.push({ id: latest.id, kind: 'fixApply' });
    }
    return out;
}
// 从本聊天的元数据重建侧聊窗口。chat 切换 / 首次载入时调用（onChatChanged）。先中止任何在途
// 生成，避免流式气泡继续写到被清掉的 DOM 上。
export function loadConvoForChat() {
    if (!messagesEl) return;                       // 窗口还没建好（极早期）——略过，init 末尾会再调一次
    // 保活：切模式重画时【不】中断在途的锻造 / 深度精简——liveForge / liveCondense 存在 = 后台保活运行
    // 正跑，让它继续（回房时下方重挂气泡，完成后按原始房间归位）。切聊天 / 清空由 onChatChanged /
    // clearConversation 显式中断并清掉两槽，到这里已 null，照常中断其它在途生成（普通聊天/访谈/校正等，
    // 维持 1.28.0 起行为；1.36.0 起用户侧切换入口会先弹确认——见 confirmConvoSwap）。
    if (isGenerating && abortCtl && !liveForge && !liveCondense) stopGeneration();
    const saved = getConvoMeta();
    // 读回 = 落盘的同一份口径（serializeConvo）：同样的角色筛选 + 同样的字段白名单，外加诊断卡的
    // diagStamp（Task 5 的陈旧闸重载后就靠它）。两处各写一遍，迟早有一处漏带新字段。
    replaceConvo(serializeConvo(saved));
    ensureCidSeqAtLeast(convo.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), cidSeq));
    messagesEl.innerHTML = '';
    // 房间头部提示线（每模式独立房间）：让「历史换了一批」读成「独立记录」而不是「记录丢了」。主流不显示。
    const cueText = streamCueLabel(convoStreamKey, getSettings());
    if (cueText) {
        const cue = document.createElement('div');
        cue.className = 'so-stream-cue';
        cue.textContent = cueText;
        messagesEl.appendChild(cue);
    }
    // 保活修（1.36.0 :8001 smoke 抓到）：空房只画空态、【不得提前 return】——回房重挂在函数尾部，
    // 提前退出会漏挂正在后台流式的锻造/深度精简气泡（空房 + 在途保活 = 清过本房记录再开跑的场景）。
    // 1.85.3：整段重画走批量段——段内逐条 addMessage / addNoteMessage / 动作卡重挂都不再各滚一次（每次滚 = 读
    // scrollHeight = 整页强制重排），历史气泡也不挂入场动画；段尾那一次 scrollToBottom 照旧。
    soBulkRender(() => {
        if (!convo.length) renderEmptyState();
        for (const m of convo) {
            // note 重画时凭注册表重挂本会话的按钮（自动诊断撤销 / 自动校正用原文——重载后注册表为空 = 只读记录，契约不变）
            m._el = (m.role === 'note') ? addNoteMessage(m, peekNoteOpts(convoStreamKey, m)) : addMessage(m.role, m.content, m);
            // F5 补渲，1.33.1 起按房间分道（repaintHtmlForRoom）：恢复的 AI 回复用与定稿路径
            // 同源的渲染器（参谋 StoryPlan 进 <pre>、诊断/世界书保持纯文本原样、校正走 ST 格式器、其余渲
            // Markdown）。仅助手回复、仅尚未渲染时。
            if (m.role === 'assistant' && m._el) {
                const c = m._el.querySelector('.so-content');
                if (c && !c.classList.contains('so-rendered')) {
                    const html = repaintHtmlForRoom(convoStreamKey, m.content || '');
                    if (html != null) { c.innerHTML = html; c.classList.add('so-rendered'); c.style.whiteSpace = 'normal'; }
                }
            }
        }
        // 重画保真（1.33.1）：按房间重挂动作卡（重挂规则见 repaintControlPlan）。校正材料凭 id+内容
        // 从会话注册表取（取不到 = 重载过 / 内容不符 → 记录保持只读，与 1.31.1 自动记录同一契约）。
        for (const p of repaintControlPlan(convoStreamKey, convo)) {
            const m = convo.find((x) => x.id === p.id);
            if (!m || !m._el) continue;
            if (p.kind === 'plans') addPathCards(m._el, p.plans);
            else if (p.kind === 'lorebook') addLorebookApplyControls(m._el, p.parsed, m);
            else if (p.kind === 'diagPatch') {
                addApplyControls(m._el, p.block, m);
                if (ENABLE_SCHEMA_DIAG) diagSchemaAfterManualReply(m._el, p.block, m, { previewOnly: true });   // 重画补回预演块，不重发
            }
            else if (p.kind === 'fixApply') {
                const fa = (peekNoteOpts(convoStreamKey, m) || {}).fixApply;
                if (fa) rehangFixApply(m._el, fa, m);
            }
        }
        // 保活回房重挂（锻造 / 深度精简同款）：切模式离开时保活运行在后台继续流式；回到原房且它仍在跑 →
        // 重建一个流式气泡、接上累积文本（entry._el 重指向新气泡，paintForge 继续画到这里）。完成/失败的
        // 落盘由各自 run 函数负责（按 originKey 归位），这里只恢复「正在流」的可见性；成稿后它已进 convo，
        // 故 id 去重防重挂。
        const liveRun = liveForge || liveCondense;
        if (liveRun && liveRun.streamKey === convoStreamKey && liveRun.entry
            && !convo.some((m) => m.id === liveRun.entry.id)) {
            const el = addMessage('assistant', '', liveRun.entry);
            liveRun.entry._el = el;
            const c = el.querySelector('.so-content');
            if (c) { c.classList.add('so-streaming'); c.textContent = liveRun.text || ''; }
        }
        // 📤 导入入口的兜底挂载 —— 条件是「这一房【没有 AI 气泡】」而不是「这一房是空的」。
        // 因为 📥📤 只挂在 AI 气泡上（addMessage），所以【有消息但一条 AI 回复都没有】的房间同样够不着入口：
        // 把唯一那条 AI 回复删掉就会掉进去（review 2026-08-09 抓到的可达性回归 —— 1.61.0 之前 ⋯ 菜单还兜得住）。
        // 放在消息循环【之后】：这样它落在最后一条消息下面，而不是插在消息上头。
        // 幂等 + 自带模式闸（见 appendConvoImportEntry），空房且空态已渲出来时这一次是 no-op。
        if (!convo.some((m) => m.role === 'assistant')) appendConvoImportEntry(messagesEl);
    });
    scrollToBottom();
}

// 把可见侧聊切到当前模式应在的房间（每模式独立房间）：参谋 → 自己的房间；普通聊天 → 主流。
// 切换 = 先把现流持久化、再换 key 重载重画，返回是否换过房（setOracleMode
// 据此决定要不要再手动刷空态）。由 setOracleMode 调用。
export function syncConvoStream() {
    const target = convoStreamKeyForMode(currentOracleMode(), getSettings());
    if (target === convoStreamKey) return false;
    persistConvo();                 // 现流落盘（写的是切换前的 convoStreamKey）
    selectConvoStream(target);
    loadConvoForChat();             // 从新流的元数据重建窗口
    return true;
}

/* ------------------------------------------------------------------ *
 * 会话内「记录按钮」注册表（1.31.1）。自动诊断的 {snapshot,patch}（撤销）与自动校正的 {fix}
 * （用原文/看改动）是内存里的闭包材料，从不落盘（重放旧补丁不安全——「重载后记录只读」契约不变）。
 * 1.28.0 分房间后，后台记录常落进【不可见】房间（旧实现直接丢 opts），且换房重画（loadConvoForChat）
 * 也会把已挂的按钮抹掉 → 把 opts 按 房间::记录id 登记在这里，重画 note 时凭 id+内容取回重挂。
 * 内容必须参与校验：cidSeq 只爬过【已载入房间】的 id，重载后新记录可能与未访问房间里的旧记录撞号——
 * 旧记录（时间戳+补丁不同）凭内容拒挂、保持只读。换聊天必须作废（见 onChatChanged）：撤销/换 swipe
 * 写的是【当前聊天】的 MVU / 楼层，跨聊天重挂会写错对象——与 1.28.0 前「切聊天即失按钮」语义一致。
 * ------------------------------------------------------------------ */
const NOTE_OPTS_MAX = 60;   // 内存保险：自动校正 opts 带整楼 before/after，超长会话只留最近 60 条
const noteOptsById = new Map();   // 'room::id' → { content, opts }（opts 存同一引用，不拷贝）
export function registerNoteOpts(roomKey, entry, opts) {
    if (!opts || !entry) return;
    noteOptsById.set(`${roomKey}::${entry.id}`, { content: entry.content, opts });
    while (noteOptsById.size > NOTE_OPTS_MAX) noteOptsById.delete(noteOptsById.keys().next().value);
}
export function peekNoteOpts(roomKey, m) {
    const hit = m ? noteOptsById.get(`${roomKey}::${m.id}`) : null;
    return (hit && hit.content === m.content) ? hit.opts : null;
}
export function clearNoteOpts() { noteOptsById.clear(); }
// 撤销 / 状态失效时按 房间::记录id 注销单条会话状态（1.33.2 已应用状态用；幂等）。
export function dropNoteOpts(roomKey, entry) { if (entry) noteOptsById.delete(`${roomKey}::${entry.id}`); }