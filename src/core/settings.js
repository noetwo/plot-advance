import { toggleSettings } from '../bootstrap.js';

import { autoGrowInput } from '../modes/chat/history.js';
import { onSend } from '../modes/chat/send.js';
import { normalizeFixTemplates } from '../modes/fix/templates.js';
import { normalizeBldTarget, sanitizeBldSections } from '../modes/builder/model.js';
import { BUILDER_NPC_ONLY, DEFAULT_SYSTEM_PROMPT, DIAG_SEED_GRACE_MS, ENABLE_BUILDER_PERSONA_STYLES, ENABLE_FIX_TEMPLATE_HUB, ENABLE_SCHEMA_DIAG, MODULE } from '../prompts/builtins.js';
import { normalizeCustomPersonas } from '../prompts/helpers.js';
import { promptDef } from '../prompts/registry.js';
import { currentOracleMode } from '../ui/mode-shell.js';
import { applyConnPreset, connPresetState, getProfiles, saveToActiveConnPreset, shortModelName, switchConnPreset } from '../ui/settings.js';
import { isGenerating } from './generation.js';
import { inputEl, win } from '../ui/refs.js';
import { getHostContext, getHostGlobal } from '../st/host.js';

let connPickerOpen = false;
let connPickerQuery = '';
let modelMenuOpen = false;
let qpMenuOpen = false;
let qpManageMode = null;

// 设置里「提示词」编辑器当前正在编辑哪一条（注册表 id；仅 UI 状态、不持久化，每次会话默认普通聊天系统提示词）。


// 校正 / 诊断的后台 LLM 调用超时（毫秒）：到点 abortCtl.abort() → 气泡「(已停止)」。覆盖按目标校正
// （runFixByTargets/Pieces）、自动校正（runAutoFix/Pieces）、自动诊断（runAutoDiagnose，共用 beginPostReplyCall）。
// 大块正文 + 慢模型 / 推理模型的单次整体校正易越 120s（用户报告 (已停止)），2026-07-03 应 Prince 提到 240s。
// 注意：与 awaitMvuIdle 的 capMs（MVU 空闲等待上限，语义不同）区分——那个仍是 120000。
export const POST_REPLY_CALL_TIMEOUT_MS = 240000;

// 2.4.0：除了端点 / 密钥 / 模型 / 地址原样，这些也随连接存档走——不同服务商要的转发、附加参数、温度、流式常常不一样。
// 存档里的键名与设置键同名（「地址原样」沿用旧名 rawUrl）。旧存档缺这些键：getSettings 用升级时的当前值补齐；
// 补齐之前（以及原版写回的存档）比较和切换都只看存档里有的项。
export const CONN_PRESET_KEYS = ['directViaBackend', 'extraIncludeBody', 'extraExcludeBody', 'extraIncludeHeaders', 'temperature', 'maxTokens', 'stream', 'sendTemperature'];

const defaults = {
    mode: 'direct',            // 'direct' | 'profile'
    // direct mode
    endpoint: '',
    apiKey: '',
    model: '',
    stream: true,
    // 直连「经酒馆后端转发」（1.17.23）：直连撞第三方端点 CORS（failed to fetch）时勾选——复用同一端点+密钥，改由
    // 酒馆服务器代发（custom 源 + 显式 Authorization 头），无浏览器跨域、无需连接配置文件。默认关 = 字节不变。
    directViaBackend: false,
    // 直连「地址原样使用」（1.22.0，原生化自二创「最终模式」）：裸地址不再自动补 /v1——请求打到
    // 地址/chat/completions、获取模型打到 地址/models。路径特殊的中转站用。默认关 = 旧行为字节不变。
    directRawUrl: false,
    // 附加参数（1.70.0，仿 ST「自定义（兼容 OpenAI）」源的同名面板；用户反馈：DS 类中转要传
    // enable_thinking: false 等关思维链参数，神谕请求体是写死的没处填）：三份原始文本（YAML 或 JSON），
    // 随每次请求附加 / 剔除主体参数、附加请求头。直连两条路全生效；profile 路仅「自定义（兼容 OpenAI）」
    // 源的配置档生效（ST 后端只在 custom 分支读这三键）。默认空 = 请求字节不变。
    extraIncludeBody: '',
    extraExcludeBody: '',
    extraIncludeHeaders: '',
    // profile mode
    profileId: '',
    // shared generation params
    temperature: 0.7,
    // 输出预算默认 12k（1.60.0，原 2000）：神谕的回复越来越长（参谋方案卡 / 序列 / 世界书区块 / 长篇分析），
    // 2000 会把它们拦腰截断，而新用户不知道要去调这个旋钮。只动【默认值】——getSettings 只补【缺失】的键
    // （下方 `if (!(k in s)) s[k] = v`），老用户存过的数值原样不动。各功能自己的地板（校正 4096 /
    // 锻造 16384 / 扫描 16384 / 人格扩写 4096…）都是 Math.max(s.maxTokens, N)，不受这次改动影响。
    maxTokens: 12288,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // 诊断 / 世界书 / 剧情参谋 模式的系统提示词【覆盖】。空串 = 用内置默认。
    // 二创版起由提示词注册表（PROMPT_DEFS 的 legacy 键）读写，键名与原版一致、双向兼容。
    diagnoseSystemPrompt: '',
    lorebookSystemPrompt: '',
    advisorSystemPrompt: '',
    // ✨ 自动校正提示词覆盖（1.46.0）：轻校 / 精校（空 = 内置；精校覆盖在 Opus 侧重没单独改时对两种侧重都生效）。
    fixLightSystemPrompt: '',
    fixThoroughSystemPrompt: '',
    // ✨ 校正目标 chip 文本覆盖（1.47.0，Prince 决定 1：整份替换、勾上即恒发；【标签】头程序自动加）。
    // 全局键（不进 FIX_CFG_KEYS：提示词文本是用户偏好，不随聊天 / 套餐走）。空 = 用内置模块正文。
    fixTargetSlopPrompt: '', fixTargetDialoguePrompt: '', fixTargetPrecisionPrompt: '',
    fixTargetMagicPrompt: '', fixTargetPacingPrompt: '', fixTargetArchaicPrompt: '',
    sysPromptPresetName: '',   // '' = use systemPrompt textarea; else name of a Chat Completion preset
    // Frozen, per-preset curations. Keyed by preset name -> { items:[...], curatedAt }.
    // Each item is a kept block in final (possibly reordered) order:
    //   { kind:'text', identifier, name, role, content }   (verbatim content + role)
    //   { kind:'marker', identifier, name }                (positional slot)
    // Once saved, edits to the live ST preset never touch this copy; only an
    // explicit re-curate refreshes it.
    curatedPresets: {},
    // One-time: whether the curation regex/preset-mismatch warning has been shown.
    curationWarned: false,
    personaId: 'plain',        // 说话人格皮肤；见 PERSONAS。普通 = 不叠加任何皮肤
    customPersonas: [],        // 自定义人格（1.39.0）：[{ id, label, voice, example }]，归一见 normalizeCustomPersonas
    contextDepth: 30,          // last N non-system messages; -1 = entire chat; 0 = none
    includeCard: true,
    // ✨ 校正模式 手动/自动 分家（2026-06-26）：两套独立设置（前缀 fixM_ / fixA_），同名设置互不串味
    // （例如手动与自动各自的「前文条数」）。fixSettingsView = 「校正设置」面板当前显示哪套（纯 UI 视图偏好，
    // 全局、不进 per-chat 覆盖）。归一由 resolveFixModeCfg 完成；校正代码一律读它的输出。
    fixSettingsView: 'manual',
    // 手动模式（在输入框直接说要改什么，像引导式 swipe）——单稿、无目标。默认【精简上下文】：只发这一条回复
    // 正文（+ 角色卡），不带前文 / 世界书 / 概要——弱模型（DeepSeek / Gemini 等）在高上下文下认不准要改哪一
    // 楼、易把前文混进成品（用户反馈）；需对齐设定 / 前情时用户再逐项开（面板顶部有高上下文告警）。
    fixM_contextDepth: 0,        // 加载前文条数；-1 = 全部，0 = 不带（默认不带：见上）
    fixM_includeCard: true,      // 带上角色卡（有界、保音色，默认开）
    fixM_includeWorld: false,    // 带上当前激活世界书（默认关：高上下文稀释目标）
    fixM_includeSummary: false,  // 带上 📜剧情概要（默认关：高上下文稀释目标）
    // ✨ 思考块保护（2026-08-16 W1 §3.1 修复）：手动整篇校正把 REASONING_TAGS 家族的思考块（<think>/<thinking> 等）
    // 先经既有保留区机械抠走（⟦SO_KEEP_n⟧ 原位锚）、校正后原样接回——实测整篇手动校正 6/10 会把整块思考链
    // 静默删光（HANDOFF-MARKFIX §3.1，depth=0 工厂默认即复现），码侧收走 = 结构性不可删。关掉 = 旧行为
    // （思考块留在正文里，模型可按「用户指令优先」软条款改它——这正是不做静默锁定的出口）。
    fixM_protectThink: true,
    // 二创版 2.1：手动整篇校正的正文标签。留空 = 整条回复（旧行为）；填了且回复里有这个标签 = 只改标签里的正文，
    // 标签外原样留在信封里、应用时原位回插（与自动的 fixA_scopeTag 同一套 splitContentScope / wrapContentScope）。
    fixM_scopeTag: '',
    // 自动模式（按目标校正按钮 + 每条新回复自动校正）——跑得勤，故默认精简省钱：只发回复正文 + 目标，按需才加上下文。
    fixA_includeCard: false, fixA_includeContext: false, fixA_contextDepth: 30, fixA_includeWorld: false, fixA_includeSummary: false,
    // 目标默认开（除魔法——仅奇幻设定才需要）：八股 / 对话 / 精确 / 详略。
    fixA_targetSlop: true, fixA_targetDialogue: true, fixA_targetPrecision: true, fixA_targetMagic: false, fixA_targetPacing: true,
    fixA_targetArchaic: false,   // 二创版 2.1：古风词混入（仅西幻 / 现代卡勾选，默认关）
    fixA_knowledgeBoundary: '', fixA_guardrails: '',
    fixA_keepTags: '', fixA_dropTags: '',
    // ✨ 作用域标签（用户功能请求）：只校正 <content>…</content> 内的正文，正文【外】的所有块（状态栏 / 选项 /
    // 世界书 / htmlcontent 地图 / UpdateVariable / 占位符…）原样保留、原位不动（信封式，绝不抽出重排）。默认
    // 'content'，且【仅当回复里确有该标签时才生效】——简单卡（无此标签）自动回退到「校正整条」的旧行为。
    // 留空 = 关闭作用域、校正整条回复。卡片若用别的标签包正文，改成那个标签名。
    fixA_scopeTag: 'content',
    // ✨ 自动配置 Phase 5（D+E）：这个作用域标签是【用户手填】的吗？true = 用户在 #pad-fix-scope 里亲手打过字，
    // 之后 resolveFixScope 永不代替用户改写（只建议、不采纳）；false = 还是默认值 / 上次由自动检测采纳写入的——
    // 缓存未命中时可以自我纠正。默认 false（默认标签 'content' 视作「尚未手动确认过」）。
    fixA_scopeManual: false,
    // ✨ 分段校正（1.18.0）：本卡正文形态的按聊天记忆。'' = 还没定（决策阶梯现场判）；'wrapped' = 正文包在
    // fixA_scopeTag 标签里（可多块，块内嵌的结构块也保护）；'bare' = 正文是标签之外的散文（own-line 结构块
    // 全部原样保留）。fixA_pieceAsked：「需要确认一次」是否已问过（问过就不再弹 toast，判定行仍显示待确认）。
    fixA_pieceMode: '',
    fixA_pieceAsked: false,
    // ✨ 分段校正「整体校正」（Prince 定案默认开）：true = 正文合并成【一次】调用，夹在正文之间的结构块
    // 换成 ⟦SO_KEEP_n⟧ 锚点原位保留（1.17.3 已验证机制），省调用、整篇连贯；false = 分段逐次调用
    //（位置由代码百分百把控、单段失败只损失那一段）。首尾的结构连片两种模式都走信封、绝不送模型。
    fixA_pieceJoin: true,
    // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：per-chat。默认 'light' = 现行提示（零行为变化，需用户主动选精校才变）；
    // 'thorough' = 三道工序精校版，按侧重再分 'deepseek'（克制，默认）/ 'opus'（数据包强攻）。见 resolveFixAutoPrompt。
    fixA_promptVersion: 'light', fixA_promptFlavor: 'deepseek',
    fixA_tighten: true,          // ✨ 收紧：自动校正后再精修一遍（删冗词废话 / 过度描写，读感更紧）；默认开
    // ✨ 校正模式 Phase 3：自动校正（开启后每条新主聊天 AI 回复后台跑一次校正、自动应用为新 swipe；
    // 经 maybePostReply 编排 → runAutoFix）。默认关。fixAutoMinChars = 成本门最小字符数（短回复不值得发调用，见
    // fixPreFilter）。共享 settle 仍复用 autoDiagnoseDelayMs（不另加延时）。
    autoFixEnabled: false,
    fixAutoMinChars: 200,
    // ✨ 校正模式 Phase 4：全局命名套餐库——把【当前生效】的校正配置存成一个具名套餐（如「硬核西幻」），
    // 之后在任何聊天里一键加载到本聊天的 per-chat 覆盖。形如 [{ name, cfg:{<FIX_CFG_KEYS 子集> } }]。
    // 全局（跨聊天）存设置；加载时写本聊天元数据（setFixCfg），不污染全局默认。
    fixBundles: [],
    // 📋 自定义模板任务：全局具名模板库 [{ name, prompt }]（仿套餐；读时 normalizeFixTemplates 归一）。
    fixTemplates: [],
    // 🌐 模板广场：已下载记录 { t0042: { version, name } }——驱动「已下载 / 有新版本」。写入恒【赋新对象】
    // （defaults 按引用赋，原地改会污染 defaults，同 fixTemplates 的注释）。旗关时这个键根本不进 defaults
    // （设置对象一个键都不多，与 1.85.3 同形）。
    ...(ENABLE_FIX_TEMPLATE_HUB ? { fixHubInstalled: {} } : {}),
    // 自定义任务的 per-chat 键（进 FIX_CFG_KEYS、随套餐走）：任务二选一 / 选中模板名 / 沿用识别 / 自带两区。
    fixA_task: 'fix', fixC_template: '', fixC_useMechanic: true, fixC_keepTags: '', fixC_dropTags: '',
    // 普通模式附带 MVU 实时变量状态（stat_data）。这是数值问题的唯一权威来源：
    // 没有它，模型会从剧情里的状态栏残影 / 自身想象中自信地编出数值（v1.14.6）。
    // 大状态卡 + 频繁提问会吃 token，可在设置里关掉（关掉后会改为如实拒答数值）。
    chatIncludeStat: true,
    // 普通聊天 / 剧情参谋模式附带「其它扩展维护的世界信息」（世界引擎 World Engine 等，或任何注册到
    // window.__ST_CONTEXT_PROVIDERS__ 的扩展）。让神谕能读到主聊天之外、扩展自己系统里保存的后台世界
    // 状态。无相关扩展时自动为空、无开销。喂的是完整数据（含全部字段），大状态卡会吃 token，可在此关掉。
    chatIncludeWorld: true,
    // 柏宝书记忆桥（ENABLE_BBS_BRIDGE）：附带柏宝书（ST-BaiBai-Book）的历史剧情摘要——被它隐藏的
    // 旧楼层的自动总结，插在对话记录之前（普通 / 参谋；校正 / 工坊勾「带上剧情概要」时也一并带）。
    // 默认关（opt-in）：开了才去读 window.STBaiBaiBook；未装柏宝书时开着也零开销。
    chatIncludeBbs: false,
    // 小白X 剧情总结桥（ENABLE_LWB_BRIDGE）：镜像小白X 注入主模型的剧情总结，同位柏宝书。
    // 默认关（opt-in）；开了才去抓小白X 的注入槽；未装小白X 时开着也零开销。
    chatIncludeLwb: false,
    applyRegex: true,          // run ST's prompt-altering regex (thinking strip, summaries, etc.)
    // 自动诊断（用户功能请求）：开启后，每收到一条新的主聊天 AI 回复，就在后台跑一次诊断
    // 并自动应用修复（见 maybePostReply 编排 → runAutoDiagnose）。autoDiagnoseWarned 记录「不再
    // 提示」那次警告。delayMs 给 MVU 先处理完该回复的更新、再读取权威状态的缓冲时间。
    autoDiagnoseEnabled: false,
    autoDiagnoseWarned: false,
    autoDiagnoseDelayMs: 1200,
    autoDiagnoseSeedGraceMs: DIAG_SEED_GRACE_MS,   // 🩺 楼层播种前给 MVU 的宽限窗（1.77.2；无 UI）
    // 🩺 自动诊断 × MVU「额外模型解析」兼容（opt-in，默认关）。开时才在 MESSAGE_RECEIVED 建 4s
    // 启动观察窗；见 busy 后锁存整批直到最终 idle UPDATE_ENDED（跨 retry false 间隙），最多 10 分钟。
    // 关闭时 awaitMvuCompatBatch 立即返回，不给普通 / 行内 MVU 用户增加任何延时。
    autoDiagnoseMvuCompat: false,
    // 🧩 允许与其他脚本并写 MVU（1.83.0，opt-in，默认关；Prince 2026-09-15）。卡自带的回合后引擎（世界推进 / 核验脚本）
    // 会在自动诊断「拍指纹 → 模型往返 → 写入」的窗口里合法改写 stat_data，整份指纹闸于是每回合都判陈旧。开时
    // 状态指纹对不上不再整份作废：按路径逐条裁，落在没被别人动过的路径上的 op 照写（写在现态之上），冲突的丢弃并在
    // 记录里点名（autoApplyFix 第 6 参 coWrite）。关着 = 1.64.0 整份指纹闸逐字节不变。
    autoDiagnoseCoWrite: false,
    // 🔁 失败自动重试（Prince 点单 2026-08-28，默认关——每次重试都是一次真金白银的模型调用）：
    // 自动诊断这一轮没跑成时自动再试。Max = 次数上限（用户可输入，2 只是默认；经 diagRetryMax
    // 消毒后钳 [1,99]）；三枚分类勾选框独立组合（空白回复 / 格式错误 / 调用失败），全勾是「开主
    // 开关即生效」的种子。成功 / 无需改动 / 安全跳过恒不重试——判据全集见 diagRetryCategory。
    autoDiagnoseRetry: false,
    autoDiagnoseRetryMax: 2,
    autoDiagnoseRetryOnEmpty: true,
    autoDiagnoseRetryOnFormat: true,
    autoDiagnoseRetryOnError: true,
    // 🩺 把诊断修正写进正文（ENABLE_DIAG_BODY_INJECT，默认关；1.65.0 起 UI 上不再标「实验性」、行住在诊断设置栏）。开了才会动消息正文；
    // 关着时核验（甲）分支的行为与 1.40.2 逐字节相同。详见该开关处的长注释。
    diagInjectBody: false,
    // ✨ 自动校正 ↔ MVU「额外模型更新」抢写协调（opt-in，默认关）。开启后校正【照常立刻并行跑】——只在【落新 swipe
    // 之前】等 MVU 的额外模型解析写完（awaitMvuIdle 轮询 isDuringExtraAnalysis），再把它注入的机制块接到校正稿末尾
    // （mergeMvuTail），两者不抢写同一条消息、且几乎不增加等待。只有【用 MVU 额外模型更新】的人需要开；不用的保持
    // 关 = 现行行为字节不变（无 MVU / MVU 不忙时 awaitMvuIdle + mergeMvuTail 都是即时空操作）。
    fixWaitForMvu: false,
    // ✨ 校正：首次切到「自动校正」时弹一次性提醒（讲清标签块 <sceneinfo>/<details> 的留存要靠排除区·保留）。
    // 与 autoDiagnoseWarned 同款一次性警告：勾「不再提示」后置真，从此不再弹。
    autoFixWarned: false,
    customFixWarned: false,   // 📋 首次关掉「沿用识别」的一次性确认已出过
    worldInfoMode: 'off',      // 'off' | 'st' (constant + keyword) | 'all' (every entry)
    // 世界书 EJS 渲染（ENABLE_WI_EJS_RENDER，opt-in，默认关）：开了才在神谕读世界书（普通 / 参谋 / 手动校正）时
    // 执行条目里的 <% %> 模板（需已装「提示词模板」ST-Prompt-Template）。含【写变量】的模板会被额外执行、可能
    // 影响卡内变量，故默认关；未装该扩展时开着也自动按原样读取（零副作用）。
    wiRenderEjs: false,
    // 读取隐藏楼层（用户功能请求）：默认关。开启后神谕读取主聊天时也纳入被 /hide 隐藏的消息。
    // 只影响「神谕读取对话记录」的所有模式；不影响世界书关键词扫描。
    includeHiddenFloors: false,
    sendTemperature: true,     // include temperature in the request (some models reject it)
    // 1.45.0 窗口配色：'dark' | 'light' | 'theme'（跟随酒馆主题 = 1.44.x 及以前的行为）。
    // 这里写 'dark' 是给【全新安装】的默认；老档由 getSettings 里的一次性迁移补 'theme'，
    // 那段跑在本循环之前，所以老用户读不到这个默认值。
    windowSkin: 'dark',
    showQrButton: true,        // 精简版 1.2：输入框上方快捷回复栏（「柏宝书」那一排）里放一个「剧情推进」文字按钮；默认开
    showChatBarButton: false,  // 用户功能请求：在 ST 聊天输入栏（☰ 旁）放一个 🌙 快捷按钮一键开 / 关神谕窗口；默认关、设置里开
    // 用户功能请求（1.48.0）：点击窗外（酒馆正文等非本扩展区域）自动收起神谕窗。默认关＝行为字节不变；
    // 收起只是隐藏（toggleWindow(false)），一切状态保留，从魔杖 / 🌙 再点开即恢复。
    clickOutsideClose: false,
    // ✂️ 选段校正快捷按钮：放在输入框【上方】那一排（快速回复条）。默认关；开关在【校正设置 → 手动】里。
    fixSelBarButton: false,
    // ✂️ 最新一条 AI 回复右上角的选段按钮（1.42.0 起一直常驻）。1.77.0 用户请求——可藏起来；
    // 默认【开】= 与 1.76.0 行为相同。改成默认关就是「真 opt-in」，一行的事（等产品负责人拍板）。
    fixSelRowButton: true,
    // A5：把 ⋯ 工具菜单里的项搬到标题栏（省一次点击）。默认关——⋯ 菜单留给未来的小模式。原生化自二创 tools-expand。
    toolsInHeader: false,
    // A6：连接预设（端点 URL + API 密钥 + 模型 的命名快照，随时切换服务商）。原生化自二创 connection-presets。
    connPresets: [],
    // 精简版 1.2.1：最近一次载入 / 保存的存档名。改了模型等字段后，靠它知道「当前连接是在哪个存档上改的」，
    // 才能显示「已修改」并一键保存回去（否则四项一不全同，就只能认成「未存档」）。
    connPresetActive: '',
    // Lorebook mode: which book(s) to load. '' = every currently-active book;
    // otherwise the exact name of a single world book.
    lorebookTarget: '',
    // 世界书多选（用户功能请求）：lorebook 模式要操作哪些书。[] = 当前激活的全部世界书；
    // 否则就是选中的那几本书名。旧的标量 lorebookTarget 仅用于一次性迁移（见 getSettings）。
    lorebookTargets: [],
    // lbEntrySel：世界书模式选条目器每本书的选择持久化（lbEntryFilter 的可存形态）：{ [书名]: number[] }。
    //   键存在 = 显式选择（空数组 = 一条不发）；键缺席 = 发送整本。1.40.1 起跨重载保留
    //   （live 用户报「选完条目下次回来又要重选」——书本身早就由 lorebookTargets 记着了，
    //   唯独条目选择只活在内存里）。形态与语义与工坊的 bldEntrySel 完全一致。
    lbEntrySel: {},
    // Whether lorebook mode also feeds the recent story transcript as context
    // (off by default — lorebook mode focuses on the books, not the RP).
    lorebookIncludeStory: false,
    // 用户功能请求：世界书选条目器里展示每条条目的内容预览（一行短摘要）。默认关——开后
    // 整列每条标题下多一行 entryPreviewText(content)；纯展示，不影响喂给模型的内容。
    lbShowEntryPreview: false,
    // Whether lorebook mode runs THROUGH the user's curated chat-completion preset
    // (the lore-manager directive is layered on top). Off by default — only useful
    // when the model needs the preset's jailbreak to do the edit. The preset's
    // extra content can pull attention off the editing task.
    lorebookUsePreset: false,
    // 诊断模式是否经用户策展的补全预设发送（1.43.0）。默认关——只有模型拒绝做这次
    // 变量审计时才需要预设里的越狱。手动诊断与自动诊断【共用】这一个开关（两条路共用
    // 同一个提示词构建器与同一套精选条目，没有校正那种手动/自动分家的基础）。
    // 内置破限（哨兵）也跟着它走 —— 见 modeWantsJb。
    diagnoseUsePreset: false,
    ...(ENABLE_SCHEMA_DIAG ? { diagSchemaRetry: true } : {}),   // 🩺 1.89.0：卡片规则拒绝时让模型按原因重写一次（多花一次调用）；旗关不多一个键
    // 角色工坊（Task 4）——全局设置（不进 per-chat 覆盖）。
    // bldTarget：打造目标。'persona' = 写进 Persona；'npc' = 写进世界书条目。
    // bldBooks：选条目器的世界书多选（同 lorebookTargets 语义：[] = 当前激活的全部）。
    // bldDepth：上下文深度。-1 = 全部，0 = 不带，正数 = 最近 N 条。
    // bldIncludeSummary / bldIncludeStat：是否带上 📜剧情概要 / 状态栏数据（stat_data）。
    // bldSections：草稿要覆盖的部分。null = 用 BUILDER_SECTIONS 里 def:true 的那些；否则显式 id 数组。
    // bldEntrySel：选条目器每本书的选择持久化（bldEntryFilter 的可存形态）：{ [书名]: number[] }。
    //   键存在 = 显式选择（空数组 = 一条不发）；键缺席 = 发送整本。跨重载保留（T12 复审后 UX 请求）。
    // bldTarget：打造目标。'npc' = NPC 世界书条目；'persona-steal' = 用户角色·抢话（AI 也扮演{{user}}）；
    // 'persona-nosteal' = 用户角色·不抢话（AI 只回应）。旧值 'persona' 由 getSettings 归一成 nosteal。
    bldTarget: 'persona-nosteal',
    bldBooks: [],
    bldDepth: 60,
    bldIncludeSummary: true,
    bldIncludeStat: true,
    // bldScanWi（1.31.0，默认关）：额外跑一次 ST 关键词扫描（蓝灯 + 主聊天/卡/工坊侧聊命中的绿灯），
    // 命中而【未被选条目器投喂】的条目作参考补充块。默认关 = 选条目器仍是唯一世界书来源（所见即所得契约）。
    bldScanWi: false,
    // 台词丰满（1.34.0，默认关）：锻造追加 DLG_RICH_RIDER——台词写成完整人话（对各模型全验证；
    // 默认关 = 发送字节与 1.33.0 逐字节一致）。
    bldDlgRich: false,
    bldSections: null,
    // 三变体各自的 chip 选择（bldSections 归 card 变体沿用旧键，零迁移）。null = 各自表里 def:true 的那些。
    bldSectionsSteal: null,
    bldSectionsNosteal: null,
    bldEntrySel: {},
    // 锻造调用的 max_tokens 下限自动为 16384（1.23.0 起 12288、1.29.0 起 16384）；超大世界书致「思考 + 成稿」被截断时可调高（T13）。
    // 原始字符串（同 bldDepth 之外的 UX），空串 = 自动。runForge 里 Number(...)||0 兜底。
    bldMaxTokens: '',
    // ✂️ 锻造后自动精简（轻精简层，1.30.0）。默认关（spec §4.4）；只在 npc-* 且原稿风格门点火
    //（叙述句中位 >28 字或 >50 字句占比 >10%）且 ≥2500 字时，锻造成功后静默补一发精简。
    bldAutoCondense: false,
    // 校正调用输出上限（Tier 0 ③，1.25.0）：空 = 自动（地板 4096）；长楼层改写被截断、校正总失败时可顶高（如 8192/12288）。
    // 全局（非 per-chat、不进 FIX_CFG_KEYS）——服务商单次输出上限是账号级的、与聊天无关。fixEffMaxTokens 读，Number(...)||0 兜底。
    fixMaxTokens: '',
    // 访谈对话是否经【设置面板策展的补全预设】发送（文本块保留、RP 标记去除、工坊指令注入历史位）——
    // 同 lorebookUsePreset / advisorUsePreset 的 opt-in 模式；默认关。锻造调用永不经预设（始终用内置工序）。
    bldUsePreset: false,
    // Advisor mode (experimental): depth at which the adopted plan's directive
    // is injected into the MAIN chat prompt (in-chat, system role). ~4 reads as
    // "ambient narrative intent" — too shallow railroads, too deep gets buried.
    advisorDepth: 4,
    // 剧情脉络（2.5.0）：后面节点的「详细」什么时候写。'all' = 参谋出方案时一次写全（不多花调用）；
    // 'later' = 只写第 1 个，轮到下一个节点时参谋按已经演出来的剧情补写（每换一个节点多一次调用）。
    advisorNodeDetail: 'all',
    // Whether advisor mode runs THROUGH the curated preset (directive layered on
    // top, RP markers skipped) — same opt-in pattern as lorebookUsePreset.
    advisorUsePreset: false,
    // 引导条（剧情引导运行时的 #pad-plan-bar）停靠窗口内时默认【收起】——只留标题行，省纵向空间、
    // 不挡聊天视图（用户反馈）；点标题栏箭头可展开，选择会记住。浮窗版有自己的折叠机制，不受此项影响。
    planBarCollapsed: true,
    // ✨ 校正模式（手动 + 自动）是否经【自定义补全预设】发送——仅破限 / 越狱用（同 advisorUsePreset 模式：保留预设的
    // 文本块 + 角色、跳过 RP 内容标记，把校正调用塞到 chatHistory 位）。默认关；全局（不进 per-chat 覆盖）。
    fixM_usePreset: false, fixA_usePreset: false, fixC_usePreset: false,
    // Floating plan strip position (when the oracle window is closed while a
    // plan is steering). null = default top-right docking until first drag.
    planFloatLeft: null,
    planFloatTop: null,
    planFloatCollapsed: false,  // float folded down to a tiny 「🧭 引导中」 pill
    // window geometry
    winLeft: null,
    winTop: null,
    winWidth: 380,
    winHeight: 540,
};

export function getCtx() {
    return getHostContext();
}

// 统一「确定吗？」弹窗：优先用 ST 自带的主题化弹窗（手机 / PC 一致，在 PWA / 应用内浏览器里也可靠），
// 不可用时（极旧的 ST 或单测 jsdom 环境）回退到浏览器原生 confirm。返回 Promise<boolean>。破坏性操作
// （清空侧聊 / 清空概要 / 重置提示词 / 放弃序列）共用，替代原生 confirm() 在手机上那个出戏的裸系统框。
export async function uiConfirm(message) {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM, '', {
                okButton: '确定',
                cancelButton: '取消',
            });
            return Boolean(result); // AFFIRMATIVE=1 → true；取消 / 关闭 → null|0 → false
        }
    } catch (e) {
        console.warn('[剧情推进] uiConfirm 弹窗失败，回退原生 confirm：', e);
    }
    return typeof confirm === 'function' ? confirm(message) : true;
}

// 统一文本输入弹窗（同 uiConfirm 风格）：优先 ST 主题化 INPUT 弹窗，不可用时回退原生 prompt。
// 返回 Promise<string|null>：取消 / 关闭 → null（ST 取消回 false，统一收敛成 null）。套餐「保存为…」起名用。
export async function uiPrompt(message, defaultValue = '') {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, defaultValue, {
                okButton: '确定',
                cancelButton: '取消',
            });
            // INPUT：确定回输入字符串（可能空串）；取消 / 关闭回 false / null。
            return (result === false || result == null) ? null : String(result);
        }
    } catch (e) {
        console.warn('[剧情推进] uiPrompt 弹窗失败，回退原生 prompt：', e);
    }
    return typeof prompt === 'function' ? prompt(message, defaultValue) : null;
}


// 破坏性删除的确认文案（1.22.0，原生化自二创的删除二次确认）。纯函数 → 单测。
// kind：'preset' 连接预设｜'userPair' 提问且其后紧跟神谕回复（成对删）｜'user' 单独提问｜'assistant' 回复。
export function soDeleteConfirmMessage(kind, name) {
    if (kind === 'preset') return `删除连接存档「${name || ''}」？此操作无法撤销。`;
    if (kind === 'userPair') return '删除这条提问？它下面的剧情推进回复会一并删除，且无法撤销。';
    if (kind === 'user') return '删除这条提问？此操作无法撤销。';
    return '删除这条回复？此操作无法撤销。';
}

export function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
        ctx.extensionSettings[MODULE] = {};
    }
    const s = ctx.extensionSettings[MODULE];
    // 一次性迁移：窗口配色（1.45.0）。新装默认【深色】（固定不透明，不受主题毛玻璃影响）；
    // 但老用户的窗口一直跟着酒馆主题走，升级不该悄悄改掉他们的外观 —— 老档补写 'theme'。
    // 判据 = 进函数时设置对象是否为空（空 = 全新安装）。装了扩展但从未触发过任何一次
    // save() 的人与全新安装无从区分，Prince 2026-07-29 定案：就按新用户处理，不为此
    // 引入「我见过你」持久标记。
    // 必须在下面的默认值填充【之前】：那个循环会先把 'dark' 写进去，之后就判不出新旧档了。
    const soFreshInstall = Object.keys(s).length === 0;
    if (s.windowSkin === undefined) s.windowSkin = soFreshInstall ? 'dark' : 'theme';
    // 退役的设置键（落拍感应 1.3.0、下一拍建议 2.3.0）清掉；提示词覆盖里已经不再登记的条目（改版换掉的旧提示词，
    // 如 2.5.0 剧情脉络之前序列 / 单拍的那几条）同样清掉，免得留在设置里永远用不上。
    for (const k of ['seqPulse', 'nextBeatEnabled', 'nextBeatAuto', 'nextBeatTemplate', 'nextBeatMaxChars']) delete s[k];
    if (s.promptOverrides && typeof s.promptOverrides === 'object') {
        try {
            for (const id of Object.keys(s.promptOverrides)) if (!promptDef(id)) delete s.promptOverrides[id];
        } catch (e) { /* 提示词注册表还没就绪（模块求值期间被调用）：下次再清 */ }
    }
    // 1.2.1 之前没记过「当前存档」：老档第一次读到时，先认四项全同的；认不出，再认「只有模型不同」的
    // 那一个（升级前就改过模型的老档也能直接「保存到此存档」）；这样的候选不唯一就不猜，留空。
    if (s.connPresetActive === undefined) {
        const list = (Array.isArray(s.connPresets) ? s.connPresets : []).filter(Boolean);
        let hit = list.find((p) => connPresetIsCurrent(p, s));
        if (!hit && s.mode === 'direct') {
            const near = list.filter((p) => (p.endpoint || '') === (s.endpoint || '')
                && (p.apiKey || '') === (s.apiKey || '') && !!p.rawUrl === !!s.directRawUrl);
            if (near.length === 1) hit = near[0];
        }
        s.connPresetActive = hit ? hit.name : '';
    }
    // 一次性迁移（须在填默认值之前——否则下面的默认填充会先把分家键设成 false，迁移就判不出旧值）：
    // 旧版单个全局 fixUsePreset（手动 + 自动共用）→ 手动/自动分家的 fixM_/fixA_usePreset；删旧键，幂等。
    if (s.fixUsePreset !== undefined) {
        if (s.fixM_usePreset === undefined) s.fixM_usePreset = s.fixUsePreset;
        if (s.fixA_usePreset === undefined) s.fixA_usePreset = s.fixUsePreset;
        delete s.fixUsePreset;
    }
    // Fill in any missing defaults IN PLACE so the reference stays stable.
    // (Rebuilding the object here would orphan the values written by event handlers.)
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = v;
    }
    // 2.4.0：旧连接存档没有高级选项 / 生成参数，用此刻的当前值补上（刚升级时切换效果不变，之后各存各的）。
    if (Array.isArray(s.connPresets)) {
        for (const p of s.connPresets) {
            if (!p || typeof p !== 'object') continue;
            for (const k of CONN_PRESET_KEYS) if (!(k in p)) p[k] = s[k];
        }
    }
    // 一次性迁移：旧版单选 lorebookTarget（标量）→ 新版多选 lorebookTargets（数组）。
    // 迁移后清空标量，使本块幂等、不会在用户清空多选（= 全部激活）后又被旧值重新种回。
    if (typeof s.lorebookTarget === 'string' && s.lorebookTarget &&
        (!Array.isArray(s.lorebookTargets) || s.lorebookTargets.length === 0)) {
        s.lorebookTargets = [s.lorebookTarget];
        s.lorebookTarget = '';
    }
    // 迁移（幂等）：退役 chip 从已保存的 bldSections 里滤掉（面板已不显示它，留着会隐形生效且无法取消）。
    s.bldSections = sanitizeBldSections(s.bldSections);
    // 打造目标归一：旧档 'persona' → 'persona-nosteal'；仅在分家开关开启时生效（关着时旧值原样保留）。
    if (BUILDER_NPC_ONLY) s.bldTarget = 'npc';                                // 只保留 NPC：一切旧目标（含 persona-*）归 npc
    else if (ENABLE_BUILDER_PERSONA_STYLES) s.bldTarget = normalizeBldTarget(s.bldTarget);
    // 提示词覆盖表（精简版）：不放进 defaults——那样会按引用把同一个对象塞给设置，写它就污染 defaults。
    if (!s.promptOverrides || typeof s.promptOverrides !== 'object' || Array.isArray(s.promptOverrides)) s.promptOverrides = {};
    // 自定义人格归一（幂等）：坏形条目丢弃、超限截断——UI 与解析读到的恒是干净数组。
    s.customPersonas = normalizeCustomPersonas(s.customPersonas);
    // ⚡ 快捷指令（二创版 2.2）：缺键 = 预置那几条（给本设置对象自己的新数组，改它不会污染 QP_DEFAULTS）；
    // [] = 用户删光了，不再补（「↺ 补回预置的」可手动补）。坏形条目在读的地方过滤，这里不重建数组——
    // 管理页的输入框直接改数组里的对象，重建会让它们改到旧对象上。
    if (!Array.isArray(s.quickPrompts)) s.quickPrompts = QP_DEFAULTS.map((q) => ({ ...q }));
    else if (s.quickPrompts.length > QP_MAX) s.quickPrompts.length = QP_MAX;
    for (const q of s.quickPrompts) {   // 没改过的预置跟着版本更新（原地改对象，不重建数组）
        const old = q && QP_DEFAULT_OLD_TEXTS[q.id];
        if (old && old.includes(q.text)) q.text = QP_DEFAULTS.find((d) => d.id === q.id).text;
    }
    // 📋 模板库归一（幂等）：坏形 / 空名 / 重名条目清掉；顺带把 defaults 里那个【按引用赋过来的空数组】
    // 换成本设置对象自己的新数组——否则往它里面写会顺着引用污染 defaults（同 customPersonas 那行的用意）。
    s.fixTemplates = normalizeFixTemplates(s.fixTemplates);
    return s;
}

export function save() {
    getCtx().saveSettingsDebounced();
}

// A6：连接预设——把「端点 URL + API 密钥 + 模型 + 地址原样开关」存成命名快照，随时切换服务商；2.4.0 起
// 高级选项与生成参数（CONN_PRESET_KEYS）也一起存。
// connPresetUpsert / connPresetRemove 是纯函数（按 name 唯一、返回新数组、不原地改），进 EXPORT_NAMES 单测。
// rawUrl（1.22.0）随预设走：同一地址在「原样 / 自动补 /v1」两种含义下不串味；旧预设缺省 false = 保存当时的行为。
// 同名存档原位替换（1.2.1：「保存到此存档」后列表顺序不变；以前是删掉再追加到末尾）。
export function connPresetUpsert(list, preset) {
    const item = { name: preset.name, endpoint: preset.endpoint || '', apiKey: preset.apiKey || '', model: preset.model || '', rawUrl: !!preset.rawUrl };
    for (const k of CONN_PRESET_KEYS) if (preset[k] !== undefined) item[k] = preset[k];
    const arr = [];
    let placed = false;
    for (const p of (Array.isArray(list) ? list : [])) {
        if (!p) continue;
        if (p.name === preset.name) {
            if (!placed) { arr.push(item); placed = true; }   // 重名的残档顺手收敛成一条
            continue;
        }
        arr.push(p);
    }
    if (!placed) arr.push(item);
    return arr;
}
// 当前设置里要存进存档的那些项（存为新存档、保存到此存档共用）。
export function connPresetSnapshot(s) {
    const snap = { endpoint: s.endpoint || '', apiKey: s.apiKey || '', model: s.model || '', rawUrl: !!s.directRawUrl };
    for (const k of CONN_PRESET_KEYS) snap[k] = s[k];
    return snap;
}
// 存档里的值和当前设置是否相同。数字框清空时是 NaN，存盘再读回来是 null，都算「空」。
export function connValSame(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
// 当前设置是否就是这个存档：旧存档只比较它实际保存过的可选项。
export function connPresetIsCurrent(p, s = getSettings()) {
    return !!p && s.mode === 'direct'
        && (p.endpoint || '') === (s.endpoint || '') && (p.apiKey || '') === (s.apiKey || '')
        && (p.model || '') === (s.model || '') && !!p.rawUrl === !!s.directRawUrl
        && CONN_PRESET_KEYS.every((key) => !(key in p) || connValSame(p[key], s[key]));
}
function connPresetRemove(list, name) {
    return (Array.isArray(list) ? list : []).filter((p) => p && p.name !== name);
}
export function renderConnPresets() {
    if (!win) return;
    const box = win.querySelector('#pad-conn-preset-list');
    if (!box) return;
    const s = getSettings();
    const presets = s.connPresets || [];
    box.innerHTML = '';
    if (!presets.length) {
        connPickerOpen = false;
        connPickerQuery = '';
        const empty = document.createElement('div');
        empty.className = 'pad-hint';
        empty.textContent = '还没有存档。填好下面的端点、密钥和模型后，在这里起个名字存起来，以后一键切换。';
        box.appendChild(empty);
        return;
    }
    const st = connPresetState(s);
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'pad-preset-head';
    head.setAttribute('aria-haspopup', 'listbox');
    head.setAttribute('aria-expanded', connPickerOpen ? 'true' : 'false');
    head.title = connPickerOpen ? '收起存档列表' : '展开存档列表，点哪个就用哪个';
    head.innerHTML = '<span class="pad-preset-main"><span class="pad-preset-name"></span><span class="pad-preset-sub"></span></span>'
        + `<span class="pad-preset-count">${presets.length} 个存档</span><i class="fa-solid fa-chevron-down"></i>`;
    const nameEl = head.querySelector('.pad-preset-name');
    nameEl.textContent = st ? st.preset.name : '当前连接未存档';
    if (st && st.modified) {
        const tag = document.createElement('span');
        tag.className = 'pad-preset-dirty';
        tag.textContent = '已修改';
        nameEl.appendChild(tag);
    }
    // 副标题显示的是【当前】连接：改过的模型也看得见
    head.querySelector('.pad-preset-sub').textContent = st
        ? [s.model || '（未填模型）', s.endpoint].filter(Boolean).join(' · ')
        : (s.mode === 'profile' ? '正在用酒馆连接配置文件' : (s.model || '未设置模型'));
    head.addEventListener('click', (e) => {
        // 头部会被重画成新节点：别让 document 上的「点别处收起」把刚打开的弹出框又关掉
        e.stopPropagation();
        if (connPickerOpen) { closeConnPicker(); return; }
        connPickerOpen = true;
        renderConnPresets();
    });
    // 弹出框挂在 anchor 上（紧贴存档栏下沿），盖住下面的「已修改」提示条和设置，不挤压它们
    const anchor = document.createElement('div');
    anchor.className = 'pad-preset-anchor';
    anchor.appendChild(head);
    box.appendChild(anchor);
    if (st && st.modified) box.appendChild(buildConnDirtyBar(st.preset));
    if (!connPickerOpen) return;

    const pop = document.createElement('div');
    pop.className = 'pad-preset-dropdown';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'pad-preset-search';
    search.placeholder = '搜索名称或模型…';
    search.value = connPickerQuery;
    const rows = document.createElement('div');
    rows.className = 'pad-preset-rows';
    rows.setAttribute('role', 'listbox');
    for (const p of presets) {
        const on = connPresetIsCurrent(p, s);
        const edited = !on && !!st && st.modified && st.preset.name === p.name;   // 当前连接是在它上面改的
        const row = document.createElement('div');
        row.className = 'pad-preset-opt' + (on || edited ? ' current' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        row.dataset.q = [p.name, p.model, p.endpoint].filter(Boolean).join(' ').toLowerCase();
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'pad-preset-pick';
        pick.title = on ? '正在使用' : (edited ? `丢掉改动，还原成「${p.name}」里存的设置` : `切换到「${p.name}」`);
        pick.innerHTML = '<span class="pad-preset-mark"></span><span class="pad-preset-main"><span class="pad-preset-name"></span><span class="pad-preset-sub"></span></span>';
        pick.querySelector('.pad-preset-mark').innerHTML = on ? '<i class="fa-solid fa-check"></i>'
            : (edited ? '<i class="fa-solid fa-pen" title="当前连接基于它，但改过"></i>' : '');
        pick.querySelector('.pad-preset-name').textContent = p.name;
        const sub = pick.querySelector('.pad-preset-sub');
        sub.textContent = [p.model || '（未填模型）', p.endpoint].filter(Boolean).join(' · ');
        sub.title = sub.textContent;
        pick.addEventListener('click', () => {
            connPickerOpen = false;
            connPickerQuery = '';
            renderConnPresets();                 // 先收起；切换（可能先弹确认）成功后经 updateBadge 再重画
            if (!on) switchConnPreset(p.name);
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'pad-icon-btn';
        del.title = `删除存档「${p.name}」`;
        del.innerHTML = '<i class="fa-solid fa-trash"></i>';
        del.addEventListener('click', async () => {
            if (!(await uiConfirm(soDeleteConfirmMessage('preset', p.name)))) return;   // 1.22.0：删除二次确认
            getSettings().connPresets = connPresetRemove(getSettings().connPresets, p.name);
            if (getSettings().connPresetActive === p.name) getSettings().connPresetActive = '';
            save();
            renderConnPresets();
            renderModelBar();
        });
        row.append(pick, del);
        rows.appendChild(row);
    }
    const none = document.createElement('div');
    none.className = 'pad-preset-none';
    none.textContent = '没有匹配的存档';
    rows.appendChild(none);
    const filter = () => {
        connPickerQuery = search.value;
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const row of rows.querySelectorAll('.pad-preset-opt')) {
            row.hidden = !!q && !row.dataset.q.includes(q);
            if (!row.hidden) shown++;
        }
        none.hidden = shown > 0;
    };
    search.addEventListener('input', filter);
    search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;   // 回车 = 选第一个匹配项
        e.preventDefault();
        const first = [...rows.querySelectorAll('.pad-preset-opt')].find((r) => !r.hidden);
        if (first) first.querySelector('.pad-preset-pick').click();
    });
    filter();
    pop.append(search, rows);
    anchor.appendChild(pop);
    // 桌面上直接把光标放进搜索框；触屏不聚焦，免得弹出软键盘把窗口挤走（同 focusOracleInput）
    const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
    if (!coarse) search.focus();
}
// 「已修改」提示条：当前连接和最近用的存档不一致时，出现在存档栏下面。
function buildConnDirtyBar(p) {
    const bar = document.createElement('div');
    bar.className = 'pad-preset-dirtybar';
    const msg = document.createElement('span');
    msg.className = 'pad-preset-dirtymsg';
    msg.textContent = `当前连接改过，和存档「${p.name}」不一样了`;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'pad-conn-preset-update';
    saveBtn.className = 'pad-mini-btn pad-primary';
    saveBtn.textContent = '保存到此存档';
    saveBtn.title = `把现在的端点、密钥、模型、高级选项和生成参数写回「${p.name}」`;
    saveBtn.addEventListener('click', () => saveToActiveConnPreset());
    const revert = document.createElement('button');
    revert.type = 'button';
    revert.id = 'pad-conn-preset-revert';
    revert.className = 'pad-mini-btn';
    revert.textContent = '还原';
    revert.title = `丢掉改动，恢复「${p.name}」里存的设置`;
    revert.addEventListener('click', () => applyConnPreset(p.name));
    bar.append(msg, saveBtn, revert);
    return bar;
}
export function closeConnPicker() {
    if (!connPickerOpen) return;
    connPickerOpen = false;
    connPickerQuery = '';
    renderConnPresets();
}

// 输入框上方的切换栏：一颗药丸显示当前连接，点开列出连接存档，点一下就切换。
/* ------------------------------------------------------------------ *
 * ⚡ 快捷指令（二创版 2.2）：存好的话，一键发给当前模式。显示在输入框上方、模型右边：
 * 宽窗口直接排成一行（点名字 = 直接发送；放不下就左右滑，⋯ 打开完整列表）；窄窗口 / 手机收成一个
 * 「⚡ 快捷指令」按钮，点开往上弹出列表（行尾 ✎ = 先填进输入框改一改再发）。宽窄按模型栏自身的宽度判断
 * （CSS 容器查询 pad-mbar），不按设备。每个模式只显示自己的；管理在设置的「快捷指令」页。
 * 存在 settings.quickPrompts = [{ id, mode, label, text }]：缺键 = 预置（QP_DEFAULTS），[] = 用户删光了、不再补。
 * text 里的 {{user}} / {{char}} 等宏在发送 / 填入时才展开，所以同一条指令换卡也能用。
 * ------------------------------------------------------------------ */
const QP_MODES = [
    ['chat', '普通聊天'], ['diagnose', '诊断'], ['lorebook', '世界书'],
    ['advisor', '剧情参谋'], ['fix', '校正'], ['builder', '角色工坊'],
];
const QP_MAX = 60;
export const QP_DEFAULTS = [
    // 用户反馈（西幻 / 穿越卡总冒古风词）：一步到位的手动校正。外来者例外与用户预设「西幻去中化」条目一致；
    // 不点名任何角色（2.2.1：原先写死「{{user}} 和系统」，换到用户是本地人的卡上反而会漏改用户的台词）。
    { id: 'qp-kill-archaic', mode: 'fix', label: '杀古风',
        text: '杀古风：按当前所在的世界（看正文里的地名、人名、风物判断），一次改完这条回复。\n- 不动：外来者——穿越者、宿主、系统、异界来客等不属于这个世界的人或存在——的对白与内心活动，以及他们从别的世界带来的能力、法宝、功法名（写在旁白里也一样）；当前世界自己的专有名词；设定里本来就有的东方元素。谁是外来者，看角色卡、世界书和正文判断。\n- 要改：本地人物的对白和旁白里混进来的中式自称与称谓（妾身、奴婢、小的、老爷、公子、姑娘、掌柜、客官……）、宫廷奴仆腔（谨遵、请缨、听凭发落、差遣、恩典、谢恩……）、古白话语气词（罢了、也罢、莫要、休得……）、中式计时货币度量（时辰、一炷香、银两、尺、丈……）、中式宗教用语（老天爷、菩萨、阎王……）、带中国历史典故的成语，换成这个世界的人会用的说法；原作或设定自带的说法优先（货币、度量、神名、称谓按原作来，比如 DnD 的世界用金币、英尺和当地神祇的名字）。\n- 只换词，剧情、动作、语气和句子结构不变；拿不准的保留原样。当前世界本来就是东方 / 古风背景的话，原样返回。' },
];
// 预置条目的旧版文本（按 id）。用户的副本还是某个旧版原文 = 没改过 → 读设置时换成当前版本（同提示词注册表：
// 没改过的跟着版本走，改过的一个字都不动）。
const QP_DEFAULT_OLD_TEXTS = {
    'qp-kill-archaic': [
        '杀古风：按当前所在的世界（看正文里的地名、人名、风物判断），一次改完这条回复。\n- 不动：{{user}}和系统的对白与内心活动；{{user}}从别的世界带来的能力、法宝、功法名（写在旁白里也一样）；当前世界自己的专有名词；设定里本来就有的东方元素。\n- 要改：本地人物的对白和旁白里混进来的中式自称与称谓（妾身、奴婢、小的、老爷、公子、姑娘、掌柜、客官……）、宫廷奴仆腔（谨遵、请缨、听凭发落、差遣、恩典、谢恩……）、古白话语气词（罢了、也罢、莫要、休得……）、中式计时货币度量（时辰、一炷香、银两、尺、丈……）、中式宗教用语（老天爷、菩萨、阎王……）、带中国历史典故的成语，换成这个世界的人会用的说法；原作自带的说法优先（比如被遗忘的国度用金币、英尺、费伦诸神的名字）。\n- 只换词，剧情、动作、语气和句子结构不变；拿不准的保留原样。当前世界本来就是东方 / 古风背景的话，原样返回。',   // 2.2.0
        '杀古风：按当前所在的世界（看正文里的地名、人名、风物判断），一次改完这条回复。\n- 不动：{{user}} 和系统的对白与内心活动；{{user}} 从别的世界带来的能力、法宝、功法名（写在旁白里也一样）；当前世界自己的专有名词；设定里本来就有的东方元素。\n- 要改：本地人物的对白和旁白里混进来的中式自称与称谓（妾身、奴婢、小的、老爷、公子、姑娘、掌柜、客官……）、宫廷奴仆腔（谨遵、请缨、听凭发落、差遣、恩典、谢恩……）、古白话语气词（罢了、也罢、莫要、休得……）、中式计时货币度量（时辰、一炷香、银两、尺、丈……）、中式宗教用语（老天爷、菩萨、阎王……）、带中国历史典故的成语，换成这个世界的人会用的说法；原作自带的说法优先（比如被遗忘的国度用金币、英尺、费伦诸神的名字）。\n- 只换词，剧情、动作、语气和句子结构不变；拿不准的保留原样。当前世界本来就是东方 / 古风背景的话，原样返回。',   // 2.2.0 测试期
    ],
};

   // 设置「快捷指令」页当前在看哪个模式；null = 跟随当前模式

export function managedQuickPromptMode(fallback) {
    return qpManageMode || fallback;
}
function qpModeLabel(mode) {
    const m = QP_MODES.find((x) => x[0] === mode);
    return m ? m[1] : mode;
}
export function qpNewId() {
    return 'qp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
// 这个模式下能用的（内容为空的条目——比如管理页里刚新建、还没写完的——不上栏）。
function qpForMode(mode, s = getSettings()) {
    return (Array.isArray(s.quickPrompts) ? s.quickPrompts : [])
        .filter((q) => q && q.mode === mode && typeof q.text === 'string' && q.text.trim());
}
// 发送 / 填入前展开 {{user}} 等宏。
function qpText(q) {
    const raw = String((q && q.text) || '').trim();
    try { return getCtx().substituteParams(raw); } catch (e) { return raw; }
}
export function closeQpMenu() {
    if (!qpMenuOpen) return;
    qpMenuOpen = false;
    renderModelBar();
}
// 点名字：直接发送。输入框里原来写了一半的话先让开、发完放回去（onSend 的同步段就读走并清空输入框）。
// 正在生成时不发——此时按发送键的语义是「停止生成」，快捷指令绝不能顺手把它停掉。
async function qpSend(q) {
    qpMenuOpen = false;
    renderModelBar();
    if (!inputEl) return;
    if (isGenerating) {
        try { const toastr = getHostGlobal('toastr'); toastr && toastr.info && toastr.info('剧情推进还在回复，等它说完再点。', '快捷指令'); } catch (e) { /* toastr 缺席 */ }
        return;
    }
    const text = qpText(q);
    if (!text) return;
    const draft = inputEl.value;
    inputEl.value = text;
    const sending = onSend();
    if (draft.trim() && !inputEl.value) { inputEl.value = draft; autoGrowInput(); }
    await sending;
}
// 点 ✎：填进输入框（已有文字时另起一行接在后面），改一改再发。
function qpFill(q) {
    qpMenuOpen = false;
    renderModelBar();
    if (!inputEl) return;
    const text = qpText(q);
    const cur = inputEl.value;
    inputEl.value = cur.trim() ? cur.replace(/\s+$/, '') + '\n' + text : text;
    autoGrowInput();
    inputEl.focus();
    try { inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); } catch (e) { /* ignore */ }
}
// 把输入框里的话存成当前模式的一条快捷指令。
async function qpSaveFromInput() {
    qpMenuOpen = false;
    renderModelBar();
    const text = inputEl ? inputEl.value.trim() : '';
    if (!text) {
        try { const toastr = getHostGlobal('toastr'); toastr && toastr.info && toastr.info('先在输入框里写好要存的话，再点这里。', '快捷指令'); } catch (e) { /* ignore */ }
        return;
    }
    const mode = currentOracleMode();
    const name = await uiPrompt(`给这条快捷指令起个名字（存到「${qpModeLabel(mode)}」模式）：`, text.slice(0, 12));
    if (name == null) return;
    const s = getSettings();
    s.quickPrompts.push({ id: qpNewId(), mode, label: name.trim() || text.slice(0, 12), text });
    save();
    renderModelBar();
    if (win && win.querySelector('#pad-settings.open')) renderQpManager();
    try { const toastr = getHostGlobal('toastr'); toastr && toastr.success && toastr.success(`已存为「${qpModeLabel(mode)}」模式的快捷指令。`, '快捷指令'); } catch (e) { /* ignore */ }
}
// 模型栏右侧：宽 = 一排名字 + ⋯；窄 = 一个「⚡ 快捷指令」按钮（两套都渲染，CSS 容器查询决定显示哪套）。
function renderQuickPrompts(bar) {
    const mode = currentOracleMode();
    const items = qpForMode(mode);
    const chips = document.createElement('div');
    chips.className = 'pad-qp-chips';
    for (const q of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pad-qp-chip';
        b.title = '点一下直接发送：\n' + q.text;
        b.innerHTML = '<i class="fa-solid fa-bolt"></i><span></span>';
        b.querySelector('span').textContent = q.label;
        b.addEventListener('click', (e) => { e.stopPropagation(); qpSend(q); });
        chips.appendChild(b);
    }
    const toggleMenu = (e) => {
        e.stopPropagation();
        qpMenuOpen = !qpMenuOpen;
        modelMenuOpen = false;
        renderModelBar();
    };
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'pad-qp-more';
    more.title = items.length ? '全部快捷指令 / 存新的 / 管理' : '快捷指令：把常说的话存起来，一键发送';
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', qpMenuOpen ? 'true' : 'false');
    more.innerHTML = items.length ? '<i class="fa-solid fa-ellipsis"></i>' : '<i class="fa-solid fa-bolt"></i>';
    more.addEventListener('click', toggleMenu);
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'pad-qp-toggle';
    tog.setAttribute('aria-haspopup', 'true');
    tog.setAttribute('aria-expanded', qpMenuOpen ? 'true' : 'false');
    tog.innerHTML = '<i class="fa-solid fa-bolt"></i><span>快捷指令</span>' + (items.length ? `<span class="pad-qp-count">${items.length}</span>` : '') + '<i class="fa-solid fa-chevron-up"></i>';
    tog.addEventListener('click', toggleMenu);
    bar.append(chips, more, tog);
    if (!qpMenuOpen) return;

    const menu = document.createElement('div');
    menu.className = 'pad-model-menu pad-qp-menu';
    menu.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'pad-model-menu-group';
    head.textContent = `快捷指令 · ${qpModeLabel(mode)}（点名字直接发送，✎ 先填进输入框）`;
    menu.appendChild(head);
    if (!items.length) {
        const none = document.createElement('div');
        none.className = 'pad-model-menu-empty';
        none.textContent = '这个模式还没有快捷指令。在输入框写好要说的话，点下面「存成快捷指令」；或到设置的「快捷指令」页新建。';
        menu.appendChild(none);
    }
    for (const q of items) {
        const row = document.createElement('div');
        row.className = 'pad-qp-row';
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'pad-model-opt';
        send.setAttribute('role', 'menuitem');
        send.title = '直接发送';
        send.innerHTML = '<span class="pad-model-opt-mark"><i class="fa-solid fa-bolt"></i></span><span class="pad-model-opt-main"><span class="pad-model-opt-name"></span><span class="pad-model-opt-sub"></span></span>';
        send.querySelector('.pad-model-opt-name').textContent = q.label;
        send.querySelector('.pad-model-opt-sub').textContent = q.text.replace(/\s+/g, ' ').trim();
        send.addEventListener('click', (e) => { e.stopPropagation(); qpSend(q); });
        const fill = document.createElement('button');
        fill.type = 'button';
        fill.className = 'pad-qp-fill';
        fill.title = '先填进输入框，改一改再发';
        fill.setAttribute('aria-label', `把「${q.label}」填进输入框`);
        fill.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
        fill.addEventListener('click', (e) => { e.stopPropagation(); qpFill(q); });
        row.append(send, fill);
        menu.appendChild(row);
    }
    const sep = document.createElement('div');
    sep.className = 'pad-model-menu-sep';
    menu.appendChild(sep);
    const action = (icon, label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pad-model-opt';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = `<span class="pad-model-opt-mark"><i class="fa-solid ${icon}"></i></span><span class="pad-model-opt-main"><span class="pad-model-opt-name"></span></span>`;
        b.querySelector('.pad-model-opt-name').textContent = label;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        menu.appendChild(b);
    };
    action('fa-plus', '把输入框里的话存成快捷指令', qpSaveFromInput);
    action('fa-gear', '管理快捷指令…', () => { qpMenuOpen = false; qpManageMode = mode; toggleSettings(true, 'qp'); });
    bar.appendChild(menu);
}

// 设置「快捷指令」页：按模式分开管理（名字 / 内容 / 所属模式 / 顺序 / 删除）。改动即存、模型栏即时跟着变。
export function renderQpManager() {
    if (!win) return;
    const segEl = win.querySelector('#pad-qp-modes');
    const listEl = win.querySelector('#pad-qp-list');
    if (!segEl || !listEl) return;
    const s = getSettings();
    const all = s.quickPrompts;
    const mode = qpManageMode || currentOracleMode();
    segEl.innerHTML = '';
    for (const [m, label] of QP_MODES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pad-pgroup' + (m === mode ? ' active' : '');
        b.textContent = label;
        const n = all.filter((q) => q && q.mode === m).length;
        if (n) {
            const c = document.createElement('span');
            c.className = 'pad-pgroup-count';
            c.textContent = String(n);
            b.appendChild(c);
        }
        b.addEventListener('click', () => { qpManageMode = m; renderQpManager(); });
        segEl.appendChild(b);
    }
    const sum = win.querySelector('#pad-qp-summary');
    if (sum) sum.textContent = all.length ? `共 ${all.length} 条` : '';
    listEl.innerHTML = '';
    const items = all.filter((q) => q && q.mode === mode);
    if (!items.length) {
        const none = document.createElement('div');
        none.className = 'pad-hint';
        none.textContent = `「${qpModeLabel(mode)}」模式还没有快捷指令，点下面「＋ 新建一条」。`;
        listEl.appendChild(none);
    }
    const changed = () => { save(); renderModelBar(); };
    const move = (q, dir) => {
        const idx = all.indexOf(q);
        let j = idx + dir;
        while (j >= 0 && j < all.length && !(all[j] && all[j].mode === q.mode)) j += dir;   // 跳到同模式的邻居
        if (j < 0 || j >= all.length) return;
        [all[idx], all[j]] = [all[j], all[idx]];
        changed();
        renderQpManager();
    };
    items.forEach((q, i) => {
        const card = document.createElement('div');
        card.className = 'pad-qp-card';
        card.innerHTML = '<div class="pad-qp-card-head"><input type="text" class="pad-qp-name" maxlength="30" placeholder="名字（显示在按钮上）">'
            + '<select class="pad-qp-mode"></select>'
            + '<button type="button" class="pad-icon-btn pad-qp-up" title="上移"><i class="fa-solid fa-arrow-up"></i></button>'
            + '<button type="button" class="pad-icon-btn pad-qp-down" title="下移"><i class="fa-solid fa-arrow-down"></i></button>'
            + '<button type="button" class="pad-icon-btn pad-qp-del" title="删除"><i class="fa-solid fa-trash"></i></button></div>'
            + '<textarea class="pad-qp-text" rows="5" spellcheck="false" placeholder="点一下就发出去的那段话。可以写 {{user}}、{{char}}，发送时换成当前的名字。"></textarea>';
        const nameEl = card.querySelector('.pad-qp-name');
        nameEl.value = q.label || '';
        nameEl.addEventListener('input', () => { q.label = nameEl.value; changed(); });
        nameEl.addEventListener('blur', () => { if (!nameEl.value.trim()) { q.label = String(q.text || '').trim().slice(0, 12) || '未命名'; nameEl.value = q.label; changed(); } });
        const sel = card.querySelector('.pad-qp-mode');
        for (const [m, label] of QP_MODES) {
            const o = document.createElement('option');
            o.value = m; o.textContent = label;
            sel.appendChild(o);
        }
        sel.value = q.mode;
        sel.addEventListener('change', () => { q.mode = sel.value; changed(); renderQpManager(); });
        const ta = card.querySelector('.pad-qp-text');
        ta.value = q.text || '';
        ta.addEventListener('input', () => { q.text = ta.value; changed(); });
        const up = card.querySelector('.pad-qp-up');
        const down = card.querySelector('.pad-qp-down');
        up.disabled = i === 0;
        down.disabled = i === items.length - 1;
        up.addEventListener('click', () => move(q, -1));
        down.addEventListener('click', () => move(q, 1));
        card.querySelector('.pad-qp-del').addEventListener('click', async () => {
            if (!(await uiConfirm(`删除快捷指令「${q.label || '未命名'}」？`))) return;
            const idx = all.indexOf(q);
            if (idx >= 0) all.splice(idx, 1);
            changed();
            renderQpManager();
        });
        listEl.appendChild(card);
    });
}


export function renderModelBar() {
    const bar = win && win.querySelector('#pad-model-bar');
    if (!bar) return;
    const s = getSettings();
    const st = connPresetState(s);
    let name;
    let sub;
    if (s.mode === 'profile') {
        const prof = getProfiles().find((x) => x.id === s.profileId);
        name = prof ? (prof.name || prof.id) : '未选择配置文件';
        sub = '酒馆连接配置';
    } else if (st) {
        name = st.preset.name + (st.modified ? ' *' : '');   // * = 改过、还没存回这个存档
        sub = shortModelName(s.model);
    } else {
        name = s.model ? shortModelName(s.model) : '未设置模型';
        sub = '未存档';
    }
    bar.innerHTML = '';
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pad-model-pill';
    pill.title = st && st.modified ? `切换连接存档（当前连接改过，还没保存到「${st.preset.name}」）` : '切换连接存档';
    pill.setAttribute('aria-haspopup', 'true');
    pill.setAttribute('aria-expanded', modelMenuOpen ? 'true' : 'false');
    pill.innerHTML = '<i class="fa-solid fa-plug"></i><span class="pad-model-pill-name"></span><span class="pad-model-pill-sub"></span><i class="fa-solid fa-chevron-up"></i>';
    pill.querySelector('.pad-model-pill-name').textContent = name;
    pill.querySelector('.pad-model-pill-sub').textContent = sub;
    pill.addEventListener('click', (e) => { e.stopPropagation(); modelMenuOpen = !modelMenuOpen; qpMenuOpen = false; renderModelBar(); });
    bar.appendChild(pill);
    renderQuickPrompts(bar);   // ⚡ 二创版 2.2：模型右边的快捷指令
    if (!modelMenuOpen) return;

    const menu = document.createElement('div');
    menu.className = 'pad-model-menu';
    menu.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'pad-model-menu-group';
    head.textContent = '连接存档';
    menu.appendChild(head);
    const presets = s.connPresets || [];
    if (!presets.length) {
        const none = document.createElement('div');
        none.className = 'pad-model-menu-empty';
        none.textContent = '还没有连接存档——在设置的「连接」页里存一个。';
        menu.appendChild(none);
    }
    const addOpt = (mark, label, subText, current, onPick) => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'pad-model-opt' + (current ? ' current' : '');
        opt.setAttribute('role', 'menuitem');
        opt.innerHTML = '<span class="pad-model-opt-mark"></span><span class="pad-model-opt-main"><span class="pad-model-opt-name"></span><span class="pad-model-opt-sub"></span></span>';
        opt.querySelector('.pad-model-opt-mark').innerHTML = mark;
        opt.querySelector('.pad-model-opt-name').textContent = label;
        const subEl = opt.querySelector('.pad-model-opt-sub');
        if (subText) subEl.textContent = subText; else subEl.remove();
        opt.addEventListener('click', (e) => { e.stopPropagation(); modelMenuOpen = false; onPick(); renderModelBar(); });
        menu.appendChild(opt);
    };
    for (const p of presets) {
        const on = connPresetIsCurrent(p, s);
        const edited = !on && !!st && st.modified && st.preset.name === p.name;
        const mark = on ? '<i class="fa-solid fa-check"></i>' : (edited ? '<i class="fa-solid fa-pen"></i>' : '');
        addOpt(mark, p.name, p.model || '（未填模型）', on || edited, () => { if (!on) switchConnPreset(p.name); });
    }
    const sep = document.createElement('div');
    sep.className = 'pad-model-menu-sep';
    menu.appendChild(sep);
    addOpt('<i class="fa-solid fa-gear"></i>', '管理连接…', '', false, () => toggleSettings(true, 'conn'));
    bar.appendChild(menu);
}
export function closeModelMenu() {
    if (!modelMenuOpen) return;
    modelMenuOpen = false;
    renderModelBar();
}