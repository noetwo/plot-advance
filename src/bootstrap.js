/*
 * 剧情推进 —— SillyTavern 的侧边问答窗口。
 *
 * 基于原版「故事神谕」1.89.0 的二创：先精简成只有普通聊天 + 剧情参谋的精简版（1.x），
 * 2.0 起把诊断、世界书、校正、角色工坊加了回来。各模式：
 *   - 普通聊天：在不污染主聊天的前提下，向 LLM 询问关于当前剧情的问题。窗口拥有
 *     自己独立的问答历史（永不写入 `chat`），会自动把当前角色卡 + 最近的对话记录
 *     作为上下文，并可随时清空。
 *   - 🩺 诊断（含自动诊断、变量编辑器、修改器）、📖 世界书、✨ 校正（手动 / 选段 / 自动 /
 *     自定义模板）、🎭 角色工坊：与原版 1.89.0 相同。
 *   - 剧情参谋：讨论剧情走向，把方案列成卡片（单节点方案，或分几个节点的「剧情脉络」，<StoryPlan>），
 *     采用后逐个节点贴合注入主聊天（只注入一段「剧情导向」）。
 * 相对原版新增：提示词注册表（PROMPT_DEFS / P()，所有模式的提示词都能在设置里改）、
 * 剧情脉络（节点 + 推进速度，2.5.0 起取代单拍方案与序列）、引导暂停、连接存档改进、输入框上方的模型切换栏与快捷回复栏按钮。
 * 原版的弧线、落拍感应、下一拍建议、数据库联动、插件接口（StoryOracleAPI）、更新检查不在本版。
 *
 * 与原版使用彼此独立的设置、聊天元数据、界面与浏览器存储命名空间，可同时启用。
 *
 * 两种连接模式（均兼容 OpenAI 接口）：
 *   - "direct"  ：浏览器直接请求你的端点（需自行填写 URL + 密钥 + 模型）。
 *                 视服务器配置，可能会被 CORS 拦截。
 *   - "profile" ：通过 SillyTavern 后端，使用你保存的某个连接配置文件转发请求。
 *                 不会有 CORS 问题。
 */

import { maybePostReply, mvuCompatLifecycleMark, postReplyHandlesType, supersedePostReply, supersedePostReplyOnChatSwitch } from './core/post-reply.js';
import { migrateChatNamespace, migrateGlobalNamespace } from './core/namespace-migration.js';
import { closeModelMenu, closeQpMenu, getCtx, getSettings, renderConnPresets, renderModelBar, renderQpManager, save } from './core/settings.js';
import { observeGenerationState } from './core/generation.js';

import { checkPlanReminder, onChatChanged } from './modes/advisor/story-path.js';
import { captureLwbSnapshot } from './modes/chat/context.js';
import { mvuedScheduleRefresh } from './modes/diagnose/editor.js';
import { refreshWiCustomUI } from './modes/diagnose/pickers.js';
import { injectWandButton, refreshOracleEntries } from './modes/diagnose/schema.js';
import { clearFixChatSel, onChatSelectionChange, refreshFixChatEntry } from './modes/fix/selection.js';
import { armGuide, disarmGuide, glueGen, glueGenReset, onPromptReadyGlue } from './modes/fix/templates.js';
import { migrateBuiltinJbDefault, migrateFixLeanDefaults } from './modes/lorebook/migrations.js';
import { BUILTIN_JB_AUTHOR } from './presets/builtin-jailbreak.js';
import { ENABLE_INJECT_GLUE, ENABLE_LWB_BRIDGE, ENABLE_MVU_EDITOR, ENABLE_WI_CUSTOM_PICK } from './prompts/builtins.js';
import { getLoadedMvu, loadRegexEngine } from './st/adapters.js';
import { getHostGlobal, getHostStorage } from './st/host.js';
import { callDirect, callProfile, callProfileStream, resolveEndpointUrl, streamDirect } from './transport/direct.js';
import { applyWindowSkin, syncChatBarButton, syncFixSelBarButton, syncQrButton } from './ui/chat-entry.js';
import { renderGenerationState } from './ui/generation-view.js';
import { loadPromptEditor, populateSysPromptPresets, refreshProfiles, renderPromptNav } from './ui/settings.js';
import { buildWindow } from './ui/window.js';
import { win } from './ui/refs.js';



// ---------- 设置面板：分页 ----------
const SETTINGS_TABS = ['conn', 'ctx', 'persona', 'prompt', 'qp', 'ui'];
const SETTINGS_TAB_KEY = 'pad.settings.tab';   // 记住上次打开的页（只存在本浏览器）
let settingsTab = 'conn';

function restoreSettingsTab() {
    let tab = 'conn';
    try {
        const saved = getHostStorage()?.getItem(SETTINGS_TAB_KEY);
        if (SETTINGS_TABS.includes(saved)) tab = saved;
    } catch (e) { /* 无痕 / 禁用存储时就用默认页 */ }
    settingsTab = tab;
}

export function setSettingsTab(tab) {
    if (tab == null) tab = settingsTab;
    else if (!SETTINGS_TABS.includes(tab)) tab = 'conn';
    settingsTab = tab;
    try { getHostStorage()?.setItem(SETTINGS_TAB_KEY, tab); } catch (e) { /* 同上 */ }
    if (!win) return;
    for (const b of win.querySelectorAll('.pad-set-tab')) {
        const on = b.dataset.tab === tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of win.querySelectorAll('.pad-set-page')) p.classList.toggle('active', p.dataset.tab === tab);
    if (tab === 'prompt') renderPromptNav();
    if (tab === 'qp') renderQpManager();
}

// 打开 / 关闭设置（open 不传 = 切换）。打开时铺满窗口，并刷新几处要现取的列表。
export function toggleSettings(open, tab) {
    if (!win) return;
    const panel = win.querySelector('#pad-settings');
    const on = panel.classList.toggle('open', open);
    win.classList.toggle('pad-settings-open', on);   // CSS 据此让出消息区、输入区与模式栏
    closeModelMenu();
    closeQpMenu();
    renderModelBar();
    if (!on) return;
    refreshProfiles();
    populateSysPromptPresets();
    loadPromptEditor();
    renderConnPresets();
    if (ENABLE_WI_CUSTOM_PICK) refreshWiCustomUI();
    setSettingsTab(tab || settingsTab);
}
// 用 getSettings().connPresets 重画预设下拉（尽量保留当前选中项）。
// A5：把 ⋯ 工具菜单里的项（普通聊天 / 剧情概要 / 调试 / 设置）搬到标题栏、删掉 ⋯ 包裹。
// 幂等（wrap 已删则 no-op）。移动 DOM 节点会保留其已绑事件监听，故在 buildWindow 全部接线后调用即安全。
// 默认关（toolsInHeader）；开时省一次点击，⋯ 菜单默认保留给未来的小模式。原生化自二创 tools-expand。
export function applyToolsInHeader() {
    if (!win) return false;
    const wrap = win.querySelector('.pad-tools-wrap');
    const menu = win.querySelector('#pad-tools-menu');
    const header = win.querySelector('#pad-header-btns');
    if (!wrap || !menu || !header) return false;
    // 插到两条分组线【之间】（⋯ 原来住的位置）——搬完仍是 模式│工具│🗑✕ 三组。插在第一条线前的
    // 旧插法，删掉 ⋯ 包裹后两条线会贴成「‖」双线、模式和工具挤成一团（1.37.1）。
    const dividers = header.querySelectorAll('.pad-hdr-div');
    const divider = dividers[1] || dividers[0];
    menu.querySelectorAll('.pad-tools-item').forEach((btn) => {
        btn.classList.remove('pad-tools-item');
        btn.querySelector('span')?.remove();
        header.insertBefore(btn, divider);
    });
    wrap.remove();
    return true;
}
// 裸模型调用（direct / profile 分发，与 generateReply 的发送路同款），供人格扩写、智能选条等一次性调用。
// onDelta（可选）收【到目前为止的全文】（direct 侧把 delta 累加成全文，与 profile 侧对齐）。不碰 UI / 锁 / 消息；signal、maxTokens 由调用方给。
export async function soCallModel(messages, opts = {}, deps = {}) {
    const readSettings = deps.getSettings || getSettings;
    const directUrl = deps.resolveEndpointUrl || resolveEndpointUrl;
    const directCall = deps.callDirect || callDirect;
    const directStream = deps.streamDirect || streamDirect;
    const profileCall = deps.callProfile || callProfile;
    const profileStream = deps.callProfileStream || callProfileStream;
    const s = readSettings();
    const { onDelta, signal } = opts;
    const stream = (opts.stream !== undefined) ? opts.stream : s.stream;
    const eff = opts.maxTokens || s.maxTokens;
    const emit = (full) => { if (onDelta) { try { onDelta(full); } catch (e) { /* 调用方回调出错不该中断生成 */ } } };
    if (s.mode === 'direct') {
        const body = { model: s.model, messages, max_tokens: eff };
        if (s.sendTemperature) body.temperature = s.temperature;
        if (stream) { let acc = ''; return await directStream(directUrl(s), s.apiKey, body, signal, (delta) => { acc += delta; emit(acc); }); }
        return await directCall(directUrl(s), s.apiKey, body, signal);
    }
    const override = s.sendTemperature ? { temperature: s.temperature } : {};
    if (stream) return await profileStream(s.profileId, messages, eff, override, signal, (full) => emit(full));
    return await profileCall(s.profileId, messages, eff, override, signal);
}


// 启动时先完成全局与当前聊天的旧命名空间迁移，再读取任何设置或聊天元数据。
export function init() {
    try {
        const ctx = getCtx();
        const globalMigration = migrateGlobalNamespace({
            extensionSettings: ctx.extensionSettings,
            storage: getHostStorage(),
        });
        if (globalMigration.changed && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        if (migrateChatNamespace(ctx.chatMetadata)) {
            const persistMetadata = ctx.saveMetadataDebounced || ctx.saveMetadata;
            if (typeof persistMetadata === 'function') persistMetadata.call(ctx);
        }
        restoreSettingsTab();
        initNow();
    } catch (e) {
        console.error('[剧情推进] init failed:', e);
    }
}
function initNow() {
    const s = getSettings();
    // Tier 0 ④（1.25.0，Prince 定案）：一次性把老用户仍停在旧默认（-1 全部前文 / 世界书 / 概要 开）的手动校正键迁到
    // 精简默认，并告知一次。放在 buildWindow 之前 → UI 直接显示迁移后的值。仅翻【仍等于旧默认】的键（自定义值不动）。
    try {
        const mig = migrateFixLeanDefaults(s);
        if (mig.migrated) {
            save();
            const toastr = getHostGlobal('toastr');
            if (toastr && toastr.info) {
                toastr.info('手动校正默认已改为精简上下文（' + mig.hit.join(' / ') + ' 已关，角色卡保留）——长聊天下更稳更省。如需全量前文，可在「校正设置」把「加载前文条数」改回 -1。', '剧情推进', { timeOut: 12000 });
            }
        }
    } catch (e) { console.warn('[剧情推进] fix lean 迁移失败：', e); }
    // 内置破限（1.40.0）：一次性把「没选任何预设」的用户预选到内置破限。同样放在 buildWindow 之前
    // → UI 直接显示迁移后的选择。已有【有效且已策展】预设的用户完全不动。
    try {
        if (migrateBuiltinJbDefault(s).migrated) {
            save();
            const toastr = getHostGlobal('toastr');
            if (toastr && toastr.info) {
                toastr.info('已为你默认启用内置破限「初心破限 1.2」（作者：' + BUILTIN_JB_AUTHOR + '）——'
                    + '它包裹在剧情推进自己的提示词外面，默认只作用于【普通聊天】。'
                    + '不想要可在「系统提示词 → 补全预设」里换回「自定义」。',
                    '剧情推进', { timeOut: 15000 });
            }
        }
    } catch (e) { console.warn('[剧情推进] 内置破限迁移失败：', e); }
    applyWindowSkin(getSettings());   // 1.45.0：先上皮肤再建窗，避免开窗瞬间闪一下旧配色
    injectWandButton();
    buildWindow();
    observeGenerationState(renderGenerationState);
    if (getSettings().toolsInHeader) applyToolsInHeader();   // A5：开了「工具移到标题栏」就在建窗后搬一次
    syncChatBarButton();   // 用户功能请求：按设置在聊天栏放 / 撤快捷按钮
    syncQrButton();        // 精简版 1.2：快捷回复栏里的「剧情推进」按钮
    syncFixSelBarButton();   // ✂️ 按设置在输入框上方那一排放 / 撤「选段校正」快捷按钮（1.44.0）
    loadRegexEngine(); // warm the cache so it's ready by first send

    // Advisor plan lifecycle: re-register (or clear) the injection whenever a
    // chat loads, and run the staleness check as the main chat grows. These are
    // the extension's only event listeners — everything else stays pull-based.
    try {
        const ctx = getCtx();
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.on === 'function') {
            // 1.77.0：切聊天不再无条件作废在途那一轮（只有 🩺 诊断 / 🎛 修改器还作废）——校正 / 模板
            // 任务跑完后把成品暂存、回到原聊天再落。判据与 onChatChanged 那一处共用 postReplyCancelsOnChatSwitch。
            ctx.eventSource.on(et.CHAT_CHANGED || 'chat_id_changed', () => supersedePostReplyOnChatSwitch());
            ctx.eventSource.on(et.CHAT_CHANGED || 'chat_id_changed', onChatChanged);
            ctx.eventSource.on(et.MESSAGE_RECEIVED || 'message_received', checkPlanReminder);
            // 1.3.1：剧情导向只在主聊天拼提示词时挂上（见 armGuide 上方说明）。
            ctx.eventSource.on(et.GENERATION_STARTED || 'generation_started', (type) => armGuide(type));
            for (const ev of [et.GENERATE_AFTER_DATA || 'generate_after_data', et.GENERATION_STOPPED || 'generation_stopped',
                et.GENERATION_ENDED || 'generation_ended']) {
                ctx.eventSource.on(ev, disarmGuide);
            }
            if (ENABLE_INJECT_GLUE) {
                // 贴合注入：先记生成类型，再在最终数组上贴。事件名对 public/scripts/events.js 真源码钉。
                ctx.eventSource.on(et.GENERATION_STARTED || 'generation_started', (type) => { glueGen.type = type; });
                ctx.eventSource.on(et.GENERATION_ENDED || 'generation_ended', glueGenReset);
                ctx.eventSource.on(et.GENERATION_STOPPED || 'generation_stopped', glueGenReset);
                ctx.eventSource.on(et.CHAT_COMPLETION_PROMPT_READY || 'chat_completion_prompt_ready', (data) => { onPromptReadyGlue(data); });
            }
            // 回复后编排：每条新 AI 回复在共享锁下先自动校正、后自动诊断（各自仅在其自动模式开启时动作）。
            // 必须「即发即忘」：ST 的 eventSource.emit 会 await 监听器，直接挂上 async 的
            // maybePostReply 会让每条回复都卡住整个校正 + 诊断往返。包一层、不把 promise 交回去。
            // 开场白（type 'first_message'：打开只有开场白的聊天时 ST 会发）不是新回复 → 跳过（postReplyHandlesType）。
            ctx.eventSource.on(et.MESSAGE_RECEIVED || 'message_received', (id, type) => {
                if (!postReplyHandlesType(type)) return;
                Promise.resolve(maybePostReply(id)).catch((e) => console.warn('[剧情推进] 回复后编排调度失败：', e));
            });
            // 新的用户输入令旧回复的后台工作失去语义基础：静默作废 剧情推进 自己的等待 / LLM，
            // 但不碰 MVU 的外部解析（它没有公开 cancel API）。这与用户点提示的“手动中断”分开，
            // 因而不会冒出“已中断”toast；下一条 AI 回复到达后会照常建立新一轮。
            ctx.eventSource.on(et.MESSAGE_SENT || 'message_sent', () => supersedePostReply());
            // 🩺 MVU 额外模型兼容：这两个观察器必须独立于变量编辑器开关常驻。额外模型的一次“请求批次”
            // 可能在重试之间反复把 isDuringExtraAnalysis 置 false；只有整批策略返回后，MVU 才会跑最终
            // handleVariablesInMessage 并发 UPDATE_ENDED。这里记的是生命周期信号，不读私有 store / 重试次数。
            try {
                ctx.eventSource.on('mag_variable_update_started', () => mvuCompatLifecycleMark('started', getLoadedMvu()));
                ctx.eventSource.on('mag_variable_update_ended', () => mvuCompatLifecycleMark('ended', getLoadedMvu()));
            } catch (e) { console.debug('[剧情推进] MVU 兼容生命周期事件未接上：', e); }
            if (ENABLE_LWB_BRIDGE) {
                // 小白X 记忆桥：主聊天生成期（小白X 已写注入槽、尚未清）抓一份总结缓存。只读、不改提示词。
                // ST 真实事件名是 GENERATE_*（events.js 无 GENERATION_AFTER_COMBINE_PROMPTS 这个键）。
                ctx.eventSource.on(et.GENERATE_AFTER_COMBINE_PROMPTS || 'generate_after_combine_prompts', captureLwbSnapshot);
            }
            // ✂️ 主聊天入口（1.42.0）：楼层重建事件全量重挂按钮；换聊天顺带弃划选记忆。聊天栏入口按钮一并重对。
            [
                et.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered',
                et.USER_MESSAGE_RENDERED || 'user_message_rendered',
                et.MESSAGE_SWIPED || 'message_swiped',
                et.MESSAGE_EDITED || 'message_edited',
                et.MESSAGE_DELETED || 'message_deleted',
            ].forEach((ev) => ctx.eventSource.on(ev, () => { refreshFixChatEntry(); refreshOracleEntries(); }));
            ctx.eventSource.on(et.CHAT_CHANGED || 'chat_id_changed', () => { clearFixChatSel(); refreshFixChatEntry(); refreshOracleEntries(); });
            if (ENABLE_MVU_EDITOR) {
                // 🎛 打开中的编辑器「跟随现实」（1.59.0）：这六个事件是「本聊天的 stat_data 可能刚被别人
                // 改过」的信号源。清单来自 staleness-audit §9 的写者盘点（每一条都对着真实写者列的）：
                //   · MESSAGE_RECEIVED —— MVU 解析新回复（最常见的一条）
                //   · MESSAGE_UPDATED  —— ★ 承重：**本扩展自己的 MVU 写者只发这一个**。Mvu.replaceMvuData
                //     本身【不发任何事件】，🩺 手动应用 / 撤销、🩺 与 🎛 的记录撤销，全靠 refreshLatestMvuBar
                //     手动补发的这一发。而这三样与 🎛 按钮同住【诊断房】，是真实使用里最容易撞上的一格。
                //     自触发不是问题：我们自己应用后补发的那一次，比对下来无差异 → 空转；刷新路径不写任何
                //     东西，构不成回环。它同时也把 MESSAGE_EDITED 那条腿加固了（编辑落定时两个都发）。
                //   · MESSAGE_SWIPED / MESSAGE_EDITED / MESSAGE_DELETED —— 换 swipe（每个 swipe 各带一份
                //     变量）、改楼、删楼
                //   · MESSAGE_SENT —— 用户发言也会新开一层并把状态带过去（便宜的补全）
                // ⚠ 事件名逐个对着【ST 真源码】public/scripts/events.js 核过（MESSAGE_SWIPED:7、
                // MESSAGE_SENT:8、MESSAGE_RECEIVED:9、MESSAGE_EDITED:10、MESSAGE_DELETED:11、
                // MESSAGE_UPDATED:12）——1.51.1 那次就是照自家设计稿拼了个不存在的名字，整层抓拍死掉而
                // 测试全绿。回退串与真值必须一字一样。
                // 全部走防抖：一条回复落地会连发好几个，逐个刷等于逐次重建整棵树。守卫都在函数里。
                [
                    et.MESSAGE_RECEIVED || 'message_received',
                    et.MESSAGE_UPDATED || 'message_updated',
                    et.MESSAGE_SWIPED || 'message_swiped',
                    et.MESSAGE_EDITED || 'message_edited',
                    et.MESSAGE_DELETED || 'message_deleted',
                    et.MESSAGE_SENT || 'message_sent',
                ].forEach((ev) => ctx.eventSource.on(ev, () => mvuedScheduleRefresh(ev)));
                // 再接两只【MVU 自己的】事件（外部件，可能压根不发到 ST 的总线上 → try 包住、发不发都不
                // 影响上面六条主路）。两个字面串都逐字抄自 MVU 的类型声明
                // JS-Slash-Runner/@types/iframe/exported.mvu.d.ts（ERA 那份副本同值）：
                //   · VARIABLE_UPDATE_ENDED = 'mag_variable_update_ended'（:115）—— 额外模型解析写完
                //   · VARIABLE_INITIALIZED  = 'mag_variable_initiailized'（:57）—— MVU 自己的
                //     「重新读取初始变量」按钮。⚠ **上游把 initialized 拼错了**（initiailized），这就是
                //     真名；拼「对」了反而永远收不到。改这两个串前先回去看那份 .d.ts，别照自己的直觉改。
                try {
                    const mvuEvts = [
                        'mag_variable_update_ended',
                        'mag_variable_initiailized',   // ← 现在真发的是这个（上游拼错的那个）
                        'mag_variable_initialized',    // ← 上游哪天把拼写修好，这条自动接上；多接一个信号
                        //    的代价 = 一次比对后返回（多余的事件天然被 JSON 比对短路吃掉）
                    ];
                    // 运行时若已能读到 MVU 的常量表，就以它为准再补一条（init 时 MVU 多半还没加载，
                    // 读不到是常态 —— 故它是「锦上添花」，上面两条字面串才是主力）。
                    const Mvu = getLoadedMvu();
                    const rt = Mvu && Mvu.events && Mvu.events.VARIABLE_INITIALIZED;
                    if (rt && !mvuEvts.includes(rt)) mvuEvts.push(rt);
                    mvuEvts.forEach((ev) => ctx.eventSource.on(ev, () => mvuedScheduleRefresh(ev)));
                } catch (e) { console.debug('[剧情推进] MVU 自有事件未接上（不影响编辑器刷新主路）：', e); }
            }
        }
    } catch (e) {
        console.warn('[剧情推进] event wiring failed (plan injection will only refresh on reload):', e);
    }
    // Cover the chat that may already be loaded by the time the extension inits.
    onChatChanged();
    document.addEventListener('selectionchange', onChatSelectionChange);   // ✂️ 划选追踪（守卫在函数内）
    refreshFixChatEntry();   // ✂️ 首载补挂（此刻聊天可能已渲染完）
}