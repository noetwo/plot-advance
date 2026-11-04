import { getSummary } from '../core/chat-metadata.js';
import { getCtx, getSettings } from '../core/settings.js';
import { sharedState } from '../core/state.js';
import { buildAdvisorPrompt, buildBbsHistorySection, buildCardSection, buildChatWorldSection, buildDiagnosePrompt, buildFixPrompt, buildLorebookPrompt, buildLwbHistorySection, buildSummarySection, buildTranscript, getBbsHistoryText, getLwbSummaryText } from '../modes/chat/context.js';
import { BUILDER_LOOK_MUSTASK, LB_SMART_SELECT_PROMPT, buildBuilderPrompt } from '../modes/lorebook/core.js';
import { BUILTIN_JB_CORE, BUILTIN_JB_TAIL } from '../presets/builtin-jailbreak.js';
import { ADVISOR_FORMAT_SECTION, ADVISOR_NODE_ASK, ADVISOR_SPEEDS, ADVISOR_SYSTEM_PROMPT, BUILDER_FORGE_PROMPT, BUILDER_FORGE_PROMPT_NOSTEAL, BUILDER_FORGE_PROMPT_STEAL, BUILDER_INTERVIEW_PROMPT, BUILDER_INTERVIEW_PROMPT_NOSTEAL, BUILDER_INTERVIEW_PROMPT_STEAL, BUILDER_PROTOCOL, CONDENSE_OPS_PROMPT, CONDENSE_SECT_PROMPT, DEFAULT_SYSTEM_PROMPT, DIAGNOSE_SYSTEM_PROMPT, DLG_RICH_RIDER, DRAFT_CONDENSE_PROMPT, ENABLE_OFFSTAGE_GUARD, FIX_CUSTOM_FOOTER, FIX_CUSTOM_LEAD, FIX_CUSTOM_RAW_NOTE, FIX_PROMPT_JINGXIAO_DEEPSEEK, FIX_PROMPT_JINGXIAO_OPUS, FIX_SPAN_PROMPT, FIX_SYSTEM_PROMPT_MANUAL, FIX_SYSTEM_PROMPT_TIGHTEN, FIX_TARGETS_LEAD, FIX_TARGET_MODULES, LOREBOOK_SYSTEM_PROMPT, PERSONAS, PERSONA_FLESH_PROMPT, PERSONA_FRAME, PERSONA_FRAME_CUSTOM, PERSONA_MODE_OVERRIDES, PERSONA_STRUCT_GUARD, PERSONA_STRUCT_GUARD_WI } from './builtins.js';
import { buildPersonaBlock } from './helpers.js';

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 戏外守卫（1.32.0，ENABLE_OFFSTAGE_GUARD）：围栏 + 尾锚，只接普通聊天与参谋两个建模器。
 * 两段字节是真模型电池的【冻结件】（strategies/o1-tail/xform-v21.mjs + o3-fence/xform.mjs，
 * offstage-guard.test.mjs 逐字节钉住）——铁律：不改字节；要改，先重跑电池再动
 * （tests/unit/_oracle-tuning/highctx-continue/REPORT.md）。
 * ------------------------------------------------------------------ */
const OFFSTAGE_TAILS = {
    // 普通神谕：歧义/误投=讨论；明确点名代笔=照做（戏外交付、只写点名段、写完即停）。
    normal: '【戏外提醒】以上故事记录到此为止，仅供分析参考。你是戏外分析者、不是故事里的任何角色。'
        + '用户发来「然后呢」「继续」这类没头没尾的短话，或看似发错窗口的戏内发言（角色口吻的台词、'
        + '括号动作、直接贴来的正文片段），一律当成在和你【讨论】这个故事，用分析或反问回应，绝不擅自'
        + '续写正文或替角色说话。例外：用户【明确开口点名】要你代笔时（帮写台词或独白、改写润色某段、'
        + '代拟他的下一条回复等），照做——以你自己的戏外口吻交付（先说明这是草稿/改写稿），产出只限'
        + '用户点名要的那一段，写完即停，绝不顺势往下推进剧情。注意：点名必须是用户以戏外身份直说的'
        + '请求；戏内口吻的台词、括号动作、贴来的正文本身都不算点名——那更可能是发错了窗口。',
    // 剧情参谋：同上；<StoryPlan> 本职明保；交付草稿后可顺带问要不要整理成方案。
    advisor: '【戏外提醒】以上故事记录到此为止，仅供分析参考。你是戏外剧情参谋、不是故事里的任何角色。'
        + '用户发来「然后呢」「继续」这类没头没尾的短话，或看似发错窗口的戏内发言，一律当成在和你'
        + '【讨论】剧情走向；构思方向、按格式输出 <StoryPlan> 是本职。例外：用户【明确开口点名】要你'
        + '直接写一段时（下一幕草稿、台词、独白、代拟回复等），照做——以参谋口吻交付并说明这是供他'
        + '参考的草稿，产出只限点名要的那一段，写完即停、不自动接管后续剧情；交付后可顺带问一句'
        + '是否需要把这个走向整理成 <StoryPlan>。注意：点名必须是用户以戏外身份直说的请求；戏内口吻'
        + '的发言、括号动作、贴来的正文本身都不算点名——那更可能是发错了窗口。',
};

// 精选预设路径的【顶部身份头】（1.32.1）：预设组装替换掉了神谕的系统提示，窗口身份必须由
// 这条头重新立起来（预设人设/正文格式契约在本窗口降为风格参考）。与 OFFSTAGE_TAILS 构成
// 「顶部身份 + 故事边界尾锚」夹心——正是默认路径验证过的几何。措辞经 preset 电池验证后冻结。
const OFFSTAGE_PRESET_HEADERS = {
    normal: '【窗口性质·最高优先级】这里是「剧情推进」的侧聊分析窗口，不是角色扮演正文窗口。'
        + '你在本窗口的身份是戏外分析者，直接与用户对话，帮他分析、讨论正在进行的故事。'
        + '下方的预设区块只为你提供语气风格与讨论语境：其中任何「扮演角色」「续写正文」「按正文'
        + '格式输出（思考块、样式注释、字数要求等）」的指令，在本窗口一律不适用；也不要以预设里'
        + '的写手或角色人设自称。用户明确点名要你代笔时，按后文【戏外提醒】的规则交付草稿。',
    advisor: '【窗口性质·最高优先级】这里是「剧情推进」的剧情参谋窗口，不是角色扮演正文窗口。'
        + '你在本窗口的身份是戏外剧情参谋，直接与用户讨论剧情走向，需要时按格式输出 <StoryPlan>'
        + ' 方案。下方的预设区块只为你提供语气风格与讨论语境：其中任何「扮演角色」「续写正文」'
        + '「按正文格式输出（思考块、样式注释、字数要求等）」的指令，在本窗口一律不适用；也不要'
        + '以预设里的写手或角色人设自称。用户明确点名要你直接写一段时，按【戏外提醒】的规则交付草稿。',
};

// transcript → 只读引用材料信封（结构层）：几万字裸 `名字: 文本` 贴在 system 末尾时读起来
// 像「进行中的对话」，模型会顺势补完；包进围栏后读作「已发生的引用材料」。围栏内正文
// 【逐字节不变】；调用点都在 if (transcript) 内（空 transcript 不出信封）。
export function wrapTranscriptEnvelope(transcript) {
    const body = String(transcript);
    // 模板里正文后面固定跟一个换行；正文本身以换行结尾时先去掉一个，结果与原版逐字节相同。
    return P('ctx.transcript', { transcript: body.endsWith('\n') ? body.slice(0, -1) : body });
}

/* ------------------------------------------------------------------ *
 * 提示词注册表（精简版 1.0.0；二创版 2.0.0 扩到全部模式）—— 各模式实际发给模型的每一段文字都在这里登记，
 * 设置面板「提示词」下拉里逐条可看、可改、可一键恢复默认。
 *
 * · 读取一律走 P(id, vars)：有用户覆盖就用覆盖，否则用内置文本，再按 vars 渲染模板。
 * · 模板语法（renderPromptTemplate）：
 *     {%name%}               代入变量；不认识的名字原样保留。
 *     {%#name%}…{%/name%}    变量非空时才保留这一段；{%^name%}…{%/name%} 反过来，变量为空时才保留。
 *     一行里出现的变量全为空 → 整行删掉（可选行就靠这条，如「可用的起始迹象：{%seed%}」）。
 *     发生过删行 / 删段时，连续的空行压成一个，首尾空行去掉。
 *   这些都在【代入之前】对模板本身做，代入只扫一遍——代入的内容（角色卡、对话记录……）一个字都不会被改。
 *   代入之后，各调用点照旧做 substituteParams（{{user}} 等酒馆宏），顺序与原版相同。
 * · 覆盖存在 settings.promptOverrides[id]（'' 也算覆盖）。原版留下的旧键直接读写、不做迁移，
 *   与原版保持双向兼容：systemPrompt（普通聊天，存全文）、advisorSystemPrompt / diagnoseSystemPrompt /
 *   lorebookSystemPrompt / fixLightSystemPrompt / fixThoroughSystemPrompt / fixTarget*Prompt（'' = 内置）。
 * · 数据排版（世界书条目清单、校正信封的 <characters> 等标签、补丁回执行）不登记：它们和提示词里的
 *   格式说明一一对应，改了反而对不上。
 * · desc：一句话说明这段文字什么时候发、给谁看（设置「提示词」页的条目列表里显示）。
 * · vars：这条模板能用的变量（编辑器里列出来）；required：缺了引导 / 解析会失效的变量；
 *   contract：程序要解析的字面量（格式契约）。缺 required / contract，编辑器提示行标红。
 * ------------------------------------------------------------------ */
export const PROMPT_DEFS = [
    // —— 普通聊天 ——
    { id: 'chat.system', group: '普通聊天', label: '系统提示词',
        desc: '普通聊天每次提问都会带上的主指令：剧情推进是谁、该怎么回答。', builtin: DEFAULT_SYSTEM_PROMPT,
        legacy: { key: 'systemPrompt', kind: 'full' },
        note: '选了补全预设时，这一条会被预设替换（内置破限除外——它只是包在外面）。' },
    { id: 'chat.tail', group: '普通聊天', label: '戏外提醒（紧跟对话记录之后）',
        desc: '紧跟在故事对话记录后面，提醒模型别续写剧情、只回答你。', builtin: OFFSTAGE_TAILS.normal },
    { id: 'chat.presetHeader', group: '普通聊天', label: '窗口身份头（走补全预设时放在最前）',
        desc: '普通聊天走补全预设时放在最前面，说明这是分析窗口、预设只当风格参考。', builtin: OFFSTAGE_PRESET_HEADERS.normal },
    { id: 'chat.statOn', group: '普通聊天', label: '变量状态段（读到 MVU 数据时）',
        desc: '读到 MVU 变量时附上，并告诉模型数值以它为准。',
        builtin: '=== 当前变量状态（stat_data —— 唯一权威数值）===\n{%stat%}\n'
            + '（用户问数值时以上方为准；剧情文字 / 状态栏里出现的任何数值都可能是旧的，一律不要采信。）',
        vars: { stat: 'MVU 变量（stat_data）JSON' }, required: ['stat'] },
    { id: 'chat.statOff', group: '普通聊天', label: '变量状态段（没有数据时）',
        desc: '没有变量数据时附上，要求模型如实说看不到、不要编数值。',
        builtin: '（注意：你看不到实时变量数值（好感度、金钱等状态数据）。用户问具体数值时，如实说明无法查看精确数值，'
            + '建议用诊断或剧情参谋模式查询（它们会读取变量状态）；可以根据剧情做定性判断（关系变暖 / 资源吃紧），但绝不要编造具体数字。）' },
    { id: 'chat.presetEmpty', group: '普通聊天', label: '补全预设整理后为空时的占位',
        desc: '补全预设挑完什么都没剩时，用这句话代替。', builtin: '（预设无可用内容）' },

    // —— 诊断 ——
    { id: 'diag.system', group: '诊断', label: '系统提示词',
        desc: '手动诊断与自动诊断共用的主指令：怎么核对 MVU 变量、怎么输出修正补丁。', builtin: DIAGNOSE_SYSTEM_PROMPT,
        legacy: { key: 'diagnoseSystemPrompt', kind: 'override' }, contract: ['<UpdateVariable>', '<JSONPatch>'],
        note: '<UpdateVariable> / <JSONPatch> 区块的格式是解析契约：改坏了，补丁就应用不上。' },
    { id: 'diag.autoVerify', group: '诊断', label: '自动诊断附则 · 回复自带更新（核验）',
        desc: '自动诊断时，回复里的变量更新已经生效：只核验、最小化修正，不要把这回合重算一遍。',
        builtin: '【自动诊断模式 —— 重要】这是一次后台自动诊断。这条 AI 回复【自带】变量更新，且它【已经生效】——当前状态就是该更新应用之后的结果。你的任务只是【核验并最小化修正】它（仍以当前状态为事实依据）。\n'
                + '【绝对不要】把这回合的变化重新推导、重新计算一遍：那些增减（花掉的钱、涨的好感度、推进的时间……）都已经算进当前状态了，再补一次就会把同一笔算两遍。只在当前状态里能指出【具体错值】时才出补丁。\n'
                + '遵循下方输出规则；没有缺陷时输出空的 JSONPatch（[]）。' },
    { id: 'diag.autoDerive', group: '诊断', label: '自动诊断附则 · 回复里没有更新（推导）',
        desc: '自动诊断时，回复里没有变量更新区块：让模型充当变量更新引擎，从正文推导本回合的更新。',
        builtin: '【自动诊断模式 —— 重要】这是一次后台自动诊断，时机是一条新 AI 回复刚到，而这条回复的正文里【没有】任何变量更新区块：说明本回合的变量更新【还没有】被写入，当前状态【尚未】包含这条回复带来的变化。请你充当变量更新引擎——通读这段回复，依角色卡 MVU 规则与当前状态，推导出本回合【应当】发生的全部变量更新（好感度增减、物品获得 / 消耗、时间推进、地点 / 状态变化……），生成 <UpdateVariable> 补丁把状态更新到这条回复之后的正确值。只依据回复里确凿发生的事，绝不脑补没写的细节。\n'
                + '遵循下方输出规则；确实没有任何变量需要变动时，输出空的 JSONPatch（[]）。' },
    { id: 'diag.autoDead', group: '诊断', label: '自动诊断附则 · 更新区块没生效（重推）',
        desc: '自动诊断时，回复里有更新区块但格式坏了、一条都没执行：让模型重新推导本回合的更新。',
        builtin: '【自动诊断模式 —— 重要】这是一次后台自动诊断，时机是一条新 AI 回复刚到。这条回复的正文里【带有】一个变量更新区块，但那个区块【没有生效】——它的格式坏了（缺闭合标签／写法引擎不认／指令本身落不了地），变量引擎这一回合一条指令都没有执行，当前状态【尚未】包含这条回复带来的变化。请你充当变量更新引擎——通读这段回复，依角色卡 MVU 规则与当前状态，重新推导出本回合【应当】发生的全部变量更新（好感度增减、物品获得 / 消耗、时间推进、地点 / 状态变化……），生成 <UpdateVariable> 补丁把状态更新到这条回复之后的正确值。\n'
                + '正文里那段坏掉的区块可以当【线索】参考（它写了什么、想改哪些字段），但不要照抄它的路径与写法——以剧情里确凿发生的事、以及当前状态里真实存在的字段为准，绝不脑补没写的细节。\n'
                + '遵循下方输出规则；确实没有任何变量需要变动时，输出空的 JSONPatch（[]）。' },
    { id: 'diag.rules', group: '诊断', label: '世界书规则段',
        desc: '角色卡的 MVU 变量规则（来自世界书）；一条规则都没找到时用后半句代替。',
        builtin: '=== 角色卡 MVU 规则（来自世界书）===\n{%#wi%}{%wi%}{%/wi%}{%^wi%}（未找到世界书规则 —— 诊断结果可能不完整）{%/wi%}',
        vars: { wi: '世界书里的规则条目' } },
    { id: 'diag.stat', group: '诊断', label: '变量状态段',
        desc: '当前的变量状态（stat_data）；读不到 MVU 时用后半句代替。',
        builtin: '=== 当前变量状态（stat_data）===\n{%#stat%}{%stat%}{%/stat%}{%^stat%}（不可用 —— 未检测到 MVU 框架）{%/stat%}',
        vars: { stat: '当前变量状态（stat_data）JSON' },
        note: '这一段按原样发送、不展开 {{user}} 等宏（补丁要对准字面数据）；下面几条「…段」同理。' },
    { id: 'diag.latestBlock', group: '诊断', label: '「待检查的更新」段（摘到了更新区块）',
        desc: '最新回复里摘出的 <UpdateVariable> 区块，交给模型核对。',
        builtin: '=== 最新更新区块（待检查的更新）===\n{%block%}', vars: { block: '最新回复里的更新区块' }, required: ['block'] },
    { id: 'diag.latestNone', group: '诊断', label: '「待检查的更新」段（没找到更新区块）',
        desc: '最新回复里没有更新区块时放的那一段。',
        builtin: '=== 最新更新区块（待检查的更新）===\n（在最新一条 AI 回复中未找到 <UpdateVariable> 区块）' },
    { id: 'diag.latestDerive', group: '诊断', label: '自动诊断 · 回复正文段（没有更新区块）',
        desc: '自动诊断推导时，把整条回复正文交给模型。',
        builtin: '=== 最新一条 AI 回复（正文里【没有】变量更新区块——请据这段剧情、依 MVU 规则与当前状态，推导出本回合应当发生的全部变量更新）===\n' + '{%reply%}', vars: { reply: '最新一条 AI 回复正文' }, required: ['reply'] },
    { id: 'diag.latestUnparsed', group: '诊断', label: '自动诊断 · 回复正文段（更新区块没摘出来）',
        desc: '回复里有更新、但标签不标准没能单独摘出时，把整条回复交给模型自己找。',
        builtin: '=== 最新一条 AI 回复（其中【含有】变量更新区块，但用的不是标准标签、系统未能单独摘出——请自行从中找出那段更新并核验。它已经生效，当前状态已包含它，切勿重新推导一遍）===\n' + '{%reply%}', vars: { reply: '最新一条 AI 回复正文' }, required: ['reply'] },
    { id: 'diag.latestDead', group: '诊断', label: '自动诊断 · 回复正文段（更新区块没生效）',
        desc: '回复里的更新区块坏了、一条都没执行时，把整条回复交给模型重推。',
        builtin: '=== 最新一条 AI 回复（其中那段变量更新区块【没有生效】——格式坏损，变量引擎这一回合一条指令都没执行；请据这段剧情、依 MVU 规则与当前状态，重新推导出本回合应当发生的全部变量更新）===\n' + '{%reply%}', vars: { reply: '最新一条 AI 回复正文' }, required: ['reply'] },
    { id: 'diag.transcript', group: '诊断', label: '故事对话记录段',
        desc: '最近的主聊天记录（诊断保留更新区块原样）。',
        builtin: '=== 故事对话记录（最新的在最后）===\n{%transcript%}', vars: { transcript: '最近的主聊天记录' }, required: ['transcript'] },
    { id: 'diag.askVerify', group: '诊断', label: '自动诊断请求 · 核验更新区块',
        desc: '自动诊断替你发给模型的那句话（回复里摘到了更新区块时）。', builtin: '【自动诊断】最新一条 AI 回复里带有变量更新区块。请按本卡 MVU 规则与当前状态核验它：有错就只输出一个修正后的 <UpdateVariable> 区块（仅含需改正的字段）；完全正确则在 <JSONPatch> 里输出空数组（[]）。' },
    { id: 'diag.askUnparsed', group: '诊断', label: '自动诊断请求 · 核验没摘出来的更新',
        desc: '自动诊断替你发给模型的那句话（回复里有更新、但标签不标准时）。', builtin: '【自动诊断】最新一条 AI 回复里【含有】变量更新区块，但它用的标签不是标准写法、系统没能单独摘出来。请从下方回复正文里自行找到那段更新并核验：有错就只输出一个修正后的 <UpdateVariable> 区块（仅含需改正的字段）；完全正确则在 <JSONPatch> 里输出空数组（[]）。它【已经生效】了——绝不要把这回合的变化重新推导一遍。' },
    { id: 'diag.askDerive', group: '诊断', label: '自动诊断请求 · 推导本回合更新',
        desc: '自动诊断替你发给模型的那句话（回复里没有更新区块时）。', builtin: '【自动诊断】最新一条 AI 回复的正文里【没有】变量更新区块。请充当变量更新引擎：通读这条回复，依本卡 MVU 规则与当前状态，推导出本回合应当发生的全部变量更新，输出一个 <UpdateVariable> 区块把状态更新到位；若这条回复确实不涉及任何变量变化，则在 <JSONPatch> 里输出空数组（[]）。' },
    { id: 'diag.askDead', group: '诊断', label: '自动诊断请求 · 重推坏掉的更新',
        desc: '自动诊断替你发给模型的那句话（回复里的更新区块没生效时）。', builtin: '【自动诊断】最新一条 AI 回复里【带有】一个变量更新区块，但它【没有生效】——格式坏损或写法引擎不认，MVU 这一回合一条指令都没有执行，当前状态【尚未】包含这条回复带来的变化。请充当变量更新引擎：通读这条回复，依本卡 MVU 规则与当前状态，重新推导出本回合应当发生的全部变量更新，输出一个 <UpdateVariable> 区块把状态更新到位。正文里那段坏掉的区块可以当线索参考，但请以剧情里确凿发生的事为准；若这条回复确实不涉及任何变量变化，则在 <JSONPatch> 里输出空数组（[]）。' },
    { id: 'diag.schemaRetry', group: '诊断', label: '卡片规则拒绝后的重写请求',
        desc: '补丁里有这张卡不接受的指令时（「被拒时让模型自动重写一次」开着），带着原因让模型重写一次。',
        builtin: '系统：上一份补丁里有 {%count%} 处这张卡不会接受，请只针对这几处改一版（其余保持不变）：\n{%items%}\n输出一份完整的新补丁（原来能通过的指令原样保留）。',
        vars: { count: '被拒的指令数', items: '逐条列出：路径（操作）：原因' }, required: ['items'] },
    { id: 'mvued.scan', group: '诊断', label: '变量编辑器 · 分析取值规则',
        desc: '🎛 变量编辑器「分析取值规则」时，让模型从 MVU 规则里抽出枚举值和数值范围。',
        builtin: [
        '你是一个数据抽取器。下面是某角色卡的 MVU 变量更新规则（写给别的模型看的自由文本），以及当前全部变量字段的路径清单。',
        '任务：从规则文本里找出【对具体字段取值的硬性限制】——枚举值（某字段只能取哪几个值）与数值范围（min/max）。',
        '只报告规则里【明确写出】的限制；没写的字段不要出现在结果里，绝不要猜。',
        '另外：若字段清单里存在大量【不带任何分组前缀】的零散字段，可给出把它们按语义分组的建议（groups）；有结构前缀（如「角色状态.」）的字段不要分组。',
        '',
        '=== MVU 规则 ===',
        '{%#rules%}{%rules%}{%/rules%}{%^rules%}（未找到规则）{%/rules%}',
        '',
        '=== 字段路径清单（dot 路径，枚举/范围只能挂在这些路径上）===',
        '{%fields%}',
        '',
        '输出【只输出】一个 <MvuSchema> 块，内容是 JSON：',
        '<MvuSchema>',
        '{"fields":[{"path":"字段.路径","options":["值1","值2"]},{"path":"另一字段","min":0,"max":100}],"groups":[{"label":"分组名","paths":["零散字段1","零散字段2"]}]}',
        '</MvuSchema>',
        '没有任何可报告的限制时输出 <MvuSchema>{"fields":[],"groups":[]}</MvuSchema>。',
        '',
        '⚠ 输出纪律（不守则本次扫描作废）：',
        '· 整个回复里【有且只有一个】 <MvuSchema> 块——系统只读第一个，后面再写的一律被丢弃。不要先给一版再给修订版，不要分块输出；想改就把最终结果直接写进那唯一的块里。',
        '· 形如 [值,"描述"] 的字段，在上面的清单里已按【整对】给出一条路径；限制只能挂在那条【自身】路径上——写「好感度」，绝不要写「好感度.0」或「好感度[0]」。带下标的路径会被系统丢弃，该字段等于白扫。',
        '· path 必须逐字节抄自上面的字段路径清单，不要自造、不要改写、不要只写末段。',
        ].join('\n'),
        vars: { rules: 'MVU 规则（世界书）', fields: '全部变量字段的路径清单' }, required: ['fields'], contract: ['<MvuSchema>'],
        note: '<MvuSchema> 区块的 JSON 格式是解析契约。' },
    { id: 'mvued.scanAsk', group: '诊断', label: '变量编辑器 · 分析请求',
        desc: '「分析取值规则」时替你发出的那句话。', builtin: '请按上方要求输出 <MvuSchema> 块。' },

    // —— 世界书 ——
    { id: 'lb.system', group: '世界书', label: '系统提示词（世界书管家）',
        desc: '世界书模式的主指令：怎么读条目、怎么用 <LorebookEdit> 区块提出改动。', builtin: LOREBOOK_SYSTEM_PROMPT,
        legacy: { key: 'lorebookSystemPrompt', kind: 'override' }, contract: ['<LorebookEdit>'],
        note: '<LorebookEdit> 区块的格式是解析契约：改坏了，改动就应用不上。世界书模式不展开 {{user}} 等宏（条目正文要逐字对上锚点）。' },
    { id: 'lb.macroLegend', group: '世界书', label: '宏说明（条目里有 {{user}} 等宏时）',
        desc: '条目按原样显示、含 {{user}} 等宏时，放在书正文最前面的说明。',
        builtin: '（说明：下列条目正文按【原样】显示，含 {{user}}、{{char}} 等宏，未做替换。' + '{%#names%}{%names%}{%/names%}' +
            '聊天作答可用真名以便阅读；但【编辑】时，anchor 锚点与 replace / content 正文都必须照抄字面的 ' +
            '{{user}} / {{char}} 等宏，不要替换成真名——否则锚点对不上当前存储，还会把名字写死进世界书。）\n\n',
        vars: { names: '当前宏对应的名字（如「当前 {{user}} = 「小明」。」；读不到时为空）' } },
    { id: 'lb.transcript', group: '世界书', label: '最近剧情对话段',
        desc: '勾了「同时带上最近剧情对话」时附上的主聊天记录。',
        builtin: '=== 最近的故事对话记录（仅供参考，最新的在最后）===\n{%transcript%}', vars: { transcript: '最近的主聊天记录' }, required: ['transcript'] },
    { id: 'lb.snapshot', group: '世界书', label: '世界书快照外壳',
        desc: '每次发送都附在最末尾的世界书快照：版本号、上次应用结果、书正文。',
        builtin: '════ 世界书快照 · 第 {%serial%} 版（每次发送自动重读，唯一权威）════\n'
            + '{%#applied%}〔上次应用结果〕（仅最近一次）\n{%applied%}\n────\n{%/applied%}{%book%}\n'
            + '════ 快照结束 · 校验与锚点只能从本快照逐字复制 ════',
        vars: { serial: '快照版本号', applied: '上次应用结果（逐条；没有时整段省略）', book: '世界书正文（含宏说明）' }, required: ['book'] },
    { id: 'lb.smartSelect', group: '世界书', label: '🪄 智能选条',
        desc: '「🪄 智能选条」时的指令：怎么看目录、怎么搜、怎么给出勾选计划。', builtin: LB_SMART_SELECT_PROMPT,
        contract: ['<LorebookSelect>'], note: '<LorebookSearch> / <LorebookFetch> / <LorebookSelect> 三种区块是解析契约。' },

    // —— 剧情参谋 ——
    { id: 'advisor.system', group: '剧情参谋', label: '系统提示词',
        desc: '参谋模式的主指令：怎么讨论剧情、什么时候出方案。', builtin: ADVISOR_SYSTEM_PROMPT,
        legacy: { key: 'advisorSystemPrompt', kind: 'override' } },
    { id: 'advisor.format', group: '剧情参谋', label: '方案格式（<StoryPlan>：单节点 / 剧情脉络）',
        desc: '教参谋把方案写成 <StoryPlan> 区块：单节点写目标，多节点写整体目标和各节点。',
        builtin: ADVISOR_FORMAT_SECTION, vars: { later: '参谋设置选了「到了再写」时非空（只给第 1 个节点写详细）' },
        contract: ['<StoryPlan>', '标题：', '目标：'],
        note: '<StoryPlan> 区块的格式与键名是解析契约：改坏了，方案卡就出不来。' },
    { id: 'advisor.pathBlock', group: '剧情参谋', label: '「当前剧情脉络」段（有引导在进行时）',
        desc: '有方案或剧情脉络在引导主聊天时，把进度和各节点告诉参谋。',
        builtin: '=== 当前正在引导主聊天的剧情脉络 ===\n标题：{%title%}\n{%#overall%}整体目标：{%overall%}{%/overall%}\n'
            + '进度：{%progress%} · 推进速度：{%speed%} · 当前节点已持续 {%since%} 条主聊天消息\n'
            + '{%nodes%}\n'
            + '已完成 / 已跳过的节点是锁定的历史。用户想调整时，讨论后用 <StoryPlan> 区块重新提案，'
            + '【只写当前节点起剩下的部分】（不要重复已完成的节点）——采用后会接在已完成的节点后面。',
        vars: { title: '标题', overall: '整体目标（单个方案时为空、整行省略）', progress: '进度（节点 X/Y；单个方案时是「单个方案」）',
            speed: '推进速度', since: '当前节点已持续的主聊天消息数', nodes: '逐个节点的清单（程序生成）' },
        required: ['nodes'] },
    { id: 'advisor.nodeAsk', group: '剧情参谋', label: '「到了再写」时请参谋写节点详细的话',
        desc: '参谋设置选「到了再写」时，轮到还没有详细的节点，替你发给参谋的那句请求。',
        builtin: ADVISOR_NODE_ASK,
        vars: { title: '脉络标题', progress: '进度（节点 X/Y）', name: '节点名', keywords: '关键词（没有时那一段省略）' },
        required: ['name'], contract: ['<NodeDetail>'],
        note: '<NodeDetail> 区块是解析契约：改坏了，写好的详细就收不下来。' },
    { id: 'advisor.stat', group: '剧情参谋', label: '变量状态段（读到 MVU 数据时）',
        desc: '读到 MVU 变量时附上，让方案和数值现状对得上。',
        builtin: '=== 当前变量状态（stat_data，来自 MVU —— 剧情推进到此刻的实时数值）===\n{%stat%}',
        vars: { stat: 'MVU 变量（stat_data）JSON' }, required: ['stat'] },
    { id: 'advisor.tail', group: '剧情参谋', label: '戏外提醒（紧跟对话记录之后）',
        desc: '紧跟在对话记录后面，提醒参谋别续写正文。', builtin: OFFSTAGE_TAILS.advisor },
    { id: 'advisor.presetHeader', group: '剧情参谋', label: '窗口身份头（套用补全预设时放在最前）',
        desc: '参谋套用补全预设时放在最前面。', builtin: OFFSTAGE_PRESET_HEADERS.advisor },
    { id: 'advisor.sendBack', group: '剧情参谋', label: '「找参谋改改」时参谋的开场白',
        desc: '在方案条点「找参谋改改」时，参谋房里自动出现的第一句话。',
        builtin: '你当前在{%where%}。想调整后面的剧情吗？聊好我把剩下的部分重新列给你。',
        vars: { where: '当前进度（如「剧情脉络「出城」的节点 2/3「城门盘查」」）' } },
    { id: 'advisor.importAsk', group: '剧情参谋', label: '「导入普通聊天讨论并整理成方案」时发出的话',
        desc: '点「导入普通聊天的讨论并整理成方案」时替你发出去的话。',
        builtin: '把我们刚才讨论的剧情走向，整理成可以采用的方案吧。' },

    // —— 主聊天注入 ——
    { id: 'inject.path', group: '主聊天注入', label: '剧情导向（整段注入主聊天的外壳）',
        desc: '采用方案后，每次主聊天生成时注入的那一段：一句交代 + 整体目标 + 已完成 + 当前目标 + 后续 + 节奏。',
        builtin: '<剧情导向>\n'
            + '以下是本段故事已经定好的剧情走向，正文必须朝它推进，不得偏离或另起炉灶。人物照旧按各自的性格和立场行事；'
            + '用你自己的叙述把它自然写进正文，不要照抄、复述或提及这段内容。\n'
            + '{%#overall%}整体目标：{%overall%}{%/overall%}\n'
            + '{%#done%}已完成：{%done%}{%/done%}\n'
            + '{%current%}\n'
            + '{%#later%}后续节点（只用来把握方向；当前目标达成之前，严禁写到这些情节）：{%later%}{%/later%}\n'
            + '{%pace%}\n'
            + '</剧情导向>',
        vars: { overall: '整体目标（单个方案时为空、整行省略）', done: '已完成的节点名（没有时整行省略）',
            current: '当前目标（见「当前目标」条目）', later: '后续节点的名字和关键词（没有时整行省略）',
            pace: '节奏行（见「节奏行」条目）' },
        required: ['current', 'pace'],
        note: '整段贴进玩家消息里发给主聊天模型（多数中转会把对话中间的 system 挪到最顶上，贴进玩家消息才稳）。' },
    { id: 'inject.current', group: '主聊天注入', label: '当前目标',
        desc: '填进剧情导向外壳 {%current%} 的部分。',
        builtin: '{%#label%}当前目标（{%label%}）：{%/label%}{%^label%}目标：{%/label%}\n{%detail%}',
        vars: { label: '「节点 2/3 · 城门盘查」（单个方案时为空）', detail: '当前节点的详细（还没写时是节点名和关键词）' },
        required: ['detail'] },
    { id: 'inject.paceLine', group: '主聊天注入', label: '节奏行（剧情导向最后一行，{%pace%}）',
        desc: '剧情导向最后一行的格式。',
        builtin: '节奏：{%pace%}', vars: { pace: '当前推进速度的节奏句' }, required: ['pace'] },
    { id: 'inject.speed.slow', group: '主聊天注入', label: '节奏句 · 慢推',
        desc: '推进速度选「慢推」时填进节奏行的那句话。', builtin: ADVISOR_SPEEDS.slow.directive },
    { id: 'inject.speed.normal', group: '主聊天注入', label: '节奏句 · 正常',
        desc: '推进速度选「正常」时填进节奏行的那句话。', builtin: ADVISOR_SPEEDS.normal.directive },
    { id: 'inject.speed.fast', group: '主聊天注入', label: '节奏句 · 快推',
        desc: '推进速度选「快推」时填进节奏行的那句话。', builtin: ADVISOR_SPEEDS.fast.directive },

    // —— 校正 ——
    { id: 'fix.manual', group: '校正', label: '手动校正 · 系统提示词',
        desc: '手动校正（在输入框直接说要改哪里）的主指令。', builtin: FIX_SYSTEM_PROMPT_MANUAL,
        contract: ['<FixedReply>'], note: '<FixedReply> 区块是解析契约：改坏了，校正稿就收不下来。' },
    { id: 'fix.structuralNote', group: '校正', label: '手动校正 · 结构块保留叮嘱',
        desc: '附在手动校正指令后面：状态栏、选项菜单等结构块默认原样保留，用户点名要改的除外。',
        builtin: '【结构块保留】这条回复里可能夹着非叙事的结构块——状态栏、[方括号]标记、HTML / XML 区块、选项菜单、'
        + '图片生成提示等。默认把它们连同内部内容【原样逐字保留】，不要改写、精简、翻译或删除，也不要改动其位置。'
        + '【例外·用户指令优先】若用户的修改要求明确指向某个结构块内部的内容，则以用户要求为准、按要求改那一处；'
        + '其余结构块仍原样保留。' },
    { id: 'fix.span', group: '校正', label: '✂️ 选段校正 · 系统提示词',
        desc: '选段校正（只改划选的一段）的主指令。', builtin: FIX_SPAN_PROMPT,
        contract: ['<FixedSpan>'], note: '<FixedSpan> 区块是解析契约。' },
    { id: 'fix.light', group: '校正', label: '自动校正 · 轻校',
        desc: '去 AI 味的默认档：定位 → 修正 → 收紧，一次调用。', builtin: FIX_SYSTEM_PROMPT_TIGHTEN,
        legacy: { key: 'fixLightSystemPrompt', kind: 'override' }, contract: ['<FixedReply>'],
        note: '保留输出格式要求（<FixedReply> / <problems> 区块）——丢了它们，校正结果将无法被解析应用。' },
    { id: 'fix.thorough', group: '校正', label: '自动校正 · 精校（DeepSeek / Gemini 侧重）',
        desc: '精校档、侧重选 DeepSeek 类或 Gemini 类时用。', builtin: FIX_PROMPT_JINGXIAO_DEEPSEEK,
        legacy: { key: 'fixThoroughSystemPrompt', kind: 'override' }, contract: ['<FixedReply>'],
        note: '改了这一条、而「精校（Opus 侧重）」没改时，Opus 侧重也用这一份（与原版一致）。' },
    { id: 'fix.thoroughOpus', group: '校正', label: '自动校正 · 精校（Opus 侧重）',
        desc: '精校档、侧重选 Opus 类时用（对「数据包腔」更强攻）。', builtin: FIX_PROMPT_JINGXIAO_OPUS, contract: ['<FixedReply>'] },
    { id: 'fix.keepAnchors', group: '校正', label: '保留区锚点说明',
        desc: '正文里嵌了 ⟦SO_KEEP_n⟧ 占位锚点时附上，要求模型原样留在原位。',
        builtin: '【保留区锚点】<text_to_transform> 里形如 ⟦SO_KEEP_数字⟧ 的标记是系统占位锚点（用户「保留区」的内容已被抽走，稍后会按标记位置原样接回）：必须【原样保留、留在它出现的位置】，绝不改写、移动、合并或删除——它不是要校正的内容；正文其余照常校正。' },
    { id: 'fix.customFooter', group: '校正', label: '📋 自定义模板 · 输出格式',
        desc: '接在你的模板后面的输出格式要求。', builtin: FIX_CUSTOM_FOOTER, contract: ['<FixedReply>'] },
    { id: 'fix.customRawNote', group: '校正', label: '📋 自定义模板 · 结构块原样保留',
        desc: '关了「沿用校正的正文识别」、整条回复交给模板时附上。', builtin: FIX_CUSTOM_RAW_NOTE },
    { id: 'fix.customLead', group: '校正', label: '📋 自定义模板 · 请求句',
        desc: '用模板处理回复时替你发出的那句话。', builtin: FIX_CUSTOM_LEAD },

    // —— 校正目标 ——
    { id: 'fix.targetsLead', group: '校正目标', label: '总起句',
        desc: '按目标去 AI 味时，排在所有目标前面的一句。', builtin: FIX_TARGETS_LEAD },
    { id: 'fix.target.slop', group: '校正目标', label: FIX_TARGET_MODULES.slop.label,
        desc: `勾选「${FIX_TARGET_MODULES.slop.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.slop.t1 + (FIX_TARGET_MODULES.slop.t2 ? '\n' + FIX_TARGET_MODULES.slop.t2 : ''),
        legacy: { key: 'fixTargetSlopPrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.slop.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.target.dialogue', group: '校正目标', label: FIX_TARGET_MODULES.dialogue.label,
        desc: `勾选「${FIX_TARGET_MODULES.dialogue.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.dialogue.t1 + (FIX_TARGET_MODULES.dialogue.t2 ? '\n' + FIX_TARGET_MODULES.dialogue.t2 : ''),
        legacy: { key: 'fixTargetDialoguePrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.dialogue.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.target.precision', group: '校正目标', label: FIX_TARGET_MODULES.precision.label,
        desc: `勾选「${FIX_TARGET_MODULES.precision.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.precision.t1 + (FIX_TARGET_MODULES.precision.t2 ? '\n' + FIX_TARGET_MODULES.precision.t2 : ''),
        legacy: { key: 'fixTargetPrecisionPrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.precision.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.target.magic', group: '校正目标', label: FIX_TARGET_MODULES.magic.label,
        desc: `勾选「${FIX_TARGET_MODULES.magic.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.magic.t1 + (FIX_TARGET_MODULES.magic.t2 ? '\n' + FIX_TARGET_MODULES.magic.t2 : ''),
        legacy: { key: 'fixTargetMagicPrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.magic.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.target.pacing', group: '校正目标', label: FIX_TARGET_MODULES.pacing.label,
        desc: `勾选「${FIX_TARGET_MODULES.pacing.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.pacing.t1 + (FIX_TARGET_MODULES.pacing.t2 ? '\n' + FIX_TARGET_MODULES.pacing.t2 : ''),
        legacy: { key: 'fixTargetPacingPrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.pacing.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.target.archaic', group: '校正目标', label: FIX_TARGET_MODULES.archaic.label,
        desc: `勾选「${FIX_TARGET_MODULES.archaic.label}」时发给模型的那一段。`,
        builtin: FIX_TARGET_MODULES.archaic.t1 + (FIX_TARGET_MODULES.archaic.t2 ? '\n' + FIX_TARGET_MODULES.archaic.t2 : ''),
        legacy: { key: 'fixTargetArchaicPrompt', kind: 'override' },
        note: '只写内容，【标签】头由程序自动加。' + (FIX_TARGET_MODULES.archaic.t2
            ? '内置分两段——第二段只在所需依据（角色卡 / 前文 / 世界书）在场时附加；改过后整份恒发。'
            : '改过后整份恒发。') },
    { id: 'fix.knowledge', group: '校正目标', label: '角色知识边界',
        desc: '「进阶设置」里填了角色知识边界时附上。',
        builtin: '【角色知识边界】把以下当成关于角色已知 / 未知的事实约束，逐句检查：任何角色用到边界外的信息，'
        + '就改成 ta 表现出不知道 / 疑惑 / 需要去查，自然不生硬；无法判断是否违反就保留原样。\n约束：' + '{%knowledge%}', vars: { knowledge: '你填的知识边界' }, required: ['knowledge'] },
    { id: 'fix.guardrails', group: '校正目标', label: '剧情护栏',
        desc: '「进阶设置」里填了剧情护栏时附上。',
        builtin: '【剧情护栏】遵守以下剧情规则，只纠正违反之处，不擅改其他剧情：\n{%guardrails%}', vars: { guardrails: '你填的剧情护栏' }, required: ['guardrails'] },

    // —— 角色工坊 ——
    { id: 'bld.interview', group: '角色工坊', label: '访谈师 · NPC',
        desc: '打造目标是 NPC 世界书条目时，访谈师的主指令。', builtin: BUILDER_INTERVIEW_PROMPT },
    { id: 'bld.interviewSteal', group: '角色工坊', label: '访谈师 · 用户角色（抢话）',
        desc: '打造目标是用户角色·抢话时，访谈师的主指令。', builtin: BUILDER_INTERVIEW_PROMPT_STEAL },
    { id: 'bld.interviewNosteal', group: '角色工坊', label: '访谈师 · 用户角色（不抢话）',
        desc: '打造目标是用户角色·不抢话时，访谈师的主指令。', builtin: BUILDER_INTERVIEW_PROMPT_NOSTEAL },
    { id: 'bld.protocol', group: '角色工坊', label: '输出区块格式',
        desc: '访谈与锻造共用：<CharBrief> / <CharDraft> / <DraftPatch> 三种区块怎么写。', builtin: BUILDER_PROTOCOL,
        contract: ['<CharBrief>', '<CharDraft>', '<DraftPatch>'], note: '三种区块的格式是解析契约：改坏了，汇总、草稿、修改都收不下来。' },
    { id: 'bld.target', group: '角色工坊', label: '「当前目标」行',
        desc: '告诉模型这次在打造什么。', builtin: '【当前目标】{%target%}', vars: { target: '打造目标（如「NPC 世界书条目」）' }, required: ['target'] },
    { id: 'bld.sections', group: '角色工坊', label: '「草稿包含」行',
        desc: '列出勾选的部分，并禁止生成 / 追问没勾的部分；一个都没勾时用后半句代替。',
        builtin: '本次草稿需要覆盖的部分：{%#list%}{%list%}{%/list%}{%^list%}（用户未勾选任何部分——只写一句话概括）{%/list%}。未列出的部分一律不要生成，也不要在访谈中追问。',
        vars: { list: '勾选的部分（顿号分隔）' } },
    { id: 'bld.lookMustAsk', group: '角色工坊', label: '外貌素材 · 必问',
        desc: 'NPC 访谈、勾了「外貌特征」时附上：没有外貌素材就必须问一次。', builtin: BUILDER_LOOK_MUSTASK },
    { id: 'bld.draftRef', group: '角色工坊', label: '当前草稿正文段（修订时）',
        desc: '已有草稿时，把它作为 <DraftPatch> 锚点的唯一来源喂给访谈师。',
        builtin: '=== 当前草稿正文（权威·你正在修改的就是这一份；出 <DraftPatch> 时锚点务必从这里【逐字复制】，不要凭对话记忆或用户转述）===\n{%draft%}',
        vars: { draft: '当前草稿（正在显示的那个版本）' }, required: ['draft'] },
    { id: 'bld.wi', group: '角色工坊', label: '访谈 · 世界书段',
        desc: '访谈时附上的世界书条目（提醒模型遵守「角色如何生成」类规则）。',
        builtin: '=== 世界书 / 设定（找找有没有专门规定「角色如何生成」的条目——命名规则、种族限制、数值模板、格式规定；有就必须遵守）===\n{%wi%}',
        vars: { wi: '选中的世界书条目' }, required: ['wi'] },
    { id: 'bld.scanWi', group: '角色工坊', label: '访谈 · 关键词命中段',
        desc: '勾了「关键词触发世界书」时附上的补充条目。',
        builtin: '=== 世界书 · 关键词命中（参考补充——聊天里提到的相关设定）===\n{%wi%}', vars: { wi: '关键词命中的条目' }, required: ['wi'] },
    { id: 'bld.stat', group: '角色工坊', label: '变量状态段',
        desc: '勾了「带上状态栏数据」时附上（访谈与锻造共用）。',
        builtin: '=== 当前变量状态（stat_data）===\n{%stat%}', vars: { stat: '当前变量状态（stat_data）JSON' }, required: ['stat'] },
    { id: 'bld.transcript', group: '角色工坊', label: '故事对话记录段',
        desc: '访谈与锻造共用的主聊天记录。',
        builtin: '=== 故事对话记录（最新的在最后）===\n{%transcript%}', vars: { transcript: '最近的主聊天记录' }, required: ['transcript'] },
    { id: 'bld.macroNote', group: '角色工坊', label: '宏说明（条目里有 {{user}} 等宏时）',
        desc: '世界书条目按原样显示、含 {{user}} 等宏时放在最前面的说明。',
        builtin: '（说明：以下条目按原样显示，{{user}}/{{char}} 等宏未替换；写草稿时可以按当前故事用真名。）' },

    // —— 角色锻造 ——
    { id: 'bld.forge', group: '角色锻造', label: '锻造工序 · NPC',
        desc: '点「🔨 生成」时锻造 NPC 世界书条目的工序指令。', builtin: BUILDER_FORGE_PROMPT,
        contract: ['<CharDraft>'], note: '工序里每个「■ 部分名」小节会按「草稿包含」的勾选删留：改写时保留这些小节头，否则没勾的部分删不掉。' },
    { id: 'bld.forgeSteal', group: '角色锻造', label: '锻造工序 · 用户角色（抢话）',
        desc: '锻造用户角色·抢话版的工序指令。', builtin: BUILDER_FORGE_PROMPT_STEAL,
        contract: ['<CharDraft>'], note: '「■ 部分名」小节头会按勾选删留，改写时请保留。' },
    { id: 'bld.forgeNosteal', group: '角色锻造', label: '锻造工序 · 用户角色（不抢话）',
        desc: '锻造用户角色·不抢话版的工序指令。', builtin: BUILDER_FORGE_PROMPT_NOSTEAL,
        contract: ['<CharDraft>'], note: '「■ 部分名」小节头会按勾选删留，改写时请保留。' },
    { id: 'bld.dlgRich', group: '角色锻造', label: '台词丰满',
        desc: '勾了「台词丰满」时附在锻造指令后面。', builtin: DLG_RICH_RIDER },
    { id: 'bld.forgeWi', group: '角色锻造', label: '锻造 · 世界书段',
        desc: '锻造时附上的世界书条目。', builtin: '=== 世界书 / 设定 ===\n{%wi%}', vars: { wi: '选中的世界书条目' }, required: ['wi'] },
    { id: 'bld.forgeScanWi', group: '角色锻造', label: '锻造 · 关键词命中段',
        desc: '锻造时附上的关键词命中条目。', builtin: '=== 世界书 · 关键词命中（参考补充）===\n{%wi%}', vars: { wi: '关键词命中的条目' }, required: ['wi'] },
    { id: 'bld.forgeAsk', group: '角色锻造', label: '锻造请求',
        desc: '点「🔨 生成」时替你发出的那句话（后接访谈汇总）。', builtin: '按工序锻造这个角色：\n\n{%brief%}',
        vars: { brief: '访谈汇总 <CharBrief> 原文' }, required: ['brief'] },
    { id: 'bld.condense', group: '角色锻造', label: '✂️ 精简',
        desc: '草稿卡上「✂️ 精简」：拆长句、删重复，不添内容。', builtin: DRAFT_CONDENSE_PROMPT,
        contract: ['<<<content'], note: '<<<content … content>>> 围栏是解析契约。' },
    { id: 'bld.condenseAsk', group: '角色锻造', label: '✂️ 精简 · 请求',
        desc: '精简时替你发出的那句话。', builtin: '请按系统规则精简下面这张角色卡正文。\n【原稿开始】\n{%draft%}\n【原稿结束】',
        vars: { draft: '草稿原稿' }, required: ['draft'] },
    { id: 'bld.condenseSect', group: '角色锻造', label: '✂️✂️ 深度精简 · 分节',
        desc: '深度精简第一步：分三份逐节精简。', builtin: CONDENSE_SECT_PROMPT,
        contract: ['<<<content'], note: '<<<content … content>>> 围栏是解析契约。' },
    { id: 'bld.condenseSectAsk', group: '角色锻造', label: '✂️✂️ 深度精简 · 分节请求',
        desc: '每一份分节精简的请求正文。',
        builtin: '【全卡参考（只读，供查重，不要输出）】\n{%full%}\n\n【你负责精简的节】{%names%}\n【这些节的原文】\n{%text%}',
        vars: { full: '整张卡原稿', names: '本份负责的节名', text: '这些节的原文' }, required: ['text'] },
    { id: 'bld.condenseOps', group: '角色锻造', label: '✂️✂️ 深度精简 · 删减手术单',
        desc: '深度精简第二步：开出删减 / 压缩清单，由程序逐条执行。', builtin: CONDENSE_OPS_PROMPT,
        contract: ['〔删〕'], note: '〔删〕/〔缩〕的行格式是解析契约。' },
    { id: 'bld.condenseOpsAsk', group: '角色锻造', label: '✂️✂️ 深度精简 · 手术单请求',
        desc: '开手术单时的请求正文。', builtin: '请为下面这张角色卡正文开删减手术单。\n【正文开始】\n{%draft%}\n【正文结束】',
        vars: { draft: '分节精简后的整卡' }, required: ['draft'] },

    // —— 上下文段落（各模式共用）——
    { id: 'ctx.card', group: '上下文段落', label: '角色卡段',
        desc: '角色名、描述、性格、场景和你的 Persona 拼成的一段。',
        builtin: '=== 角色 / 设定 ===\n角色：{%char%}\n\n用户 / Persona：{%user%}\n\n'
            + '{%#description%}描述：\n{%description%}{%/description%}\n\n'
            + '{%#personality%}性格：\n{%personality%}{%/personality%}\n\n'
            + '{%#scenario%}场景：\n{%scenario%}{%/scenario%}\n\n'
            + '{%#persona%}Persona：\n{%persona%}{%/persona%}',
        vars: { char: '角色名', user: '用户名', description: '角色描述', personality: '性格', scenario: '场景', persona: '用户 Persona 描述' } },
    { id: 'ctx.wi', group: '上下文段落', label: '世界书段',
        desc: '世界书条目前面加的标题。', builtin: '=== 世界书 / 设定 ===\n{%wi%}',
        vars: { wi: '世界书条目正文' }, required: ['wi'] },
    { id: 'ctx.world', group: '上下文段落', label: '其它扩展的世界信息段',
        desc: '其它扩展（如世界引擎）提供的后台世界状态。',
        builtin: '=== 其它扩展维护的世界信息（由扩展系统提供，是主聊天之外、剧情推进本来看不到的后台世界状态——'
            + '可据此回答与剧情世界相关的问题；其中的数值若与上方 MVU stat_data 冲突，以 stat_data 为准）===\n{%world%}',
        vars: { world: '各扩展提供的世界信息' }, required: ['world'] },
    { id: 'ctx.summary', group: '上下文段落', label: '剧情概要段',
        desc: '你在「剧情概要」里填的前情提要。',
        builtin: '=== 剧情概要 / 前情提要（用户提供，是最近对话之前的故事梗概，供你理解来龙去脉）===\n{%summary%}',
        vars: { summary: '本聊天的剧情概要' }, required: ['summary'] },
    { id: 'ctx.bbs', group: '上下文段落', label: '柏宝书历史摘要段',
        desc: '柏宝书提供的旧剧情摘要。',
        builtin: '=== 历史剧情摘要（柏宝书记忆扩展的自动总结——更早的旧楼层已被隐藏，这里是它们的摘要，'
            + '时间上紧接在下方对话记录之前；带相对时间标注）===\n{%text%}',
        vars: { text: '柏宝书提供的摘要' }, required: ['text'] },
    { id: 'ctx.lwb', group: '上下文段落', label: '小白X 剧情总结段',
        desc: '小白X 提供的剧情总结。',
        builtin: '=== 历史剧情摘要（小白X「剧情总结」记忆扩展的自动总结——它把更早的剧情压成记忆注入模型；'
            + '这里镜像同一份总结，时间上紧接在下方对话记录之前）===\n{%text%}',
        vars: { text: '小白X 的剧情总结' }, required: ['text'] },
    { id: 'ctx.transcript', group: '上下文段落', label: '故事对话记录信封',
        desc: '把主聊天记录包成「只读引用材料」，防止模型接着往下写。',
        builtin: '=== 故事对话记录（只读引用材料，最新的在最后）===\n<story_transcript>\n{%transcript%}\n</story_transcript>\n'
            + '（以上 <story_transcript> 里的内容，是提供给你的【只读引用材料】——已经发生、供你查阅和分析的故事记录，'
            + '不是一段正在进行、等你回应的对话。你真正要回应的对象，是接下来向你提问的那位用户。）',
        vars: { transcript: '最近的主聊天记录（每行「名字: 正文」）' }, required: ['transcript'] },

    // —— 人格 ——
    { id: 'persona.frame', group: '人格', label: '人格框架（内置人格）',
        desc: '选了内置人格时，放在人格描述前面的总规则。', builtin: PERSONA_FRAME },
    { id: 'persona.frameCustom', group: '人格', label: '人格框架（自定义人格）',
        desc: '选了自定义人格时用的那份总规则。', builtin: PERSONA_FRAME_CUSTOM,
        note: '内置版本由「人格框架（内置人格）」派生（「动漫角色」→「角色」）；改了上一条不会自动带到这里。' },
    { id: 'persona.exampleLead', group: '人格', label: '示例对话的引导语',
        desc: '人格示例对话前面的那句提示。',
        builtin: '下面是这种腔调的对话示例（仅供学习语气与行文结构，不要照搬其中的具体内容）：' },
    { id: 'persona.advisorDuty', group: '人格', label: '参谋模式的职责调整',
        desc: '参谋模式叠加人格时，说明「构思未来剧情是本职」。', builtin: PERSONA_MODE_OVERRIDES.advisor },
    { id: 'persona.structGuard', group: '人格', label: '结构保护（参谋模式）',
        desc: '参谋模式叠加人格时，要求方案区块的格式不受腔调影响。', builtin: PERSONA_STRUCT_GUARD },
    { id: 'persona.lorebookDuty', group: '人格', label: '世界书模式的职责调整',
        desc: '世界书模式叠加人格时，说明「按要求改条目是本职」。', builtin: PERSONA_MODE_OVERRIDES.lorebook },
    { id: 'persona.builderDuty', group: '人格', label: '角色工坊的职责调整',
        desc: '角色工坊访谈叠加人格时，要求区块内部格式不受腔调影响。', builtin: PERSONA_MODE_OVERRIDES.builder },
    { id: 'persona.structGuardWi', group: '人格', label: '结构保护（世界书 / 角色工坊）',
        desc: '世界书与工坊叠加人格时，要求区块格式和条目正文都不带人格腔调。', builtin: PERSONA_STRUCT_GUARD_WI },
    { id: 'persona.flesh', group: '人格', label: '「✨ AI 帮我完善」扩写提示词',
        desc: '自定义人格编辑器里「✨ AI 帮我完善」用的指令。', builtin: PERSONA_FLESH_PROMPT,
        contract: ['<PersonaVoice>'], note: '<PersonaVoice> / <PersonaExample> 区块是解析契约。' },
    ...PERSONAS.filter((p) => p.voice).flatMap((p) => [
        { id: 'persona.voice.' + p.id, group: '人格', label: `内置人格 · ${p.label} · 腔调`,
            desc: `内置人格「${p.label}」的腔调描述。`, builtin: p.voice },
        { id: 'persona.example.' + p.id, group: '人格', label: `内置人格 · ${p.label} · 示例对话`,
            desc: `内置人格「${p.label}」的示例对话。`, builtin: p.example || '' },
    ]),

    // —— 内置破限 ——
    { id: 'jb.core', group: '内置破限', label: '破限头（放在最前）',
        desc: '选了内置破限时，放在整组消息最前面。', builtin: BUILTIN_JB_CORE },
    { id: 'jb.tail', group: '内置破限', label: '破限尾（放在最后）',
        desc: '选了内置破限时，放在整组消息最后面。', builtin: BUILTIN_JB_TAIL },
];
const PROMPT_DEF_MAP = new Map(PROMPT_DEFS.map((d) => [d.id, d]));
const PROMPT_VAR_RE = /\{%\s*(\w+)\s*%\}/g;

export function promptDef(id) {
    return PROMPT_DEF_MAP.get(id) || null;
}

// 用户覆盖表（settings.promptOverrides）。getSettings 保证它是本设置对象自己的普通对象。
function promptOverrides(s) {
    return (s && s.promptOverrides && typeof s.promptOverrides === 'object') ? s.promptOverrides : {};
}

// 未渲染的提示词原文：用户覆盖 → 否则内置。旧键各按原版语义读。
export function promptRaw(id, s = getSettings()) {
    const d = promptDef(id);
    if (!d) { console.error('[剧情推进] 未登记的提示词：', id); return ''; }
    const lg = d.legacy;
    if (lg) {
        const v = s ? s[lg.key] : undefined;
        if (lg.kind === 'full') return typeof v === 'string' ? v : d.builtin;
        if (lg.kind === 'override') return (typeof v === 'string' && v.trim() !== '') ? v : d.builtin;
    }
    const o = promptOverrides(s);
    return Object.prototype.hasOwnProperty.call(o, id) ? String(o[id]) : d.builtin;
}

export function promptIsCustom(id, s = getSettings()) {
    const d = promptDef(id);
    if (!d) return false;
    return promptRaw(id, s) !== d.builtin;
}

// 写入：与内置完全相同就删掉覆盖（之后内置文本改进时自动用上）。旧键按原版语义写。
export function promptSet(id, text, s = getSettings()) {
    const d = promptDef(id);
    if (!d || !s) return;
    const t = String(text ?? '');
    const lg = d.legacy;
    if (lg && lg.kind === 'full') { s[lg.key] = t; return; }
    if (lg && lg.kind === 'override') { s[lg.key] = (t === d.builtin || t.trim() === '') ? '' : t; return; }
    if (!s.promptOverrides || typeof s.promptOverrides !== 'object') s.promptOverrides = {};
    if (t === d.builtin) delete s.promptOverrides[id];
    else s.promptOverrides[id] = t;
}

export function promptReset(id, s = getSettings()) {
    const d = promptDef(id);
    if (!d || !s) return;
    const lg = d.legacy;
    if (lg && lg.kind === 'full') { s[lg.key] = d.builtin; return; }
    if (lg && lg.kind === 'override') { s[lg.key] = ''; return; }
    if (s.promptOverrides && typeof s.promptOverrides === 'object') delete s.promptOverrides[id];
}

// 纯函数：按上面注释里的规则渲染模板。vars 里没有的名字原样保留。
function renderPromptTemplate(raw, vars) {
    const v = vars || {};
    const filled = (k) => Object.prototype.hasOwnProperty.call(v, k) && String(v[k] ?? '') !== '';
    const DROP = '\u0001';
    let t = String(raw ?? '');
    let dropped = false;
    // 条件段：{%#x%}…{%/x%} / {%^x%}…{%/x%}（不支持同名嵌套）
    t = t.replace(/\{%\s*([#^])\s*(\w+)\s*%\}([\s\S]*?)\{%\s*\/\s*\2\s*%\}/g, (m, kind, k, body) => {
        if (!Object.prototype.hasOwnProperty.call(v, k)) return m;
        const keep = (kind === '#') === filled(k);
        if (keep) return body;
        dropped = true;
        return DROP;
    });
    const lines = [];
    for (const line of t.split('\n')) {
        if (line.includes(DROP) && line.split(DROP).join('').trim() === '') { dropped = true; continue; }
        const keys = [...line.matchAll(PROMPT_VAR_RE)].map((x) => x[1]).filter((k) => Object.prototype.hasOwnProperty.call(v, k));
        if (keys.length && keys.every((k) => !filled(k))) { dropped = true; continue; }
        lines.push(line.split(DROP).join(''));
    }
    t = lines.join('\n');
    if (dropped) t = t.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    // 代入只扫一遍：代入的值不会被再当成模板
    return t.replace(PROMPT_VAR_RE, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? String(v[k] ?? '') : m));
}

// 取一条提示词：用户覆盖或内置，按 vars 渲染（不传 vars = 原文）。
export function P(id, vars, s) {
    const raw = promptRaw(id, s === undefined ? getSettings() : s);
    return vars ? renderPromptTemplate(raw, vars) : raw;
}

// 编辑器用：这条模板缺了哪些必需变量 / 格式契约字面量。
export function promptProblems(id, text) {
    const d = promptDef(id);
    if (!d) return [];
    const t = String(text ?? '');
    const have = new Set([...t.matchAll(PROMPT_VAR_RE)].map((x) => x[1]));
    const out = [];
    for (const k of d.required || []) if (!have.has(k)) out.push(`{%${k}%}`);
    for (const lit of d.contract || []) if (!t.includes(lit)) out.push(lit);
    return out;
}

export function buildSystemPrompt() {
    const ctx = getCtx();
    const s = getSettings();

    if (sharedState.diagnoseMode) return buildDiagnosePrompt(ctx, s);
    if (sharedState.lorebookMode) return buildLorebookPrompt(ctx, s);
    if (sharedState.advisorMode) return buildAdvisorPrompt(ctx, s);
    if (sharedState.fixMode) return buildFixPrompt(ctx, s);
    if (sharedState.builderMode) return buildBuilderPrompt(ctx, s);

    const parts = [P('chat.system', null, s)];

    const personaBlock = buildPersonaBlock(s.personaId, null, s);
    if (personaBlock) parts.push(personaBlock);

    if (s.includeCard) {
        parts.push(buildCardSection(ctx));
    }

    if (sharedState.worldInfoBlock) {
        parts.push(P('ctx.wi', { wi: sharedState.worldInfoBlock }, s));
    }

    parts.push(buildChatStatSection());
    parts.push(buildChatWorldSection());

    // 用户功能请求：运行概要插在最近对话记录的正前方。
    const summarySection = buildSummarySection(getSummary());
    if (summarySection) parts.push(summarySection);

    // 柏宝书记忆桥：被隐藏旧楼层的摘要，紧跟概要、贴着对话记录（时间线：概要 → 摘要 → 可见对话）。
    const bbsSection = buildBbsHistorySection(getBbsHistoryText());
    if (bbsSection) parts.push(bbsSection);
    // 小白X 记忆桥：镜像小白X 注入主模型的剧情总结，同位柏宝书。
    const lwbSection = buildLwbHistorySection(getLwbSummaryText());
    if (lwbSection) parts.push(lwbSection);

    const transcript = buildTranscript(ctx, s);
    if (transcript) {
        if (ENABLE_OFFSTAGE_GUARD) {
            // 戏外守卫：围栏（结构层）+ 尾锚（行为层）。字节冻结，改必重测（见常量处注释）。
            parts.push(wrapTranscriptEnvelope(transcript));
            parts.push(P('chat.tail', null, s));
        } else {
            parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);
        }
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

// 普通模式的变量数值纪律（v1.14.6）。两种姿态、绝无中间态：
// 有权威状态 -> 给全量数值 + 「剧情里的旧数值一律以此为准」（状态栏残影免疫）；
// 无权威状态 -> 明令如实拒答具体数值。LLM 被问数值时默认编一个像样的，
// 这一段就是把「编」这条路堵死。
export function buildChatStatSection() {
    return sharedState.chatStatData ? P('chat.statOn', { stat: sharedState.chatStatData }) : P('chat.statOff');
}