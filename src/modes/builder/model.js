import { renderMarkdownOnly } from '../chat/context.js';
import { ENABLE_BUILDER_PERSONA_STYLES } from '../../prompts/builtins.js';
import { P } from '../../prompts/registry.js';
import { locateTagOpen } from '../../ui/messages.js';
import { escapeHtml } from '../../ui/mode-shell.js';
import { fuzzyReplace } from '../lorebook/operations.js';

// 访谈回复的显示渲染（与参谋 renderAdvisorReplyHtml 同构）：散文段渲 Markdown（只走 renderMarkdownOnly，不碰正则引擎），
// <CharBrief>/<CharDraft>/<DraftPatch> 区块进 <pre class="so-plan-raw"> 转义原样（区块解析走 classifyBuilderReply 从
// 【字符串】读，与这里的 DOM 渲染无关）。库缺失（无 showdown/DOMPurify）→ 返回 null，调用方回退纯文本。
export function renderBuilderReplyHtml(text) {
    const segs = splitBuilderSegments(String(text || ''));
    if (!segs.some((x) => x.type === 'block')) return renderMarkdownOnly(String(text || ''));
    let html = '';
    for (const seg of segs) {
        if (seg.type === 'block') {
            html += '<pre class="so-plan-raw">' + escapeHtml(seg.text) + '</pre>';
        } else if (seg.text.trim()) {
            const h = renderMarkdownOnly(seg.text);
            if (h == null) return null;   // 库缺失 → 整条回退纯文本（不出半渲染的杂拼）
            html += h;
        }
    }
    return html;
}

// ===== 角色工坊：区块解析（CharBrief / CharDraft / DraftPatch）=====
// 与世界书区块同族：键值头 + <<<tag … tag>>> 围栏，绝不使用 JSON。
const BLD_TARGETS = ['persona-update', 'persona-new', 'npc-new', 'npc-edit'];

// 角色工坊：可勾选的草稿部分。id 进设置，label 是 chip 文案（锻造提示词按 label 引用——改label要同步）。
// def = 默认开：默认集 = 写卡教室的必修层 + 防误读；默认关 = 教程自己标注「视角色而定」的进阶件
// （多副面孔/言行反差/点睛比喻）+ 可选清单项（弱点缺陷/能力技能——2026-07-08 Prince 裁定默认关、
// 排到普通 chip 行末尾）。adv:true = 进阶三件（默认关、UI 归一组给指引）。
// #2 reframe：勾选=要求锻造工序做出来（用户说了算，工序不再自判适用性——不合适是用户的责任，UI 指引兜底）。
const BUILDER_SECTIONS = [
    { id: 'basics',      label: '基本信息', def: true,  desc: '姓名、年龄、性别、身份，以及和你的关系定位' },
    { id: 'appearance',  label: '外貌特征', def: true,  desc: '只写认得出TA的特征——遮住名字也知道是谁' },
    { id: 'backstory',   label: '背景经历', def: true,  desc: '改变过TA的关键事件（因果链），不堆生平流水账' },
    { id: 'relations',   label: '人际关系', def: true,  desc: '和重要人物的具体相处画面，不写抽象总结' },
    { id: 'personality', label: '性格画像', def: true,  desc: '三层颜色（底色/主色调/点缀）+ 具体场景衍生，不贴标签' },
    { id: 'speech',      label: '说话方式', def: true,  desc: 'TA怎么开口——语气、口癖、台词示例' },
    { id: 'goals',       label: '目标动机', def: true,  desc: 'TA现在想要什么、被什么驱动' },
    { id: 'depth',       label: '深层人格', def: true,  desc: 'AI推导的决策层：TA真正缺什么、怕什么、底线在哪（默认开，简单角色可关）' },
    { id: 'antimisread', label: '防误读提示', def: true,  desc: '提前拦住AI最容易演歪的方向（比如把安静演成冷漠、把拒绝演成傲娇）' },
    // retired（2026-07-08 Prince 裁定）：行为逻辑 chip 从面板退役——UI 不显示、老存档选择由 getSettings
    // 迁移滤掉；提示词 ■ 块 / 门控 / 调优 rig 全保留（rig 喂显式 id 数组、不经 UI 闸）。复活 = 删掉此旗。
    { id: 'habits',      label: '行为逻辑', def: false, retired: true, desc: '日常琐事里TA会怎么做——吃亏/尴尬/求助时的具体反应画面（可选，勾了才生成）' },
    // 可选两件（2026-07-08 Prince：默认关、排在普通 chip 行末尾——想要就勾，锻造才会写）。
    { id: 'flaws',       label: '弱点缺陷', def: false, desc: '短板、软肋，以及TA保护自己的方式（可选，勾了才生成）' },
    { id: 'abilities',   label: '能力技能', def: false, desc: '会什么、擅长什么、边界在哪（可选，默认不写，勾了才生成）' },
    // 进阶三件（adv）排在最末、UI 前面挂一条「简单/喜剧角色留空」标签——门控已移交用户（#2 reframe）。
    { id: 'faces',       label: '多副面孔', def: false, adv: true, desc: '〔进阶·按需〕同一个人在压力场景间判若两人才勾——性格始终如一的角色不必勾' },
    { id: 'mix',         label: '言行反差', def: false, adv: true, desc: '〔进阶·按需〕内心有拉扯、嘴上身体不一致的角色才勾——实心眼直性子不必勾' },
    { id: 'imagery',     label: '点睛比喻', def: false, adv: true, desc: '〔进阶·按需〕用一个总比喻收束整个角色（如「冬天窗台上那一小格阳光」）——功能型/喜剧型可跳过' },
];

// 面板可见的 chips（retired 件不出现）。UI 渲染 / 图例都从这里取——retired 的死角由它 + getSettings
// 迁移兜住；builderSelectedSections 本身对显式 id 数组保持透明（调优 rig 契约，ALL15 feeds 不受影响）。
export function builderVisibleSections(table = BUILDER_SECTIONS) {
    return table.filter((x) => !x.retired);
}


// 存档迁移（getSettings 调用）：把 retired chip 从已保存的显式选择里滤掉——不然老存档会隐形续用
// 一个面板上已不存在、也无法取消的件。null / 非数组原样放行。纯函数、可单测。
export function sanitizeBldSections(sel) {
    if (!Array.isArray(sel)) return sel;
    const retired = new Set(BUILDER_SECTIONS.filter((x) => x.retired).map((x) => x.id));
    return sel.some((id) => retired.has(id)) ? sel.filter((id) => !retired.has(id)) : sel;
}

// 打造目标归一（纯函数、可单测）：旧档 'persona' → 'persona-nosteal'；不认识的值回默认。
// 只在 ENABLE_BUILDER_PERSONA_STYLES 开启时由 getSettings 调用——关着时旧值原样保留（回退零损伤）。
export function normalizeBldTarget(v) {
    if (v === 'persona') return 'persona-nosteal';
    if (v === 'npc' || v === 'persona-steal' || v === 'persona-nosteal') return v;
    return 'persona-nosteal';
}
// 工坊「写入」目标世界书回退判定（纯函数）：picked = resolveLbTargetNames(s.bldBooks, all, active) 的结果
//（与选书器「已选 N 本」读数同源、已滤掉磁盘上不存在的书）。恰一本 → {book}；零本 → {err:'none'}；
// 多本 → {err:'multi',count}。draft 自带 book 时调用方直接用、不进这里。可单测（builder-book-target.test.mjs）。
export function resolveBuilderTargetBook(picked) {
    const list = Array.isArray(picked) ? picked : [];
    if (list.length === 1) return { book: list[0] };
    if (!list.length) return { err: 'none' };
    return { err: 'multi', count: list.length };
}

// 把设置里的 chip 选择解析成 section 对象数组：变体自 builderVariantKey 定，各读自己的 sectionsKey
// （null = 该变体表里 def:true 的那些；否则显式 id 数组），顺序恒按该变体 sections 表，未知 id 丢弃。
// 对显式 id 数组保持透明（调优 rig 契约：ALL15 feeds 点名 card 块，不经 UI/存档闸）。纯函数、可单测。
export function builderSelectedSections(s) {
    const v = BUILDER_VARIANTS[builderVariantKey(s)];
    const sel = Array.isArray(s[v.sectionsKey]) ? s[v.sectionsKey] : null;
    if (!sel) return v.sections.filter((x) => x.def);
    return v.sections.filter((x) => sel.includes(x.id));
}

// 生成喂给锻造模型的中文提示行：列出本次草稿要覆盖的部分，并禁止生成 / 追问未列出的部分。
export function builderSectionsLine(s) {
    const labels = builderSelectedSections(s).map((x) => x.label);
    return P('bld.sections', { list: labels.join('、') });
}


export function builderLookAskLine(s) {
    if (builderVariantKey(s) !== 'card') return '';   // 外貌必问是 card 访谈的专属注入；persona 变体有自己的外貌话术
    return builderSelectedSections(s).some((x) => x.id === 'appearance') ? P('bld.lookMustAsk', null, s) : '';
}

// —— chip 物理门控（lessons-pass ■ 块版；前身 #3 Tier 2 行前缀门控）：未勾的部分从锻造提示词里
// 【物理删除/重写】——所见即所得（勾选=送进模型）。BUILDER_FORGE_PROMPT 保持字节冻结；这里按选择后处理。
// 工序三里每个 chip 小节 = 一个以「■ <label>：」起头的整块，块到下一个「■ 」行或工序头（一、~五、）
// 为止——未勾就整块删除（块内允许多行：junior 打磨后的块可能带子行）。块头逐字取自冻结提示词 +
// BUILDER_SECTIONS 的 label——tests/unit/builder-gating.test.mjs 的漂移守卫钉住两边：提示词/label
// 一改动、门控就红（而非静默错删）。buildForgeMessages 发送前施加，选择 = builderSelectedSections(s) 的 id。可单测。
const CHIP_BLOCK_HEADER = {
    basics:      '■ 基本信息',
    appearance:  '■ 外貌特征',
    backstory:   '■ 背景经历',
    relations:   '■ 人际关系',
    personality: '■ 性格画像',
    faces:       '■ 多副面孔',
    mix:         '■ 言行反差',
    depth:       '■ 深层人格',
    speech:      '■ 说话方式',
    goals:       '■ 目标动机',
    flaws:       '■ 弱点缺陷',
    habits:      '■ 行为逻辑',
    abilities:   '■ 能力技能',
    antimisread: '■ 防误读提示',
    imagery:     '■ 点睛比喻',
};
// 工序五组装顺序（lessons 6 A7 裁定；≠ BUILDER_SECTIONS 的 chip 排列）——防误读提示/点睛比喻 恒为最后两节。
const FORGE_ASSEMBLY_ORDER = ['basics', 'appearance', 'backstory', 'relations', 'personality', 'faces', 'mix', 'depth', 'speech', 'goals', 'flaws', 'habits', 'abilities', 'antimisread', 'imagery'];

/* ==== 用户角色分家（1.25.0）：三变体数据表 ====
 * 设计：docs/superpowers/specs/2026-07-08-builder-persona-split-design.md。
 * card = NPC 卡（沿用冻结的 BUILDER_SECTIONS / CHIP_BLOCK_HEADER / FORGE_ASSEMBLY_ORDER）；
 * steal = 用户角色·抢话（AI 也扮演{{user}}：简化卡 + 禁止说明 + 边界）；
 * nosteal = 用户角色·不抢话（AI 只回应：行为翻译手册，无调色盘——教程错误二）。
 * label 与各自锻造提示词的 ■ 块头逐字同步（builder-gating.test.mjs 漂移守卫钉三方）。 */
const BUILDER_SECTIONS_STEAL = [
    { id: 'basics',     label: '基本信息',   def: true, desc: '姓名、年龄、身份、家境、住处——写满的硬事实表（AI 演你，知道越具体演得越准）' },
    { id: 'appearance', label: '外貌特征',   def: true, desc: '两三个特化特征，每个都带「禁止说明」——不写，AI 会把你的白发翻来覆去地提' },
    { id: 'backstory',  label: '背景设定',   def: true, desc: '只写影响你现在行为的关键经历，一到三件' },
    { id: 'goals',      label: '目标动机',   def: true, desc: 'AI 根据材料和世界观推导你当前所求——只写有依据的，无台词' },
    { id: 'palette',    label: '性格调色盘', def: true, desc: '底色/主色调/点缀 + 少量衍生——AI 要演你，需要知道你的质地' },
    { id: 'boundary',   label: '边界',       def: true, desc: '关键剧情允许 AI 演出超出日常的反应——要惊喜就勾，要完全可控就关' },
];
const BUILDER_SECTIONS_NOSTEAL = [
    { id: 'basics',      label: '基础设定', def: true, desc: '姓名、身份、家境、关键经历、和角色的关系——写满的客观信息表' },
    { id: 'goals',       label: '目标动机', def: true, desc: 'AI 根据材料和世界观推导你当前所求——知道你图什么，才不会把手段误读成动机' },
    { id: 'touch',       label: '肢体接触', def: true, desc: '你的触碰方式和真实含义——拦住「揉脸=占有」这类误读' },
    { id: 'speech',      label: '说话方式', def: true, desc: '命令口气/沉默/短回复/损人的真实含义——最容易被 AI 读歪的部分' },
    { id: 'emotion',     label: '情绪表达', def: true, desc: '开心/生气/难过/紧张时你的可见表现——AI 靠这个判断你当下心情' },
    { id: 'interaction', label: '互动模式', def: true, desc: '你和当前角色之间的专属习惯——「不反驳=包容不是认怂」' },
];
const CHIP_BLOCK_HEADER_STEAL = {
    basics: '■ 基本信息', appearance: '■ 外貌特征', backstory: '■ 背景设定',
    goals: '■ 目标动机', palette: '■ 性格调色盘', boundary: '■ 边界',
};
const CHIP_BLOCK_HEADER_NOSTEAL = {
    basics: '■ 基础设定', goals: '■ 目标动机', touch: '■ 肢体接触',
    speech: '■ 说话方式', emotion: '■ 情绪表达', interaction: '■ 互动模式',
};
const FORGE_ASSEMBLY_ORDER_STEAL = ['basics', 'appearance', 'backstory', 'goals', 'palette', 'boundary'];
const FORGE_ASSEMBLY_ORDER_NOSTEAL = ['basics', 'goals', 'touch', 'speech', 'emotion', 'interaction'];

// 变体解析（纯函数）：设置 → card/steal/nosteal。开关关闭一律 card（= 现状行为）。
export function builderVariantKey(s) {
    if (!ENABLE_BUILDER_PERSONA_STYLES) return 'card';
    const t = normalizeBldTarget(s && s.bldTarget);
    return t === 'npc' ? 'card' : (t === 'persona-steal' ? 'steal' : 'nosteal');
}

// 变体资料束（提示词字段在 builderInterviewPromptFor / builderForgePromptFor——两张 map 分开，
// 避免本表与提示词常量互相前置）。assemblyTail = 工序组装顺序里强制收尾的 id 对（card 专属）。
export const BUILDER_VARIANTS = {
    card:    { sections: BUILDER_SECTIONS,         chipHeaders: CHIP_BLOCK_HEADER,         assemblyOrder: FORGE_ASSEMBLY_ORDER,         assemblyTail: ['antimisread', 'imagery'], sectionsKey: 'bldSections',        streamKey: 'bld_card' },
    steal:   { sections: BUILDER_SECTIONS_STEAL,   chipHeaders: CHIP_BLOCK_HEADER_STEAL,   assemblyOrder: FORGE_ASSEMBLY_ORDER_STEAL,   assemblyTail: [],                         sectionsKey: 'bldSectionsSteal',   streamKey: 'bld_steal' },
    nosteal: { sections: BUILDER_SECTIONS_NOSTEAL, chipHeaders: CHIP_BLOCK_HEADER_NOSTEAL, assemblyOrder: FORGE_ASSEMBLY_ORDER_NOSTEAL, assemblyTail: [],                         sectionsKey: 'bldSectionsNosteal', streamKey: 'bld_nosteal' },
};
export function gateForgePrompt(sys, selectedIds, headers = CHIP_BLOCK_HEADER, order = FORGE_ASSEMBLY_ORDER, tailIds = ['antimisread', 'imagery']) {
    const sel = new Set(selectedIds || []);
    const label = (id) => headers[id].slice(2);   // 「■ 」后即 chip label
    const out = [];
    let dropping = false;   // 正在删除某个未勾 ■ 块的行
    for (const line of String(sys).split('\n')) {
        // ■ 块边界：新「■ 」行或工序头结束上一块的删除态。
        if (line.startsWith('■ ')) {
            const hit = Object.entries(headers).find(([, h]) => line.startsWith(h + '：'));
            dropping = !!hit && !sel.has(hit[0]);
            if (dropping) continue;
        } else if (/^[一二三四五]、/.test(line)) {
            dropping = false;
        } else if (dropping) {
            continue;
        }
        // Op C：工序五组装顺序行——按选择重生成（order 参数过滤 → label 连接；tailIds 非空则钉收尾节）。
        if (line.startsWith('- 只覆盖勾选的部分，按 ')) {
            const o = order.filter((id) => sel.has(id)).map(label).join('→');
            let l = '- 只覆盖勾选的部分，按 ' + o + ' 的顺序组装';
            const lastTwo = tailIds.filter((id) => sel.has(id)).map(label);
            if (lastTwo.length === 2) l += '——' + lastTwo[0] + '与' + lastTwo[1] + '永远是最后两节';
            else if (lastTwo.length === 1) l += '——' + lastTwo[0] + '永远是最后一节';
            out.push(l + '。');
            continue;
        }
        // Op D：成稿规矩·外貌/关系——未勾就删对应从句（派生：拆分号从句），通用「写行为不贴标签」恒留。
        if (line.startsWith('- 外貌只写')) {
            const cl = line.replace(/^- /, '').replace(/。$/, '').split('；');
            const kept = [];
            if (sel.has('appearance')) kept.push(cl[0]);
            if (sel.has('relations')) kept.push(cl[1]);
            kept.push(cl[cl.length - 1]);   // 通用从句恒留
            out.push('- ' + kept.join('；') + '。');
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

// —— v4 探针兜底（HANDOFF-V4 §3D，2026-07-09）：锻造稿入坞前的机械地板 ——
// 三轮调优 + v4 探针（DS-nosteal ×8：7/8 稿在带类型槽里照样编造「我知道」类引号台词）实锤：
// 散文禁令/自检对 DeepSeek 不可靠、提示词已到天花板 → 提示词管质量、这里管下限（仿校正器的
// 机械块处理惯例）。只动 persona 变体，card 原样回；GM 稿本来干净＝无操作。纯函数、幂等。
// ① nosteal：原话/禁止误读 行之外的成对引号只剥【引号标记】、内容保留——「抢着说"我知道"」
//    →「抢着说我知道」＝转述形，不删字（含义格语法不伤）；steal 不剥（教程允许 ≤3 句台词）。
// ② 绝对词软化（两变体）：从不/绝不→一般不、极度→很、每次…都→多数时候…都、一定会→多半会、
//    永远→一直；「不一定会」「永远的」「拒绝不了」「服从不了」有负向断言护着不误伤。
// ③ ⟨…⟩ 与 （依据：…） 跨段占位护住（⟦SO_EV_n⟧，同校正器 ⟦SO_KEEP_n⟧ 惯例）——依据是
//    一字未改的引文，一个字节不动。
export function sanitizePersonaDraft(content, variantKey) {
    if (variantKey !== 'steal' && variantKey !== 'nosteal') return String(content ?? '');
    const guarded = [];
    let s = String(content ?? '').replace(/（依据：[^）]*）|⟨[^⟩]*⟩/g, (m) => {
        guarded.push(m);
        return '⟦SO_EV_' + (guarded.length - 1) + '⟧';
    });
    const soften = (t) => t
        .replace(/(?<![拒谢婉回])绝不/g, '一般不')
        .replace(/(?<![服听遵屈盲跟])从不/g, '一般不')
        .replace(/极度/g, '很')
        .replace(/每次([^\n，。；]{0,6})都/g, '多数时候$1都')
        .replace(/(?<!不)一定会/g, '多半会')
        .replace(/永远(?!的)/g, '一直');
    s = s.split('\n').map((line) => {
        const t = line.trimStart();
        if (t.startsWith('原话') || t.startsWith('禁止误读')) return line;
        let out = line;
        if (variantKey === 'nosteal') {
            out = out.replace(/「([^」\n]+)」|“([^”\n]+)”|"([^"\n]+)"/g, (_, a, b, c) => a ?? b ?? c);
        }
        // Prince 裁决 2026-07-09（v4.1 R2）：范畴式含义格是拦截的牙——「含义：」整行、
        // 对偶行「＝ 意思：」右半 豁免软化；引号剥离照旧。原话行整行豁免在上面已优先。
        if (/^含义[:：]/.test(t)) return out;
        const pair = out.match(/[＝=]\s*意思[:：]/);
        if (pair) return soften(out.slice(0, pair.index)) + out.slice(pair.index);
        return soften(out);
    }).join('\n');
    return s.replace(/⟦SO_EV_(\d+)⟧/g, (m, i) => guarded[Number(i)] ?? m);
}

function bldExtractFence(body, tag) {
    // 闭合行宽容 </tag>>> 变体（XML 反射滑手，评估轮 A.1 真实 DeepSeek 稿 1/10 出现）；
    // 教学语法（BUILDER_PROTOCOL）不变，仍只教 tag>>>。
    const m = body.match(new RegExp('<<<' + tag + '\\n([\\s\\S]*?)\\n(?:</)?' + tag + '>>>'));
    return m ? m[1] : null;
}

function bldParseHeaders(body) {
    const headers = {};
    for (const line of body.split('\n')) {
        if (line.startsWith('<<<')) break;
        const m = line.match(/^(target|name|book|uid|entry|key|comment)\s*[:：]\s*(.*)$/);
        if (m) headers[m[1]] = m[2].trim();
    }
    return headers;
}

function parseCharBrief(text) {
    const m = String(text || '').match(/<CharBrief>([\s\S]*?)<\/CharBrief>/i);
    if (!m) return { brief: null, error: '' };
    const h = bldParseHeaders(m[1]);
    const desc = bldExtractFence(m[1], 'desc');
    if (!BLD_TARGETS.includes(h.target)) return { brief: null, error: 'target 缺失或不合法' };
    if (desc == null || !desc.trim()) return { brief: null, error: '缺少 <<<desc 围栏' };
    const uid = /^\d+$/.test(h.uid || '') ? parseInt(h.uid, 10) : null;
    if (h.target === 'npc-edit' && uid == null && !(h.entry || '').trim()) {
        return { brief: null, error: 'npc-edit 需要 uid 或 entry' };
    }
    if (h.target === 'persona-new' && !(h.name || '').trim()) return { brief: null, error: 'persona-new 需要 name' };
    return { brief: { target: h.target, name: h.name || '', book: h.book || '', uid, entry: h.entry || '', desc: desc.trim(), raw: m[0] } };
}

export function parseCharDraft(text) {
    const src = String(text || '');
    // 开锚防劫持（1.29.0，locateTagOpen/1.25.0 同族）：思考里【提到】字面 <CharDraft> 会劫持
    // 首次出现匹配（polish-5 合并电池 cp-ds2 实证、基线 rand-ds-02 前兆）——行首出现取最后一个，
    // 无行首出现再取最后任意（真区块按输出格式独占一行）。
    const open = locateTagOpen(src, 'CharDraft');
    if (!open) return { draft: null, error: '' };
    const rest = src.slice(open.index + open.length);
    const closeM = rest.match(/<\/CharDraft>/i);
    // 收尾滑手容错：</CharDraft> 缺失时取到文末（评估轮 A.1；polish-5 基线 rand-ds-01 真丢稿实证）。
    const body = closeM ? rest.slice(0, closeM.index) : rest;
    const h = bldParseHeaders(body);
    if (!BLD_TARGETS.includes(h.target)) return { draft: null, error: 'target 缺失或不合法' };
    let content = bldExtractFence(body, 'content');
    if (content == null) {
        const fenceM = body.match(/^<<<content\b[^\n]*\n?/m);
        if (fenceM) {
            // 围栏开了没关（rand-ds-01 实证：稿其实完整，DS 只是忘了 content>>> 和 </CharDraft>）——
            // 围栏行之后全部当正文。真截断的残稿也会被救成【可见的】半稿坞进草稿卡，由用户审改/
            // 重锻——好过整锻白跑（1.29.0；同批 16384 地板让真截断本身更难发生）。bldExtractFence
            // 语义未动（persona-pass 的 </content> 容忍待办不受影响）。
            content = body.slice(fenceM.index + fenceM[0].length);
        } else {
            // 围栏整个缺失（头部照写、正文裸奔）：头部行之后全部当正文兜底。
            const lines = body.split('\n');
            let i = 0;
            while (i < lines.length && (!lines[i].trim() || /^(target|name|book|uid|entry|key|comment)\s*[:：]/.test(lines[i]))) i++;
            const bare = lines.slice(i).join('\n');
            if (bare.trim()) content = bare;
        }
    }
    if (content == null || !content.trim()) return { draft: null, error: '缺少 <<<content 围栏' };
    if (h.target === 'persona-new' && !(h.name || '').trim()) return { draft: null, error: 'persona-new 需要 name' };
    const uid = /^\d+$/.test(h.uid || '') ? parseInt(h.uid, 10) : null;
    const rawEnd = closeM ? open.index + open.length + closeM.index + closeM[0].length : src.length;
    return { draft: { target: h.target, name: h.name || '', book: h.book || '', uid, key: h.key || '', comment: h.comment || '', content: content.trim(), raw: src.slice(open.index, rawEnd) } };
}

export function parseDraftPatch(text) {
    const m = String(text || '').match(/<DraftPatch>([\s\S]*?)<\/DraftPatch>/i);
    if (!m) return { ops: [], errors: [] };
    const ops = []; const errors = [];
    // 每个单元：anchor: 行（吸收到 <<<replace 为止的多行锚点）+ replace 围栏。
    // 收尾 \n 设为可选（\n?）：删除 op 空替换体常被模型写成 `<<<replace\nreplace>>>`（无空行），
    // 缺那个换行会让逐字正确的锚点也解析失败（2026-07-19 真 DS 高上下文电池）；`\n\nreplace>>>`
    // 与 `\nreplace>>>` 现在等价 = 空删除。正常替换体行为不变（非贪婪体仍在收尾换行处收束）。
    const unitRe = /anchor\s*[:：]\s*([\s\S]*?)\n<<<replace\n([\s\S]*?)\n?(?:<\/)?replace>>>/g;
    let u;
    while ((u = unitRe.exec(m[1])) !== null) {
        const anchor = u[1].replace(/\s*\n\s*/g, ' ').trim();
        if (!anchor) { errors.push('空锚点'); continue; }
        ops.push({ anchor, replace: u[2] });
    }
    const anchorCount = (m[1].match(/^anchor\s*[:：]/gm) || []).length;
    if (anchorCount > ops.length) errors.push(`有 ${anchorCount - ops.length} 个 anchor 缺少 <<<replace 围栏`);
    if (!ops.length && !errors.length) errors.push('DraftPatch 内没有可解析的修改');
    return { ops, errors };
}

function splitBuilderSegments(text) {
    const src = String(text || '');
    const re = /<(CharBrief|CharDraft|DraftPatch)>[\s\S]*?<\/\1>|<(CharBrief|CharDraft|DraftPatch)>[\s\S]*$/gi;
    const out = []; let last = 0; let m;
    while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push({ type: 'prose', text: src.slice(last, m.index) });
        out.push({ type: 'block', text: m[0] });
        last = m.index + m[0].length;
    }
    if (last < src.length) out.push({ type: 'prose', text: src.slice(last) });
    return out;
}

export function classifyBuilderReply(text) {
    const d = parseCharDraft(text);
    if (d.draft) return { kind: 'draft', draft: d.draft };
    const p = parseDraftPatch(text);
    if (p.ops.length || p.errors.length) return { kind: 'patch', ops: p.ops, errors: p.errors };
    const b = parseCharBrief(text);
    if (b.brief) return { kind: 'brief', brief: b.brief };
    // draftError 非空 ⟺ 有 <CharDraft> 开标签但没解析成（parseCharDraft 无开标签时恒返回 ''）——
    // 调用方靠它把「整稿没落地」说出口，而不是把一整篇改写静默丢掉（1.43.1）。
    return { kind: 'none', draftError: d.error || '' };
}

// 外科手术式改稿：逐条用世界书同款模糊锚点替换；未命中的记录原因、不阻断后续。
export function applyDraftPatchOps(draftText, ops) {
    let cur = String(draftText || '');
    const results = [];
    for (const op of (ops || [])) {
        const { result, matched } = fuzzyReplace(cur, op.anchor, op.replace);
        if (matched) { cur = result; results.push({ ok: true, anchor: op.anchor }); }
        else results.push({ ok: false, anchor: op.anchor, reason: '锚点未找到' });
    }
    return { result: cur, results };
}

// 纯函数：把「锻造阶段误发的 <DraftPatch>」当作对现有 NPC 条目正文的补丁应用，产出可入坞的 npc-edit 草稿。
// 背景（FINDINGS Round B）：npc-edit 目标下 DeepSeek ~3/5 会从锻造直接吐 <DraftPatch>（把「改已有条目」
// 读成外科补丁）而非完整 <CharDraft>——runForge 只认 CharDraft，故 live 报「锻造没产出草稿」＝Prince 的
// 「编辑经常失败」。这里用现有条目正文吃下补丁、合成 target=npc-edit 的完整草稿正文，让 🔨 生成路径照常入坞。
// ops 空 → 无补丁可救（空 error，调用方退回常规提示）；锚点全未命中 → 不硬塞（返回 error，多半锚的不是这条目）。可单测。
export function forgePatchToDraft(existingContent, ops, brief, resolvedUid) {
    if (!ops || !ops.length) return { draft: null, error: '' };
    const base = String(existingContent == null ? '' : existingContent);
    if (!base.trim()) return { draft: null, error: '找不到要改的条目正文——请让访谈师在汇总里带上 uid 或准确的条目标题' };
    const { result, results } = applyDraftPatchOps(base, ops);
    const matched = results.filter((r) => r.ok).length;
    if (!matched) return { draft: null, error: '锻造给的是补丁，但锚点都没对上现有条目正文' };
    const b = brief || {};
    const draft = {
        target: 'npc-edit',
        name: b.name || '',
        book: b.book || '',
        uid: (resolvedUid != null) ? resolvedUid : (b.uid != null ? b.uid : null),
        key: '',
        comment: b.entry || b.name || '',
        content: result,
        raw: '',
    };
    return { draft, note: `锻造直接给了补丁（${matched}/${results.length} 处命中），已套用到现有条目上`, matched, total: results.length };
}
