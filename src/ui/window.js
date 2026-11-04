import { applyToolsInHeader, setSettingsTab, soCallModel, toggleSettings } from '../bootstrap.js';
import { confirmConvoSwap, confirmModeSwitch, convoStreamKeyForMode, getDiagWiMeta, getWiCustomMeta, serializeDiagSel, setDiagWiMeta, setSummary, setWiCustomMeta } from '../core/chat-metadata.js';
import { diagRetryMax } from '../core/post-reply.js';
import { QP_DEFAULTS, closeConnPicker, closeModelMenu, closeQpMenu, connPresetSnapshot, connPresetUpsert, getSettings, qpNewId, renderConnPresets, renderModelBar, renderQpManager, save, uiConfirm, uiPrompt } from '../core/settings.js';
import { sharedState } from '../core/state.js';
import { addSystemNote, clearConversation, modeEntryNote, renderEmptyState, syncConvoStream } from '../modes/advisor/cards.js';
import { getPath } from '../modes/advisor/metadata.js';
import { maybeWritePathDetail, pathAbandon, pathComplete, pathSendBack, syncNodeDetailSeg, toggleGuidePause } from '../modes/advisor/story-path.js';
import { currentInjectionPreview, renderPlanBar, startPathEdit, syncPlanBarCollapsed } from '../modes/advisor/ui.js';
import { toggleAdvisor } from '../modes/builder/ui.js';
import { autoGrowInput, nearBottom, openSummary, soApplyConvoIoVisual, updateSummaryIndicator } from '../modes/chat/history.js';
import { onSend } from '../modes/chat/send.js';
import { openMvuEditor } from '../modes/diagnose/editor.js';
import { filterWiCustomBooks, onDiagHybridToggle, onDiagUseSelToggle, populateDiagWiBooks, populateDiagWiEntries, populateWiCustomBooks, reflectDiagRetryVisible, selectFilteredDiagEntries, selectFilteredWiCustomEntries, setAllDiagEntries, setAllWiCustomBooks, setAllWiCustomEntries, setDiagEntriesByType, setWiCustomEntriesByType, updateDiagFilteredBtn, updateDiagHint, updateWiCustomFilteredBtn } from '../modes/diagnose/pickers.js';
import { maybeRunSaveHealth } from '../modes/diagnose/schema.js';
import { clampFixAutoMinChars, normalizeScopeInput } from '../modes/fix/algorithms.js';
import { openFixSelectCard, refreshFixChatEntry, runFixByTargets } from '../modes/fix/selection.js';
import { fixEnvNote, runCustomTaskNow } from '../modes/fix/staging.js';
import { applyPlanInjection, deleteFixBundle, deleteFixTemplate, findFixTemplate, getEffectiveFixCfg, getFixCfg, loadFixBundle, normalizeFixTemplates, openFixHub, openFixShare, pathActiveNode, saveFixBundle, saveFixTemplate, setFixCfg } from '../modes/fix/templates.js';
import { applyFixFlavorView, applyFixModeView, applyFixPresetLock, openDebug, populateFixBundles, populateFixTemplates, renderFixConfigWarnings, resetFixCfg, scanFixScope, seedFixControls, updateFixTplDirtyMarker, updateFixVerdict } from '../modes/fix/ui.js';
import { normalizeBldTarget } from '../modes/lorebook/core.js';
import { filterBldBooks, filterBookEntries, filterLbBooks, onBldBookSelectionChange, onLbBookSelectionChange, openSmartSelect, populateBuilderBooks, populateLorebookBooks, reflectLbPreview, renderBuilderChips, selectFilteredBldEntries, selectFilteredLbEntries, setAllBldEntries, setAllLbEntries, setBldEntriesByType, setLbEntriesByType, toggleBuilderChipsLegend, toggleLbPreview, updateBldFilteredBtn, updateLbFilteredBtn } from '../modes/lorebook/ui.js';
import { BUILDER_NPC_ONLY, CUSTOM_PERSONA_CAPS, ENABLE_AUTO_DIAGNOSE, ENABLE_BBS_BRIDGE, ENABLE_BUILDER_PERSONA_STYLES, ENABLE_CHAR_BUILDER, ENABLE_CUSTOM_PERSONAS, ENABLE_DIAG_BODY_INJECT, ENABLE_DIAG_WI_PICKER, ENABLE_DRAFT_CONDENSE, ENABLE_FIXSEL_CHAT_ENTRY, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_SELECT, ENABLE_FIX_TEMPLATE_HUB, ENABLE_LB_SMART_SELECT, ENABLE_LIGHT_CONDENSE, ENABLE_LWB_BRIDGE, ENABLE_MVU_EDITOR, ENABLE_SCHEMA_DIAG, ENABLE_WI_CUSTOM_PICK, ENABLE_WI_EJS_RENDER, PERSONAS } from '../prompts/builtins.js';
import { allPersonasView, buildPersonaFleshMessages, findPersonaById, fixSampleCopyName, fixTemplateIsBuiltin, parsePersonaFleshReply } from '../prompts/helpers.js';
import { promptDef, promptReset, promptSet } from '../prompts/registry.js';
import { wiEffectiveMode } from '../st/adapters.js';
import { onFetchModels, openExtraParams, updateExtraParamsHint } from '../transport/direct.js';
import { applyWindowSkin, syncChatBarButton, syncFixSelBarButton, syncQrButton } from './chat-entry.js';
import { applyInitialGeometry, makeDraggable, makeResizable, onFullscreenEscKeydown, scheduleEnsureInView, setFullscreen } from './geometry.js';
import { copyTextRobust } from './messages.js';
import { currentOracleMode, onDocClickOutside, openAutoDiagWarn, openAutoFixWarn, openCuration, reflectAutoDiagCheckbox, setAutoDiagnose, setOracleMode, soEnterShouldSend, soIsMobileForEnter, soReadSendOnEnter, toggleBuilder, toggleDiagnose, toggleFix, toggleLorebook, toggleWindow, updateDiagButtonVisual, updateFixButtonVisual } from './mode-shell.js';
import { applyModeVisibility, applyPromptEditorUiState, buildCurationRows, curationRowsFromSnapshot, getCuratedSnapshot, loadPromptEditor, onPresetSelected, populateSysPromptPresets, presetCurationActive, refreshProfiles, refreshPromptBadges, updateBadge, updateWiHint } from './settings.js';

/* ------------------------------------------------------------------ *
 * The floating window
 * ------------------------------------------------------------------ */
Object.assign(sharedState, { win: undefined, messagesEl: undefined, inputEl: undefined, sendBtn: undefined, modeBadge: undefined });

export function buildWindow() {
    if (document.getElementById('so-window')) return;
    const s = getSettings();

    sharedState.win = document.createElement('div');
    sharedState.win.id = 'so-window';
    sharedState.win.style.display = 'none';
    applyInitialGeometry(s);
    // 视口变化时把窗口重新夹回可见区——旋屏 / 手机软键盘弹收 / 浏览器地址栏伸缩都会改变【可见】视口，
    // 否则 position:fixed 的窗口标题栏（唯一带 ✕ 关闭 + 拖动把手的地方）可能被挤出屏外、再也够不到
    //（手机「常驻、无法关闭」bug）。ensureWindowInView 只贴合显示、不 save，键盘收起后会自己长回原尺寸。
    window.addEventListener('resize', scheduleEnsureInView);
    window.addEventListener('orientationchange', scheduleEnsureInView);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleEnsureInView);

    sharedState.win.innerHTML = `
        <div id="so-header">
            <div id="so-title"><i class="fa-solid fa-moon"></i> 剧情推进 <span id="so-mode-badge"></span><span id="so-diag-pill">诊断</span><span id="so-lb-pill">世界书</span><span id="so-adv-pill">参谋</span></div>
            <div id="so-header-btns">
                <div class="so-iconbtn" id="so-advisor-btn" title="剧情参谋 —— 构思新剧情走向，并引导主线靠近它"><i class="fa-solid fa-compass"></i></div>
                <div class="so-iconbtn" id="so-lorebook-btn" title="世界书模式 —— 聊聊或修改世界书"><i class="fa-solid fa-book"></i></div>
                <div class="so-iconbtn" id="so-diagnose-btn" title="诊断模式 —— 修复 MVU 状态变量（再点一次开启自动模式）"><i class="fa-solid fa-stethoscope"></i><span class="so-auto-tag">A</span></div>
                <div class="so-iconbtn" id="so-fix-btn" title="校正模式 —— 修一修最新这条回复（AI 味 / 对话 / 设定 / 详略…），应用后原文仍在"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                <span class="so-hdr-div" aria-hidden="true"></span>
                <div class="so-tools-wrap">
                    <div class="so-iconbtn" id="so-tools-btn" aria-haspopup="true" aria-expanded="false" title="更多 —— 剧情概要 / 调试提示词 / 设置"><i class="fa-solid fa-ellipsis"></i></div>
                    <div id="so-tools-menu" aria-label="更多工具">
                        <div class="so-iconbtn so-tools-item" id="so-normalchat-btn" title="回到普通聊天（自动诊断如已开启会继续在后台运行）"><i class="fa-solid fa-comment"></i><span>普通聊天</span></div>
                        <div class="so-iconbtn so-tools-item" id="so-summary-btn" title="剧情概要 —— 粘贴你的运行总结 / 前情提要，剧情推进会在最近对话前读到它"><i class="fa-solid fa-scroll"></i><span>剧情概要</span></div>
                        <div class="so-iconbtn so-tools-item" id="so-debug-btn" title="查看上一次发送的提示词"><i class="fa-solid fa-bug"></i><span>调试提示词</span></div>
                        ${ENABLE_CHAR_BUILDER ? '<div class="so-iconbtn so-tools-item" id="so-builder-btn" title="角色工坊 —— 和我一起打造 / 完善一个角色，写进 Persona 或世界书"><i class="fa-solid fa-masks-theater"></i><span>角色工坊</span></div>' : ''}
                        <div class="so-iconbtn so-tools-item" id="so-settings-btn" title="设置"><i class="fa-solid fa-gear"></i><span>设置</span></div>
                    </div>
                </div>
                <span class="so-hdr-div" aria-hidden="true"></span>
                <div class="so-iconbtn" id="so-clear-btn" title="清空对话"><i class="fa-solid fa-trash-can"></i></div>
                <div class="so-iconbtn" id="so-fullscreen-btn" title="全屏" aria-label="全屏" aria-pressed="false"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></div>
                <div class="so-iconbtn" id="so-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>

        <div id="so-settings" class="so-tabbed">
            <div class="so-set-tabbar" role="tablist">
                <button type="button" class="so-set-tab" data-tab="conn" role="tab"><i class="fa-solid fa-plug"></i>连接</button>
                <button type="button" class="so-set-tab" data-tab="ctx" role="tab"><i class="fa-solid fa-layer-group"></i>上下文</button>
                <button type="button" class="so-set-tab" data-tab="persona" role="tab"><i class="fa-solid fa-masks-theater"></i>人格</button>
                <button type="button" class="so-set-tab" data-tab="prompt" role="tab"><i class="fa-solid fa-file-pen"></i>提示词</button>
                <button type="button" class="so-set-tab" data-tab="qp" role="tab"><i class="fa-solid fa-bolt"></i>快捷指令</button>
                <button type="button" class="so-set-tab" data-tab="ui" role="tab"><i class="fa-solid fa-palette"></i>界面</button>
                <span class="so-set-tabbar-spacer"></span>
                <button type="button" class="so-icon-btn" id="so-settings-close" title="关闭设置，回到聊天"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="so-set-page" data-tab="conn" role="tabpanel">
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-bookmark"></i>连接存档<span class="so-set-title-aside">输入框上方也能一键切换</span></div>
                    <div class="so-preset-list" id="so-conn-preset-list"></div>
                    <div class="so-preset-add">
                        <input id="so-conn-preset-name" type="text" placeholder="给当前连接起个名字">
                        <button type="button" class="so-mini-btn" id="so-conn-preset-save">存为新存档</button>
                    </div>
                    <div class="so-hint">存档记下端点、密钥、模型，以及下面的高级选项和生成参数，切换存档时一起换。</div>
                </div>
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-plug"></i>当前连接</div>
                    <div class="so-seg" id="so-mode-seg">
                        <button type="button" data-mode="direct">直连（自定义地址）</button>
                        <button type="button" data-mode="profile">酒馆连接配置文件</button>
                    </div>
                    <select id="so-mode" hidden>
                        <option value="direct">直连（自定义 URL）</option>
                        <option value="profile">连接配置文件</option>
                    </select>
                    <div id="so-direct-fields" class="so-set-stack">
                        <label class="so-field"><span>端点 URL</span>
                            <input id="so-endpoint" type="text" placeholder="https://your-proxy.com/v1">
                        </label>
                        <label class="so-field"><span>API 密钥</span>
                            <input id="so-apikey" type="password" placeholder="sk-...">
                        </label>
                        <label class="so-field"><span>模型</span>
                            <div class="so-model-row">
                                <input id="so-model" type="text" placeholder="gpt-4o-mini">
                                <div class="so-iconbtn" id="so-model-fetch" title="从服务商获取可用模型列表"><i class="fa-solid fa-cloud-arrow-down"></i></div>
                            </div>
                            <select id="so-model-list" style="display:none"></select>
                            <div class="so-hint" id="so-model-hint"></div>
                        </label>
                    </div>
                    <div id="so-profile-fields" class="so-set-stack">
                        <label class="so-field"><span>配置文件</span>
                            <div class="so-profile-row">
                                <select id="so-profile"></select>
                                <div class="so-iconbtn" id="so-profile-refresh" title="刷新配置文件列表"><i class="fa-solid fa-rotate-right"></i></div>
                            </div>
                        </label>
                        <div class="so-hint" id="so-profile-hint">使用酒馆里保存的连接配置文件，经酒馆服务器转发（无 CORS 问题）。</div>
                    </div>
                    <details class="so-adv-fold"><summary>高级选项（跨域转发、原样地址、附加参数）</summary><div class="so-adv-fold-body">
                        <div id="so-direct-adv" class="so-set-stack">
                            <div class="so-opt"><label class="so-check" title="打开后，直连请求改由酒馆服务器代发——避免浏览器跨域(CORS)，用的还是上面这个端点和密钥。"><input id="so-direct-backend" type="checkbox"><span>经酒馆后端转发</span></label><div class="so-hint">直连报 <b>CORS / failed to fetch</b> 时勾上，改由酒馆服务器代发；获取模型也一样。</div></div>
                            <div class="so-opt"><label class="so-check" title="打开后，填什么地址就用什么地址：不再自动补 /v1，请求直接打到 地址/chat/completions（获取模型打到 地址/models）。"><input id="so-raw-url" type="checkbox"><span>地址原样使用（不自动补 /v1）</span></label><div class="so-hint">地址明明填对了却 404 / 拉不到模型时勾上，常和上面的转发一起用。</div></div>
                        </div>
                        <label class="so-row" title="像 ST「自定义（兼容 OpenAI）」接口的「附加参数」面板：给每次请求附加 / 剔除自定义参数、附加请求头（YAML 或 JSON）——例如给 DeepSeek 类中转关掉思维链。">
                            <span>附加参数</span>
                            <div class="so-iconbtn" id="so-extraparams-btn" title="打开附加参数设置"><i class="fa-solid fa-sliders"></i></div>
                        </label>
                        <div class="so-hint" id="so-extraparams-hint"></div>
                    </div></details>
                </div>
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-sliders"></i>生成参数<span class="so-set-title-aside">随连接存档保存</span></div>
                    <div class="so-grid2">
                        <label class="so-field"><span>温度</span>
                            <input id="so-temp" type="number" step="0.05" min="0" max="2">
                        </label>
                        <label class="so-field"><span>最大 tokens 数</span>
                            <input id="so-maxtok" type="number" step="50" min="1">
                        </label>
                    </div>
                    <label class="so-check"><input id="so-stream" type="checkbox"><span>流式输出</span></label>
                    <div class="so-opt"><label class="so-check"><input id="so-sendtemp" type="checkbox"><span>发送温度参数</span></label><div class="so-hint">个别模型拒收温度参数时关掉。</div></div>
                </div>
            </div>

            <div class="so-set-page" data-tab="ctx" role="tabpanel">
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-comments"></i>对话记录</div>
                    <label class="so-field"><span>读取最近多少条（-1 全部，0 不读）</span>
                        <input id="so-depth" type="number" step="1" min="-1">
                    </label>
                    <div class="so-opt"><label class="so-check"><input id="so-hidden" type="checkbox"><span>读取隐藏楼层</span></label><div class="so-hint">被 /hide 隐藏的消息也读进来（不影响世界书关键词扫描）。</div></div>
                    <div class="so-opt"><label class="so-check"><input id="so-regex" type="checkbox"><span>应用剧情正则</span></label><div class="so-hint">和主聊天一样剥掉思维链、状态栏，使用总结。</div></div>
                </div>
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-id-card"></i>角色与状态</div>
                    <label class="so-check"><input id="so-card" type="checkbox"><span>角色卡（描述 / 性格 / 场景）</span></label>
                    <div class="so-opt"><label class="so-check"><input id="so-stat" type="checkbox"><span>变量状态（MVU）</span></label><div class="so-hint">普通聊天问数值时以它为准；关掉则如实说看不到。参谋始终会读。</div></div>
                    <div class="so-opt"><label class="so-check"><input id="so-world" type="checkbox"><span>世界引擎的后台世界状态</span></label><div class="so-hint">目前只适配世界引擎（World Engine）；数据较大、比较费 token，没装时没有任何开销。</div></div>
                </div>
                ${ENABLE_BBS_BRIDGE || ENABLE_LWB_BRIDGE ? `<div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-brain"></i>记忆扩展</div>
                    ${ENABLE_BBS_BRIDGE ? '<div class="so-opt"><label class="so-check"><input id="so-bbs" type="checkbox"><span>柏宝书的剧情总结</span></label><div class="so-hint">让剧情推进也记得住早期剧情。需已安装柏宝书（ST-BaiBai-Book）。</div></div>' : ''}
                    ${ENABLE_LWB_BRIDGE ? '<div class="so-opt"><label class="so-check"><input id="so-lwb" type="checkbox"><span>小白X 的剧情总结</span></label><div class="so-hint">需已安装小白X（LittleWhiteBox）并开启其「剧情总结」。</div></div>' : ''}
                </div>` : ''}
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-book"></i>世界书</div>
                    <label class="so-field"><span>读取范围</span>
                        <select id="so-wi">
                            <option value="off">关闭</option>
                            <option value="st">常驻 + 关键词匹配（ST 默认行为）</option>
                            <option value="char">仅角色相关世界书（排除全局）</option>
                            <option value="all">全部条目（规划用 —— 忽略关键词）</option>
                            ${ENABLE_WI_CUSTOM_PICK ? '<option value="custom">自定义（手动挑书和条目）</option>' : ''}
                        </select>
                    </label>
                    <div class="so-hint" id="so-wi-hint"></div>
                    ${ENABLE_WI_CUSTOM_PICK ? `
                    <div id="so-wi-custom" hidden>
                        <div class="so-lb-row">
                            <i class="fa-solid fa-book so-lb-icon"></i>
                            <details id="so-wic-bookpick" class="so-lb-bookpick">
                                <summary id="so-wic-bookpick-sum" title="选择要发给剧情推进的世界书（可多选；不选＝当前激活的全部）">全部激活的世界书</summary>
                                <div class="so-lb-bookpick-tools">
                                    <button type="button" class="so-lb-mini" id="so-wic-book-all">全选</button>
                                    <button type="button" class="so-lb-mini" id="so-wic-book-none">全不选（＝全部激活）</button>
                                </div>
                                <input type="text" id="so-wic-book-filter" class="so-lb-book-filter" placeholder="筛选世界书（名称）…">
                                <div id="so-wic-book-list" class="so-lb-book-list"></div>
                                <div id="so-wic-book-empty" class="so-lb-book-empty" hidden>（没有匹配的世界书）</div>
                            </details>
                            <div class="so-iconbtn" id="so-wic-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
                        </div>
                        <label class="so-check so-lb-check"><input id="so-wic-hybrid" type="checkbox"><span>混合模式：勾选的条目 + 已选世界书里当前触发的绿灯条目</span></label>
                        <div id="so-wic-entries" class="so-lb-entries">
                            <div class="so-lb-entries-head">
                                <span id="so-wic-entries-summary">条目：全部</span>
                                <div class="so-iconbtn so-lb-ent-toggle" id="so-wic-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                            </div>
                            <div class="so-lb-entries-tools">
                                <button type="button" class="so-lb-mini" id="so-wic-all">全选</button>
                                <button type="button" class="so-lb-mini" id="so-wic-none">全不选</button>
                                <button type="button" class="so-lb-mini" id="so-wic-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                                <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-wic-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                                <button type="button" class="so-lb-mini so-lb-mini-green" id="so-wic-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                                <button type="button" class="so-lb-mini so-lb-mini-off" id="so-wic-disabled" title="只选已禁用条目">仅禁用</button>
                            </div>
                            <input type="text" id="so-wic-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                            <div id="so-wic-entries-list" class="so-lb-entries-list"></div>
                        </div>
                        <div class="so-hint" id="so-wic-hint"></div>
                    </div>` : ''}
                    ${ENABLE_WI_EJS_RENDER ? '<div class="so-opt"><label class="so-check"><input id="so-wi-ejs" type="checkbox"><span>支持 EJS 世界书条目</span></label><div class="so-hint">⚠ 含「写变量」的条目会被额外执行、可能影响卡内变量，遇异常请关闭。</div></div>' : ''}
                </div>
            </div>

            <div class="so-set-page" data-tab="persona" role="tabpanel">
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-masks-theater"></i>说话人格</div>
                    <div class="so-profile-row">
                        <select id="so-persona"></select>
                        ${ENABLE_CUSTOM_PERSONAS ? '<div class="so-iconbtn" id="so-persona-edit" title="管理自定义人格"><i class="fa-solid fa-pen"></i></div>' : ''}
                    </div>
                    <div class="so-hint">只改变剧情推进说话的语气与文采，不改变它的分析职责；参谋 / 世界书 / 角色工坊模式下同样叠加（方案与条目正文的格式不受影响），诊断与校正模式下不生效。选「普通」即不套人格。用了补全预设时，人格叠加在预设之上。</div>
                    ${ENABLE_CUSTOM_PERSONAS ? `
                    <div id="so-persona-editor" style="display:none">
                        <label class="so-row"><span>选择</span>
                            <select id="so-pe-sel"></select>
                        </label>
                        <label class="so-row"><span>名称</span>
                            <input type="text" id="so-pe-name" maxlength="30" placeholder="如：嘻嘻哈哈的损友">
                        </label>
                        <div class="so-pe-field"><span>人格描述</span>
                            <textarea id="so-pe-voice" rows="5" placeholder="只写性格、态度与说话腔调（例：一个嘻嘻哈哈爱起哄的损友）。职责规则（准确、知无不言）由剧情推进自带，不用写。"></textarea>
                        </div>
                        <div class="so-pe-field"><span>示例对话（可选）</span>
                            <textarea id="so-pe-example" rows="3" placeholder="示例问：……　示例答：……"></textarea>
                        </div>
                        <div class="so-pe-btns">
                            <button type="button" id="so-pe-flesh" class="so-fix-run-btn">✨ AI 帮我完善</button>
                            <button type="button" id="so-pe-undo" class="so-fix-run-btn" style="display:none">↩ 撤销</button>
                            <span class="so-pe-spacer"></span>
                            <button type="button" id="so-pe-save" class="so-fix-run-btn">保存</button>
                            <button type="button" id="so-pe-del" class="so-fix-run-btn">删除</button>
                        </div>
                        <div class="so-hint">改动只在点「保存」时生效；切换人格或收起编辑器会丢弃未保存的修改。「✨ AI 帮我完善」用当前连接的模型把你的点子扩写成完整描述。</div>
                    </div>` : ''}
                </div>
            </div>

            <div class="so-set-page" data-tab="prompt" role="tabpanel">
                <div class="so-set-section" id="so-sysprompt-preset-wrap">
                    <div class="so-set-title"><i class="fa-solid fa-file-lines"></i>普通聊天的系统提示词来源</div>
                    <div class="so-profile-row">
                        <select id="so-sysprompt-preset"></select>
                        <div class="so-iconbtn" id="so-sysprompt-preset-recurate" title="重新挑选要保留的块"><i class="fa-solid fa-list-check"></i></div>
                        <div class="so-iconbtn" id="so-sysprompt-preset-refresh" title="刷新预设列表"><i class="fa-solid fa-rotate-right"></i></div>
                    </div>
                    <div class="so-hint" id="so-sysprompt-preset-hint"></div>
                </div>
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-pen-to-square"></i>提示词<span class="so-set-title-aside" id="so-prompt-summary"></span></div>
                    <div class="so-hint">剧情推进各模式发给模型的每一段文字都在这里。先选分组，再点条目查看或修改；改过的会标出来，随时可以恢复默认。</div>
                    <div class="so-pgroups" id="so-pgroups"></div>
                    <div class="so-plist" id="so-plist"></div>
                    <div class="so-peditor" id="so-peditor" hidden>
                        <div class="so-peditor-head"><span id="so-peditor-title"></span><button type="button" class="so-mini-btn" id="so-sysprompt-reset" title="把这一条恢复为内置默认">↺ 恢复默认</button></div>
                        <textarea id="so-sysprompt" rows="8" spellcheck="false"></textarea>
                        <div class="so-pvars" id="so-pvars"></div>
                        <div class="so-hint" id="so-sysprompt-which-hint"></div>
                    </div>
                </div>
            </div>

            <div class="so-set-page" data-tab="qp" role="tabpanel">
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-bolt"></i>快捷指令<span class="so-set-title-aside" id="so-qp-summary"></span></div>
                    <div class="so-hint">显示在输入框上方、模型右边：点名字直接发送，点 ✎ 先填进输入框。每个模式只显示自己的。内容里可以写 {{user}}、{{char}}，发送时换成当前的名字。</div>
                    <div class="so-pgroups" id="so-qp-modes"></div>
                    <div id="so-qp-list"></div>
                    <div class="so-qp-actions">
                        <button type="button" class="so-mini-btn" id="so-qp-add"><i class="fa-solid fa-plus"></i> 新建一条</button>
                        <button type="button" class="so-mini-btn" id="so-qp-restore" title="把预置的快捷指令（如「杀古风」）补回来，已有的不动">↺ 补回预置的</button>
                    </div>
                </div>
            </div>

            <div class="so-set-page" data-tab="ui" role="tabpanel">
                <div class="so-set-section">
                    <div class="so-set-title"><i class="fa-solid fa-palette"></i>外观与行为</div>
                    <label class="so-field"><span>窗口配色</span><select id="so-window-skin" title="深色 / 浅色为固定配色，不跟随酒馆主题"><option value="dark">深色</option><option value="light">浅色</option><option value="theme">跟随酒馆主题</option></select></label>
                    <label class="so-check"><input id="so-qr-toggle" type="checkbox"><span>输入框上方的快捷回复栏里放一个「剧情推进」按钮</span></label>
                    <label class="so-check"><input id="so-chatbar-toggle" type="checkbox"><span>在聊天输入栏放一个 🌙 快捷按钮（一键开 / 关剧情推进）</span></label>
                    <label class="so-check"><input id="so-clickout-toggle" type="checkbox"><span>点击窗外自动收起</span></label>
                    <div class="so-opt"><label class="so-check"><input id="so-tools-header-toggle" type="checkbox"><span>把 ⋯ 里的工具按钮移到标题栏</span></label><div class="so-hint">关闭后刷新页面恢复 ⋯ 菜单。</div></div>
                </div>
            </div>
        </div>

        <div id="so-diag-bar">
            <details class="so-mode-collapse" id="so-diag-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-stethoscope"></i><span>诊断设置</span></summary>
                <div class="so-mode-collapse-body">
            ${ENABLE_AUTO_DIAGNOSE ? '<label class="so-check so-lb-check"><input id="so-diag-auto" type="checkbox"><span>自动诊断每条新回复（后台自动检查并修复 MVU）</span></label>\n            <div class="so-hint">每收到一条新的 AI 回复就在后台检查其中的变量更新，发现问题自动修复，并在诊断记录里留一条可撤销的记录。窗口关着也照常工作——诊断按钮变红就表示它在后台跑着。每条回复会多发一次模型请求。</div>\n            <label class="so-check so-lb-check"><input id="so-diag-mvu-compat" type="checkbox"><span>⏳ 兼容 MVU「额外模型解析」</span></label>\n            <div class="so-hint">只有同时使用自动诊断与 TavernHelper / MVU 的「额外模型解析」时才勾选。每条 AI 回复先观察 4 秒启动窗；一旦外部解析启动，会等完整重试批次结束。成功写出更新块就核验；失败或没有有效更新块，就由自动诊断照常推导。最多等 10 分钟，仍未收尾则本轮安全跳过、不抢写。若自动校正也开启，它会在落新 swipe 前共享这次等待并合并更新块。</div>\n            <label class="so-check so-lb-check"><input id="so-diag-cowrite" type="checkbox"><span>🧩 允许与其他脚本并写 MVU</span></label>\n            <div class="so-hint">某些卡脚本 / 扩展会在诊断期间改写 MVU。勾选后自动诊断仍会执行，但只写入未被改动的值，被改动的值跳过不写。</div>\n            <label class="so-check so-lb-check"><input id="so-diag-retry" type="checkbox"><span>🔁 失败自动重试</span></label>\n            <div class="so-hint">自动诊断这一轮没跑成时自动再试（每次重试都会重新读取当前状态、再发一次模型请求）。在下方勾选哪些失败情形需要重试；成功、无需改动、以及安全跳过（切聊天 / 状态已变 / 手动中断）永不重试。</div>\n            <div id="so-diag-retry-opts">\n            <label class="so-field"><span>最多重试次数</span><input id="so-diag-retry-count" type="number" step="1" min="1" max="99"></label>\n            <label class="so-check so-lb-check"><input id="so-diag-retry-empty" type="checkbox"><span>空白回复（模型没返回内容）</span></label>\n            <label class="so-check so-lb-check"><input id="so-diag-retry-format" type="checkbox"><span>格式错误（没能读懂 / 拒收模型给的更新）</span></label>\n            <label class="so-check so-lb-check"><input id="so-diag-retry-error" type="checkbox"><span>调用失败（网络错误 / 超时等）</span></label>\n            </div>' : ''}
            ${ENABLE_DIAG_BODY_INJECT ? '<label class="so-check so-lb-check"><input id="so-diag-inject" type="checkbox"><span>把诊断修正写进正文 —— 开启后，诊断的修正（自动与手动）会写进这条回复的更新区块——撤销时一并移除。</span></label>' : ''}
            <label class="so-check so-lb-check"><input id="so-diag-preset" type="checkbox"><span>套用我的补全预设（诊断指令叠加其上）</span></label>
            <div class="so-hint so-diag-preset-warn">⚠ 仅在诊断确实被模型拒绝时才勾选：预设的额外内容会分散模型注意力、影响诊断精度。</div>${ENABLE_SCHEMA_DIAG ? '\n            <label class="so-check so-lb-check"><input id="so-diag-schema-retry" type="checkbox"><span>被拒时让模型自动重写一次（多花一次调用）</span></label>' : ''}
            ${ENABLE_MVU_EDITOR ? '<div class="so-mvued-row"><button type="button" class="so-lb-mini" id="so-mvued-btn">🎛 变量编辑器 —— 直接查看 / 修改当前变量</button></div>' : ''}${ENABLE_SCHEMA_DIAG ? '\n            <div class="so-mvued-row"><button type="button" class="so-lb-mini" id="so-diag-health-btn">🩺 检查存档</button></div>' : ''}
            <div id="so-diag-wisel">
            <label class="so-check so-lb-check"><input id="so-diag-usesel" type="checkbox"><span>诊断使用精选世界书条目（关闭则用默认扫描）</span></label>
            <div class="so-hint">开启后可【按本聊天】挑选要喂给诊断的世界书条目，无视其在 ST 里的启用 / 禁用状态——解决「禁用了变量规则条目后诊断就看不到」与「全量太吵」的两难。首次开启会按当前激活情况预选一份，之后随你增删、按聊天记忆。</div>
            <div id="so-diag-picker">
                <label class="so-check so-lb-check"><input id="so-diag-hybrid" type="checkbox"><span>混合模式：精选条目 + 主聊天当前触发的绿灯条目</span></label>
                <div class="so-lb-row">
                    <i class="fa-solid fa-book so-lb-icon"></i>
                    <select id="so-diag-book" title="选择要从哪本世界书里挑条目"></select>
                    <div class="so-iconbtn" id="so-diag-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
                </div>
                <div id="so-diag-entries" class="so-lb-entries">
                    <div class="so-lb-entries-head">
                        <span id="so-diag-entries-summary">条目：全部</span>
                        <div class="so-iconbtn so-lb-ent-toggle" id="so-diag-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                    </div>
                    <div class="so-lb-entries-tools">
                        <button type="button" class="so-lb-mini" id="so-diag-all">全选</button>
                        <button type="button" class="so-lb-mini" id="so-diag-none">全不选</button>
                        <button type="button" class="so-lb-mini" id="so-diag-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                        <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-diag-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                        <button type="button" class="so-lb-mini so-lb-mini-green" id="so-diag-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                        <button type="button" class="so-lb-mini so-lb-mini-off" id="so-diag-disabled" title="只选已禁用条目">仅禁用</button>
                    </div>
                    <input type="text" id="so-diag-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                    <div id="so-diag-entries-list" class="so-lb-entries-list"></div>
                </div>
                <div class="so-hint" id="so-diag-hint"></div>
            </div>
            </div>
                </div>
            </details>
        </div>

        <div id="so-fix-bar">
            <details class="so-mode-collapse" id="so-fix-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-wand-magic-sparkles"></i><span>校正设置</span></summary>
                <div class="so-mode-collapse-body">
                    <label class="so-check so-lb-check"><span>校正模式</span>&nbsp;<select id="so-fix-mode-select" title="手动 = 在输入框直接说要改什么（单稿、快）；去 AI 味 = 按目标去八股 / 每条新回复后台跑（双稿收紧）"><option value="manual">手动（说要改哪里）</option><option value="auto">去 AI 味（按目标 / 每条新回复）</option>${ENABLE_FIX_CUSTOM_TASK ? '<option value="custom">自定义（用自己的模板处理每条回复）</option>' : ''}</select></label>
                    <!-- ✨ 判定预览行（1.18.0 迁出 #so-fix-auto-wrap，修 P8）：本聊天开了自动校正就该看得见
                         「这条回复会被怎么处理」，不再被「面板正显示手动视图」这个全局偏好埋没。 -->
                    <div id="so-fix-verdict" class="so-fix-verdict" hidden></div>

                    <!-- 手动模式：在下方输入框直接说要改什么。默认带上丰富上下文（一次性精修、质量优先）。单稿、无目标。 -->
                    <div id="so-fix-manual">
                        <label class="so-check so-lb-check"><input id="so-fixm-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                        <div class="so-hint">仅当模型拒绝校正请求时才开（需先在【设置】里精选一个补全预设）。</div>
                        <div class="so-hint so-fixm-warn">⚠ 部分模型（如 DeepSeek、Gemini）在高上下文下会认不准要改哪一条回复、把前文内容混进结果——下面几项默认关闭，仅在确有需要（对齐设定 / 前情）时再逐项开启。若确要带前文，更建议改用 ✂️ 选段校正：只把你划选的一段发给模型，高上下文下更稳，也绝不动没划到的部分。</div>
                        <label class="so-check so-lb-check"><span>只改此标签内的正文</span>&nbsp;<input id="so-fixm-scope" type="text" style="width:110px;" placeholder="留空 = 整条"></label>
                        <div class="so-hint">填正文所在的标签名（如 <code>Interleaving</code>，不用写尖括号）：模型只看到、只改这个标签里的正文，标签外的构建块、状态栏、占位符原样保留。留空，或这条回复里没有这个标签时，按整条回复处理。</div>
                        <label class="so-check so-lb-check"><span>加载前文条数（0 = 不带，-1 = 全部）</span>&nbsp;<input id="so-fixm-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-world" type="checkbox"><span>带上当前激活世界书</span></label>
                        <label class="so-check so-lb-check"><input id="so-fixm-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                        <div class="so-hint">柏宝书 / 小白X 的总结要先在「设置 → 上下文 → 记忆扩展」里打开才会带上；柏宝书只提供已经隐藏的旧楼层的摘要（和它注入主聊天的是同一份）。</div>
                        <!-- ✨ 思考块保护（W1 2026-08-16 §3.1 修复）。文案待 Prince 过目（行文案 + title 候选见 REPORT-FIXROUND） -->
                        <label class="so-check so-lb-check"><input id="so-fixm-protectthink" type="checkbox"><span>保护思考区块（&lt;think&gt; 思维链等，校正时原样保留）</span></label>
                        <div class="so-hint">部分模型改整条回复时会顺手把卡片的思考区块整块删掉——开着时系统先把它收走、校正后原样接回（校正卡会注明）。想让校正连思考块一起改时再关。</div>
                        <label class="so-check so-lb-check"><span>校正回复上限</span>&nbsp;<input id="so-fix-maxtok" type="number" min="0" step="1024" style="width:6em" placeholder="自动·4096" title="校正调用的 max_tokens 下限自动为 4096；长楼层（约 3000 字以上）改写被截断、校正总失败时可调高（如 8192/12288）。对手动与自动校正都生效。注意：超过服务商单次输出上限会被直接拒绝——报错就调回来。留空 = 自动。"></label>
                        <div class="so-hint">手动：在下方输入框直接说要改哪里（如「换种写法重写这段」「她这里不该笑」），只改最新这一条回复，单稿、更快。</div>
                        ${ENABLE_FIX_SELECT ? '<button type="button" id="so-fixsel-open" class="so-fix-run-btn" title="划选回复里的一段，只把这段发给模型改——弱模型 / 长聊天下更稳，绝不动你没选的部分（状态栏 / 面板等）"><i class="fa-solid fa-scissors"></i> 选段校正（只改划选的一段）</button>' : ''}
                        ${ENABLE_FIXSEL_CHAT_ENTRY && ENABLE_FIX_SELECT ? '<label class="so-check so-lb-check"><input id="so-fixsel-barbtn" type="checkbox"><span>在聊天输入框上方放一个「✂️ 选段校正」快捷按钮</span></label><div class="so-hint">免去每次开窗切模式：在主聊天里划选一段，点它即可直接打开选段卡（不划选 = 直接开卡）。</div><label class="so-check so-lb-check"><input id="so-fixsel-rowbtn" type="checkbox"><span>在最新一条 AI 回复的右上角放「✂️」选段按钮</span></label><div class="so-hint">不想看到回复上的小剪刀就取消勾选；输入框上方的快捷按钮不受影响。</div>' : ''}
                    </div>

                    <!-- 自动模式（1.18.3 新手优先重排）：判定行 → 跑一次 / 每条 → 目标 → 强度 → 警告盒 → 进阶折叠 → 恢复推荐。 -->
                    <div id="so-fix-auto-wrap">
                        <button type="button" id="so-fix-run" class="so-fix-run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> 按目标给最新回复去 AI 味</button>
                        <label class="so-check so-lb-check"><input id="so-fix-auto" type="checkbox"><span>每条新回复自动去 AI 味</span></label>
                        <div class="so-fix-targets-head">校正目标</div>
                        <div class="so-fix-tgt-grid">
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-slop" type="checkbox"><span>AI 八股 / 套话</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-dialogue" type="checkbox"><span>对话机械 / 不自然</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-precision" type="checkbox"><span>过度精确（数学论文腔）</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-magic" type="checkbox"><span>魔法被写成理科（仅奇幻设定）</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-pacing" type="checkbox"><span>描写拖沓 / 流水账</span></label>
                            <label class="so-check so-lb-check"><input id="so-fix-tgt-archaic" type="checkbox"><span>古风词混入（仅西幻 / 现代设定）</span></label>
                        </div>
                        <label class="so-check so-lb-check"><span>强度</span>&nbsp;<select id="so-fix-prompt-version" title="轻校＝现行提示词（较克制）；精校＝更彻底的三道工序校正"><option value="light">轻校（默认）</option><option value="thorough">精校（更彻底）</option></select></label>
                        <label class="so-check so-lb-check" id="so-fix-prompt-flavor-row"><span>精校侧重</span>&nbsp;<select id="so-fix-prompt-flavor" title="按你用的模型选侧重：DeepSeek / 国产模型选 DeepSeek 类；Claude / Opus 选 Opus 类；Gemini 选 Gemini 类"><option value="deepseek">DeepSeek 类（默认）</option><option value="opus">Opus 类</option><option value="gemini">Gemini 类</option></select></label>
                        <div class="so-hint">轻校 = 克制（默认）。精校 = 更彻底的三道工序；按你用的模型选侧重：DeepSeek / 国产模型选「DeepSeek 类」，Claude / Opus 选「Opus 类」，Gemini 选「Gemini 类」。</div>
                        <div id="so-fix-warnings" class="so-hint" hidden></div>
                        <details class="so-mode-collapse" id="so-fix-adv">
                            <summary class="so-fix-targets-head" style="cursor:pointer;">进阶设置（一般不用动）</summary>
                            <label class="so-check so-lb-check"><span>只校正此标签内的正文</span>&nbsp;<input id="so-fix-scope" type="text" style="width:110px;"></label>
                            <div class="so-hint">通常不用动：会自动识别卡片的正文标签（默认 <code>content</code>），认不准时会请你确认一次。识别错了才在这里改（<strong>手填后自动识别会停用</strong>，交还给你）；<strong>留空</strong> = 校正整条回复。</div>
                            <button type="button" id="so-fix-scan" class="so-fix-run-btn"><i class="fa-solid fa-magnifying-glass"></i> 重新扫描正文标签（识别不对时用）</button>
                            <div id="so-fix-scan-panel" class="so-fix-scan-panel" hidden></div>
                            <div class="so-fix-targets-head">保留区 / 丢弃区：结构块会自动识别并原样保留——下面是<strong>本条回复</strong>实际识别到的。没认出的块，点它加进保留区（或手动填，每行一个<strong>起始</strong>标记；支持嵌套同名标签与 <code>[IMG_GEN]</code> 方括号块）；丢弃区 = 直接删掉、不放回。识别不对的格式欢迎在 Discord 私信 <strong>@Prince</strong>，会加进测试集修复。标签写法：&lt;thinking&gt; 或 thinking 都行，不用写闭合标签；方括号块写 [IMG_GEN]；同一标签两边都填按保留处理。</div>
                            <div id="so-fix-receipts" class="so-hint" hidden></div>
                            <textarea id="so-fix-keep" rows="3" placeholder="保留区标签：每行一个，只写开标签或名字即可——例如 <status> 或 status（不用写 </status>）；方括号块写 [IMG_GEN]"></textarea>
                            <textarea id="so-fix-drop" rows="3" placeholder="丢弃区标签：每行一个，只写开标签或名字即可——例如 <thinking>（不用写 </thinking>）；方括号块写 [IMG_GEN]。命中的块直接删掉、不放回"></textarea>
                            <label class="so-check so-lb-check"><input id="so-fix-join" type="checkbox"><span>整体校正（默认开）：正文合并为 1 次调用，结构块用锚点原位保留</span></label>
                            <div class="so-hint">开 = 省调用、整篇更连贯；结构块位置靠锚点标记保留（模型极偶尔挪动锚点时内容不丢、位置兜底接到正文末尾，记录里会如实说明）。关 = 每段正文各发一次调用（位置由代码百分百把控、单段失败只损失那一段，调用更多）。</div>
                            <label class="so-check so-lb-check"><input id="so-fix-wait-mvu" type="checkbox"><span>⏳ 与 MVU「额外模型更新」并用（避免抢写冲突）</span></label>
                            <div class="so-hint">仅当你开了 MVU 的「额外模型更新」（用另一个模型异步解析变量）时才勾。勾上后：校正<strong>照常立刻开跑</strong>（与 MVU 并行、几乎不多等），只在<strong>生成新回复稿之前</strong>等 MVU 把变量写完再合并进来——两者不再抢写同一条消息、数据不错乱。没开额外模型更新就<strong>保持不勾</strong>。</div>
                            <label class="so-check so-lb-check"><input id="so-fixa-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                            <div class="so-hint">⚠ 仅在你的模型 / 中转会【拒绝】校正请求、需要破限 / 越狱时才开。需先在【设置】里选好并「精选」一个补全预设。手动与自动【各自独立】开关；开启的那一套会套上该预设的文本块与角色（跳过角色卡 / 世界书等 RP 内容标记），可能更慢 / 更贵。不需要破限就别开。</div>
                            <textarea id="so-fix-know" rows="2" placeholder="角色知识边界（可空）：例如「主角不知道自己的真实身世」"></textarea>
                            <textarea id="so-fix-guard" rows="2" placeholder="剧情护栏 / 自定义（可空）：例如「保持慢热，不要时间跳跃」"></textarea>
                            <details class="so-mode-collapse" id="so-fix-ctx-adv">
                                <summary class="so-fix-targets-head" style="cursor:pointer;">上下文（默认关，点开）</summary>
                                <div class="so-hint">⚠ 默认关闭以省时间。仅当你的「知识边界 / 剧情护栏」需要参考前文 / 角色卡 / 世界书才能判断时，才勾选。</div>
                                <label class="so-check so-lb-check"><input id="so-fix-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                                <label class="so-check so-lb-check"><input id="so-fix-ctx" type="checkbox"><span>带上前文上下文（最近若干条主聊天）</span></label>
                                <label class="so-check so-lb-check" style="margin-left:18px;"><span>条数（-1=全部）</span>&nbsp;<input id="so-fix-ctx-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                                <label class="so-check so-lb-check"><input id="so-fix-world" type="checkbox"><span>带上激活世界书（蓝灯 + 本条命中的绿灯）</span></label>
                                <label class="so-check so-lb-check"><input id="so-fixa-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                                <div class="so-hint">柏宝书 / 小白X 的总结要先在「设置 → 上下文 → 记忆扩展」里打开才会带上；柏宝书只提供已经隐藏的旧楼层的摘要（和它注入主聊天的是同一份）。</div>
                            </details>
                            <div class="so-fix-bundle-row">
                                <select id="so-fix-bundle" title="已存的校正套餐（全局，跨聊天可用）"></select>
                                <button type="button" id="so-fix-bundle-load" class="so-fix-run-btn">加载</button>
                                <button type="button" id="so-fix-bundle-save" class="so-fix-run-btn">保存为…</button>
                                <button type="button" id="so-fix-bundle-del" class="so-fix-run-btn">删除</button>
                            </div>
                            <div class="so-hint">套餐＝把当前这套自动校正配置（目标 / 约束 / 上下文）存成一个名字（如「硬核西幻」），换聊天后一键加载回来。</div>
                        </details>
                        <button type="button" id="so-fix-reset" class="so-fix-run-btn"><i class="fa-solid fa-rotate-left"></i> 恢复推荐设置</button>
                        <div class="so-hint">把本聊天的自动校正设置一键还原成推荐值：作用域 = <code>content</code>、默认校正目标、排除区清空、自动关、任务切回校正（也会清掉已确认的正文形态，回到自动识别）。</div>
                    </div>

                    ${ENABLE_FIX_CUSTOM_TASK ? ''
                    // 📋 自定义模式（1.77.0）：用自己的模板处理每条回复。整块由 ENABLE_FIX_CUSTOM_TASK 门控——
                    // 关着时下面一个节点都不渲染（与「旗关 = 与上一版 DOM 全同」的统一语义一致）。
                    // ⚠ 这段说明【必须】留在插值表达式里、写成 JS 注释：写成模板字面量正文里的 <!-- --> 会变成
                    //   一个真的 DOM 注释节点，旗关时 DOM 就不再与 1.76.0 逐字节相同（评审 F5a）。
                    + '<div id="so-fix-custom-wrap">'
                    + '<button type="button" id="so-fixc-run" class="so-fix-run-btn"><i class="fa-solid fa-clipboard-list"></i> 用模板处理最新回复</button>'
                    + '<label class="so-check so-lb-check"><input id="so-fixc-auto" type="checkbox"><span>每条新回复自动运行模板</span></label>'
                    + '<div class="so-fix-targets-head">模板</div>'
                    + '<div class="so-fix-bundle-row">'
                    // 📋 下拉里除了用户自己的模板，末尾还有一个 optgroup「内置示例」装两份现成的
                    // （populateFixTemplates 填；2026-09-05 产品负责人裁定：示例直接列进下拉，不再有「示例…」按钮）。
                    + '<select id="so-fixc-template" title="已存的模板（全局，跨聊天可用）；末尾「内置示例」两份可直接选用"></select>'
                    + '<button type="button" id="so-fixc-tpl-new" class="so-fix-run-btn">新建…</button>'
                    + '<button type="button" id="so-fixc-tpl-save" class="so-fix-run-btn">保存</button>'
                    + '<button type="button" id="so-fixc-tpl-del" class="so-fix-run-btn">删除</button>'
                    // 🌐 模板广场（1.86.0）：旗关时这里是空串。📤 分享（2026-09-29 起只剩复制分享文本、纯本地）不受旗管。
                    + (ENABLE_FIX_TEMPLATE_HUB ? '<button type="button" id="so-fixc-hub" class="so-fix-run-btn" title="浏览、下载大家分享的模板">🌐 广场</button>' : '')
                    + '<button type="button" id="so-fixc-share" class="so-fix-run-btn" title="复制分享文本，发到神谕 Discord 的模板分享频道">📤 分享</button>'
                    + '</div>'
                    // 「未保存」标记：fixTplDirty 的唯一可视化（updateFixTplDirtyMarker 是唯一写它的地方）。
                    // 默认 hidden——旗关时这一整段本就不渲染，旗开而不脏时它也不占视觉。
                    + '<span id="so-fixc-dirty" class="so-hint" hidden>未保存</span>'
                    + '<textarea id="so-fixc-prompt" rows="6" placeholder="只写你要它做的事（例：把正文完整翻译成日文）。输出格式与保留标记由剧情推进自动附上。"></textarea>'
                    + '<label class="so-check so-lb-check"><input id="so-fixc-mech" type="checkbox"><span>沿用校正的正文识别</span></label>'
                    + '<div class="so-hint">开：只处理剧情正文，状态栏、变量块等原样保留。关：整条回复交给模板，输出原样替换。</div>'
                    + '<div class="so-fix-targets-head">保留区 / 丢弃区（本档自己的）</div>'
                    // 标签写法提示（1.77.0 UI 二波）：自动面板把同一句追加在它那段长说明末尾，这里因为没有那段
                    // 说明，单独起一行 so-hint 放在两个 textarea 之上。
                    + '<div class="so-hint">标签写法：&lt;thinking&gt; 或 thinking 都行，不用写闭合标签；方括号块写 [IMG_GEN]；同一标签两边都填按保留处理。</div>'
                    + '<textarea id="so-fixc-keep" rows="3" placeholder="保留区标签：每行一个，只写开标签或名字即可——例如 <status> 或 status（不用写 </status>）；方括号块写 [IMG_GEN]"></textarea>'
                    + '<textarea id="so-fixc-drop" rows="3" placeholder="丢弃区标签：每行一个，只写开标签或名字即可——例如 <thinking>（不用写 </thinking>）；方括号块写 [IMG_GEN]。命中的块直接删掉、不放回"></textarea>'
                    + '<div id="so-fixc-warnings" class="so-hint" hidden></div>'
                    + '<label class="so-check so-lb-check"><input id="so-fixc-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>'
                    + '<label class="so-check so-lb-check"><span>最少字数（更短的回复不处理）</span>&nbsp;<input id="so-fixc-minchars" type="number" min="50" max="2000" style="width:72px;"></label>'
                    + '</div>' : ''}
                </div>
            </details>
        </div>

        <div id="so-bld-bar">
            <details class="so-mode-collapse" id="so-bld-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-masks-theater"></i><span>角色工坊</span></summary>
                <div class="so-mode-collapse-body">
                    <label class="so-check so-lb-check"><span>打造目标</span>&nbsp;<select id="so-bld-target" title="用户角色 = 写进 Persona（抢话:AI 也扮演你 / 不抢话:AI 只回应你）；NPC = 写进世界书条目"></select></label>
                    <div class="so-bld-chips-row"><span class="so-bld-chips-label">草稿包含：<button type="button" id="so-bld-chips-help" title="每个部分是什么？点开看说明">?</button></span><div id="so-bld-chips"></div></div>
                    <div id="so-bld-chips-legend" style="display:none"></div>
                    <details class="so-lb-books"><summary id="so-bld-bookpick-sum">世界书：当前激活的</summary><div class="so-lb-bookpick-tools"><button type="button" class="so-lb-mini" id="so-bld-books-active" title="清空选择、回到「跟随当前所有激活的世界书」">用当前激活的</button></div><input type="text" id="so-bld-book-filter" class="so-lb-book-filter" placeholder="筛选世界书（名称）…"><div id="so-bld-book-list"></div><div id="so-bld-book-empty" class="so-lb-book-empty" hidden>（没有匹配的世界书）</div></details>
                    <details class="so-lb-books"><summary id="so-bld-entries-sum">条目：全部发送</summary>
                        <div class="so-lb-entries-tools"><button type="button" class="so-lb-mini" id="so-bld-ent-all">全选</button><button type="button" class="so-lb-mini" id="so-bld-ent-none">全不选</button><button type="button" class="so-lb-mini" id="so-bld-ent-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在搜索框输入关键词）">全选筛选</button><button type="button" class="so-lb-mini so-lb-mini-blue" id="so-bld-ent-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button><button type="button" class="so-lb-mini so-lb-mini-green" id="so-bld-ent-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button><input id="so-bld-ent-filter" type="text" placeholder="搜索条目…"></div>
                        <div id="so-bld-entry-list"></div>
                    </details>
                    <label class="so-check so-lb-check"><span>上下文深度</span>&nbsp;<input id="so-bld-depth" type="number" min="0" step="10" style="width:5em">&nbsp;<label class="so-check"><input id="so-bld-depth-all" type="checkbox"><span>全部</span></label></label>
                    <label class="so-check so-lb-check"><input id="so-bld-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                    <label class="so-check so-lb-check"><input id="so-bld-stat" type="checkbox"><span>带上状态栏数据（stat_data）</span></label>
                    <label class="so-check so-lb-check"><input id="so-bld-scanwi" type="checkbox"><span>关键词触发世界书（把聊天与访谈里提到的设定条目作参考补充）</span></label>
                    <label class="so-check so-lb-check" title="锻造时把台词写得更丰满自然——每句都是当面说出口的完整人话，保留角色个性与说话习惯（话少的角色照旧话少，但开口的句子完整）。各家模型都验证过；不改条数与结构。"><input id="so-bld-dlgrich" type="checkbox"><span>台词丰满（锻造台词写成完整人话）</span></label>
                    <label class="so-check so-lb-check"><span>锻造回复上限</span>&nbsp;<input id="so-bld-maxtok" type="number" min="0" step="1024" style="width:6em" placeholder="自动·16384" title="锻造调用的 max_tokens 下限自动为 16384；超大世界书导致思考+成稿被截断时可调高。注意：超过服务商单次输出上限会被直接拒绝——报错就调回来。留空 = 自动。"></label>
                    <label class="so-check so-lb-check" title="勾选后，访谈对话走你在设置面板策展的预设（文本块保留、RP标记去除，工坊指令注入历史位）。锻造调用不受影响——始终使用内置锻造工序。"><input id="so-bld-preset" type="checkbox"><span>用自定义预设（设置面板所选）</span></label>
                    <label class="so-check so-lb-check" id="so-bld-autocond-row" title="锻造成功后自动跑一遍「✂️ 精简」（拆长句、删跨节重复；守卫不过=原稿原样保留）。只在 NPC 草稿、且原稿明显冗长时触发——本就精炼的稿子不会白花调用。强输出模型（如 Claude）建议开。"><input id="so-bld-autocond" type="checkbox"><span>锻造后自动精简</span></label>
                    <div class="so-hint" id="so-bld-condinfo" style="margin:4px 0">✂️✂️ 深度精简仅适合 <b>Opus 类</b>模型（DeepSeek / Gemini 的锻造稿本就精炼，收益不大）；会分多次流式调用，通常要等上几分钟才跑完。</div>
                    <div id="so-bld-card" style="display:none"></div>
                </div>
            </details>
        </div>

        <div id="so-lb-bar">
            <details class="so-mode-collapse" id="so-lb-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-book"></i><span>世界书设置</span></summary>
                <div class="so-mode-collapse-body">
            <div class="so-lb-row">
                <i class="fa-solid fa-book so-lb-icon"></i>
                <details id="so-lb-bookpick" class="so-lb-bookpick">
                    <summary id="so-lb-bookpick-sum" title="选择要聊 / 编辑的世界书（可多选；不选＝当前激活的全部）">全部激活的世界书</summary>
                    <div class="so-lb-bookpick-tools">
                        <button type="button" class="so-lb-mini" id="so-lb-book-all">全选</button>
                        <button type="button" class="so-lb-mini" id="so-lb-book-none">全不选（＝全部激活）</button>
                    </div>
                    <input type="text" id="so-lb-book-filter" class="so-lb-book-filter" placeholder="筛选世界书（名称）…">
                    <div id="so-lb-book-list" class="so-lb-book-list"></div>
                    <div id="so-lb-book-empty" class="so-lb-book-empty" hidden>（没有匹配的世界书）</div>
                </details>
                <div class="so-iconbtn" id="so-lb-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
            </div>
            <label class="so-check so-lb-check"><input id="so-lb-story" type="checkbox"><span>同时带上最近剧情对话</span></label>
            <label class="so-check so-lb-check"><input id="so-lb-preset" type="checkbox"><span>套用我的补全预设（指令叠加其上）</span></label>
            <div class="so-hint so-lb-preset-warn">⚠ 勾选后，世界书管家指令会叠加在你选定的补全预设之上（用于越狱）。预设内容会分散模型注意力、可能影响编辑精度——仅在确实需要越狱时才勾选。</div>
            <div id="so-lb-entries" class="so-lb-entries">
                <div class="so-lb-entries-head">
                    <span id="so-lb-entries-summary">条目：全部</span>
                    <div class="so-iconbtn so-lb-ent-toggle" id="so-lb-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                </div>
                <div class="so-lb-entries-tools">
                    <button type="button" class="so-lb-mini" id="so-lb-all">全选</button>
                    <button type="button" class="so-lb-mini" id="so-lb-none">全不选</button>
                    <button type="button" class="so-lb-mini" id="so-lb-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                    <button type="button" class="so-lb-mini so-lb-mini-blue" id="so-lb-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-green" id="so-lb-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                    <button type="button" class="so-lb-mini so-lb-mini-off" id="so-lb-disabled" title="只选已禁用条目">仅禁用</button>
                    <button type="button" class="so-lb-mini so-lb-mini-eye" id="so-lb-preview-toggle" title="显示 / 隐藏每条条目的内容预览">👁 内容预览</button>
                </div>
                <input type="text" id="so-lb-entries-filter" class="so-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                <div id="so-lb-entries-list" class="so-lb-entries-list"></div>
            </div>
            <div class="so-hint" id="so-lb-hint"></div>
                </div>
            </details>
        </div>

        <div id="so-adv-bar">
            <details class="so-mode-collapse" id="so-adv-collapse" open>
                <summary class="so-mode-collapse-sum"><i class="fa-solid fa-compass"></i><span>参谋设置</span></summary>
                <div class="so-mode-collapse-body">
            <label class="so-check so-adv-check"><input id="so-adv-preset" type="checkbox"><span>套用我的补全预设（参谋指令叠加其上）</span></label>
            <div class="so-hint so-adv-preset-warn">⚠ 仅在确实需要预设里的越狱时才勾选：预设的额外内容会分散模型注意力。未整理过预设时勾它不报错，会自动退回内置参谋提示词。</div>
            <label class="so-field so-adv-field"><span>剧情引导注入深度（方案指令插入主聊天的深度）——模型不听引导时调低，最低 0</span>
                <input id="so-adv-depth" type="number" step="1" min="0">
            </label>
            <div class="so-adv-field"><span>剧情脉络里，后面节点的详细什么时候写</span>
                <div class="so-seg" id="so-adv-detail-seg"><button type="button" data-v="all">一次写全</button><button type="button" data-v="later">到了再写</button></div>
            </div>
            <div class="so-hint" id="so-adv-detail-hint"></div>
                </div>
            </details>
        </div>

        <div id="so-plan-bar">
            <div class="so-plan-head">
                <i class="fa-solid fa-compass so-plan-icon"></i>
                <span class="so-plan-label" id="so-plan-label">引导中</span>
                <span id="so-plan-goal"></span>
                <button type="button" class="so-plan-collapse-btn" id="so-plan-collapse" title="收起 / 展开引导条"><i class="fa-solid fa-chevron-up"></i></button>
            </div>
            <div class="so-plan-intensity" id="so-plan-intensity"></div>
            <div class="so-hint" id="so-plan-caption"></div>
            <div class="so-plan-actions">
                <button type="button" class="so-plan-mini" id="so-plan-show">▸ 查看注入内容</button>
                <button type="button" class="so-plan-mini" id="so-plan-edit" title="修改当前目标"><i class="fa-solid fa-pencil"></i></button>
                <button type="button" class="so-plan-mini" id="so-plan-pause" title="暂停引导：主聊天先不注入，进度都保留，随时继续"><i class="fa-solid fa-pause"></i> 暂停</button>
                <span class="so-plan-spacer"></span>
                <button type="button" class="so-plan-mini so-plan-done" id="so-plan-done" title="目标已达成，停止引导">完成</button>
                <button type="button" class="so-plan-mini" id="so-seq-sendback" title="回参谋房继续聊——当前目标照常引导着，聊好可以只重排剩下的部分">💬 找参谋改改</button>
                <button type="button" class="so-plan-mini so-plan-drop" id="so-plan-drop" title="不再需要，停止引导">放弃</button>
            </div>
            <pre id="so-plan-directive"></pre>
            <div id="so-seq-list"></div>
        </div>

        <div id="so-messages"></div>

        <div id="so-model-bar"></div>
        <div id="so-footer">
            <textarea id="so-input" rows="2" placeholder="就当前剧情提问…（Enter 发送，Shift+Enter 换行）"></textarea>
            <div class="so-iconbtn" id="so-send" title="发送"><i class="fa-solid fa-paper-plane"></i></div>
        </div>

        <div id="so-debug">
            <div id="so-debug-head">
                <span><i class="fa-solid fa-bug"></i> 上一次发送的提示词 <span id="so-debug-meta"></span></span>
                <div style="display:flex;gap:2px;">
                    <div class="so-iconbtn" id="so-debug-copy" title="复制完整提示词"><i class="fa-solid fa-copy"></i></div>
                    <div class="so-iconbtn" id="so-debug-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <pre id="so-debug-body"></pre>
        </div>

        <div id="so-summary">
            <div id="so-summary-head">
                <span><i class="fa-solid fa-scroll"></i> 剧情概要（本聊天）</span>
                <div style="display:flex;gap:2px;">
                    <div class="so-iconbtn" id="so-summary-clear" title="清空概要"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="so-iconbtn" id="so-summary-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div id="so-summary-sub">粘贴你的运行总结 / 前情提要（比如存在补全预设或别处、剧情推进本来读不到的剧情梗概）。它随【本聊天】保存，并在【普通聊天】与【剧情参谋】模式下插入到最近对话记录的正前方。留空即不启用。</div>
            <textarea id="so-summary-text" placeholder="在此粘贴剧情概要 / 前情提要…"></textarea>
            <div id="so-summary-foot"><span id="so-summary-count"></span></div>
        </div>

        <div id="so-autowarn">
            <div id="so-autowarn-card">
                <div id="so-autowarn-head"><span class="so-warn-title"><i class="fa-solid fa-triangle-exclamation"></i> 开启自动诊断模式？</span><div class="so-iconbtn so-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>
                <div id="so-autowarn-body">
                    <p>开启后，每当主聊天收到一条新的 AI 回复，剧情推进都会在后台自动处理它的 MVU 变量，并<strong>自动应用</strong>（无需点击确认，每次都会弹出可撤销提示；窗口关着也照常工作）：</p>
                    <p>· 回复里<strong>带有</strong> &lt;UpdateVariable&gt; 更新 → 核验并修正它；<br>· 回复里<strong>没有</strong>更新区块 → 直接据剧情<strong>推导</strong>出本回合应有的变量更新并补上。</p>
                    <p>因此它既能<strong>替代</strong> MVU 的「额外模型解析」，也能在需要时与它配合：外部解析成功后做核验，外部解析失败 / 没有写出有效更新块时接手推导。</p>
                    <p class="so-autowarn-danger">⚠ 若要与「额外模型解析」<strong>同时</strong>使用，请在诊断设置里勾选「⏳ 兼容 MVU『额外模型解析』」。兼容开关会识别完整重试批次并在写入前协调自动校正；不勾时仍按普通自动诊断时序运行，可能与外部解析抢写。</p>
                    <p class="so-autowarn-note">自动模式每条回复都会多发一次模型请求，会额外消耗 token。</p>
                </div>
                <label class="so-autowarn-check"><input type="checkbox" id="so-autowarn-never"><span>不再提示</span></label>
                <div id="so-autowarn-btns">
                    <button type="button" id="so-autowarn-cancel">取消</button>
                    <button type="button" id="so-autowarn-ok">开启自动模式</button>
                </div>
            </div>
        </div>

        <div id="so-fixwarn">
            <div id="so-fixwarn-card">
                <div id="so-fixwarn-head"><span class="so-warn-title"><i class="fa-solid fa-circle-info"></i> ✨ 自动校正：一键去 AI 味</span><div class="so-iconbtn so-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>
                <div id="so-fixwarn-body">
                    <p>「自动校正」会把回复里的<strong>故事正文</strong>重写得更像人写的——去 AI 八股 / 套话、让对白自然、收紧读感——并作为<strong>新的一条 swipe</strong> 放进来：原回复永远留在左滑，随时能滑回去，<strong>不破坏存档</strong>。</p>
                    <p class="so-autowarn-danger"><strong>常见的卡片格式会自动识别</strong>：正文在哪、状态栏 / 选项菜单 / 面板 / 图生指令这些结构块该原样保留，通常不用你设置；认不准时它会<strong>问你一次</strong>（面板出现「✋ 需要确认」点一下就好）。</p>
                    <p>格式特别的卡可能有漏网。遇到识别不对：打开「进阶设置」可以看到<strong>这条回复实际识别到了哪些结构块</strong>，没认出的块点一下（或手动填）加进保留区就行；也欢迎<strong>把那条回复原文在 Discord 私信发给作者 @Prince</strong>——这种格式会加进测试集，之后的版本就能自动认出。</p>
                    <p>面板顶部的<strong>判定行</strong>随时告诉你：最新这条回复会被怎么处理（校正哪几段、保留多少块、还是跳过）。</p>
                    <p>校正只改文字表达：<strong>不</strong>翻译、<strong>不</strong>改设定、<strong>不</strong>算数值、<strong>不</strong>修卡片本身的问题。</p>
                    <p class="so-autowarn-note">成本：开「每条新回复自动去 AI 味」后每条回复多发一次模型请求；很短 / 很干净的回复自动跳过。只想偶尔用，就用「按目标给最新回复去 AI 味」，点一次跑一次。</p>
                </div>
                <label class="so-autowarn-check"><input type="checkbox" id="so-fixwarn-never"><span>不再提示</span></label>
                <div id="so-fixwarn-btns">
                    <button type="button" id="so-fixwarn-ok">知道了</button>
                </div>
            </div>
        </div>
        <div id="so-resize-grip" title="拖动调整大小" aria-label="调整窗口大小"></div>
    `;
    document.body.appendChild(sharedState.win);

    sharedState.messagesEl = sharedState.win.querySelector('#so-messages');
    sharedState.inputEl = sharedState.win.querySelector('#so-input');
    sharedState.sendBtn = sharedState.win.querySelector('#so-send');
    sharedState.modeBadge = sharedState.win.querySelector('#so-mode-badge');

    bindControls();
    enhanceIconButtonA11y();
    loadSettingsIntoForm();
    sharedState.planBarEl = sharedState.win.querySelector('#so-plan-bar');
    // 手机：整条标题栏（含 8 个按钮）都能起拖——按钮太多、留给拖动的空隙太少（用户反馈「手机拖不动」）。
    // 复用折叠药丸那套（1.17.5）：dragFromButtons 放行「在按钮上起拖」，再用 6px 位移阈值区分轻点/拖动，
    // suppressNextClick 吞掉拖完补发的一下 click，所以轻点按钮照常触发、拖动才移动窗口。桌面（≥600）不传、行为不变。
    makeDraggable(sharedState.win, sharedState.win.querySelector('#so-header'), { left: 'winLeft', top: 'winTop' },
        { dragFromButtons: () => window.innerWidth < 600 });
    makeResizable(sharedState.win, sharedState.win.querySelector('#so-resize-grip'));
    renderEmptyState();
    renderPlanBar();
}

// 无障碍：图标按钮本是 <div>（为了样式自由），这里补上原生 <button> 该有的语义与键盘操作——
// role=button + 可聚焦（tabindex）+ Enter/空格触发，并把每个按钮已有的 title 复用为屏幕阅读器
// 的可读名（aria-label）。这样整套图标工具栏对键盘 / 读屏用户也完全可用，且无需改动任何模板标记。
function enhanceIconButtonA11y() {
    sharedState.win.querySelectorAll('.so-iconbtn').forEach(enhanceIconBtnNode);
    // 委托键盘事件：聚焦某个图标按钮时按 Enter / 空格即等同点击（原生 <button> 的默认行为）。
    // 输入框 / 文本域里的按键不会命中（closest 找不到 .so-iconbtn），故不影响打字与「Enter 发送」。
    sharedState.win.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const btn = e.target.closest && e.target.closest('.so-iconbtn');
        if (!btn || !sharedState.win.contains(btn)) return;
        e.preventDefault();
        btn.click();
    });
}

// 单个图标按钮的语义补齐（幂等）。抽成独立函数是因为【动态建卡】的图标按钮
// 赶不上 buildWindow 那一趟批量增强，而 enhanceIconButtonA11y 整体【不可】重复调用——
// 它每次还会往 win 上再挂一只委托 keydown，重复挂 = 按一下 Enter 触发两次 click。
// 委托本身挂在 win 上、动态卡片又都追加在 win 内部 → 单独补上 tabindex 就能被聚焦，Enter/空格照常生效。
export function enhanceIconBtnNode(b) {
    if (!b) return;
    b.setAttribute('role', 'button');
    if (!b.hasAttribute('tabindex')) b.setAttribute('tabindex', '0');
    if (!b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title);
}

function bindControls() {
    const s = getSettings();

    sharedState.win.querySelector('#so-close-btn').addEventListener('click', () => toggleWindow(false));
    sharedState.win.querySelector('#so-fullscreen-btn').addEventListener('click', () => setFullscreen());   // 全屏阅读切换（1.51.0）
    document.addEventListener('keydown', onFullscreenEscKeydown, true);   // 全屏时 ESC 退出（捕获阶段，gated on 全屏）
    sharedState.win.querySelector('#so-clear-btn').addEventListener('click', clearConversation);
    sharedState.win.querySelector('#so-diagnose-btn').addEventListener('click', toggleDiagnose);
    sharedState.win.querySelector('#so-lorebook-btn').addEventListener('click', toggleLorebook);
    sharedState.win.querySelector('#so-advisor-btn').addEventListener('click', toggleAdvisor);
    sharedState.win.querySelector('#so-fix-btn').addEventListener('click', toggleFix);
    sharedState.win.querySelector('#so-adv-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.advisorUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：剧情参谋指令会叠加在你的补全预设之上。注意预设可能分散模型注意力——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，参谋模式仍用内置提示词。');
        }
    });
    // Live depth change re-registers the active injection — wired AFTER the
    // generic bind() below so the new value is already persisted when it runs.
    sharedState.win.querySelector('#so-plan-show').addEventListener('click', () => {
        // Query through planBarEl, not win — the strip may have been reparented
        // into the floating container by the time this fires.
        const pre = sharedState.planBarEl.querySelector('#so-plan-directive');
        const open = pre.classList.toggle('open');
        sharedState.planBarEl.querySelector('#so-plan-show').textContent = open ? '▾ 收起注入内容' : '▸ 查看注入内容';
        if (open) pre.textContent = currentInjectionPreview();   // type-aware (sequence beat OR single plan)
    });
    // 引导条收起 / 展开箭头（用户反馈：停靠时默认收起、别挡聊天视图）。状态持久化；renderPlanBar 也同步。
    sharedState.win.querySelector('#so-plan-collapse').addEventListener('click', () => {
        const s = getSettings();
        s.planBarCollapsed = !s.planBarCollapsed;
        save();
        syncPlanBarCollapsed();
    });
    // ✏️ 修改当前目标（2.5.0）：在方案条的列表里就地编辑当前节点。
    sharedState.win.querySelector('#so-plan-edit').addEventListener('click', () => {
        const path = getPath();
        const node = pathActiveNode(path);
        if (node) startPathEdit(node.id);
    });
    /* 点击窗外自动收起（1.48.0，opt-in clickOutsideClose）。监听 click 而非 pointerdown：
     * 滚屏滑动、长按选字都不产生 click；再加
     * 「有选区不收」保险。capture 阶段注册：别人 stopPropagation 也拦不住我们看见这次点击。
     * 排除面 = 一切 so- 前缀元素（本扩展全部选择器按约定带 so- 前缀，含浮条/toast/🌙）
     * + ST 弹窗 + 魔杖菜单（不排除会出现「点菜单先关窗、点菜单项又开窗」的双开关打架）。 */
    document.addEventListener('click', onDocClickOutside, true);
    sharedState.win.querySelector('#so-plan-done').addEventListener('click', () => pathComplete());
    sharedState.win.querySelector('#so-plan-pause').addEventListener('click', () => toggleGuidePause());
    sharedState.win.querySelector('#so-plan-drop').addEventListener('click', () => { void pathAbandon(); });
    // 「找参谋改改」：开参谋房继续讨论（当前目标照常引导着）。
    sharedState.win.querySelector('#so-seq-sendback').addEventListener('click', () => pathSendBack());
    sharedState.win.querySelector('#so-lb-refresh').addEventListener('click', () => populateLorebookBooks(true));
    sharedState.win.querySelector('#so-lb-book-list').addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) onLbBookSelectionChange();
    });
    sharedState.win.querySelector('#so-lb-book-all').addEventListener('click', () => {
        sharedState.win.querySelectorAll('#so-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = true; });
        onLbBookSelectionChange();
    });
    sharedState.win.querySelector('#so-lb-book-none').addEventListener('click', () => {
        sharedState.win.querySelectorAll('#so-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = false; });
        onLbBookSelectionChange();
    });
    sharedState.win.querySelector('#so-lb-story').addEventListener('change', (e) => {
        getSettings().lorebookIncludeStory = e.target.checked;
        save();
    });
    sharedState.win.querySelector('#so-lb-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.lorebookUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：世界书管家指令会叠加在你的补全预设之上。注意预设可能分散模型注意力、影响编辑精度——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，世界书模式仍用内置管家提示词。');
        }
    });
    sharedState.win.querySelector('#so-lb-entries-toggle').addEventListener('click', () => {
        sharedState.win.querySelector('#so-lb-entries').classList.toggle('open');
    });
    // 手机上把模式工具栏（各模式的配置栏）默认折叠，先把聊天区露出来；桌面保持展开。用户随后可自行开合。
    // 参谋 / 工坊此前漏在名单外：#so-messages 是 flex:1 1 0（basis 0 → 负剩余空间时收缩权重为 0），
    // 配置栏一旦比可用高度还高，被压没的就是聊天区。工坊锻造成功后仍会主动展开该面板（见 runForge）。
    if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
        sharedState.win.querySelectorAll('#so-lb-collapse, #so-diag-collapse, #so-fix-collapse, #so-adv-collapse, #so-bld-collapse')
            .forEach((d) => { d.open = false; });
    }
    sharedState.win.querySelector('#so-lb-all').addEventListener('click', () => setAllLbEntries(true));
    sharedState.win.querySelector('#so-lb-none').addEventListener('click', () => setAllLbEntries(false));
    sharedState.win.querySelector('#so-lb-filtered').addEventListener('click', () => selectFilteredLbEntries());
    sharedState.win.querySelector('#so-lb-blue').addEventListener('click', () => setLbEntriesByType('blue'));
    sharedState.win.querySelector('#so-lb-green').addEventListener('click', () => setLbEntriesByType('green'));
    sharedState.win.querySelector('#so-lb-disabled').addEventListener('click', () => setLbEntriesByType('off'));
    sharedState.win.querySelector('#so-lb-preview-toggle').addEventListener('click', () => toggleLbPreview());
    sharedState.win.querySelector('#so-lb-entries-filter').addEventListener('input', (e) => filterBookEntries('#so-lb-entries-list', e.target.value, updateLbFilteredBtn));
    sharedState.win.querySelector('#so-lb-book-filter').addEventListener('input', (e) => filterLbBooks(e.target.value));
    // 世界书「智能选条」🪄 入口（ENABLE_LB_SMART_SELECT）：创建门——关时按钮从不创建、字节级零变化。
    // 弹出输入框走懒建 overlay（openSmartSelect），不占选择器常驻空间（1.49.0 搜索框教训：picker 已很挤）。
    if (ENABLE_LB_SMART_SELECT) {
        const tools = sharedState.win.querySelector('#so-lb-entries .so-lb-entries-tools');   // 📖 那条工具栏（class 有三处：诊断/工坊/世界书）
        if (tools && !tools.querySelector('#so-lb-smart')) {
            const b = document.createElement('button');
            b.type = 'button';
            b.id = 'so-lb-smart';
            b.className = 'so-lb-mini so-lb-mini-magic';
            b.title = '智能选条：用一句话让 AI 帮你勾选 / 取消条目（只动勾选、可一键还原）';
            b.textContent = '🪄 智能选条';
            b.addEventListener('click', () => openSmartSelect());
            tools.insertBefore(b, tools.firstChild);
        }
    }
    // 🎛 变量编辑器入口（ENABLE_MVU_EDITOR）。关时模板里就没有这个按钮 → querySelector 为 null，
    // 布线守卫与模板守卫同源，两处一起 no-op = 字节级零变化（同 ENABLE_DIAG_BODY_INJECT 的 bind 写法）。
    if (ENABLE_MVU_EDITOR) {
        const mvuedBtn = sharedState.win.querySelector('#so-mvued-btn');
        if (mvuedBtn) mvuedBtn.addEventListener('click', () => { openMvuEditor(); });
    }
    // 🩺 1.89.0：存档检查按钮（按一次就查一次，结果进诊断记录）。
    if (ENABLE_SCHEMA_DIAG) {
        const hb = sharedState.win.querySelector('#so-diag-health-btn');
        if (hb) hb.addEventListener('click', () => { maybeRunSaveHealth('button'); });
    }
    // 诊断经自定义补全预设（1.43.0，opt-in）——全局开关，同 advisorUsePreset 写法（写 getSettings + save）。
    sharedState.win.querySelector('#so-diag-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.diagnoseUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：诊断指令会叠加在你的补全预设之上（手动诊断与自动诊断都生效）。注意预设可能分散模型注意力、影响诊断精度——仅在诊断被模型拒绝时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，诊断仍用内置提示词。');
        }
    });
    // 🩺 1.89.0：「被拒时让模型自动重写一次」（全局开关，写 getSettings + save）。
    if (ENABLE_SCHEMA_DIAG) {
        const sr = sharedState.win.querySelector('#so-diag-schema-retry');
        if (sr) sr.addEventListener('change', (e) => { getSettings().diagSchemaRetry = e.target.checked; save(); });
    }
    // 诊断「精选世界书条目」绑定（用户功能请求；ENABLE_DIAG_WI_PICKER）。关掉时隐藏那一段、不挂任何处理器。
    if (ENABLE_DIAG_WI_PICKER) {
        sharedState.win.querySelector('#so-diag-usesel').addEventListener('change', (e) => onDiagUseSelToggle(e.target.checked));
        sharedState.win.querySelector('#so-diag-hybrid').addEventListener('change', (e) => onDiagHybridToggle(e.target.checked));
        sharedState.win.querySelector('#so-diag-refresh').addEventListener('click', () => populateDiagWiBooks(true));
        sharedState.win.querySelector('#so-diag-book').addEventListener('change', (e) => {
            const meta = getDiagWiMeta();
            setDiagWiMeta({ use: meta.use, hybrid: meta.hybrid, target: e.target.value, sel: serializeDiagSel(sharedState.diagEntrySel) });
            updateDiagHint();
            populateDiagWiEntries();
        });
        sharedState.win.querySelector('#so-diag-entries-toggle').addEventListener('click', () => {
            sharedState.win.querySelector('#so-diag-entries').classList.toggle('open');
        });
        sharedState.win.querySelector('#so-diag-all').addEventListener('click', () => setAllDiagEntries(true));
        sharedState.win.querySelector('#so-diag-none').addEventListener('click', () => setAllDiagEntries(false));
        sharedState.win.querySelector('#so-diag-filtered').addEventListener('click', () => selectFilteredDiagEntries());
        sharedState.win.querySelector('#so-diag-blue').addEventListener('click', () => setDiagEntriesByType('blue'));
        sharedState.win.querySelector('#so-diag-green').addEventListener('click', () => setDiagEntriesByType('green'));
        sharedState.win.querySelector('#so-diag-disabled').addEventListener('click', () => setDiagEntriesByType('off'));
        sharedState.win.querySelector('#so-diag-entries-filter').addEventListener('input', (e) => filterBookEntries('#so-diag-entries-list', e.target.value, updateDiagFilteredBtn));
    } else {
        // 只隐藏精选条目那一段 —— 预设行与它无关，不该被这个杀开关带走（1.43.0）
        const wisel = sharedState.win.querySelector('#so-diag-wisel');
        if (wisel) wisel.style.display = 'none';
    }
    // 🌐 世界书范围「自定义」绑定（1.81.0；旗关时 markup 不存在、整块不执行）。
    if (ENABLE_WI_CUSTOM_PICK) {
        sharedState.win.querySelector('#so-wic-hybrid').addEventListener('change', (e) => {
            const meta = getWiCustomMeta();
            if (!meta) { e.target.checked = false; return; }
            setWiCustomMeta({ books: meta.books, hybrid: e.target.checked, sel: meta.sel });
        });
        sharedState.win.querySelector('#so-wic-refresh').addEventListener('click', () => populateWiCustomBooks(true));
        sharedState.win.querySelector('#so-wic-book-all').addEventListener('click', () => setAllWiCustomBooks(true));
        sharedState.win.querySelector('#so-wic-book-none').addEventListener('click', () => setAllWiCustomBooks(false));
        sharedState.win.querySelector('#so-wic-book-filter').addEventListener('input', (e) => filterWiCustomBooks(e.target.value));
        sharedState.win.querySelector('#so-wic-entries-toggle').addEventListener('click', () => sharedState.win.querySelector('#so-wic-entries').classList.toggle('open'));
        sharedState.win.querySelector('#so-wic-all').addEventListener('click', () => setAllWiCustomEntries(true));
        sharedState.win.querySelector('#so-wic-none').addEventListener('click', () => setAllWiCustomEntries(false));
        sharedState.win.querySelector('#so-wic-filtered').addEventListener('click', () => selectFilteredWiCustomEntries());
        sharedState.win.querySelector('#so-wic-blue').addEventListener('click', () => setWiCustomEntriesByType('blue'));
        sharedState.win.querySelector('#so-wic-green').addEventListener('click', () => setWiCustomEntriesByType('green'));
        sharedState.win.querySelector('#so-wic-disabled').addEventListener('click', () => setWiCustomEntriesByType('off'));
        sharedState.win.querySelector('#so-wic-entries-filter').addEventListener('input', (e) => filterBookEntries('#so-wic-entries-list', e.target.value, updateWiCustomFilteredBtn));
    }
    // 标题栏「⋯」工具下拉：把 剧情概要 / 调试 / 设置 三个次级按钮收进一个下拉里。它们的 id 与各自
    // 的点击处理保持不变（只是被挪进菜单内），所以下面 openDebug / 设置开关 / openSummary 的绑定照旧生效。
    const toolsBtn = sharedState.win.querySelector('#so-tools-btn');
    const toolsMenu = sharedState.win.querySelector('#so-tools-menu');
    const closeToolsMenu = () => {
        if (!toolsMenu) return;
        toolsMenu.classList.remove('open');
        if (toolsBtn) toolsBtn.setAttribute('aria-expanded', 'false');
    };
    if (toolsBtn && toolsMenu) {
        toolsBtn.addEventListener('click', () => {
            const open = toolsMenu.classList.toggle('open');
            toolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // 点菜单里的任意一项后收起（该项自己的处理仍会照常触发，打开对应面板 / 设置）。
        toolsMenu.addEventListener('click', (e) => {
            if (e.target.closest('.so-tools-item')) closeToolsMenu();
        });
        // 点别处或按 Esc 收起。
        document.addEventListener('click', (e) => {
            if (toolsMenu.classList.contains('open') && !e.target.closest('.so-tools-wrap')) closeToolsMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && toolsMenu.classList.contains('open')) closeToolsMenu();
        });
    }
    // 「普通聊天」菜单项：从任何模式一键回普通聊天（仅切换视图——自动诊断如开启会继续在后台跑，
    // 诊断按钮仍红；要停自动诊断请点诊断按钮）。菜单收起由上面的 .so-tools-item 监听统一处理。
    sharedState.win.querySelector('#so-normalchat-btn')?.addEventListener('click', async () => {
        // 已在普通聊天 → 无事可做。
        if (currentOracleMode() === 'chat') return;
        if (!(await confirmModeSwitch('chat'))) return;   // 1.36.0 中断确认
        sharedState.priorOracleMode = 'chat';
        setOracleMode('chat');
        modeEntryNote('已返回普通聊天模式。');
    });
    sharedState.win.querySelector('#so-debug-btn').addEventListener('click', openDebug);
    sharedState.win.querySelector('#so-debug-close').addEventListener('click', () => sharedState.win.querySelector('#so-debug').classList.remove('open'));
    sharedState.win.querySelector('#so-debug-copy').addEventListener('click', async () => {
        const btn = sharedState.win.querySelector('#so-debug-copy');
        const ok = await copyTextRobust(sharedState.win.querySelector('#so-debug-body').textContent || '');
        if (ok) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1200);
        } else {
            btn.title = '复制失败 —— 请手动选择文本';
        }
    });
    sharedState.win.querySelector('#so-builder-btn')?.addEventListener('click', toggleBuilder);
    sharedState.win.querySelector('#so-settings-btn').addEventListener('click', () => toggleSettings());
    // 用户功能请求：剧情概要编辑器（本聊天，自动保存到元数据）。
    sharedState.win.querySelector('#so-summary-btn').addEventListener('click', openSummary);
    // 📥📤 导出 / 导入对话（1.60.0 / 1.61.0）：⋯ 工具菜单【不】设入口（Prince 2026-08-09 定案）。
    // 唯二的入口是 AI 气泡行上那对小按钮（见 addMessage）＋ 空页时的空态入口（见 renderEmptyState）。
    sharedState.win.querySelector('#so-summary-close').addEventListener('click', () => sharedState.win.querySelector('#so-summary').classList.remove('open'));
    sharedState.win.querySelector('#so-summary-text').addEventListener('input', (e) => {
        setSummary(e.target.value);
        updateSummaryIndicator(e.target.value);
    });
    sharedState.win.querySelector('#so-summary-clear').addEventListener('click', async () => {
        const ta = sharedState.win.querySelector('#so-summary-text');
        if (ta.value.trim() && !(await uiConfirm('确定清空本聊天的剧情概要吗？'))) return;
        ta.value = '';
        setSummary('');
        updateSummaryIndicator('');
        ta.focus();
    });
    // 用户功能请求：自动诊断首次开启前的一次性警告弹窗。
    const autoWarnOverlay = sharedState.win.querySelector('#so-autowarn');
    const closeAutoWarn = () => autoWarnOverlay.classList.remove('open');
    sharedState.win.querySelector('#so-autowarn-cancel').addEventListener('click', closeAutoWarn);
    sharedState.win.querySelector('#so-autowarn-ok').addEventListener('click', () => {
        if (sharedState.win.querySelector('#so-autowarn-never').checked) { getSettings().autoDiagnoseWarned = true; save(); }
        closeAutoWarn();
        setAutoDiagnose(true);   // 1.65.0：确认后才真开（勾选框在弹窗打开那一刻已被拨回未勾选）
    });
    // 🩺 自动诊断勾选框（1.65.0，取代按钮三态循环的第二下点击）。勾上时若还没看过一次性警告，
    // 先把勾拨回去再弹窗——「确认」走 setAutoDiagnose(true) 才真开，「取消 / ✕ / 点遮罩」什么都不做，
    // 于是取消后 UI 与设置天然一致，不需要在三处关闭路径上各写一遍回滚。
    const autoDiagChk = sharedState.win.querySelector('#so-diag-auto');
    if (autoDiagChk) autoDiagChk.addEventListener('change', () => {
        if (!autoDiagChk.checked) { setAutoDiagnose(false); return; }
        if (!getSettings().autoDiagnoseWarned) { autoDiagChk.checked = false; openAutoDiagWarn(); return; }
        setAutoDiagnose(true);
    });
    // 手机逃生阀：警告叠层 z60 盖住了标题栏 ✕（顶）和缩放把手 z6（角），底部按钮又可能被压出屏——
    // 于是顶部再给一个始终在屏内的 ✕，点遮罩空白处也能关，保证任何视口下都逃得出去（见 style.css 弹窗注释）。
    autoWarnOverlay.querySelector('.so-warn-x').addEventListener('click', closeAutoWarn);
    autoWarnOverlay.addEventListener('click', (e) => { if (e.target === autoWarnOverlay) closeAutoWarn(); });
    // ✨ 校正：切到「自动校正」时的一次性标签块提醒（信息性，无需取消——已经切过去了，只是提醒）。
    const fixWarnOverlay = sharedState.win.querySelector('#so-fixwarn');
    const closeFixWarn = () => fixWarnOverlay.classList.remove('open');
    const fixWarnOk = sharedState.win.querySelector('#so-fixwarn-ok');
    if (fixWarnOk) fixWarnOk.addEventListener('click', () => {
        if (sharedState.win.querySelector('#so-fixwarn-never').checked) { getSettings().autoFixWarned = true; save(); }
        closeFixWarn();
    });
    // 同款手机逃生阀（顶部 ✕ + 点遮罩关闭）。
    fixWarnOverlay.querySelector('.so-warn-x').addEventListener('click', closeFixWarn);
    fixWarnOverlay.addEventListener('click', (e) => { if (e.target === fixWarnOverlay) closeFixWarn(); });
    sharedState.win.querySelector('#so-profile-refresh').addEventListener('click', refreshProfiles);
    sharedState.win.querySelector('#so-extraparams-btn').addEventListener('click', openExtraParams); // 附加参数（1.70.0）
    updateExtraParamsHint(); // 开窗即反映「设了没设」，不用点开弹窗才知道

    // settings inputs -> persist
    const bind = (id, key, parse = (v) => v) => {
        const el = sharedState.win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            s[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
            if (key === 'mode') {
                applyModeVisibility();
                if (s.mode === 'profile') refreshProfiles();
            }
            updateBadge();
            save();
        });
    };
    bind('#so-mode', 'mode');
    bind('#so-endpoint', 'endpoint', (v) => v.trim());
    bind('#so-apikey', 'apiKey', (v) => v.trim());
    bind('#so-model', 'model', (v) => v.trim());
    bind('#so-stream', 'stream');
    bind('#so-direct-backend', 'directViaBackend'); // 1.17.23：经酒馆后端转发（避免直连 CORS）
    bind('#so-raw-url', 'directRawUrl');            // 1.22.0：地址原样使用（不自动补 /v1，原生化自二创「最终模式」）
    // A6：连接存档（端点 + 密钥 + 模型 + 地址原样开关 + 高级选项与生成参数的命名快照）。列表行上有「使用」「删除」，这里只管存新档。
    sharedState.win.querySelector('#so-conn-preset-save').addEventListener('click', async () => {
        const name = sharedState.win.querySelector('#so-conn-preset-name').value.trim();
        if (!name) { if (window.toastr) window.toastr.info('先给存档起个名字', '剧情推进'); return; }
        // 同名会覆盖：先问一句（改了当前存档想存回去，用存档栏下面的「保存到此存档」更顺手）
        const exists = (getSettings().connPresets || []).some((p) => p.name === name);
        if (exists && !(await uiConfirm(`已经有叫「${name}」的存档了，用现在的连接覆盖它吗？`))) return;
        getSettings().connPresets = connPresetUpsert(getSettings().connPresets, {
            ...connPresetSnapshot(getSettings()),
            name,
            endpoint: sharedState.win.querySelector('#so-endpoint').value.trim(),
            apiKey: sharedState.win.querySelector('#so-apikey').value.trim(),
            model: sharedState.win.querySelector('#so-model').value.trim(),
            rawUrl: sharedState.win.querySelector('#so-raw-url').checked,   // 1.22.0：地址原样开关随存档保存
        });
        getSettings().connPresetActive = name;
        save();
        sharedState.win.querySelector('#so-conn-preset-name').value = '';
        renderConnPresets();
        renderModelBar();
    });
    // 连接方式：两段式按钮代替原来的下拉（下拉还在、只是藏起来，走既有 bind 落盘）。
    for (const b of sharedState.win.querySelectorAll('#so-mode-seg [data-mode]')) {
        b.addEventListener('click', () => {
            const sel = sharedState.win.querySelector('#so-mode');
            if (sel.value === b.dataset.mode) return;
            sel.value = b.dataset.mode;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    // 设置分页 + 右上角关闭
    for (const b of sharedState.win.querySelectorAll('.so-set-tab')) b.addEventListener('click', () => setSettingsTab(b.dataset.tab));
    sharedState.win.querySelector('#so-settings-close').addEventListener('click', () => toggleSettings(false));
    // ⚡ 设置「快捷指令」页：新建 / 补回预置的。
    sharedState.win.querySelector('#so-qp-add').addEventListener('click', () => {
        const mode = sharedState.qpManageMode || currentOracleMode();
        getSettings().quickPrompts.push({ id: qpNewId(), mode, label: '新指令', text: '' });
        save();
        renderQpManager();
        const names = sharedState.win.querySelectorAll('#so-qp-list .so-qp-name');
        const last = names[names.length - 1];
        if (last) { last.focus(); last.select(); }
    });
    sharedState.win.querySelector('#so-qp-restore').addEventListener('click', () => {
        const list = getSettings().quickPrompts;
        const missing = QP_DEFAULTS.filter((d) => !list.some((q) => q && q.id === d.id));
        for (const d of missing) list.push({ ...d });
        if (missing.length) { save(); renderQpManager(); renderModelBar(); }
        try { toastr.info(missing.length ? `补回了 ${missing.length} 条预置的快捷指令。` : '预置的快捷指令都还在。', '快捷指令'); } catch (e) { /* ignore */ }
    });
    // 切换栏的菜单、快捷指令列表、设置里的存档弹出框：点别处或按 Esc 收起。
    document.addEventListener('click', (e) => {
        const inside = (sel) => !!(e.target && e.target.closest && e.target.closest(sel));
        if (sharedState.modelMenuOpen && !inside('#so-model-bar')) closeModelMenu();
        if (sharedState.qpMenuOpen && !inside('#so-model-bar')) closeQpMenu();
        // 删存档时弹出的确认框（酒馆的 dialog.popup）也算「里面」：确认完弹出框还开着，可以接着删
        if (sharedState.connPickerOpen && !inside('#so-conn-preset-list, .popup, dialog')) closeConnPicker();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeModelMenu();
        closeQpMenu();
        closeConnPicker();
    });
    // A5：工具移到标题栏开关——开时立刻搬（幂等）；关时提示刷新恢复（⋯ 包裹已删，重建靠 buildWindow）。
    sharedState.win.querySelector('#so-tools-header-toggle').addEventListener('change', (e) => {
        getSettings().toolsInHeader = e.target.checked;
        save();
        if (e.target.checked) applyToolsInHeader();
        else if (window.toastr) window.toastr.info('已关闭——刷新页面后恢复 ⋯ 工具菜单', '剧情推进');
    });
    // 精简版 1.2：快捷回复栏按钮开关——同样立刻放 / 撤。
    sharedState.win.querySelector('#so-qr-toggle').addEventListener('change', (e) => {
        getSettings().showQrButton = e.target.checked;
        save();
        syncQrButton();
    });
    // 用户功能请求：聊天栏快捷按钮开关——改设置后立刻放 / 撤按钮（不只是存）。
    sharedState.win.querySelector('#so-chatbar-toggle').addEventListener('change', (e) => {
        getSettings().showChatBarButton = e.target.checked;
        save();
        syncChatBarButton();
    });
    // 点击窗外自动收起（1.48.0）：只是存设置——监听器常驻，由 onDocClickOutside 每次读设置决定收不收。
    sharedState.win.querySelector('#so-clickout-toggle').addEventListener('change', (e) => {
        getSettings().clickOutsideClose = e.target.checked;
        save();
    });
    // 1.45.0 窗口配色：改完立刻生效，不用刷新（同 #so-chatbar-toggle 的手感）。
    // 不走 bind()：bind 只存值，这里还要 applyWindowSkin 真去换类。
    sharedState.win.querySelector('#so-window-skin').addEventListener('change', (e) => {
        getSettings().windowSkin = e.target.value;
        save();
        applyWindowSkin(getSettings());
    });
    bind('#so-profile', 'profileId');
    bind('#so-temp', 'temperature', (v) => parseFloat(v));
    bind('#so-maxtok', 'maxTokens', (v) => parseInt(v, 10));
    bind('#so-depth', 'contextDepth', (v) => parseInt(v, 10));
    bind('#so-adv-depth', 'advisorDepth', (v) => parseInt(v, 10));
    // After bind() has written the new depth, re-register the active injection —
    // otherwise the setting silently applies only on the next chat switch.
    sharedState.win.querySelector('#so-adv-depth').addEventListener('input', () => applyPlanInjection());
    // 剧情脉络：后面节点的详细什么时候写（一次写全 / 到了再写）。改成「到了再写」时，当前节点还没详细就顺手请参谋写。
    sharedState.win.querySelectorAll('#so-adv-detail-seg [data-v]').forEach((b) => b.addEventListener('click', () => {
        getSettings().advisorNodeDetail = b.dataset.v;
        save();
        syncNodeDetailSeg();
        const path = getPath();
        if (path) { maybeWritePathDetail(path); renderPlanBar(); }
    }));
    bind('#so-card', 'includeCard');
    bind('#so-stat', 'chatIncludeStat');
    bind('#so-world', 'chatIncludeWorld');
    if (ENABLE_BBS_BRIDGE) bind('#so-bbs', 'chatIncludeBbs');   // 柏宝书记忆桥（行仅在开关开时渲染）
    if (ENABLE_LWB_BRIDGE) bind('#so-lwb', 'chatIncludeLwb');   // 小白X 记忆桥（行仅在开关开时渲染）
    if (ENABLE_AUTO_DIAGNOSE) bind('#so-diag-mvu-compat', 'autoDiagnoseMvuCompat');   // MVU external-analysis compatibility (opt-in)
    if (ENABLE_AUTO_DIAGNOSE) bind('#so-diag-cowrite', 'autoDiagnoseCoWrite');         // 🧩 允许与其他脚本并写 MVU（1.83.0，opt-in）
    if (ENABLE_AUTO_DIAGNOSE) {   // 🔁 失败自动重试（2026-08-28）：主开关 + 次数 + 三枚分类
        bind('#so-diag-retry', 'autoDiagnoseRetry');
        sharedState.win.querySelector('#so-diag-retry').addEventListener('change', () => reflectDiagRetryVisible());
        bind('#so-diag-retry-count', 'autoDiagnoseRetryMax', (v) => parseInt(v, 10));
        bind('#so-diag-retry-empty', 'autoDiagnoseRetryOnEmpty');
        bind('#so-diag-retry-format', 'autoDiagnoseRetryOnFormat');
        bind('#so-diag-retry-error', 'autoDiagnoseRetryOnError');
    }
    if (ENABLE_DIAG_BODY_INJECT) bind('#so-diag-inject', 'diagInjectBody');   // 🩺 诊断修正写进正文（1.65.0 起在「诊断设置」里，行同上）
    bind('#so-hidden', 'includeHiddenFloors');
    // —— 角色工坊设置 —— 全局设置（不是 per-chat）。
    const bldTargetSel = sharedState.win.querySelector('#so-bld-target');
    if (bldTargetSel && BUILDER_NPC_ONLY) {
        // 只保留 NPC：目标恒 npc，选择器整行藏起来（只有一个选项的下拉没意义）。
        getSettings().bldTarget = 'npc';
        const row = bldTargetSel.closest('label');
        if (row) row.style.display = 'none';
    } else if (bldTargetSel) {
        // 选项随分家开关：开 → 三态（默认不抢话）；关 → 旧两态（= 字节级现状行为）。
        const opts = ENABLE_BUILDER_PERSONA_STYLES
            ? [['persona-nosteal', '用户角色·不抢话（AI 只回应你）'], ['persona-steal', '用户角色·抢话（AI 也扮演你）'], ['npc', 'NPC 世界书条目']]
            : [['persona', '角色（Persona）'], ['npc', 'NPC 世界书条目']];
        for (const [val, label] of opts) {
            const o = document.createElement('option');
            o.value = val; o.textContent = label;
            bldTargetSel.appendChild(o);
        }
        bldTargetSel.value = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(getSettings().bldTarget) : (getSettings().bldTarget === 'npc' ? 'npc' : 'persona');
        bldTargetSel.addEventListener('change', async () => {
            const s = getSettings();
            const prevVal = s.bldTarget;
            const nextVal = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(bldTargetSel.value) : (bldTargetSel.value === 'npc' ? 'npc' : 'persona');
            // 1.36.0 中断确认：预演新目标会落到的房间（临时代入、算完还原，不落盘）——只有当前正是工坊模式
            // 且房间真会换时才会问（syncConvoStream 按当前模式算房，非工坊模式下换目标不换房）。取消把选择器拨回。
            s.bldTarget = nextVal;
            const targetKey = convoStreamKeyForMode(currentOracleMode(), s);
            s.bldTarget = prevVal;
            if (!(await confirmConvoSwap(targetKey))) {
                bldTargetSel.value = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(prevVal) : (prevVal === 'npc' ? 'npc' : 'persona');
                return;
            }
            s.bldTarget = nextVal;
            save();
            renderBuilderChips();   // chip 集随目标切换
            syncConvoStream();      // 切到该目标的独立访谈房间
        });
    }
    renderBuilderChips();
    sharedState.win.querySelector('#so-bld-chips-help')?.addEventListener('click', toggleBuilderChipsLegend);
    const bldDepth = sharedState.win.querySelector('#so-bld-depth');
    const bldDepthAll = sharedState.win.querySelector('#so-bld-depth-all');
    const reflectBldDepth = () => {
        const d = getSettings().bldDepth;
        if (bldDepthAll) bldDepthAll.checked = d === -1;
        if (bldDepth) { bldDepth.value = d === -1 ? '' : d; bldDepth.disabled = d === -1; }
    };
    bldDepth?.addEventListener('change', () => { getSettings().bldDepth = Math.max(0, parseInt(bldDepth.value, 10) || 0); save(); reflectBldDepth(); });
    bldDepthAll?.addEventListener('change', () => { getSettings().bldDepth = bldDepthAll.checked ? -1 : 60; save(); reflectBldDepth(); });
    reflectBldDepth();
    bind('#so-bld-summary', 'bldIncludeSummary');
    bind('#so-bld-stat', 'bldIncludeStat');
    bind('#so-bld-scanwi', 'bldScanWi');
    bind('#so-bld-dlgrich', 'bldDlgRich');
    bind('#so-bld-preset', 'bldUsePreset');   // T13：访谈经预设 opt-in（锻造不受影响）——同 bldSummary/bldStat 用 bind
    // ✂️ 锻造后自动精简（轻精简层）：总开关关 或 轻精简整体关闭（ENABLE_LIGHT_CONDENSE=false）时整行不渲染。
    const bldAutoCondRow = sharedState.win.querySelector('#so-bld-autocond-row');
    if (bldAutoCondRow && (!ENABLE_DRAFT_CONDENSE || !ENABLE_LIGHT_CONDENSE)) bldAutoCondRow.style.display = 'none';
    bind('#so-bld-autocond', 'bldAutoCondense');
    // ✂️✂️ 深度精简 = Opus-only 说明行（无勾选项；深度恒串行流式，见 runCondenseDepth）：总开关关时整行不渲染。
    const bldCondInfoRow = sharedState.win.querySelector('#so-bld-condinfo');
    if (bldCondInfoRow && !ENABLE_DRAFT_CONDENSE) bldCondInfoRow.style.display = 'none';
    const bldMaxTok = sharedState.win.querySelector('#so-bld-maxtok');
    if (bldMaxTok) {
        bldMaxTok.value = getSettings().bldMaxTokens || '';   // 建窗时回填当前值（原始字符串）
        bldMaxTok.addEventListener('change', () => { getSettings().bldMaxTokens = bldMaxTok.value.trim(); save(); });
    }
    // Tier 0 ③（1.25.0）：校正回复上限 —— 仿 bldMaxTok，空串=自动（地板 4096）。全局、对手动+自动都生效。
    const fixMaxTok = sharedState.win.querySelector('#so-fix-maxtok');
    if (fixMaxTok) {
        fixMaxTok.value = getSettings().fixMaxTokens || '';
        fixMaxTok.addEventListener('change', () => { getSettings().fixMaxTokens = fixMaxTok.value.trim(); save(); });
    }
    sharedState.win.querySelector('#so-bld-book-list')?.addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) onBldBookSelectionChange();
    });
    // 「全部激活」：清空选书、回到「跟随当前所有激活的世界书」（bldBooks = [] 语义），重画选书 / 选条目器。
    sharedState.win.querySelector('#so-bld-books-active')?.addEventListener('click', () => {
        getSettings().bldBooks = [];
        save();
        populateBuilderBooks();   // 重渲选书行（全取消勾）+ 更新摘要 + 刷新选条目器
    });
    sharedState.win.querySelector('#so-bld-ent-all')?.addEventListener('click', () => setAllBldEntries(true));
    sharedState.win.querySelector('#so-bld-ent-none')?.addEventListener('click', () => setAllBldEntries(false));
    sharedState.win.querySelector('#so-bld-ent-filtered')?.addEventListener('click', () => selectFilteredBldEntries());
    sharedState.win.querySelector('#so-bld-ent-blue')?.addEventListener('click', () => setBldEntriesByType('blue'));
    sharedState.win.querySelector('#so-bld-ent-green')?.addEventListener('click', () => setBldEntriesByType('green'));
    sharedState.win.querySelector('#so-bld-ent-filter')?.addEventListener('input', (e) => filterBookEntries('#so-bld-entry-list', e.target.value, updateBldFilteredBtn));
    sharedState.win.querySelector('#so-bld-book-filter')?.addEventListener('input', (e) => filterBldBooks(e.target.value));
    // ✨ 校正模式 Phase 4：校正配置按【当前聊天】持久化（chat A 的目标不渗进 chat B）。专用 bindFix——
    // 写到 setFixCfg（per-chat 元数据）而非 getSettings()；不写全局、不调 save()（setFixCfg 自己触发 saveChatMetadata）。
    const bindFix = (id, key, parse = (v) => v) => {
        const el = sharedState.win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            setFixCfg({ [key]: el.type === 'checkbox' ? el.checked : parse(el.value) });
        });
    };
    // ✨ 校正 手动/自动 分家（2026-06-26）：下拉只切「显示哪套设置」（纯 UI 视图，全局存 fixSettingsView，不进 per-chat）。
    const fixModeSel = sharedState.win.querySelector('#so-fix-mode-select');
    if (fixModeSel) {
        fixModeSel.addEventListener('change', () => {
            getSettings().fixSettingsView = (fixModeSel.value === 'auto') ? 'auto' : ((ENABLE_FIX_CUSTOM_TASK && fixModeSel.value === 'custom') ? 'custom' : 'manual');
            save();
            applyFixModeView();
            updateFixVerdict();   // ✨ 1.18.0：判定行可见性跟视图 / per-chat 自动开关走（P8），切视图即时对齐
            // 首次切到「自动校正」→ 弹一次性标签块提醒（用户功能请求）。仅用户手动 change 触发；
            // applyFixModeView 程序化设 sel.value 不发 change，故载入 / 切聊天不会误弹。
            if (fixModeSel.value === 'auto' && !getSettings().autoFixWarned) openAutoFixWarn();
        });
    }
    // ✨ 经预设发送（破限 / 越狱用）—— 全局开关（不进 per-chat），同 advisorUsePreset 写法（写 getSettings + save）。
    const fixmPresetCb = sharedState.win.querySelector('#so-fixm-preset');
    if (fixmPresetCb) fixmPresetCb.addEventListener('change', () => { getSettings().fixM_usePreset = fixmPresetCb.checked; save(); applyFixPresetLock(); });
    const fixaPresetCb = sharedState.win.querySelector('#so-fixa-preset');
    if (fixaPresetCb) fixaPresetCb.addEventListener('change', () => { getSettings().fixA_usePreset = fixaPresetCb.checked; save(); applyFixPresetLock(); });
    // ✨ MVU「额外模型更新」抢写协调（opt-in，全局设置——用户环境级，不入 per-chat FIX_CFG_KEYS）。
    const fixWaitMvuCb = sharedState.win.querySelector('#so-fix-wait-mvu');
    if (fixWaitMvuCb) fixWaitMvuCb.addEventListener('change', () => { getSettings().fixWaitForMvu = fixWaitMvuCb.checked; save(); });
    // 数字框条数 parse：非数字 / 非正数 → -1（全部），正数原样。手动 / 自动各一份独立存储。
    const depthParse = (v) => { const n = parseInt(v, 10); return (Number.isNaN(n) || n <= 0) ? -1 : n; };
    // 手动：0 = 不带前文（默认值就是 0，resolveFixModeCfg 也按「显式 0 = 不带」读）。原版共用上面那个 parse，
    // 手填 0 会被存成 -1 = 带上全部前文，与界面显示相反（二创版 2.1.1 修）。负数 / 清空仍 = -1（全部）。
    const depthParseM = (v) => { const n = parseInt(v, 10); return (Number.isNaN(n) || n < 0) ? -1 : n; };
    // 手动模式控件（fixM_*）——上下文条数 / 卡 / 世界书 / 概要。
    bindFix('#so-fixm-depth', 'fixM_contextDepth', depthParseM);
    bindFix('#so-fixm-card', 'fixM_includeCard');
    bindFix('#so-fixm-world', 'fixM_includeWorld');
    bindFix('#so-fixm-summary', 'fixM_includeSummary');
    bindFix('#so-fixm-protectthink', 'fixM_protectThink');   // ✨ 思考块保护（W1）
    bindFix('#so-fixm-scope', 'fixM_scopeTag');   // 二创版 2.1：手动整篇的正文标签（留空 = 整条）
    sharedState.win.querySelector('#so-fixm-scope').addEventListener('blur', (e) => {   // 失焦清洗：全角括号 / <> 包装 / 多词只取第一个
        const cleaned = normalizeScopeInput(e.target.value);
        if (cleaned === e.target.value) return;
        e.target.value = cleaned;
        setFixCfg({ fixM_scopeTag: cleaned });
    });
    // 自动模式控件（fixA_*）——目标 / 排除区 / 约束 / 收紧 / 折叠上下文 + 运行按钮 + 自动开关。
    bindFix('#so-fix-tgt-slop', 'fixA_targetSlop');
    bindFix('#so-fix-tgt-dialogue', 'fixA_targetDialogue');
    bindFix('#so-fix-tgt-precision', 'fixA_targetPrecision');
    bindFix('#so-fix-tgt-magic', 'fixA_targetMagic');
    bindFix('#so-fix-tgt-pacing', 'fixA_targetPacing');
    bindFix('#so-fix-tgt-archaic', 'fixA_targetArchaic');
    // ✨ 作用域标签（per-chat）。Phase 5（D+E）：用户在这里亲手打字 = 明确表达了意图，标记 fixA_scopeManual:true——
    // 之后 resolveFixScope 缓存未命中时永不代替用户改写，只会建议（suggest），不会自作主张 detected 采纳新标签。
    sharedState.win.querySelector('#so-fix-scope').addEventListener('input', (e) => { setFixCfg({ fixA_scopeTag: e.target.value, fixA_scopeManual: true }); updateFixVerdict(); renderFixConfigWarnings(); });
    // ✨ 防呆（1.18.0）：失焦清洗——IME 全角括号 / <>[] 包装 / 多词只取第一个（normalizeScopeInput）。留空是合法 opt-out，不动。
    sharedState.win.querySelector('#so-fix-scope').addEventListener('blur', (e) => {
        const cleaned = normalizeScopeInput(e.target.value);
        if (!e.target.value.trim() || cleaned === e.target.value) return;
        e.target.value = cleaned;
        setFixCfg({ fixA_scopeTag: cleaned, fixA_scopeManual: true });
        updateFixVerdict();
        renderFixConfigWarnings();
    });
    bindFix('#so-fix-join', 'fixA_pieceJoin');   // ✨ 整体校正 vs 分段逐次（per-chat，默认开）
    sharedState.win.querySelector('#so-fix-join')?.addEventListener('change', () => { updateFixVerdict(); });
    sharedState.win.querySelector('#so-fix-keep').addEventListener('input', (e) => { setFixCfg({ fixA_keepTags: e.target.value }); updateFixVerdict(); renderFixConfigWarnings(); });
    sharedState.win.querySelector('#so-fix-drop').addEventListener('input', (e) => { setFixCfg({ fixA_dropTags: e.target.value }); renderFixConfigWarnings(); });
    sharedState.win.querySelector('#so-fix-know').addEventListener('input', (e) => { setFixCfg({ fixA_knowledgeBoundary: e.target.value }); });
    sharedState.win.querySelector('#so-fix-guard').addEventListener('input', (e) => { setFixCfg({ fixA_guardrails: e.target.value }); });
    // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：写 per-chat；切版本时即时显隐侧重行。归一在此就地做（只认 thorough / opus）。
    sharedState.win.querySelector('#so-fix-prompt-version')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptVersion: e.target.value === 'thorough' ? 'thorough' : 'light' });
        applyFixFlavorView();
    });
    sharedState.win.querySelector('#so-fix-prompt-flavor')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptFlavor: ['opus', 'gemini'].includes(e.target.value) ? e.target.value : 'deepseek' });
    });
    bindFix('#so-fix-card', 'fixA_includeCard');
    bindFix('#so-fix-ctx', 'fixA_includeContext');
    bindFix('#so-fix-ctx-depth', 'fixA_contextDepth', depthParse);
    bindFix('#so-fix-world', 'fixA_includeWorld');
    bindFix('#so-fixa-summary', 'fixA_includeSummary');
    sharedState.win.querySelector('#so-fix-run').addEventListener('click', () => { runFixByTargets(); });
    sharedState.win.querySelector('#so-fixsel-open')?.addEventListener('click', () => openFixSelectCard());   // ✂️ 选段校正（1.27.0）
    // ✂️ 输入框上方快捷按钮开关（1.44.0）：改设置后立刻放 / 撤按钮（不只是存），同 🌙 那颗的手感。
    sharedState.win.querySelector('#so-fixsel-barbtn')?.addEventListener('change', (e) => {
        getSettings().fixSelBarButton = e.target.checked;
        save();
        syncFixSelBarButton();
    });
    // ✂️ 回复右上角那颗的隐藏开关（1.77.0，opt-out `fixSelRowButton`）：同款手感——改设置后立刻
    // 重挂 / 拔掉（refreshFixChatEntry 起手就先拔光，所以取消勾选是当场生效，不必等楼层重建）。
    sharedState.win.querySelector('#so-fixsel-rowbtn')?.addEventListener('change', (e) => {
        getSettings().fixSelRowButton = e.target.checked;
        save();
        refreshFixChatEntry();
    });
    sharedState.win.querySelector('#so-fix-scan')?.addEventListener('click', () => { scanFixScope(); });   // ✨ Phase 6：扫描本卡正文标签
    sharedState.win.querySelector('#so-fix-reset')?.addEventListener('click', () => { resetFixCfg(); });   // ✨ Phase 7（M4）：恢复推荐设置
    bindFix('#so-fix-auto', 'autoFixEnabled');   // 自动校正每条新回复（message_received 编排读 cfg.autoFixEnabled）
    sharedState.win.querySelector('#so-fix-auto')?.addEventListener('change', updateFixButtonVisual);   // 改开关 → ✨ 金色指示即时对齐
    // ✨ 防呆（P5）：开自动但连接没配 → 一次性说明（fixEnvNote），否则用户只看到「什么都没发生」；顺带刷新判定行 / 警告盒。
    sharedState.win.querySelector('#so-fix-auto')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const st = getSettings();
            const unset = (st.mode === 'direct' && (!st.endpoint || !st.model)) || (st.mode === 'profile' && !st.profileId);
            if (unset && typeof toastr !== 'undefined') toastr.warning(fixEnvNote('connectionUnset'), '剧情推进 · 自动校正', { timeOut: 8000 });
        }
        updateFixVerdict();
        renderFixConfigWarnings();
    });
    // ✨ 校正 Phase 4：全局命名套餐库——加载 / 保存为… / 删除（saveFixBundle / loadFixBundle / deleteFixBundle + populateFixBundles）。
    sharedState.win.querySelector('#so-fix-bundle-load').addEventListener('click', () => {
        const sel = sharedState.win.querySelector('#so-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个已存套餐'); return; }
        if (loadFixBundle(name)) toastr.success(`已加载套餐「${name}」到本聊天`);
    });
    sharedState.win.querySelector('#so-fix-bundle-save').addEventListener('click', async () => {
        const name = await uiPrompt('给这套校正配置起个名字（如「硬核西幻」）：', '');
        const trimmed = (name || '').trim();
        if (!trimmed) return;   // 取消 / 空 = no-op
        if (saveFixBundle(trimmed)) { populateFixBundles(); const sel = sharedState.win.querySelector('#so-fix-bundle'); if (sel) sel.value = trimmed; toastr.success(`已保存套餐「${trimmed}」`); }
    });
    sharedState.win.querySelector('#so-fix-bundle-del').addEventListener('click', async () => {
        const sel = sharedState.win.querySelector('#so-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个要删的套餐'); return; }
        if (!(await uiConfirm(`删除套餐「${name}」？`))) return;
        if (deleteFixBundle(name)) { populateFixBundles(); toastr.success(`已删除套餐「${name}」`); }
    });
    // 📋 自定义模板任务（1.77.0）：整块由旗 + 面板存在性双门控——旗关时面板根本没渲染，一个监听都不挂。
    if (ENABLE_FIX_CUSTOM_TASK && sharedState.win.querySelector('#so-fix-custom-wrap')) {
        sharedState.win.querySelector('#so-fixc-run').addEventListener('click', () => { runCustomTaskNow(); });
        sharedState.win.querySelector('#so-fixc-auto').addEventListener('change', (e) => {
            // 首次勾选【不】弹「自动模式会花钱」提醒（Prince 2026-09-04 定：模板档不需要这道一次性提醒）；
            // 自动面板 #so-fix-auto 的首弹保持原样。
            if (e.target.checked) {
                setFixCfg({ autoFixEnabled: true, fixA_task: 'custom' });
            } else setFixCfg({ autoFixEnabled: false });
            seedFixControls(); updateFixButtonVisual();
        });
        // 自动面板的勾选：勾上即回到校正任务（互斥）。任务变了 ✨ 金色指示也要跟着重算（pending 判据看 task）。
        sharedState.win.querySelector('#so-fix-auto')?.addEventListener('change', (e) => { if (e.target.checked) { setFixCfg({ fixA_task: 'fix' }); seedFixControls(); updateFixButtonVisual(); } });
        const tplSel = sharedState.win.querySelector('#so-fixc-template');
        const tplBox = sharedState.win.querySelector('#so-fixc-prompt');
        tplBox.addEventListener('input', () => { sharedState.fixTplDirty = true; updateFixTplDirtyMarker(); });   // 只置脏；归属由「回填正文」的那些地方记
        tplSel.addEventListener('change', async () => {
            // 用户【亲手】换模板才走这条确认；取消时退回【归属】而不是配置里的名字——脏着时配置可能早被
            // 切聊天 / 套餐改成别人了，退回配置等于把未保存的正文交给另一份模板。
            if (sharedState.fixTplDirty && !(await uiConfirm('当前模板正文有未保存的改动，放弃并切换？'))) { tplSel.value = sharedState.fixTplDirtyFor || getEffectiveFixCfg(getSettings(), getFixCfg()).fixC_template || ''; updateFixTplDirtyMarker(); return; }
            setFixCfg({ fixC_template: tplSel.value });
            const t = findFixTemplate(getSettings(), tplSel.value);
            tplBox.value = t ? t.prompt : '';
            sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = tplSel.value; updateFixTplDirtyMarker();
            updateFixVerdict();
        });
        sharedState.win.querySelector('#so-fixc-tpl-new').addEventListener('click', async () => {
            // 新建会把文本框清空——脏着时先问一句，与「亲手换模板」同一道防误覆盖闸（spec §4.3）。
            // 放在起名之前：用户改主意时连名字都不必编。
            if (sharedState.fixTplDirty && !(await uiConfirm('当前模板正文有未保存的改动，放弃并新建？'))) return;
            const name = (await uiPrompt('给这份模板起个名字（如「中译日」）：', '') || '').trim();
            if (!name) return;
            // 「已存在」只问【用户库】：findFixTemplate 现在会兜底到内置示例，拿它判会对着内置名多问一句
            // 「覆盖？」，而 saveFixTemplate 压根不会覆盖它（保留名硬拒）。
            if (normalizeFixTemplates(getSettings().fixTemplates).some((t) => t.name === name)
                && !(await uiConfirm(`模板「${name}」已存在，覆盖？`))) return;
            // 存不下就停在这儿（内置保留名被拒）：照着往下走会把配置指到一个用户库里没有的名字上
            // ——下拉显示内置那一份、正文框却空着，再按保存又是一次另存，纯属添乱。
            if (!saveFixTemplate(name, '')) return;
            setFixCfg({ fixC_template: name });
            populateFixTemplates(); tplSel.value = name; tplBox.value = ''; sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = name; updateFixTplDirtyMarker(); updateFixVerdict();
        });
        sharedState.win.querySelector('#so-fixc-tpl-save').addEventListener('click', async () => {
            // 写回【归属】那一份，不是下拉此刻显示的那一份：脏着时两者本就该相等（seed 会把下拉钉住），
            // 但归属才是这段文字真正的主人，按它写永远不会写错人。写完把配置也同步到实际保存的那份。
            const name = sharedState.fixTplDirtyFor || tplSel.value;
            if (!name) { toastr.info('先新建或选一份模板'); return; }
            // 📋 内置示例是只读的（正文由电池钉死）：正文框照旧可改，但「保存」改走【另存为】——
            // 起个新名字存成用户自己的一份并选中它，示例本身一个字不动。收尾与「新建」逐项同一套。
            if (fixTemplateIsBuiltin(name)) {
                const copy = (await uiPrompt('内置示例本身不会被改动。给你改过的这一份起个名字：', fixSampleCopyName(name)) || '').trim();
                if (!copy) return;
                if (fixTemplateIsBuiltin(copy)) { toastr.info('这是内置示例的名字，换一个'); return; }
                // 「已存在」只问【用户库】：findFixTemplate 现在会兜底到示例，拿它判会把上面那句拒绝重问一遍。
                if (normalizeFixTemplates(getSettings().fixTemplates).some((t) => t.name === copy)
                    && !(await uiConfirm(`模板「${copy}」已存在，覆盖？`))) return;
                if (!saveFixTemplate(copy, tplBox.value)) return;
                setFixCfg({ fixC_template: copy });
                sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = copy; updateFixTplDirtyMarker();
                populateFixTemplates(); tplSel.value = copy;
                updateFixVerdict();
                toastr.success(`已另存为「${copy}」——内置示例本身不会被改动`);
                return;
            }
            saveFixTemplate(name, tplBox.value);
            sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = name; updateFixTplDirtyMarker();
            setFixCfg({ fixC_template: name });
            populateFixTemplates(); tplSel.value = name;
            updateFixVerdict();
            toastr.success(`已保存模板「${name}」`);
        });
        sharedState.win.querySelector('#so-fixc-tpl-del').addEventListener('click', async () => {
            const name = tplSel.value;
            if (!name) { toastr.info('先选一个要删的模板'); return; }
            // 内置示例删不掉（它根本不在 fixTemplates 里，deleteFixTemplate 会静默 false）——先说一句，
            // 否则用户点了确认框、什么也没发生，看着像坏了。
            if (fixTemplateIsBuiltin(name)) { toastr.info('内置示例不能删除'); return; }
            if (!(await uiConfirm(`删除模板「${name}」？`))) return;
            if (deleteFixTemplate(name)) {
                // 删掉后下拉会落到【另一份】模板上（populateFixTemplates 的 prev 已不存在）——必须把选择态
                // 与正文一起搬过去认领它，否则「配置说没选、下拉显示着 A、正文却空着」，再点一次保存就把
                // 用户从没打开过的 A 清空了（spec §4.3 防误覆盖）。清旗后交给 seedFixControls 统一回填
                // ——它在「不脏」这一支里会把 fixTplDirtyFor 一并记成新认领的这份。
                sharedState.fixTplDirty = false; sharedState.fixTplDirtyFor = ''; updateFixTplDirtyMarker();
                setFixCfg({ fixC_template: '' });
                populateFixTemplates();
                setFixCfg({ fixC_template: tplSel.value || '' });
                seedFixControls();
                updateFixVerdict();
                toastr.success(`已删除模板「${name}」`);
            }
        });
        // 🌐 模板广场（1.86.0）：旗关时按钮根本没渲染，这里同门跳过。📤 分享恒在。
        if (ENABLE_FIX_TEMPLATE_HUB) {
            sharedState.win.querySelector('#so-fixc-hub').addEventListener('click', openFixHub);
        }
        sharedState.win.querySelector('#so-fixc-share').addEventListener('click', () => { openFixShare(); });
        sharedState.win.querySelector('#so-fixc-mech').addEventListener('change', async (e) => {
            if (!e.target.checked && !getSettings().customFixWarned) {
                const ok = await uiConfirm('关掉后，状态栏 / 变量块也会一起交给模板，模板输出会原样替换整条回复。原文仍留在 swipe 0。确定？');
                if (!ok) { e.target.checked = true; return; }
                getSettings().customFixWarned = true; save();
            }
            setFixCfg({ fixC_useMechanic: e.target.checked }); updateFixVerdict(); updateFixButtonVisual();
        });
        bindFix('#so-fixc-keep', 'fixC_keepTags');
        bindFix('#so-fixc-drop', 'fixC_dropTags');
        for (const id of ['#so-fixc-keep', '#so-fixc-drop']) sharedState.win.querySelector(id).addEventListener('input', () => { renderFixConfigWarnings(); updateFixVerdict(); });
        sharedState.win.querySelector('#so-fixc-preset').addEventListener('change', (e) => { getSettings().fixC_usePreset = e.target.checked; save(); });
        bindFix('#so-fixc-minchars', 'fixAutoMinChars', (v) => clampFixAutoMinChars(v));
    }
    bind('#so-regex', 'applyRegex');
    bind('#so-wi', 'worldInfoMode');
    if (ENABLE_WI_EJS_RENDER) bind('#so-wi-ejs', 'wiRenderEjs');   // 世界书 EJS 渲染（行仅在开关开时渲染）
    bind('#so-sendtemp', 'sendTemperature');
    sharedState.win.querySelector('#so-wi').addEventListener('change', updateWiHint);
    bind('#so-persona', 'personaId');
    if (ENABLE_CUSTOM_PERSONAS) {   // 关着时编辑器元素根本不渲染，这里同门跳过
        sharedState.win.querySelector('#so-persona-edit')?.addEventListener('click', openPersonaEditor);
        sharedState.win.querySelector('#so-pe-sel')?.addEventListener('change', loadPeFields);
        sharedState.win.querySelector('#so-pe-save')?.addEventListener('click', savePersonaFromEditor);
        sharedState.win.querySelector('#so-pe-del')?.addEventListener('click', deletePersonaFromEditor);
        sharedState.win.querySelector('#so-pe-flesh')?.addEventListener('click', fleshPersonaFromEditor);
        sharedState.win.querySelector('#so-pe-undo')?.addEventListener('click', () => {
            const e = peEls();
            if (!sharedState.peFleshUndo) return;
            e.voice.value = sharedState.peFleshUndo.voice;
            e.example.value = sharedState.peFleshUndo.example;
            sharedState.peFleshUndo = null;
            e.undo.style.display = 'none';
        });
    }
    sharedState.win.querySelector('#so-sysprompt-preset').addEventListener('change', (e) => onPresetSelected(e.target.value));
    sharedState.win.querySelector('#so-sysprompt-preset-refresh').addEventListener('click', populateSysPromptPresets);
    sharedState.win.querySelector('#so-sysprompt-preset-recurate').addEventListener('click', () => {
        const s = getSettings();
        const cur = s.sysPromptPresetName;
        if (!cur) return;
        // 回显【已保存】的挑选（1.88.0）：不带种子行就会按分类器默认重建，用户以为没存上、再存一遍反把选择盖掉。
        const snap = getCuratedSnapshot(s, cur);
        openCuration(cur, snap ? curationRowsFromSnapshot(buildCurationRows(cur), snap) : undefined);
    });
    // 提示词编辑器：设置「提示词」页里点开的条目，文本框改的就是那一条（PROMPT_DEFS）。
    let promptInjectTimer = null;
    const afterPromptEdit = (id) => {
        refreshPromptBadges();
        // 主聊天注入类：停手片刻后重登记一次，正在进行的引导立刻换上新文字。
        if (/^inject\./.test(id)) {
            clearTimeout(promptInjectTimer);
            promptInjectTimer = setTimeout(() => { applyPlanInjection(); if (sharedState.win) renderPlanBar(); }, 600);
        }
    };
    sharedState.win.querySelector('#so-sysprompt').addEventListener('input', (e) => {
        promptSet(sharedState.promptEditId, e.target.value);
        save();
        applyPromptEditorUiState();   // 实时刷新「内置 / 已自定义」与缺项提示
        afterPromptEdit(sharedState.promptEditId);
    });
    sharedState.win.querySelector('#so-sysprompt-reset').addEventListener('click', async () => {
        const d = promptDef(sharedState.promptEditId);
        if (!d) return;
        if (!(await uiConfirm(`确定把「${d.group} · ${d.label}」重置为内置默认吗？当前的修改会丢失。`))) return;
        promptReset(d.id);
        save();
        loadPromptEditor();
        afterPromptEdit(d.id);
        addSystemNote(`已将「${d.group} · ${d.label}」重置为内置默认。`);
    });

    // send
    sharedState.sendBtn.addEventListener('click', onSend);
    sharedState.win.querySelector('#so-model-fetch').addEventListener('click', onFetchModels);
    sharedState.win.querySelector('#so-model-list').addEventListener('change', (e) => {
        const val = e.target.value;
        if (!val) return;
        const input = sharedState.win.querySelector('#so-model');
        input.value = val;
        s.model = val;
        updateBadge();
        save();
    });
    // 1.85.1：Enter 是否发送跟随酒馆「用户设置 → 按 Enter 发送」（手机默认 Enter 换行）——判据见 soEnterShouldSend。
    // 设置在【按键当时】读，用户在酒馆里改了立即生效，不必重开窗口。
    sharedState.inputEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (soEnterShouldSend(e, soReadSendOnEnter(), soIsMobileForEnter())) {
            e.preventDefault();
            onSend();
        }
    });
    sharedState.inputEl.addEventListener('input', autoGrowInput);                                                      // #4 输入框随内容自动增高
    // #1 跟随意图【只】由真·用户手势（滚轮 / 触摸）更新——程序化滚动（固定顶部 / 跟随到底）不触发 wheel / touchmove，
    // 故不会被「空占位气泡刚固定到顶时 nearBottom 恰好为真」误翻成跟随（先前用通用 scroll 监听正栽在这）。
    const soUpdateFollow = () => { try { requestAnimationFrame(() => { sharedState.soFollowStream = nearBottom(); }); } catch (e) { sharedState.soFollowStream = nearBottom(); } };
    sharedState.messagesEl.addEventListener('wheel', soUpdateFollow, { passive: true });        // 桌面滚轮
    sharedState.messagesEl.addEventListener('touchmove', soUpdateFollow, { passive: true });    // 手机触摸滑动

    // 用户功能请求：反映持久化的自动诊断状态（重载后若 AUTO 仍开着，按钮显示红色 + AUTO）。
    updateDiagButtonVisual();
    updateFixButtonVisual();
    soApplyConvoIoVisual(null);   // 📥📤 气泡行 / 空态入口：首次建窗时按当前模式定可见性（此后由 setOracleMode 维持）
}

function loadSettingsIntoForm() {
    const s = getSettings();
    sharedState.win.querySelector('#so-mode').value = s.mode;
    sharedState.win.querySelector('#so-endpoint').value = s.endpoint;
    sharedState.win.querySelector('#so-apikey').value = s.apiKey;
    sharedState.win.querySelector('#so-model').value = s.model;
    sharedState.win.querySelector('#so-stream').checked = !!s.stream;
    sharedState.win.querySelector('#so-direct-backend').checked = !!s.directViaBackend; // 1.17.23：经酒馆后端转发
    sharedState.win.querySelector('#so-raw-url').checked = !!s.directRawUrl;            // 1.22.0：地址原样使用

    sharedState.win.querySelector('#so-temp').value = s.temperature;
    sharedState.win.querySelector('#so-maxtok').value = s.maxTokens;
    sharedState.win.querySelector('#so-depth').value = s.contextDepth;
    sharedState.win.querySelector('#so-adv-depth').value = s.advisorDepth;
    syncNodeDetailSeg();
    sharedState.win.querySelector('#so-card').checked = !!s.includeCard;
    sharedState.win.querySelector('#so-stat').checked = !!s.chatIncludeStat;
    sharedState.win.querySelector('#so-world').checked = !!s.chatIncludeWorld;
    if (ENABLE_BBS_BRIDGE) sharedState.win.querySelector('#so-bbs').checked = !!s.chatIncludeBbs;   // 柏宝书记忆桥
    if (ENABLE_LWB_BRIDGE) sharedState.win.querySelector('#so-lwb').checked = !!s.chatIncludeLwb;   // 小白X 记忆桥
    if (ENABLE_AUTO_DIAGNOSE) sharedState.win.querySelector('#so-diag-mvu-compat').checked = !!s.autoDiagnoseMvuCompat;   // MVU external-analysis compatibility
    if (ENABLE_AUTO_DIAGNOSE) sharedState.win.querySelector('#so-diag-cowrite').checked = !!s.autoDiagnoseCoWrite;         // 🧩 允许与其他脚本并写 MVU（1.83.0）
    if (ENABLE_AUTO_DIAGNOSE) {   // 🔁 失败自动重试（2026-08-28）
        sharedState.win.querySelector('#so-diag-retry').checked = !!s.autoDiagnoseRetry;
        // 次数经 diagRetryMax（与运行时同一枚消毒器）回画：存档里的胡话 / 越界值不原样上屏。
        sharedState.win.querySelector('#so-diag-retry-count').value = diagRetryMax(s);
        sharedState.win.querySelector('#so-diag-retry-empty').checked = !!s.autoDiagnoseRetryOnEmpty;
        sharedState.win.querySelector('#so-diag-retry-format').checked = !!s.autoDiagnoseRetryOnFormat;
        sharedState.win.querySelector('#so-diag-retry-error').checked = !!s.autoDiagnoseRetryOnError;
        reflectDiagRetryVisible();
    }
    if (ENABLE_DIAG_BODY_INJECT) sharedState.win.querySelector('#so-diag-inject').checked = !!s.diagInjectBody;   // 🩺 诊断修正写进正文（1.65.0 起住在「诊断设置」里）
    reflectAutoDiagCheckbox();   // 🩺 自动诊断勾选框（1.65.0）：与 autoDiagnoseEnabled 同步，唯一写者
    sharedState.win.querySelector('#so-hidden').checked = !!s.includeHiddenFloors;
    // ✨ 校正模式 Phase 4：校正控件从【本聊天】生效配置读种子（per-chat 覆盖全局）——不直读 s.fix*。
    seedFixControls();
    populateFixBundles();   // ✨ 校正 Phase 4：填充全局命名套餐下拉
    sharedState.win.querySelector('#so-qr-toggle').checked = !!s.showQrButton;
    sharedState.win.querySelector('#so-chatbar-toggle').checked = !!s.showChatBarButton;
    sharedState.win.querySelector('#so-clickout-toggle').checked = !!s.clickOutsideClose;   // 1.48.0 点击窗外自动收起
    sharedState.win.querySelector('#so-window-skin').value = s.windowSkin;   // 1.45.0 窗口配色
    const fixSelBarBox = sharedState.win.querySelector('#so-fixsel-barbtn');   // 门控关时该行不存在
    if (fixSelBarBox) fixSelBarBox.checked = !!s.fixSelBarButton;
    const fixSelRowBox = sharedState.win.querySelector('#so-fixsel-rowbtn');   // 同上；判 !== false = 老档缺键当「开」
    if (fixSelRowBox) fixSelRowBox.checked = getSettings().fixSelRowButton !== false;
    sharedState.win.querySelector('#so-tools-header-toggle').checked = !!s.toolsInHeader;
    sharedState.win.querySelector('#so-regex').checked = !!s.applyRegex;
    sharedState.win.querySelector('#so-wi').value = wiEffectiveMode(s);
    if (ENABLE_WI_EJS_RENDER) { const soWiEjs = sharedState.win.querySelector('#so-wi-ejs'); if (soWiEjs) soWiEjs.checked = !!s.wiRenderEjs; }   // 世界书 EJS 渲染（回填勾选态）
    sharedState.win.querySelector('#so-sendtemp').checked = !!s.sendTemperature;
    sharedState.win.querySelector('#so-lb-story').checked = !!s.lorebookIncludeStory;
    sharedState.win.querySelector('#so-lb-preset').checked = !!s.lorebookUsePreset;
    reflectLbPreview();   // 「👁 内容预览」开关按钮初始高亮跟随保存的设置
    // 角色工坊：概要 / 状态栏勾选的初始态（bind() 只挂监听、不回填，同世界书那两项的处理）。
    const bldSum = sharedState.win.querySelector('#so-bld-summary');
    if (bldSum) bldSum.checked = !!s.bldIncludeSummary;
    const bldStat = sharedState.win.querySelector('#so-bld-stat');
    if (bldStat) bldStat.checked = !!s.bldIncludeStat;
    const bldScanWi = sharedState.win.querySelector('#so-bld-scanwi');
    if (bldScanWi) bldScanWi.checked = !!s.bldScanWi;
    const bldDlgRich = sharedState.win.querySelector('#so-bld-dlgrich');
    if (bldDlgRich) bldDlgRich.checked = !!s.bldDlgRich;
    const bldPreset = sharedState.win.querySelector('#so-bld-preset');
    if (bldPreset) bldPreset.checked = !!s.bldUsePreset;

    sharedState.win.querySelector('#so-adv-preset').checked = !!s.advisorUsePreset;
    sharedState.win.querySelector('#so-diag-preset').checked = !!s.diagnoseUsePreset;
    if (ENABLE_SCHEMA_DIAG) { const sr = sharedState.win.querySelector('#so-diag-schema-retry'); if (sr) sr.checked = !!s.diagSchemaRetry; }
    updateWiHint();
    populatePersonas();
    // 提示词编辑器：载入当前条目；设置面板停在上次打开的那一页。
    populateSysPromptPresets();
    loadPromptEditor();
    setSettingsTab(sharedState.settingsTab);
    applyModeVisibility();
    updateBadge();
}

// —— 自定义人格编辑器（1.39.0）——字段是工作区、不走 bind()：只有「保存」才写设置（防误落盘，
// data-smoketest 残留地雷的构造性预防）。扩写调用用本地中止器，绝不共用主发送的 abortCtl（1.37.0 教训）。
sharedState.peFleshAbort = null;   // 生成中 = AbortController；空闲 = null（按钮兼作 ⏹ 取消）
sharedState.peFleshUndo = null;    // 扩写前 { voice, example } 快照（一次性，收起编辑器即弃）
function peEls() {
    return {
        editor: sharedState.win.querySelector('#so-persona-editor'),
        sel: sharedState.win.querySelector('#so-pe-sel'),
        name: sharedState.win.querySelector('#so-pe-name'),
        voice: sharedState.win.querySelector('#so-pe-voice'),
        example: sharedState.win.querySelector('#so-pe-example'),
        flesh: sharedState.win.querySelector('#so-pe-flesh'),
        undo: sharedState.win.querySelector('#so-pe-undo'),
        save: sharedState.win.querySelector('#so-pe-save'),
        del: sharedState.win.querySelector('#so-pe-del'),
    };
}
function populatePeSel(keepId) {
    const e = peEls();
    if (!e.sel) return;
    e.sel.innerHTML = '';
    const optNew = document.createElement('option');
    optNew.value = '';
    optNew.textContent = '＋ 新建人格';
    e.sel.appendChild(optNew);
    for (const p of getSettings().customPersonas) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        e.sel.appendChild(opt);
    }
    e.sel.value = (keepId && getSettings().customPersonas.some((p) => p.id === keepId)) ? keepId : '';
}
function loadPeFields() {
    const e = peEls();
    const cur = findPersonaById(getSettings().customPersonas, e.sel.value);
    e.name.value = cur ? cur.label : '';
    e.voice.value = cur ? cur.voice : '';
    e.example.value = cur ? (cur.example || '') : '';
    sharedState.peFleshUndo = null;
    e.undo.style.display = 'none';
    e.del.style.display = cur ? '' : 'none';
}
function openPersonaEditor() {
    if (!ENABLE_CUSTOM_PERSONAS) return;   // 杀开关读点（关着时元素不渲染，这里是双保险）
    const e = peEls();
    if (!e.editor) return;
    if (e.editor.style.display !== 'none') { e.editor.style.display = 'none'; sharedState.peFleshUndo = null; return; }   // 再点铅笔 = 收起
    e.editor.style.display = '';
    const s = getSettings();
    const curIsCustom = s.customPersonas.some((p) => p.id === s.personaId);
    populatePeSel(curIsCustom ? s.personaId : '');
    loadPeFields();
}
function savePersonaFromEditor() {
    const e = peEls();
    const s = getSettings();
    const name = e.name.value.trim();
    const voice = e.voice.value.trim();
    const example = e.example.value.trim();
    if (!name || !voice) { toastr.info('名称与人格描述都不能为空'); return; }
    if (voice.length > CUSTOM_PERSONA_CAPS.voice) { toastr.info(`人格描述最长 ${CUSTOM_PERSONA_CAPS.voice} 字`); return; }
    if (example.length > CUSTOM_PERSONA_CAPS.example) { toastr.info(`示例对话最长 ${CUSTOM_PERSONA_CAPS.example} 字`); return; }
    const editingId = e.sel.value;   // '' = 新建
    const nameTaken = allPersonasView(s).some((p) => p.id !== editingId && p.label.toLowerCase() === name.toLowerCase());
    if (nameTaken) { toastr.info('已有同名人格，换个名字吧'); return; }
    let id = editingId;
    if (editingId) {
        const cur = findPersonaById(s.customPersonas, editingId);
        if (!cur) { toastr.warning('要编辑的人格不存在了'); populatePeSel(''); loadPeFields(); return; }
        cur.label = name; cur.voice = voice; cur.example = example;
    } else {
        if (s.customPersonas.length >= CUSTOM_PERSONA_CAPS.count) {
            toastr.info(`自定义人格最多 ${CUSTOM_PERSONA_CAPS.count} 个，先删一个吧`); return;
        }
        id = 'cp-' + Date.now();
        s.customPersonas.push({ id, label: name, voice, example });
        s.personaId = id;   // 新建即选中（少一步）
    }
    save();
    populatePersonas();
    populatePeSel(id);
    loadPeFields();
    toastr.success(`已保存人格「${name}」`);
}
async function deletePersonaFromEditor() {
    const e = peEls();
    const s = getSettings();
    const cur = findPersonaById(s.customPersonas, e.sel.value);
    if (!cur) { toastr.info('先选一个要删的自定义人格'); return; }
    if (!(await uiConfirm(`删除自定义人格「${cur.label}」？`))) return;
    s.customPersonas = s.customPersonas.filter((p) => p.id !== cur.id);
    if (s.personaId === cur.id) s.personaId = 'plain';
    save();
    populatePersonas();
    populatePeSel('');
    loadPeFields();
    toastr.success(`已删除人格「${cur.label}」`);
}
async function fleshPersonaFromEditor() {
    const e = peEls();
    if (sharedState.peFleshAbort) { sharedState.peFleshAbort.abort(); return; }   // 生成中再点 = 取消
    const name = e.name.value.trim();
    const seedText = e.voice.value.trim();
    if (!name && !seedText) { toastr.info('先写一两句想要的感觉（名称或描述任填其一）'); return; }
    sharedState.peFleshUndo = { voice: e.voice.value, example: e.example.value };
    const ctl = new AbortController();
    sharedState.peFleshAbort = ctl;
    const timer = setTimeout(() => ctl.abort(), 120000);
    const prevLabel = e.flesh.textContent;
    e.flesh.textContent = '⏹ 取消';
    e.save.disabled = true; e.del.disabled = true;
    try {
        const s = getSettings();
        const reply = await soCallModel(buildPersonaFleshMessages(name, seedText), {
            maxTokens: Math.max(Number(s.maxTokens) || 0, 4096),   // 隐藏推理计费教训：地板 4096
            signal: ctl.signal,
        });
        const parsed = parsePersonaFleshReply(reply);
        if (!parsed.voice) { toastr.warning('模型没有返回可用内容'); sharedState.peFleshUndo = null; return; }
        e.voice.value = parsed.voice;
        if (parsed.example) e.example.value = parsed.example;
        e.undo.style.display = '';
        if (parsed.fallback) toastr.info('回复格式不标准，已原样填入（可手动修剪）');
    } catch (err) {
        if (!ctl.signal.aborted) toastr.error('扩写失败：' + ((err && err.message) || err));
        sharedState.peFleshUndo = null;
    } finally {
        clearTimeout(timer);
        sharedState.peFleshAbort = null;
        e.flesh.textContent = prevLabel;
        e.save.disabled = false; e.del.disabled = false;
    }
}

function populatePersonas() {
    const sel = sharedState.win.querySelector('#so-persona');
    if (!sel) return;
    sel.innerHTML = '';
    for (const p of PERSONAS) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        sel.appendChild(opt);
    }
    const s = getSettings();
    const view = allPersonasView(s);
    const customs = view.filter((p) => p.custom);
    if (customs.length) {
        const grp = document.createElement('optgroup');
        grp.label = '── 自定义 ──';
        for (const p of customs) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.label;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
    sel.value = findPersonaById(view, s.personaId) ? s.personaId : 'plain';
}