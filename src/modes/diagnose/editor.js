import { saveChatMetadata } from '../../core/chat-metadata.js';
import { awaitMvuIdle, postReplyShouldStop, refreshLatestMvuBar } from '../../core/post-reply.js';
import { getSettings } from '../../core/settings.js';

import { MVUED_LIST_META_KEY, MVUED_META_KEY, MVUED_TRAINER_META_KEY, getChatMetadataSafe } from '../advisor/metadata.js';
import { appendNoteToRoom } from '../chat/history.js';
import { chatIdentityKey } from '../chat/send.js';
import { applyMvuedEdits, buildMvuedModel, buildMvuedScanPrompt, diagUserFloorNotice, mvuIsVwdPair, mvuMsgOpts, mvuedFieldPathList, mvuedLeafKind, mvuedNoteContent, mvuedPathStr, mvuedScanLooksTruncated, parseMvuedSchema } from './auto.js';
import { extractUpdateBlock, getMvu, getMvuStatData } from './mvu.js';
import { maybeRunSaveHealth, mvuedEffectiveLeaf } from './schema.js';
import { buildDiagSelectedWi, diagPickerActive } from '../lorebook/core.js';
import { DIAG_PATCH_CLOSE, DIAG_PATCH_OPEN, ENABLE_MVU_EDITOR, ENABLE_MVU_TRAINER, ENABLE_SCHEMA_DIAG, MVU_BLOCK_DIALECTS } from '../../prompts/builtins.js';
import { detectMvuBlockDialect } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { buildWorldInfo, collectMvuUpdateRules, wiContextMode } from '../../st/adapters.js';
import { callDirect, callProfile, resolveEndpointUrl } from '../../transport/direct.js';
import { enhanceIconBtnNode } from '../../ui/window.js';
import { lastPrompt, nextCid, setLastPrompt, setLastPromptMeta } from '../../core/runtime-state.js';
import { mvuedActiveTab, mvuedApplying, mvuedDirty, mvuedKindOverrides, mvuedOpenChatKey, mvuedOpenData, mvuedRefreshTimer, mvuedScanCtl, mvuedScanning, mvuedSchemaCache, setMvuedActiveTab, setMvuedApplying, setMvuedDirty, setMvuedKindOverrides, setMvuedOpenChatKey, setMvuedOpenData, setMvuedRefreshTimer, setMvuedScanCtl, setMvuedScanning, setMvuedSchemaCache, setTrainerLastRun, setTrainerRulesForRender, trainerLastRun, trainerRulesForRender } from './state.js';
import { mvuApi } from '../../st/runtime-state.js';
import { win } from '../../ui/state.js';

/* ── 🎛 变量编辑器 UI ─────────────────────────────────────────────────
 * 会话内瞬态：脏表 / 打开快照 / 当前页签都【不落盘】（同全屏阅读的做法——UI 状态不进设置）。
 * 打开时抓一份 MvuData 拷贝只用于【显示】；真正写入时（mvuedApply）重读 fresh 数据再落 applyMvuedEdits。 */

      // 打开时的 MvuData 拷贝（仅供展示；应用时重读 fresh）
   // 本聊天的扫描 schema（打开时从 metadata 读）
        // 当前页签下标（开窗归零）
 // 🩺 1.89.0：从存档检查跳来时，把那一格按卡片要求的类型渲染（{pathStr: kind}；开卡时定、关卡清空）
// 「应用」在途标志（防连点写两次）。updateMvuedFoot 是「应用」键 disabled 的唯一写入口，故它也读这里——
// 否则用户在写入过程中随手改个值，updateMvuedFoot 会把刚禁用的按钮又点亮。

// 「🔍 分析取值规则」在途标志。刻意【不】复用 mvuedApplying：两件事互不相干（扫描只读规则、应用只写变量），
// 共用一个标志会让任一方在途时把对方的按钮也锁死，而扫描一趟最长 120 秒 —— 用户会以为「应用」坏了。
// updateMvuedScanBtn 是扫描键 disabled + 文案的唯一写入口（在途时该键翻成「⏹ 中断扫描」，见那里）。

// 在途扫描的中断器把手（空闲时恒 null）。必须是【模块级】而非 runMvuedScan 里的局部 const：两个圈外的
// 中断来源都得够得着它——① 用户按扫描键上的「⏹ 中断扫描」（spec §6 的可中断承诺）；② 切聊天时
// onChatChanged——那一趟的结果已经注定要在危险点三被丢弃，让它继续跑就是白烧钱，且扫描键会
// 在【新聊天】里僵成在途态最长 120 秒。

// 开卡那一刻的聊天身份键（同 mvuedApply / runMvuedScan 用的 chatIdentityKey）。只服务于「跟随现实」的刷新：
// onChatChanged 已经会 closeMvuEditor，正常情况下切聊天时这张卡早没了；但刷新走的是一颗 300ms 的防抖
// 定时器，它完全可能在「切聊天」与「新聊天里又开了一张卡」之间落地。带上身份钉 = 那颗迟到的定时器
// 绝无可能把【新聊天】的数据当成刷新结果摆进任何一张卡。开卡时写、关卡时清。

// 「跟随现实」的防抖把手（空闲恒 null）。必须是模块级：关卡时要掐掉（closeMvuEditor），
// 而事件监听器是在 init 里一次性挂的、够不着任何局部变量。

// 修改器上一回合的执行结果（会话内存，不落盘、不进侧聊）。唯一消费者 = 🎛 页的读数行。
// 形状：{ changes:[{label,from,to,kind}], skipped:string[], stamp:string, chatKey:string } | null
// chatKey = 执行那一刻钉住的聊天身份（runTrainer 的入参、来自 chatIdentityKey()）。切聊天后这个变量
// 依然留着【上一个】聊天的读数（它本身不随聊天切换清空）——挂上 chatKey 是让 Task 9 的渲染器能
// 判断「这条读数是不是当前聊天的」，不把旧聊天的改动误显示成这一个聊天的「上一回合」。

// 🎛 修改器：本次重画用的规则快照。renderMvuedBody 开头刷一次，叶子渲染只读它——
// 否则每个叶子都要读一遍 chat metadata + 规范化一遍（几百个叶子 × 每次重画）。


function collectMvuedEdits() { return Array.from(mvuedDirty.values()); }

// 🗑 待删标记的开关（1.88.0；对传入的脏表就地操作，可单测）。返回 true = 已标记待删，false = 已取消。
// 标记 = 同路径的一条 {path, remove:true}，【不】立即写 MVU —— 与值编辑一样等「应用」、计入「已改 N 项」、
// 「还原」一并清掉；应用后的撤销走侧聊记录（整份快照换回）。标记时把两样东西暂存进标记条目、取消时原样还回：
//   · 同路径原有的值编辑（prev）；· 子孙路径上的编辑（dropped）—— 待删子树不再渲染，留着它们只会在应用时
//     落成「跳过 N 项（字段已不存在）」的假警报。误点一下 🗑 再点 ↩，用户手上的活一个都不丢。
// 标记条目带着暂存物直接交给 applyMvuedEdits 无妨：写入只认 path / remove。
function mvuedToggleRemove(dirty, path) {
    const key = mvuedPathStr(path);
    const cur = dirty.get(key);
    if (cur && cur.remove) {
        dirty.delete(key);
        if (cur.prev) dirty.set(key, cur.prev);
        for (const [k, e] of (cur.dropped || [])) dirty.set(k, e);
        return false;
    }
    const under = (p) => Array.isArray(p) && p.length > path.length && path.every((seg, i) => p[i] === seg);
    const dropped = [];
    for (const [k, e] of Array.from(dirty.entries())) {
        if (k !== key && e && under(e.path)) { dropped.push([k, e]); dirty.delete(k); }
    }
    dirty.set(key, { path: path.slice(), remove: true, prev: cur || null, dropped });
    return true;
}

function mvuedReadSchemaCache() {
    try {
        const md = getChatMetadataSafe();
        const c = md && md[MVUED_META_KEY];
        return (c && c.v === 1) ? { fields: c.fields || {}, groups: c.groups || [] } : null;
    } catch (e) { return null; }
}

// 「当作列表」覆盖清单的读侧（形状见 MVUED_LIST_META_KEY）。恒返回数组：读不到 / 形状不对 → []，
// 让 buildMvuedModel 的第三参永远拿到干净输入。每次重画现读（本聊天的元数据，不缓存进模块变量：
// 它不像 schema 那样要跨在途扫描活着，现读一次的代价是一次对象取值）。
function mvuedReadListOverrides() {
    try {
        const md = getChatMetadataSafe();
        const a = md && md[MVUED_LIST_META_KEY];
        return Array.isArray(a) ? a.filter(p => typeof p === 'string') : [];
    } catch (e) { return []; }
}

// 「当作列表」开关的唯一写入口（≡ 与 ⇄ 两颗按钮都走这里）。三件事，缺一不可：
//   ① 读-改-写 metadata + 落盘（空清单删键，保持元数据干净，同 setDiagWiMeta 风格）；
//   ② **丢掉该路径上的脏项**（本函数唯一的承重不变量，两个方向都要丢）—— 形状一变，旧载荷即非法：
//      VWD 编辑的载荷是【标量】（写进 [0]），列表编辑的载荷是【整个数组】。两种事故都不是「跳过并上报」，
//      都很难看，故照实写在这里，别「顺手简化」掉：
//        · ≡ 方向（旧脏项是 VWD 的标量）：改建成 list 后 mvuedListValue 命中同一个 pathStr、直接返回那个
//          **标量**，renderMvuedList 的 `val.forEach` 当场 TypeError。而 renderMvuedBody 是先
//          `bodyEl.innerHTML = ''` 再逐节点 append 的 → 抛在中途 = 用户看到**整个编辑器正文一片空白**。
//        · ⇄ 方向（旧脏项是整数组 + vwd:false）：applyMvuedEdits 【不会】跳过它（vwd 闸只管 vwd:true 的），
//          于是 `parent[last] = [...]` 把整个数组**盖到那个 [值,"描述"] 对上** —— 静默写坏形状，
//          MVU 那边再也读不出这个字段。
//      （附带作用：脏项没了，「已改 N 项」计数也就诚实了 —— 那条改动确实已经作废。）
//   ③ 重画。切换显示形状【本身绝不标脏】——它是显示偏好，不是一次改动（不写 stat_data）。
function mvuedSetListOverride(path, on) {
    const key = mvuedPathStr(path);
    const md = getChatMetadataSafe();
    if (md) {
        const next = mvuedReadListOverrides().filter(p => p !== key);
        if (on) next.push(key);
        if (next.length) md[MVUED_LIST_META_KEY] = next;
        else delete md[MVUED_LIST_META_KEY];
        saveChatMetadata();
    }
    mvuedDirty.delete(key);
    renderMvuedBody();
}

/* ── 🎛 变量修改器（ENABLE_MVU_TRAINER）规则存储 ───────────────────────
 * 规则【点击即存】，不经「应用」——它们不是一次值编辑，而是常驻设置。 */

// 规则表的规范化闸（纯，可单测）。宽进严出：逐条校验，脏项丢弃、干净项照收。
// 承重理由同 mvuedReadListOverrides：metadata 是落盘数据，手改过 / 旧版本残留 / 别的扩展写脏都可能，
// 一条坏规则绝不许让整个编辑器打不开。
function trainerNormalizeRules(raw) {
    const out = [];
    const seen = Object.create(null);          // 跨 realm 安全：普通对象而非 Map/Set
    for (const r of (Array.isArray(raw) ? raw : [])) {
        if (!r || typeof r !== 'object') continue;
        if (!Array.isArray(r.path) || !r.path.length) continue;
        if (r.path.some(seg => seg === '$internal')) continue;
        const kind = r.kind;
        let rule = null;
        if (kind === 'freeze') {
            if (r.value === undefined) continue;
            // freeze 目标只收标量（whole-branch review Finding 1，Path B）：mvuedApply 的「冻结重新
            // 武装」（~10262）只按 path 字符串比对目标，不会去看用户刚写的新值是什么形状——「≡ 当作
            // 列表」把一个 VWD 叶子翻正成列表编辑之后，用户改的就是【整个数组】，重新武装会把它原样
            // 塞进 freeze.value，下一回合 trainerComputeEdits 读到 VWD 判真的旧字段，把这个数组整个
            // 写进 [0]，得到 `[[新剑,皮甲],皮甲]`——逐字复现 MVU 头号地雷，且此后每回合都会重犯。
            // 这里是 trainerSetRule 的唯一收口（trainerReadRules/trainerComputeEdits 都经它），是堵住
            // 这条路径最省事的一点：与 trainerComputeEdits 那边的容器闸互为表里——那边挡「cur 变成
            // 容器」，这里挡「规则存的目标本身就是容器」，两条路径互不重叠，缺一个都堵不住另一条。
            if (!['number', 'string', 'boolean'].includes(typeof r.value)) continue;
            rule = { path: r.path.slice(), kind, value: r.value };
        } else if (kind === 'step') {
            if (!Number.isFinite(r.delta)) continue;
            rule = { path: r.path.slice(), kind, delta: r.delta };
        } else if (kind === 'clamp') {
            const min = Number.isFinite(r.min) ? r.min : null;
            const max = Number.isFinite(r.max) ? r.max : null;
            if (min == null && max == null) continue;   // 两边都没有 = 不成其为规则
            rule = { path: r.path.slice(), kind, min, max };
        } else {
            continue;
        }
        const key = mvuedPathStr(rule.path) + '|' + kind;
        if (key in seen) out[seen[key]] = rule;         // 同键后者覆盖
        else { seen[key] = out.length; out.push(rule); }
    }
    return out;
}

// 读侧：恒返回数组。每次现读（本聊天 metadata，不缓存进模块变量——同 mvuedReadListOverrides 的理由）。
export function trainerReadRules() {
    try {
        const md = getChatMetadataSafe();
        return trainerNormalizeRules(md && md[MVUED_TRAINER_META_KEY]);
    } catch (e) { return []; }
}

// 写侧唯一入口（🔒 chip 与 🎛 页的表单都走这里）。patch 为 null = 删除该 (path, kind) 规则。
// 空表删键，保持 metadata 干净（同 mvuedSetListOverride 的做法）。
export function trainerSetRule(path, kind, patch) {
    const md = getChatMetadataSafe();
    if (!md) return;
    const key = mvuedPathStr(path) + '|' + kind;
    const next = trainerReadRules().filter(r => (mvuedPathStr(r.path) + '|' + r.kind) !== key);
    if (patch) next.push(Object.assign({ path: path.slice(), kind }, patch));
    const clean = trainerNormalizeRules(next);
    if (clean.length) md[MVUED_TRAINER_META_KEY] = clean;
    else delete md[MVUED_TRAINER_META_KEY];
    saveChatMetadata();
}

function trainerRemoveRule(path, kind) { trainerSetRule(path, kind, null); }

/* 逐回合判定核（纯，可单测）—— 本功能全部语义都在这一个函数里。
 * 产出的 edits 与 applyMvuedEdits 吃的形状【逐字相同】，写入侧因此一行都不用改。
 *
 * 运算顺序（spec §3.2，规则叠在同一字段时承重）：先 ±X → 再 上下限 → 最后 冻结压过一切。
 * 顺序按【种类】判，不按规则在数组里的下标 —— 否则同一组规则换个添加顺序就会算出不同的值。
 *
 * 四条纪律：
 *  ① 路径必须是【自有属性】且逐段走得通，走不通就进 skipped —— 绝不造新键（同 applyMvuedEdits）。
 *  ② VWD 对（mvuIsVwdPair）只读写 [0] 的标量，vwd 标记【现判不入库】：字段换形状后
 *     存下来的旧标记就是过期的谎，而写标量还是写整对恰恰是 MVU 头号地雷。
 *  ③ step / clamp 只对数值动手，落在字符串 / 数组上一律跳过并上报（不做隐式类型转换）。
 *  ④ 算完与现值【逐字相同】→ 不产出 edit：无变化的回合必须一个字节都不写（不刷状态栏、不留读数）。
 */
function trainerComputeEdits(statData, rules) {
    const edits = [];
    const skipped = [];
    const changes = [];
    const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

    // 先按 pathStr 归拢：同一字段的三种规则要一起算，不能各出一条 edit（后写的会盖掉先写的）。
    const byPath = Object.create(null);
    for (const r of trainerNormalizeRules(rules)) {
        const key = mvuedPathStr(r.path);
        if (!byPath[key]) byPath[key] = { path: r.path, freeze: null, step: null, clamp: null };
        byPath[key][r.kind] = r;
    }

    for (const key of Object.keys(byPath)) {
        const g = byPath[key];
        const label = g.path.join('.');
        // 沿 statData 走到父容器
        let parent = statData;
        let ok = true;
        for (let i = 0; i < g.path.length - 1; i++) {
            if (!own(parent, g.path[i])) { ok = false; break; }
            parent = parent[g.path[i]];
        }
        const last = g.path[g.path.length - 1];
        if (!ok || !own(parent, last)) { skipped.push(label); continue; }

        const raw = parent[last];
        const vwd = mvuIsVwdPair(raw);
        const cur = vwd ? raw[0] : raw;

        // freeze 的容器闸（whole-branch review Finding 1，Path A）：cur 的「是不是容器」在规则创建
        // 之后可以变——最典型的是两项字符串列表（背包=['长剑','皮甲']，mvuIsVwdPair 的天然歧义把它
        // 当叶子渲染、🔒 冻结成了标量），剧情往里加一项之后 mvuIsVwdPair 判它为假，cur 就从标量变成
        // 【整个数组】。这条路径纯靠故事推进就能触发，不需要任何手改 metadata。不设防的话下面
        // `next = g.freeze.value` 会原样执行，一个标量把整个数组/对象顶替掉——正是 MVU 头号地雷
        // （landmine 笔记 mvu-parsing-facts）的另一种触发方式，而且没有 hand-editing 前置条件。
        // 用 mvuedLeafKind 而非 typeof：这是全仓「什么算可编辑叶子」的唯一口径（编辑器 UI 判断要不要
        // 挂 🔒 用的也是它），容器（数组/对象）恒 'readonly'——与「叶子」的定义保持一致，不用另开一套。
        if (g.freeze && mvuedLeafKind(cur) === 'readonly') { skipped.push(label); continue; }

        let next = cur;
        if (g.step || g.clamp) {
            if (typeof cur !== 'number') { skipped.push(label); continue; }
            if (g.step) next = next + g.step.delta;
            if (g.clamp) {
                if (g.clamp.min != null && next < g.clamp.min) next = g.clamp.min;
                if (g.clamp.max != null && next > g.clamp.max) next = g.clamp.max;
            }
        }
        if (g.freeze) next = g.freeze.value;      // 冻结压过一切——类型本身已在上面被容器闸校过

        if (next === cur) continue;               // 无变化 → 不写
        edits.push({ path: g.path.slice(), value: next, vwd });
        changes.push({ label, from: cur, to: next, kind: g.freeze ? 'freeze' : (g.step ? 'step' : 'clamp') });
    }
    return { edits, skipped, changes };
}

// 数字槽的唯一转换口。空串 / 半截输入（"-"、"1e"）/ 非数字 → NaN，调用方据此【什么都不标】。
// 用严格 Number 而非 parseFloat：parseFloat('12abc') 会悄悄收下 12。空串单独挡掉，否则 Number('') === 0
// —— 清空输入框会被写成 0，那是最容易被用户当成 bug 的一种「静默改值」。
function mvuedToNumber(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return NaN;
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
}

// 把【字符串态】的用户输入按叶子类型写进脏表。数字槽恒经 mvuedToNumber：扫描 schema 的 options
// 永远是字符串数组（数值字段也不例外），✎ 自由输入同理 —— 数字槽绝不能收到字符串，NaN 更不能进脏表。
// 返回：是否真的标了脏（调用方据此才点亮「已改」底色）。
function mvuedMarkTyped(leaf, raw) {
    if (leaf.kind === 'number') {
        const v = mvuedToNumber(raw);
        if (!Number.isFinite(v)) return false;
        mvuedMarkDirty(leaf, v);
        return true;
    }
    mvuedMarkDirty(leaf, raw);
    return true;
}

export async function openMvuEditor(opts) {
    if (!ENABLE_MVU_EDITOR || !win) return;
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') {
        try { window.toastr && window.toastr.info && window.toastr.info('未检测到 MVU —— 本聊天没有可编辑的变量。', '剧情推进 · 变量编辑器'); } catch (e) { /* ignore */ }
        return;
    }
    let data = null;
    try { data = Mvu.getMvuData(mvuMsgOpts()); } catch (e) { /* 下面按空处理 */ }
    try { setMvuedOpenData(data ? JSON.parse(JSON.stringify(data)) : null); } catch (e) { setMvuedOpenData(null); }
    setMvuedDirty(new Map());
    setMvuedActiveTab(0);
    setMvuedOpenChatKey(chatIdentityKey());   // 「跟随现实」刷新的身份钉（见 mvuedMaybeRefresh 的守卫②）
    setMvuedSchemaCache(mvuedReadSchemaCache());
    setMvuedKindOverrides((ENABLE_SCHEMA_DIAG && opts && Array.isArray(opts.focusPath) && opts.focusKind)
        ? { [mvuedPathStr(opts.focusPath)]: opts.focusKind } : null);

    // getMvu 是 async（可能等 TavernHelper 初始化）→ 连点两下按钮会走进两次 append。
    // 建卡前先把旧卡摘掉：永远只有一张 #so-mvued-card。
    const stale = document.getElementById('so-mvued-card');
    if (stale) stale.remove();

    const overlay = document.createElement('div');
    overlay.id = 'so-mvued-card';
    overlay.className = 'so-mvued-overlay';
    overlay.innerHTML = `
        <div class="so-mvued-inner">
            <div class="so-mvued-head">
                <span class="so-mvued-title">🎛 变量编辑器</span>
                <button type="button" class="so-lb-mini" id="so-mvued-scan">🔍 分析取值规则</button>
                <div class="so-iconbtn so-warn-x" id="so-mvued-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div id="so-mvued-scan-hint" class="so-hint">🔍 AI 读一遍卡的规则后：该选的变下拉菜单、有范围的数字加滑杆——只问一次，本聊天记住。</div>
            <input type="text" id="so-mvued-search" placeholder="搜索字段名…">
            <div id="so-mvued-tabs"></div>
            <div id="so-mvued-body"></div>
            <div class="so-mvued-foot">
                <span id="so-mvued-count"></span>
                <span id="so-mvued-status" class="so-apply-status"></span>
                <button type="button" class="so-apply-btn" id="so-mvued-revert">还原</button>
                <button type="button" class="so-apply-btn" id="so-mvued-apply" disabled>应用</button>
            </div>
        </div>`;
    win.appendChild(overlay);
    // 逃生两件套（叠层地雷）：✕、点背景关。Esc 【不】接管 —— 全屏那套的 Esc 消费者名单是有意收窄的，不动它。
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeMvuEditor(); });
    overlay.querySelector('#so-mvued-close').addEventListener('click', closeMvuEditor);
    // ✕ 是动态建出来的 .so-iconbtn → 补语义（role/tabindex/aria-label），否则键盘用户聚焦不到它 =
    // 关不掉这张卡（win 上的委托 keydown 只对可聚焦节点有意义）。整体的 enhanceIconButtonA11y 不能在这里调。
    enhanceIconBtnNode(overlay.querySelector('#so-mvued-close'));
    overlay.querySelector('#so-mvued-revert').addEventListener('click', () => { mvuedDirty.clear(); renderMvuedBody(); });
    overlay.querySelector('#so-mvued-apply').addEventListener('click', () => { mvuedApply(); });
    // 一键两态（spec §6 的「可中断」）：空闲 = 发起扫描，在途 = 中断这一趟。文案由 updateMvuedScanBtn 同步，
    // 这里只按当下的 mvuedScanning 分道。连点无害：cancelMvuedScan 只发中断（把手已 null 时直接返回、绝不
    // 自己复位状态机），runMvuedScan 自己也有 mvuedScanning 闸门挡住重入。
    overlay.querySelector('#so-mvued-scan').addEventListener('click', () => {
        if (mvuedScanning) cancelMvuedScan();
        else runMvuedScan();
    });
    renderMvuedBody();
    updateMvuedScanBtn();   // 本聊天已扫过 → 开卡就显示「重新扫描」（mvuedSchemaCache 上面刚从 metadata 读过）
    overlay.querySelector('#so-mvued-search').addEventListener('input', renderMvuedBody);
    // 🩺 1.89.0：存档检查的「在变量编辑器里打开这一格」——跳到那一页、滚到那一行、闪 2 秒（不替玩家改值）。
    // 找不到那一格就退到最近的祖先；全都找不到就停在首页，编辑照常。
    const focus = opts && Array.isArray(opts.focusPath) ? opts.focusPath : null;
    if (ENABLE_SCHEMA_DIAG && focus) {
        try {
            const stat = mvuedOpenData && (mvuedOpenData.stat_data || mvuedOpenData);
            const idx = mvuedTabIndexForPath(buildMvuedModel(stat, mvuedSchemaCache, mvuedReadListOverrides()), focus);
            if (idx >= 0) { setMvuedActiveTab(idx); renderMvuedBody(); }
            for (let n = focus.length; n > 0; n--) {
                const want = mvuedPathStr(focus.slice(0, n));
                const el = [...overlay.querySelectorAll('[data-path]')].find((x) => x.dataset.path === want);
                if (!el) continue;
                el.scrollIntoView({ block: 'center' });
                el.classList.add('so-mvued-flash');
                setTimeout(() => el.classList.remove('so-mvued-flash'), 2000);
                break;
            }
        } catch (e) { /* 跳不过去就停在首页，不影响编辑 */ }
    }
}

// 关卡即弃全部会话内状态（脏表 / 快照 / schema 缓存都是【某一次打开】的东西，schema 更是 per-chat）。
// 没开卡时纯空操作 —— onChatChanged 无条件调它就靠这一点。
export function closeMvuEditor() {
    const el = document.getElementById('so-mvued-card');
    if (el) el.remove();
    setMvuedKindOverrides(null);
    setMvuedDirty(new Map());
    setMvuedOpenData(null);
    setMvuedSchemaCache(null);
    setMvuedOpenChatKey(null);
    // 在途的「跟随现实」防抖也一起掐：卡都没了，那次刷新已无事可做（mvuedMaybeRefresh 自己也会空转，
    // 掐掉只是不留悬着的定时器）。与 cancelMvuedScan 的取舍不同——扫描的结果仍属于本聊天、值得跑完。
    if (mvuedRefreshTimer) { clearTimeout(mvuedRefreshTimer); setMvuedRefreshTimer(null); }
}

/* ── 打开中的编辑器「跟随现实」（1.59.0）────────────────────────────────
 * 卡里摆的是【打开那一刻】的 stat_data 拷贝，而剧情还在往下跑：新回复被 MVU 解析、自动诊断写回、
 * MVU 额外模型解析——任何一次都会把库里的值改掉。以前这张卡纹丝不动：状态栏已经显示体力 30，编辑器
 * 里还是 80，用户对着 80 改。（应用前重读 fresh 那道闸只保证「不覆盖别人的改动」，保证不了眼前这份
 * 显示是真的。）此处让它跟上。
 *
 * 三道守卫 + 一次比对，缺一不可：
 *   ① 旗关 / 卡不在文档里 → 不做事（本函数因此是无条件可调的空操作安全件）；
 *   ② 聊天已切走 → 整趟作废。onChatChanged 已经 closeMvuEditor 了，正常路径根本走不到这里；但刷新
 *      走 300ms 防抖，一颗旧定时器完全可能落在「切聊天 + 新聊天里又开了一张卡」之后——那时若照刷，
 *      就是把【新聊天】的数据摆进一张按【旧聊天】开的卡（同 mvuedApply 危险点一的伤，只是只读侧）。
 *   ③ 与卡上这份【逐字节一样】→ 什么都不做。renderMvuedBody 是整棵树重建：折叠起来的分组会全部
 *      弹开（det.open 恒 true）、滚动位置归零、✎ 逃生门退回下拉。这些代价用户真的看得见，所以
 *      「没有真变化就绝不重画」是本函数的承重不变量——别为了省一次 JSON.stringify 把它简化掉。
 * 脏项安然无恙：renderMvuedLeaf / mvuedListValue 都是【先读脏表、读不到才用模型值】，用户改到一半的
 * 输入重画后原样还在；脏项指向的路径若在新状态里已消失，它只是画不出来、仍留在脏表里（应用时
 * applyMvuedEdits 跳过并上报，不静默）。「还原」也因此自动变准了：它清空脏表后显示的正是刷新后的现值。
 *
 * 刻意【不 await】：卡开着就意味着 openMvuEditor 早已 await 过 getMvu，句柄就在 mvuApi 里。写成 async
 * 只会凭空多出一个「await 期间切了聊天」的窗口，而这个函数一步都不该给出去。
 */
export function mvuedMaybeRefresh(reason) {
    if (!ENABLE_MVU_EDITOR) return;
    const card = document.getElementById('so-mvued-card');
    if (!card) return;
    if (mvuedOpenChatKey !== null && chatIdentityKey() !== mvuedOpenChatKey) return;
    // ── 用户正在动手 → 这一拍不重画，改成【推迟】（重排一次防抖，等他停手）──────────────
    // renderMvuedBody 是整棵树重建（`#so-mvued-body` 先 innerHTML='' 再逐节点 append），所以在两种时刻
    // 重画就是直接毁掉用户手上的活：
    //   ① ⤢ 放大编辑弹层开着 —— 它捕获的目标 input 就住在正文里。重画后那个节点变孤儿，用户还在一个
    //      看起来好好的大文本框里接着敲，直到按「确定」才被 isConnected 守卫拦下（提示重开）——
    //      一整段话就这么没了。守卫拦得住写坏，拦不住白打一场。
    //   ② 正文里的输入框正被聚焦 —— 光标位置、选区、**中文 IME 正在合成中的字**全没；更狠的是
    //      「半截输入」（`-`、`1.`）**根本不在脏表里**（mvuedMarkTyped 对非有限数一律不标脏），
    //      重画后连痕迹都不剩。
    // 同款做法在本文件已有先例：refreshSummaryUI 的 `document.activeElement !== ta` →「别在用户正打字时
    // 覆盖」；聚焦判据则照抄 onFullscreenEscKeydown 的 editorFocused（INPUT/TEXTAREA/isContentEditable，
    // 并且【明确排除】某个不算数的框）。这里排除的是 #so-mvued-search：它住在卡里但**不在重画范围内**
    // （renderMvuedBody 只重建 #so-mvued-tabs 与 #so-mvued-body），重画伤不到它；而「打完筛选词把焦点
    // 留在搜索框里看结果」是最常见的停留姿势，把它算进推迟等于让编辑器**再也不刷新**。
    // 不会永远推下去：每次推迟只是按同一个防抖间隔重排一次，用户一失焦 / 一关弹层就落地；而关卡
    // （closeMvuEditor）会把定时器掐掉，切聊天走的也是关卡那条路 —— 没有能让它空转到天荒地老的路径。
    const ae = document.activeElement;
    const busyInput = !!(ae && card.contains(ae) && ae.id !== 'so-mvued-search'
        && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable));
    if (document.getElementById('so-mvued-bigedit') || busyInput) {
        mvuedScheduleRefresh(reason);
        return;
    }
    const Mvu = mvuApi || window.Mvu;
    if (!Mvu || typeof Mvu.getMvuData !== 'function') return;
    let fresh = null;
    try { fresh = Mvu.getMvuData(mvuMsgOpts()); } catch (e) { return; }
    let copy = null;
    try { copy = fresh ? JSON.parse(JSON.stringify(fresh)) : null; } catch (e) { return; }
    // 比对口径 = 【真正被渲染的那一份投影】，逐字照抄 renderMvuedBody 取值的那个表达式
    // （`d.stat_data || d`）—— 不是整份 MvuData。理由与 F2 漂移比对同源：display_data / delta_data 是
    // MVU **每一轮都会重算**的派生数据（delta_data 更是「本轮变了什么」，值一样也会换内容）。拿整份比，
    // 真实对局里「上一轮改过值、这一轮没改」就会比出 false → 整棵树重建（折叠的分组全弹开、✎ 逃生门
    // 退回下拉），有脏项时还会弹一条【假的】「⚠ 剧情刚更新了变量」。stub smoke 的 delta_data 是冻的，
    // 结构上照不出这个 bug —— 所以这行注释就是它的钉。
    // 比对用投影、赋值仍用【整份 copy】：撤销 / 应用要的是完整 MvuData，投影只负责回答「画面要不要重画」。
    // 代价（有意接受）：只有 display_data 变了时 mvuedOpenData 会留着旧的那一份 —— 它是纯显示用快照，
    // 写入路径（mvuedApply）永远自己重读 fresh，落不到任何写上。
    const rendered = (d) => (d ? (d.stat_data || d) : null);
    let same = false;
    try { same = JSON.stringify(rendered(copy)) === JSON.stringify(rendered(mvuedOpenData)); } catch (e) { same = false; }
    if (same) return;
    setMvuedOpenData(copy);
    renderMvuedBody();
    // 有脏项时才出声：用户手上有没提交的改动，值在脚下换了，这件事必须让他知道（否则「我明明改的是
    // 80」会变成一桩灵异事件）。没脏项时静默——那种情况下刷新就是「显示终于对了」，说一句反而是噪音。
    if (mvuedDirty.size > 0) {
        const status = card.querySelector('#so-mvued-status');
        if (status) {
            status.classList.remove('so-hint-error');
            status.textContent = '⚠ 剧情刚更新了变量：你没动过的值已同步为最新，你改过的保持不变。';
        }
    }
    console.debug('[Story Oracle] 🎛 变量编辑器：已随外部改动刷新（' + (reason || '') + '）');
}

// 「跟随现实」的防抖入口（约 300ms）。一条回复落地时事件常常连着来（MESSAGE_RECEIVED 之后
// 校正还会补发 MESSAGE_SWIPED / MESSAGE_UPDATED），逐个刷就是逐次重建整棵树。卡没开时连定时器
// 都不起：这是全聊天每条消息都会经过的路径，能不做的活一点都别做。
export function mvuedScheduleRefresh(reason) {
    if (!ENABLE_MVU_EDITOR) return;
    if (!document.getElementById('so-mvued-card')) return;
    if (mvuedRefreshTimer) clearTimeout(mvuedRefreshTimer);
    setMvuedRefreshTimer(setTimeout(() => {
        setMvuedRefreshTimer(null);
        try { mvuedMaybeRefresh(reason); } catch (e) { console.warn('[Story Oracle] 🎛 变量编辑器刷新失败：', e); }
    }, 300));
}

// 掐掉在途的「🔍 分析取值规则」扫描。两个调用者：扫描键在途时的「⏹ 中断扫描」（用户主动，spec §6）与
// onChatChanged（结果已注定作废）。刻意【不】写进 closeMvuEditor：
// ✕ / 点背景关卡的意思是「我不看了」，那趟扫描的结果仍然属于【本聊天】、写进缓存完全正确（现有行为如此，
// 不动它）；而切聊天的意思是「结果已注定作废」（危险点三必然丢弃），继续跑下去只剩两样坏处：真金白银
// 白烧，以及扫描键在【新聊天】里僵成「分析中…」最长 120 秒、还没有取消的地方。
// ⚠ 这里【只】发中断，绝不自己动 mvuedScanning / 按钮：状态机的复位口只有 runMvuedScan 的 finally 一个。
// 抢着在这里置 false，会让用户在旧那趟的 reject 落地【之前】发起新一趟扫描，随后旧 finally 把新一趟的
// 标志清掉、按钮中途点亮 → 同一时刻两个在途请求。中断的 reject 是同一轮微任务就排上的，等它复位足够快。
export function cancelMvuedScan() {
    if (!mvuedScanCtl) return;
    try { mvuedScanCtl.abort(); } catch (e) { /* ignore */ }
}

/* 🎛 变量编辑器 / 修改器 共用的 MVU 写入序列（1.63.0 抽出）。
 * 手动「应用」与修改器的每回合写入【必须】走同一条序列 —— 1.59.0 的 F1（display_data 未随
 * stat_data 重算 → 状态栏静默显示旧值）就在这条链里，复制第二份等于给它准备一个没人测的复发地。
 *
 * 顺序与理由（每一环各扛一件事，别重排）：
 *  ① 重读 fresh —— 卡里 / 规则算的都是某一刻的快照，期间自动诊断可能已写过状态；拿旧底稿写回去
 *     = 悄悄回滚别人的改动。编辑按 path 落到 fresh 的克隆上，并发改动因此存活。
 *  ② 身份钉 —— 唯一的 await（getMvu）之后再判一次聊天有没有换；换了就整趟作废（还没写、代价为零）。
 *  ③ 写前快照 —— snapshot 是写入前 fresh 的整份深拷贝，是侧聊记录撤销按钮（addMvuedUndoControls）
 *     要换回去的那份底片：那颗按钮做的是【整份 MvuData 互换】，不是补丁回退。必须在写之前拍下来——
 *     写完了「写之前长什么样」就再也读不到了，没法事后补拍。
 *  ④ $internal 既不读也不改 —— 它随 fresh 深拷贝 → r.stat → newData.stat_data 一路原样带过。这条链
 *     是「整份克隆、只选择性覆盖 stat_data / display_data 两格」，不是「重新拼一个对象出来」——往后一
 *     种方向「简化」会把没人显式搬运的 $internal 悄悄漏掉。
 *  ⑤ display_data 同批重算 —— 缺席路径照样跳过（own-property 纪律在这里恰恰是对的：display 里
 *     没有这一格，就不该凭空长出来）；delta_data 有意不动（它的语义是「本轮 MVU 更新的变化」）。
 *  ⑥ replaceMvuData 不发任何事件 → 必须自己 refreshLatestMvuBar，否则状态栏停在旧值。
 * 返回 ok:false 的三种情形都发生在【写入之前】，此时一个字节都没写进 MVU。
 */
async function writeMvuedEdits(edits, chatKey) {
    if (!Array.isArray(edits) || !edits.length) return { ok: false, reason: 'noop' };
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function' || typeof Mvu.getMvuData !== 'function') {
        return { ok: false, reason: 'nomvu' };
    }
    if (chatKey != null && chatIdentityKey() !== chatKey) return { ok: false, reason: 'chatswitched' };
    const opts = mvuMsgOpts();   // F4：读写共用同一解析结果（消掉 TOCTOU），别在写之前再解析一次
    const fresh = Mvu.getMvuData(opts);
    const snapshot = JSON.parse(JSON.stringify(fresh == null ? {} : fresh));
    const r = applyMvuedEdits(fresh && fresh.stat_data ? fresh.stat_data : {}, edits);
    if (!r.applied) return { ok: false, reason: 'gone', skipped: r.skipped };
    const newData = JSON.parse(JSON.stringify(fresh == null ? {} : fresh));
    newData.stat_data = r.stat;
    if (fresh && fresh.display_data && typeof fresh.display_data === 'object') {
        // 这次 applyMvuedEdits 的 .skipped 有意丢弃、绝不并进下面 return 的 skipped：「编辑是否生效」
        // 唯一由 stat_data 那次的 r.skipped 上报；display 这份缺席同一路径不是「编辑没生效」，只是这
        // 份副本里没有那一格——合并两份 skipped 会把「显示层没这格」误算成一次额外的跳过，重复计数。
        newData.display_data = applyMvuedEdits(fresh.display_data, edits).stat;
    }
    await Mvu.replaceMvuData(newData, opts);
    // ── 分水岭：写入已经发生、撤不回来。往下每一件都只是收尾，各自兜底。 ──
    const ops = diffMvuStat(snapshot.stat_data, r.stat, '');
    return { ok: true, ops, skipped: r.skipped, snapshot, applied: JSON.parse(JSON.stringify(newData)) };
}

/* 修改器的每回合执行器（ENABLE_MVU_TRAINER）。由 maybePostReply 在 fix / diag 之后调用。
 *
 * 三条钉：
 *  ① 恒等 MVU 空闲 —— MVU 的「额外模型解析」是回复后自己异步发一次模型调用再写状态；它若还在跑，
 *     会【后写】、把我们刚拉回来的冻结值又吃掉。自动校正已有这套机制（那边是 opt-in fixWaitForMvu），
 *     修改器【恒开】：MVU 不忙时 awaitMvuIdle 即刻返回，零代价。
 *  ② 身份钉 —— 与 mvuedApply 同款 chatIdentityKey()：writeMvuedEdits 内部对它自己那个 await（getMvu）
 *     判一次；写完后（危险点二同款）在碰读数 / 状态栏之前再判一次——writeMvuedEdits 的最后一个
 *     await（replaceMvuData）之后不再判身份（分水岭：写入已经落地、判了也不能撤），但【它之后】的
 *     收尾动作（刷状态栏、记读数）全都认「现在」是哪个聊天，那一步必须我们自己拦。
 *  ③ 静默 —— 不发 toast、不留侧聊记录（每回合一条会把诊断房淹掉）。读数进 trainerLastRun，
 *     由 🎛 页显示；另留一行 console.debug 供排查。规则本身就是台账，关掉规则就是撤销。
 * 无规则 / 算不出改动 → 一个字节都不写（连 refreshLatestMvuBar 都不调）。
 */
export async function runTrainer(chatKey, compatSession) {
    if (!ENABLE_MVU_TRAINER) return;
    const rules = trainerReadRules();
    if (!rules.length) return;
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') return;
    if (chatIdentityKey() !== chatKey) return;
    // 自动诊断的外部解析兼容开启时，修改器是共享 worker 的最后一个写者，也必须认同一批次结果。
    // 否则 fixer / diagnose 在 10 分钟上限安全跳过后，它会在旧 120s idle cap 处独自穿透并抢写。
    if (compatSession && compatSession.enabled && typeof compatSession.wait === 'function') {
        const compat = await compatSession.wait();
        if (postReplyShouldStop() || chatIdentityKey() !== chatKey) return;
        if (compat && (compat.status === 'timed-out' || compat.status === 'cancelled')) return;
    }
    await awaitMvuIdle(Mvu, { isCancelled: () => postReplyShouldStop() || chatIdentityKey() !== chatKey });
    if (postReplyShouldStop() || chatIdentityKey() !== chatKey) return;

    let stat = null;
    try { stat = await getMvuStatData(); } catch (e) { return; }
    if (!stat) return;
    const { edits, skipped, changes } = trainerComputeEdits(stat, rules);
    if (!edits.length) {
        // 有规则但这一回合无事可做：读数如实记「无改动」，不写、不刷。
        setTrainerLastRun({ changes: [], skipped, stamp: trainerStamp(), chatKey });
        renderTrainerReadout();
        return;
    }
    const w = await writeMvuedEdits(edits, chatKey);
    if (!w.ok) {
        console.warn('[Story Oracle] 🎛 修改器：本回合未能写入（' + w.reason + '）。');
        // 读数如实记「这回合失败了」（whole-branch review 追加）：不写的话 trainerLastRun 还留着
        // 【上一回合】的 changes，chatKey 照样对得上（都是这个聊天）——renderTrainerReadout 的身份门
        // 只认 chatKey，会放它原样过去，🎛 页因此把上一回合的改动继续显示成「这一回合的」，看起来
        // 这一轮照常跑了，而不是刚刚失败。修改器本就是静默功能（不发 toast、不留侧聊记录），这条读数
        // 行是用户唯一能看见的痕迹，它说谎比什么都不说更糟。
        const reasonLabel = { nomvu: '未检测到 MVU', chatswitched: '聊天已切换', gone: '字段已不存在' }[w.reason] || w.reason;
        setTrainerLastRun({ changes: [], skipped, failed: reasonLabel, stamp: trainerStamp(), chatKey });
        renderTrainerReadout();
        return;
    }
    // 危险点二同款（mvuedApply 的写后身份钉）：writeMvuedEdits 的最后一个 await（replaceMvuData）
    // 之后它自己不再判身份——写入已经落在【正确】的聊天上（chatKey 在写之前已生效核过），但往下
    // 这几件事全都读「现在」是哪个聊天：切了聊天再做，就会把上一个聊天的改动刷 / 记成这一个聊天的。
    if (chatIdentityKey() !== chatKey) {
        console.warn('[Story Oracle] 🎛 修改器：写入期间聊天已切换 —— 变量已写入该聊天，但跳过状态栏刷新与读数记录。');
        return;
    }
    // notice（Task 7，审计簇 D）：落点是用户自己那一楼时的提示，【在跑完这一刻】现算、随读数一起记下。
    // 这里【不】留到渲染时再算，与其余四处（诊断卡 / 记录条 / 自动记录）有意不同：那几处的写入与显示
    // 是同一瞬间，而这条读数行会在用户很久以后打开 🎛 页时重画 —— 那时的最末楼早就不是当时写入的那一楼
    // 了（随手发一句话就变），到那时再算等于凭空断言一件从没发生过的事。读数说的是「上一回合」，
    // 落点也就该是上一回合那个落点。只有【真写了东西】的这一支记它（上面两支都没写）。
    setTrainerLastRun({ changes, skipped, stamp: trainerStamp(), chatKey, notice: diagUserFloorNotice() });
    try { refreshLatestMvuBar(); } catch (e) {
        console.warn('[Story Oracle] 🎛 修改器：变量已写入，但状态栏刷新失败。', e);
    }
    console.debug('[Story Oracle] 🎛 修改器：本回合改了 ' + changes.length + ' 项'
        + (skipped.length ? '，跳过 ' + skipped.length + ' 项（字段不存在 / 类型不符）' : '')
        + ' → ' + changes.map(c => `${c.label} ${c.from}→${c.to}`).join('、'));
    renderTrainerReadout();
}

function trainerStamp() {
    try { return new Date().toLocaleTimeString(); } catch (e) { return ''; }
}

// 读数行渲染——DOM 里找不到读数行元素就什么都不做：卡没开是一种情况，卡开着但用户不在 🎛 页
// （元素只在 renderTrainerTab 铺开时才存在）是另一种，两种都是合法的「无事可做」，不是错误。
function renderTrainerReadout() {
    const el = document.getElementById('so-mvued-trainer-readout');
    if (!el) return;
    // chatKey 门：trainerLastRun 是模块级变量，切聊天后依然留着【上一个】聊天的读数（它本身不随切聊天
    // 清空，见该变量声明处的注释）。这里必须核对身份，否则用户在当前聊天打开 🎛 页会把另一个聊天的
    // 改动看成这一个聊天的「上一回合」——比什么都不显示更糟，因为它看起来完全成立。
    if (!trainerLastRun || trainerLastRun.chatKey !== chatIdentityKey()) {
        el.textContent = '（本次打开后还没有新回复经过修改器。）';
        return;
    }
    const { changes, skipped, stamp, failed, notice } = trainerLastRun;
    // failed：写入前置校验没过（未检测到 MVU / 聊天已切换 / 字段已不存在）——与下面「无需改动」/
    // 「改了 N 项」是三种互斥的读数，必须先分岔，不能落进 changes.length 的判断（那会把「没跑成」
    // 误显示成「跑了但没什么可改」，用户没法分辨规则是不是还活着）。
    if (failed) {
        el.textContent = `上一回合：修改器未能写入（${failed}），规则这一轮没生效。${stamp ? ' · ' + stamp : ''}`;
        return;
    }
    const head = changes.length
        ? '上一回合：' + changes.map(c => `${c.label} ${c.from}→${c.to}`).join('、')
        : '上一回合：无需改动。';
    const tail = skipped.length ? `（跳过 ${skipped.length} 项：字段不存在或类型不符）` : '';
    // notice（Task 7）= 那一轮写入落在用户自己那一楼时的提示，由 runTrainer 在跑完那一刻算好记下（理由
    // 见那里）。上面 failed 那一支永远拿不到它（没写入的轮次不记）。这一行不是 pre-line 的元素，
    // 故用空格接，不用换行。
    const say = notice ? ' ' + notice : '';
    el.textContent = `${head}${tail}${stamp ? ' · ' + stamp : ''}${say}`;
}

// 「应用」：一次批量写入（spec §7）。写入前那几步——重读 fresh、聊天身份钉、写前整份快照（撤销要用
// 的底片）、$internal 原样带过、display_data 同批重算——现在都在上面 writeMvuedEdits 里，理由见那个
// 函数自己的头注；两边号码各编各的，不是同一份清单的延续，别对着数。这里接着走的是 replaceMvuData
// 之后仍留在 mvuedApply 的部分：
//  ⑤ replaceMvuData 不发 VARIABLE_UPDATE_ENDED → 必须自己 refreshLatestMvuBar，否则状态栏停在旧值。
//  ⑥ replaceMvuData 一旦返回，写入就【撤不回来】了 —— 此后的每一步（状态栏刷新 / 侧聊记录 / 编辑器
//     重同步）都只是收尾，各自 try、各自兜底，绝不许把这趟已经成功的写入改口说成「应用失败」。
//     外层那个 try 因此只管【写入之前】的失败。
// 记录里的「改了 N 项」用 diffMvuStat 的【真实差异】而非 applyMvuedEdits 的 applied 计数：脏表不会因为
// 用户把值改回原样而消项，那种空操作应用得掉但不算改动，两个数字有意各说各话（状态行说写入、记录说改动）。
async function mvuedApply() {
    if (!ENABLE_MVU_EDITOR || mvuedApplying) return;
    const card = document.getElementById('so-mvued-card');
    const status = card && card.querySelector('#so-mvued-status');
    const fail = (msg) => { if (status) { status.textContent = msg; status.classList.add('so-hint-error'); } };
    if (status) status.classList.remove('so-hint-error');
    const edits = collectMvuedEdits();
    if (!edits.length) return;
    // 身份钉（P-CORRUPT 同族，与校正的 fixCaptured.chatId 走同一个 chatIdentityKey）：onChatChanged 会
    // clearNoteOpts() + closeMvuEditor()，两句都在说同一件事 ——「撤销 / 应用针对的是【旧聊天】的 MVU」。
    // 在途的这一趟是唯一能绕过它们的路径（它已经跑起来了，关卡关不掉它），故自己带身份钉。
    // 整条链路只有【两个 await】，切聊天只可能落在这两处，下面各钉一次。
    const chatKey = chatIdentityKey();
    // 上锁必须在【第一个 await 之前】：getMvu 是 async（可能在等 TavernHelper 初始化），连点两下会双双
    // 穿过这里、各写一遍 —— 同 openMvuEditor 那处双击坑，只是这一处的代价是写两次状态、留两条记录。
    setMvuedApplying(true);
    updateMvuedFoot();
    try {
        const w = await writeMvuedEdits(edits, chatKey);
        if (!w.ok) {
            if (w.reason === 'nomvu') { fail('未检测到 MVU —— 无法应用。'); return; }
            if (w.reason === 'chatswitched') { fail('聊天已切换，本次应用已取消（没有写入任何变量）。'); return; }
            if (w.reason === 'gone') { fail('没有任何改动被应用（这些字段在当前状态里已不存在）。'); return; }
            return;   // 'noop'：collectMvuedEdits 为空，上面早已 return，这里是防御
        }
        const { ops, skipped, snapshot } = w;
        // 危险点二（写之后）：底稿已确认是本聊天的（危险点一把关），所以写下去的值本身是对的；能出事的是
        // 后面三件【都认「当前聊天」】的收尾动作，切走后它们全会作用到新聊天身上：
        //   · refreshLatestMvuBar → getLatestAiMessage 取的是【现聊天】最后一条 AI 消息，重渲染 + 补发
        //     MESSAGE_UPDATED 会打到一条毫不相干的楼层上；
        //   · appendNoteToRoom → 把旧聊天的编辑记录【持久化】进新聊天的 metadata，并且把 onChatChanged 刚
        //     clearNoteOpts() 清空的注册表又填回去 —— 新聊天里于是出现一个活的「撤销」，按下去就把【旧聊天
        //     的整份 MvuData】replaceMvuData 进新聊天的 latest。这是本条链路最重的一处伤，且是落盘的；
        //   · 编辑器重同步 → closeMvuEditor 已清空会话状态，复活它等于把旧聊天的数据摆进新聊天的卡。
        // 三件一起跳过。与危险点一的区别：那处能防住全部伤害，这处写入已经发生、撤不回来，只能不让伤害扩散。
        // 代价是这次写入在旧聊天里没留下可撤销的记录（记录只能写进「当前」聊天，写不回旧的）——与校正
        // 的 stale 守卫同款半径：宁可少留一条记录，也绝不写到别的对话上。留一行 warn 以便事后追。
        if (chatIdentityKey() !== chatKey) {
            console.warn('[Story Oracle] 🎛 变量编辑器：写入期间聊天已切换 —— 已跳过侧聊记录 / 状态栏刷新 / 编辑器重同步（本次编辑因此没有可撤销的记录）。');
            fail('聊天已切换 —— 变量已写入，但这次没能留下可撤销的记录。');
            return;
        }
        // ── 分水岭：写入已经发生、撤不回来（承重事实⑥）───────────────────────────────
        // 下面全是【收尾】，而且每一件都真的会抛：refreshLatestMvuBar 要摸 ST 的楼层与事件总线、
        // appendNoteToRoom 要写 chat metadata（落盘路径）、renderMvuedBody 要重画整棵树。它们以前
        // 与写入共用同一个 try —— 任何一处抛出都会把这趟【已成功的写入】说成「应用失败」，并且连
        // 重同步一起跳过：卡里还亮着一排「已改」，底下的变量却早就是新值了，用户看到「失败」的下一步
        // 多半是再点一次应用（在新值之上再写一遍旧编辑）。故先把「成功」落定，再逐件兜底。
        const stamp = (() => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } })();
        const tail = skipped.length ? `，跳过 ${skipped.length} 项（字段已不存在）` : '';
        // head = 写入这件事本身的如实陈述，恒真；「可撤销」那半句只有记录真落下了才敢说
        //（无改动那条原本就不提撤销 —— 两条成功文案逐字保持原样，只是拆成了两段拼）。
        const head = ops.length
            ? `已应用 ${ops.length} 项改动${tail}。`
            : `已写入，但值与当前状态一致、没有实际改动${tail}。`;
        const undoClause = ops.length ? '可在诊断侧聊记录里撤销。' : '';
        // F3（staleness-audit §7）：MVU 的 'latest' 是最后一条【非系统】楼层——用户自己的消息也算。
        // 而状态栏住在最后一条【AI】楼层的 iframe 里，那个 iframe 结构上只看得到它自己那一层及更早的
        // 变量（TavernHelper 的合并是 chat.slice(0, id+1)）。所以「最后一楼是用户消息」时，值确实写对了、
        // 下一条回复也会以它为底，但状态栏就是要等到下一条回复才显示得出来。与其让用户以为编辑没生效，
        // 不如把这件事说在明处。
        // ⚠ 这里【只调】diagUserFloorNotice（whole-branch review FIX 4）：本处原先自带一份逐字复制的
        // 楼层扫描 + 一句 Prince 已经判过「太含糊」的文案（没分清【记在哪】与【显示在哪】）。同一件事
        // 全仓只该有一份口径、一句话；写入落点的判定本来就是 diagUserFloorNotice 的全部职责。
        // 现调不缓存（楼层随时会变），与其余五个显示面同款；换行分隔 —— #so-mvued-status 挂的正是
        // .so-apply-status（white-space: pre-line）。
        const barLagClause = diagUserFloorNotice();
        const say = (t) => { if (status) status.textContent = t; };
        const withNotice = (t) => t + (barLagClause ? '\n' + barLagClause : '');
        say(withNotice(head));

        // 🎛 冻结重新武装（ENABLE_MVU_TRAINER）：这一趟手动应用里，凡是被冻结的字段，
        // 把它的冻结目标改成用户刚写进去的新值。不做的话修改器会在下一条回复把用户自己
        // 刚做的编辑悄悄拉回旧值 —— 那是「编辑器坏了」的经典现象。
        // 只动 freeze：±X / 上下限与「用户刚设的值」无关，原样保留。
        // trainerFreezeUndo（whole-branch review Finding 2）：记下每条被重新武装的规则【武装之前】的
        // 目标值，连同 snapshot/applied 一起挂在侧聊记录上——不在这里拍下来，撤销按钮往后就再也读不出
        // 「武装之前」是什么了（trainerSetRule 这一行就把旧值覆盖掉了，与 writeMvuedEdits 的 snapshot
        // 必须写前拍的道理相同）。没有这份材料，「撤销」只换回 MvuData、规则还指着新值，下一条回复会把
        // 用户刚撤销掉的编辑原样拉回来——撤销一回合后就被规则悄悄推翻，参见该 finding 的复现步骤。
        let trainerFreezeUndo = null;
        if (ENABLE_MVU_TRAINER) {
            try {
                const frozen = trainerReadRules().filter(r => r.kind === 'freeze');
                const rearmed = [];
                for (const e of edits) {
                    // 🗑 删除没有「新值」可武装：冻结规则原样保留，🎛 页会把它显示成「字段已不存在」（同一贯口径：
                    // 不替用户删规则）。不跳过的话 freeze 目标会被写成 undefined。
                    if (e.remove) continue;
                    const k = mvuedPathStr(e.path);
                    const rule = frozen.find(r => mvuedPathStr(r.path) === k);
                    if (rule) {
                        rearmed.push({ path: e.path.slice(), prevValue: rule.value, nextValue: e.value });
                        trainerSetRule(e.path, 'freeze', { value: e.value });
                    }
                }
                if (rearmed.length) trainerFreezeUndo = rearmed;
            } catch (err) {
                console.warn('[Story Oracle] 🎛 冻结重新武装失败（变量已写入，规则仍是旧目标）：', err);
            }
        }

        try { refreshLatestMvuBar(); } catch (e) {
            console.warn('[Story Oracle] 🎛 变量编辑器：变量已写入，但状态栏刷新失败（楼层可能仍显示旧值）。', e);
        }
        // 编辑器留在原地（用户常要连改几轮），输入重同步到刚写进去的现值；页签 / 搜索词保持不变。
        // 卡在这期间被关掉（✕ / 点背景；换聊天在危险点二就返回了，到不了这里）→ 只落记录，不复活会话状态。
        try {
            if (document.getElementById('so-mvued-card')) {
                setMvuedDirty(new Map());
                setMvuedOpenData(JSON.parse(JSON.stringify(w.applied)));
                renderMvuedBody();
            }
        } catch (e) {
            console.error('[Story Oracle] 🎛 变量编辑器：变量已写入，但编辑器重同步失败（脏表可能还亮着旧的「已改」）。', e);
        }

        // 侧聊记录 + 会话内可撤销（重载后为只读记录 —— 与自动诊断记录同款半径）。快照 / 已应用两份都是
        // 深拷贝，与刚交给 MVU 的那份【不共享引用】：MVU 之后再改 latest，撤销材料也不会跟着漂。
        // 记录没落下【不是】写入失败 —— 只是这次没有撤销入口，状态行如实追述，绝不覆盖 head。
        // 有意不加 so-hint-error：整行标红会把「已应用 N 项改动」也一起说成错，那是假的。
        try {
            const entry = { id: nextCid(), role: 'note', content: mvuedNoteContent({ ops, skipped, stamp }) };
            // trainerFreeze 随 snapshot/applied 一起挂在这条记录上（Finding 2）：撤销 / 重新应用按钮
            // （addMvuedUndoControls）读它来把重新武装过的冻结目标也换回相应方向的值，否则冻结规则会在
            // 撤销之后的下一回合把用户刚撤销掉的编辑悄悄拉回来。
            appendNoteToRoom('diagnose', entry, { mvued: { snapshot, applied: JSON.parse(JSON.stringify(w.applied)), trainerFreeze: trainerFreezeUndo } });
            say(withNotice(head + undoClause));
            if (ENABLE_SCHEMA_DIAG) maybeRunSaveHealth('recheck');   // 🩺 1.89.0：改完再查一次，修好了就说「已恢复正常」
        } catch (e) {
            console.error('[Story Oracle] 🎛 变量编辑器：变量已写入，但侧聊记录没能留下。', e);
            // 落点提示这一路也要带上：记录没落下与「状态栏会晚一拍」是两件互不相干的事，
            // 少说一句会让这条路径上的用户以为「没记录 + 状态栏没动 = 整个失败了」。
            say(withNotice(head + `⚠ 侧聊记录没能留下（${e && e.message ? e.message : e}）—— 本次编辑因此没有可撤销的记录。`));
        }
    } catch (e) {
        // 只可能是【写入之前】的失败（分水岭之后每件事都自带 try）—— 这时一个字节都没写进 MVU。
        fail('应用失败：' + (e && e.message ? e.message : e));
    } finally {
        setMvuedApplying(false);
        updateMvuedFoot();
    }
}

// 一次性的「🔍 分析取值规则」扫描（spec §6）。无头非流式；结果经 parseMvuedSchema 严校后写入
// chat metadata（MVUED_META_KEY 的写入侧就在这里），并热更新打开中的编辑器。
//
// 身份钉（同 mvuedApply 的做法，半径更大）：这趟链路里最长的一个 await 是【模型调用本身，最长 120 秒】——
// 比应用那两处暴露得多，用户完全可能在等待期间换个聊天。schema 是【按聊天】缓存的，切走后再写下去就是把
// A 卡的取值规则钉进 B 聊天的 metadata（落盘、且下次开编辑器会照它渲染下拉框 → 用户看到一堆对不上的选项，
// 还完全不知道从哪来的）。故每个 await 之后各钉一次，不匹配就整趟作废：不写 metadata、不动 mvuedSchemaCache、
// 不重画编辑器。状态行只在【我们自己那张卡】还在文档里时才写（切聊天会 closeMvuEditor 把它摘掉；用户若已在
// 新聊天里重开了一张新卡，那张卡的 status 节点是另一个对象，isConnected 判定天然不会误伤）。
//
// 连接分支与自动诊断同款（direct: 端点+模型；profile: 配置文件），但【无人格 / 无破限 / 无预设】——
// 这是一次数据抽取调用，套人格只会让模型开始演戏。中断器是【本扩展自己的、扫描专用】的一只：绝不碰
// postReplyAbortCtl，那是「校正 / 自动诊断」共用的模块级中断器，借用它会让用户点一下「中断自动诊断」
// 把扫描也掐了（反之亦然）；但它也不能是纯局部的 —— 切聊天必须够得着（见 mvuedScanCtl / cancelMvuedScan）。
async function runMvuedScan() {
    if (!ENABLE_MVU_EDITOR || mvuedScanning) return;
    const card = document.getElementById('so-mvued-card');
    const status = card && card.querySelector('#so-mvued-status');
    // 只往【发起这趟扫描的那张卡】写状态：卡被关掉 / 换聊天摘掉后 isConnected 为 false，直接哑掉。
    const say = (t, err) => {
        if (!status || !status.isConnected) return;
        status.textContent = t;
        status.classList.toggle('so-hint-error', !!err);
    };
    const sayAborted = () => say('扫描已中断。', true);   // 三处出口共用一句话（用户按了中断 / 切聊天）
    const s = getSettings();
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) { say('先在设置里配置直连端点与模型。', true); return; }
    if (s.mode === 'profile' && !s.profileId) { say('先在设置里选择连接配置文件。', true); return; }
    // 上锁在第一个 await 之前（getMvuStatData → getMvu 是 async，连点两下会双双穿过去、各发一次付费调用）。
    const chatKey = chatIdentityKey();
    setMvuedScanning(true);
    // 中断器在【第一个 await 之前】就挂上模块级把手。从这一刻起扫描键就是「⏹ 中断扫描」，用户随时可能按下去，
    // 而前置那几步也会耗时（getMvu 首次最长等 5 秒 TavernHelper、取世界书要跑扫描/读书文件）——把手若只覆盖
    // 请求段，那几秒里按「中断」会毫无反应。中断落在前置段是安全的：已 aborted 的 signal 交给 fetch 会当场
    // reject（请求根本发不出去 = 不烧钱），下面两个危险点还各补一次判定，让它更早、更确定地落地。
    const ctl = new AbortController();
    setMvuedScanCtl(ctl);
    updateMvuedScanBtn();
    let timedOut = false;
    let selfAborted = false;   // 「这一趟是我们自己掐的」——超时 / 用户按中断 / 切聊天。与 HTTP 失败彻底分家，见下面的 catch。
    try {
        // 危险点一：getMvu 首次未缓存时最长等 5 秒 TavernHelper 初始化。
        const stat = await getMvuStatData();
        if (ctl.signal.aborted) { sayAborted(); return; }
        if (chatIdentityKey() !== chatKey) { say('聊天已切换，本次扫描已取消。', true); return; }
        if (!stat) { say('未检测到 MVU 状态。', true); return; }
        say('正在分析取值规则…');

        // 取规则的口径与自动诊断【完全一致】（精选生效就只喂精选条目，否则世界书 + 补齐 [mvu_update] 规则）。
        // 这里【不】自己做 substituteParams：'all'/'char' 是原文、'st' 是酒馆装配好的（宏已展），
        // collectMvuRuleContents 内部本就替换过 —— 本函数只读不锚（不像世界书补丁要按字面锚定），照单全收即可。
        let wiBlock;
        if (diagPickerActive()) {
            wiBlock = (await buildDiagSelectedWi()).block;
        } else {
            wiBlock = await buildWorldInfo(wiContextMode(s));
            const mvuRules = await collectMvuUpdateRules(wiBlock);
            if (mvuRules.length) wiBlock = [wiBlock, ...mvuRules].filter(Boolean).join('\n\n');
        }
        // 危险点二：取世界书那几步都是 async（跑扫描 / 读书文件）。此处还什么都没写，整趟作废代价为零。
        if (ctl.signal.aborted) { sayAborted(); return; }
        if (chatIdentityKey() !== chatKey) { say('聊天已切换，本次扫描已取消。', true); return; }

        const sys = buildMvuedScanPrompt(wiBlock, mvuedFieldPathList(stat));
        const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: P('mvued.scanAsk', null, s) },
        ];
        // 调试提示词查看器快照（同自动诊断：无头调用也必须能在「调试提示词」面板里看到发了什么）。
        setLastPrompt(messages.map((m) => ({ role: m.role, content: m.content })));
        setLastPromptMeta({
            mode: '变量编辑器扫描',
            target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
            chars: lastPrompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
            time: new Date().toLocaleTimeString(),
        });
        const timer = setTimeout(() => { timedOut = true; try { ctl.abort(); } catch (e) { /* ignore */ } }, 120000);
        let text = '';
        try {
            // 地板 16384（**只此一处**，别的功能的地板不动：校正/诊断 4096、arc 8192、锻造 16384）。
            // 真模型电池实测（11 次真调用，DS+GM 两张真卡，记录见 tests/unit/_mvued-tuning/FINDINGS.md）：
            // 带**原生思考**的模型把 4096 吃得干干净净 —— 一次 GM 调用 completion_tokens=2720 里
            // reasoning_tokens=2485（91%），可见输出只剩 ~235 tok，<MvuSchema> 块开了没闭合。同一份喂料
            // 抬到 8192 立刻全绿。DS（推理关）8 次从没碰到 —— 也就是说 4096 对思考型模型是**紧贴上限**，
            // 推理长度一波动就截断。1.57.0 再抬到 16384（对齐全仓最高地板 = 角色工坊锻造）：8192 只是
            // 「实测这批喂料够用」，字段一多 / 推理一长仍会贴顶，而这是无头一次性调用、抬高不额外烧钱
            // （只在真的写那么多时才计费），截断反而白花一整趟。
            const effMaxTokens = Math.max(s.maxTokens, 16384);
            if (s.mode === 'direct') {
                const body = { model: s.model, messages, max_tokens: effMaxTokens };
                text = await callDirect(resolveEndpointUrl(s), s.apiKey, body, ctl.signal);
            } else {
                text = await callProfile(s.profileId, messages, effMaxTokens, {}, ctl.signal);
            }
        } finally {
            clearTimeout(timer);
            // 内层 finally 在外层 catch 【之前】执行 → 这里把「是不是我们自己掐的」定死，catch 便无须靠
            // 错误文本猜。ctl.signal.aborted 是权威判据（我们自己的中断器），HTTP 错误正文里恰好带 "abort"
            // 字样也绝不会被误判成中断（那正是原来那条 /abort/i 正则的风险）。
            selfAborted = ctl.signal.aborted;
            setMvuedScanCtl(null);
        }
        // 危险点三（最重的一处，暴露最长 120 秒）：切走了就【什么都不落】—— schema 是按聊天缓存的，
        // 写进新聊天的 metadata 是落盘伤害，且下次开编辑器就按它渲染，用户无从知道选项是哪来的。
        if (chatIdentityKey() !== chatKey) { say('聊天已切换，本次扫描结果已丢弃（没有写入任何缓存）。', true); return; }

        const schema = parseMvuedSchema(text, stat);
        // 两种「没拿到 schema」分开说：截断（块开了没收尾）得告诉用户预算被思考吃光了、换个模型才有用，
        // 说成笼统的「解析失败」他只会一遍遍重试同一个思考模型。判据见 mvuedScanLooksTruncated。
        if (!schema) {
            say(mvuedScanLooksTruncated(text)
                ? '扫描回复不完整（<MvuSchema> 块没收尾，多半是被截断）——思考型模型容易吃光输出预算，可重试或换个非思考模型。'
                : '扫描回复解析失败（没有合法的 <MvuSchema> 块）——可重试。', true);
            return;
        }
        const md = getChatMetadataSafe();
        if (md) {
            md[MVUED_META_KEY] = {
                v: 1,
                time: Date.now(),
                model: s.mode === 'direct' ? (s.model || '直连') : 'profile',
                fields: schema.fields,
                groups: schema.groups,
            };
            saveChatMetadata();
        }
        setMvuedSchemaCache(schema);
        // 卡可能在这期间被 ✕ 关掉（换聊天已在危险点三挡住）：缓存照写不误，重画则只在卡还在时做。
        if (document.getElementById('so-mvued-card')) renderMvuedBody();
        const n = Object.keys(schema.fields).length;
        say(n ? `扫描完成：识别出 ${n} 个受限字段。` : '扫描完成：规则里没有发现硬性取值限制。');
    } catch (e) {
        // 三种结局各说各话，且判据互不重叠：超时有自己的闩；「我们掐的」看 ctl.signal.aborted / AbortError
        // 的 name（不看错误文本，免得正文含 "abort" 的 HTTP 错误被当成中断报成「已中断」）；其余才是真失败。
        if (timedOut) say('扫描超时（120 秒）——可重试。', true);
        else if (selfAborted || (e && e.name === 'AbortError')) {
            // 「非超时的自己掐」两个来源，同一句话、结局却各自恰当：① 用户按了「⏹ 中断扫描」——卡还开着，
            // 状态行如实写「已中断」；② 切聊天——那条路上卡已被 closeMvuEditor 摘掉 → say 天然哑掉，不会在
            // 新聊天那张卡上留下误导性残留（say 认的是【发起这趟扫描的那个】status 节点）。
            sayAborted();
        }
        else say('扫描失败：' + (e && e.message ? e.message : e), true);
    } finally {
        // 状态机的唯一复位口（cancelMvuedScan 有意不碰这两样）：无论成功 / 失败 / 中断 / 提前 return，
        // 在途标志与按钮都回到空闲（按钮由此从「⏹ 中断扫描」翻回「分析 / 重新扫描」），把手一并清空——
        // 它现在从函数一开头就挂着，这一句是它归零的唯一保证，否则空闲期按中断会去 abort 上一趟的死把手。
        setMvuedScanning(false);
        setMvuedScanCtl(null);
        updateMvuedScanBtn();
    }
}

// 扫描键 disabled + 文案 + 悬浮提示 + 那行说明（#so-mvued-scan-hint）的唯一写入口（同 updateMvuedFoot
// 之于「应用」键）。三态：
//   在途   → 「⏹ 中断扫描」且【可点】—— 它此刻就是中断键（spec §6 承诺可中断；模板里刻意不写死 title
//            与文案，免得两处各写一套、改了一处忘另一处）；
//   已扫过 →「重新扫描」；否则「分析取值规则」。
// 文案读 mvuedSchemaCache 而非重新读 metadata —— 它正是编辑器当下渲染所用的那份，两者恒一致；扫描成功但
// metadata 不可写（无聊天元数据）时也照样如实显示「已扫过」。
// 说明行只在【还没扫过且不在途】时出：那一刻用户面对的是一颗看不出好处的按钮，得先说清「点了能得到什么」；
// 一旦扫过 / 在途，按钮文案（重新扫描 / ⏹）与状态行已经把状态说全了，再留一行等于白占手机的竖向空间。
function updateMvuedScanBtn() {
    const b = document.getElementById('so-mvued-scan');
    if (!b) return;
    const hint = document.getElementById('so-mvued-scan-hint');
    if (hint) hint.style.display = (!mvuedScanning && !mvuedSchemaCache) ? '' : 'none';
    b.disabled = false;
    if (mvuedScanning) {
        b.textContent = '⏹ 中断扫描';
        b.title = '中断这一次分析（不会写入任何缓存，随后可重新扫描）';
        return;
    }
    b.textContent = mvuedSchemaCache ? '🔍 重新扫描取值规则' : '🔍 分析取值规则';
    b.title = 'AI 读一遍卡的规则后：该选的变下拉菜单、有范围的数字加滑杆——只问一次，本聊天记住';
}

// 搜索命中口径（单一实现，页签计数与节点显隐共用，两者绝不各写一套）：
// 叶子 / 列表按【自身标签】匹配；分组标签自身命中 → 整棵子树放行（搜一个角色名就该看到他名下全部字段）。
function mvuedCountLeaves(nd) {
    if (nd.type !== 'group') return 1;
    let n = 0;
    for (const c of (nd.children || [])) n += mvuedCountLeaves(c);
    return n;
}
function mvuedSelfHit(nd, q) {
    return !!q && String(nd.label == null ? '' : nd.label).toLowerCase().includes(q);
}
function mvuedCountHits(nd, q) {
    if (!q) return 1;
    if (nd.type === 'group') {
        if (mvuedSelfHit(nd, q)) return Math.max(1, mvuedCountLeaves(nd));
        let n = 0;
        for (const c of (nd.children || [])) n += mvuedCountHits(c, q);
        return n;
    }
    return mvuedSelfHit(nd, q) ? 1 : 0;
}
function mvuedTabHits(nodes, q) {
    let n = 0;
    for (const nd of (nodes || [])) n += mvuedCountHits(nd, q);
    return n;
}

// 纯函数（1.89.0）：路径（或它的祖先）落在哪一页。给存档检查的「在变量编辑器里打开这一格」跳页用。
function mvuedTabIndexForPath(model, segs) {
    const want = (Array.isArray(segs) ? segs : []).map(String);
    const hits = (nd) => {
        const p = (nd.path || []).map(String);
        if (p.length <= want.length && p.every((x, i) => x === want[i])) return true;
        return (nd.children || []).some(hits);
    };
    const tabs = (model && model.tabs) || [];
    for (let i = 0; i < tabs.length; i++) if ((tabs[i].nodes || []).some(hits)) return i;
    return -1;
}

function renderMvuedBody() {
    const card = document.getElementById('so-mvued-card');
    if (!card) return;
    const stat = mvuedOpenData && (mvuedOpenData.stat_data || mvuedOpenData);
    const model = buildMvuedModel(stat, mvuedSchemaCache, mvuedReadListOverrides());
    setTrainerRulesForRender(ENABLE_MVU_TRAINER ? trainerReadRules() : []);
    const q = (card.querySelector('#so-mvued-search').value || '').trim().toLowerCase();
    const tabsEl = card.querySelector('#so-mvued-tabs');
    const bodyEl = card.querySelector('#so-mvued-body');
    tabsEl.innerHTML = ''; bodyEl.innerHTML = '';

    if (!model.tabs.length) {
        bodyEl.innerHTML = '<div class="so-hint">当前没有可编辑的变量（stat_data 为空）。</div>';
        updateMvuedFoot(); return;
    }
    // 搜索时自动跳到第一个有命中的页（否则用户在 A 页搜 B 页的字段会看到一片空白，以为搜不到）。
    // 合成页（= model.tabs.length）是合法下标，别把它当越界踢回首页。
    if (mvuedActiveTab > model.tabs.length || (!ENABLE_MVU_TRAINER && mvuedActiveTab >= model.tabs.length)) setMvuedActiveTab(0);
    if (q && mvuedActiveTab < model.tabs.length && !mvuedTabHits(model.tabs[mvuedActiveTab].nodes, q)) {
        const hit = model.tabs.findIndex(t => mvuedTabHits(t.nodes, q) > 0);
        if (hit >= 0) setMvuedActiveTab(hit);
    }
    model.tabs.forEach((t, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-mvued-tab' + (i === mvuedActiveTab ? ' so-mvued-tab-on' : '');
        b.textContent = t.label + (q ? `（${mvuedTabHits(t.nodes, q)}）` : '');
        b.addEventListener('click', () => { setMvuedActiveTab(i); renderMvuedBody(); });
        tabsEl.appendChild(b);
    });
    // 数据页之后追加合成页「🎛 修改器」（ENABLE_MVU_TRAINER）。它不来自 buildMvuedModel，
    // 因此单独建按钮、单独走渲染分支——数据页的搜索 / 计数逻辑一概不适用。
    const trainerTabIdx = ENABLE_MVU_TRAINER ? model.tabs.length : -1;
    if (ENABLE_MVU_TRAINER) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-mvued-tab' + (mvuedActiveTab === trainerTabIdx ? ' so-mvued-tab-on' : '');
        const n = trainerRulesForRender.length;
        b.textContent = '🎛 修改器' + (n ? `（${n}）` : '');
        b.addEventListener('click', () => { setMvuedActiveTab(trainerTabIdx); renderMvuedBody(); });
        tabsEl.appendChild(b);
    }
    if (mvuedActiveTab === trainerTabIdx) { renderTrainerTab(bodyEl); updateMvuedFoot(); return; }
    for (const nd of model.tabs[mvuedActiveTab].nodes) bodyEl.appendChild(renderMvuedNode(nd, q));
    updateMvuedFoot();
}

/* 🎛 修改器页：规则总览 + 编辑 + 读数行（ENABLE_MVU_TRAINER）。
 * 这一页是「为什么我的金钱一直涨」的唯一答案所在地——字段行上的标记只告诉你某个字段有规则，
 * 跨页签找规则是找不动的。 */
function renderTrainerTab(bodyEl) {
    const rules = trainerRulesForRender;
    if (!rules.length) {
        const empty = document.createElement('div');
        empty.className = 'so-hint';
        empty.textContent = '还没有任何规则。到左边的页签里点某个字段右侧的 🔒 就能把它冻结；'
            + '冻结之后可以在这里改成「每回合 ±X」或「上下限」。';
        bodyEl.appendChild(empty);
    }
    // 失效判定（spec §3.9）：路径在当前状态里已不存在 → 规则【保留】但置灰并标注。
    // 不自动删除：字段可能只是暂时不在这一分支的状态里，替用户做主删掉规则是不可逆的。
    const stat = mvuedOpenData && (mvuedOpenData.stat_data || mvuedOpenData);
    const pathAlive = (path) => {
        let cur = stat;
        for (const seg of path) {
            if (cur == null || typeof cur !== 'object') return false;
            if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
            cur = cur[seg];
        }
        return true;
    };
    for (const r of rules) {
        const row = document.createElement('div');
        row.className = 'so-mvued-rule-row';
        const alive = pathAlive(r.path);
        if (!alive) row.classList.add('so-mvued-rule-dead');
        const icon = r.kind === 'freeze' ? '🔒' : (r.kind === 'step' ? '➕' : '🚧');
        const name = document.createElement('span');
        name.className = 'so-mvued-rule-name';
        name.textContent = `${icon} ${r.path.join('.')}`;
        row.appendChild(name);

        const desc = document.createElement('span');
        desc.className = 'so-mvued-rule-desc';
        desc.textContent = r.kind === 'freeze' ? `锁定在 ${r.value}`
            : (r.kind === 'step' ? `每回合 ${r.delta >= 0 ? '+' : ''}${r.delta}`
                : [r.min != null ? `不低于 ${r.min}` : '', r.max != null ? `不超过 ${r.max}` : ''].filter(Boolean).join('、'));
        if (!alive) desc.textContent += '　·　字段已不存在（每回合跳过）';
        row.appendChild(desc);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'so-lb-mini';
        del.textContent = '✕';
        del.title = '删除这条规则';
        del.addEventListener('click', () => { trainerRemoveRule(r.path, r.kind); renderMvuedBody(); });
        row.appendChild(del);
        bodyEl.appendChild(row);
    }
    // 新增「每回合 ±X」/「上下限」的表单（字段来自现有规则的路径 —— 先 🔒 再细调，
    // 避免在这里放一个几百项的路径下拉）。
    if (rules.length) bodyEl.appendChild(renderTrainerAddForm(rules));
    const readout = document.createElement('div');
    readout.className = 'so-hint so-mvued-trainer-readout';
    readout.id = 'so-mvued-trainer-readout';
    bodyEl.appendChild(readout);
    renderTrainerReadout();
}

// 「加一条规则」表单：字段下拉只列【已经有规则的路径】。理由见 renderTrainerTab 的注释。
function renderTrainerAddForm(rules) {
    const wrap = document.createElement('div');
    wrap.className = 'so-mvued-rule-add';
    const paths = [];
    for (const r of rules) { const p = mvuedPathStr(r.path); if (!paths.some(x => mvuedPathStr(x) === p)) paths.push(r.path); }
    const sel = document.createElement('select');
    for (const p of paths) { const o = document.createElement('option'); o.value = mvuedPathStr(p); o.textContent = p.join('.'); sel.appendChild(o); }
    const kind = document.createElement('select');
    for (const [v, t] of [['step', '每回合 ±X'], ['clamp', '上下限']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = t; kind.appendChild(o);
    }
    const a = document.createElement('input'); a.type = 'number'; a.placeholder = '±X / 下限';
    const b = document.createElement('input'); b.type = 'number'; b.placeholder = '上限';
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'so-lb-mini'; add.textContent = '添加';
    add.addEventListener('click', () => {
        const path = JSON.parse(sel.value);
        if (kind.value === 'step') {
            const d = mvuedToNumber(a.value);
            if (!Number.isFinite(d)) return;
            trainerSetRule(path, 'step', { delta: d });
        } else {
            const min = mvuedToNumber(a.value);
            const max = mvuedToNumber(b.value);
            if (!Number.isFinite(min) && !Number.isFinite(max)) return;
            trainerSetRule(path, 'clamp', { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null });
        }
        renderMvuedBody();
    });
    const syncB = () => { b.style.display = kind.value === 'clamp' ? '' : 'none'; };
    kind.addEventListener('change', syncB); syncB();
    [sel, kind, a, b, add].forEach(el => wrap.appendChild(el));
    return wrap;
}

function updateMvuedFoot() {
    const card = document.getElementById('so-mvued-card');
    if (!card) return;
    const n = mvuedDirty.size;
    card.querySelector('#so-mvued-count').textContent = n ? `已改 ${n} 项` : '';
    const apply = card.querySelector('#so-mvued-apply');
    apply.disabled = !n || mvuedApplying;   // 在途写入期间恒禁用（改值触发的重画不得把它点亮）
    apply.textContent = n ? `应用 (${n})` : '应用';
}

function mvuedMarkDirty(leaf, value) {
    const key = mvuedPathStr(leaf.path);
    mvuedDirty.set(key, { path: leaf.path, value, vwd: !!leaf.vwd });
    updateMvuedFoot();
}

// 🗑 删除（1.88.0，Prince 2026-09-27 裁：页签【内】的任何字段 / 文件夹 / 列表可删，页签本身不可删）。
// 页签本身 = 根级对象 / 数组（buildMvuedModel 把根级对象摊成页签、根级数组成页内唯一的 list 节点）；
// 根级散字段（基础页的标量 / VWD 对）是叶子、可删。列表【项】不走这里 —— 它们有 ➖（整列表替换）。
function mvuedCanRemove(nd) {
    return !!nd && Array.isArray(nd.path) && (nd.path.length > 1 || nd.type === 'leaf');
}
function mvuedMarkedRemove(nd) {
    const d = mvuedDirty.get(mvuedPathStr(nd.path));
    return !!(d && d.remove);
}
// 🗑 / ↩ 钮。挂进 <summary> 时必须吃掉默认动作，否则点一下还顺带折叠 / 展开整组。
function mvuedRemoveBtn(nd) {
    const marked = mvuedMarkedRemove(nd);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'so-lb-mini so-mvued-rm';
    b.textContent = marked ? '↩' : '🗑';
    b.title = marked ? '取消删除' : '删除（点「应用」后生效，可撤销）';
    b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        mvuedToggleRemove(mvuedDirty, nd.path);
        renderMvuedBody();
    });
    return b;
}

function renderMvuedNode(nd, q) {
    if (nd.type === 'group') {
        const selfHit = mvuedSelfHit(nd, q);
        const inner = selfHit ? '' : q;   // 组名自身命中 → 子树整体放行（不再逐叶过滤）
        const det = document.createElement('details');
        det.className = 'so-mvued-group';
        if (ENABLE_SCHEMA_DIAG) det.dataset.path = mvuedPathStr(nd.path);   // 🩺 1.89.0：跳到这一格的锚（旗关不加属性）
        det.open = true;
        if (q && !selfHit && !mvuedCountHits(nd, q)) det.classList.add('so-mvued-miss');
        const sum = document.createElement('summary');
        const lab = document.createElement('span');
        lab.className = 'so-mvued-grouplabel';
        lab.textContent = nd.label;
        sum.appendChild(lab);
        det.appendChild(sum);
        if (mvuedCanRemove(nd)) {
            sum.appendChild(mvuedRemoveBtn(nd));
            // 待删：只留标题（划线 + ↩），子树不渲染 —— 子孙编辑已被 mvuedToggleRemove 暂存，没东西可改。
            if (mvuedMarkedRemove(nd)) { det.classList.add('so-mvued-removed', 'so-mvued-dirty'); return det; }
        }
        for (const c of nd.children) det.appendChild(renderMvuedNode(c, inner));
        return det;
    }
    if (nd.type === 'list') return renderMvuedList(nd, q);
    return renderMvuedLeaf(nd, q);
}

function renderMvuedLeaf(nd, q) {
    nd = mvuedEffectiveLeaf(nd, mvuedKindOverrides);   // 🩺 1.89.0：无覆盖 → 原对象，逐字节同旧
    const row = document.createElement('div');
    row.className = 'so-mvued-leaf';
    if (ENABLE_SCHEMA_DIAG) row.dataset.path = mvuedPathStr(nd.path);   // 🩺 1.89.0：跳到这一格的锚（旗关不加属性）
    if (q && !mvuedSelfHit(nd, q)) row.classList.add('so-mvued-miss');
    const dirty = mvuedDirty.get(mvuedPathStr(nd.path));
    const cur = dirty ? dirty.value : nd.value;
    if (dirty) row.classList.add('so-mvued-dirty');
    const lab = document.createElement('span');
    lab.className = 'so-mvued-label';
    lab.textContent = nd.label;
    row.appendChild(lab);
    // 🗑 待删：只剩划线的字段名 + ↩（没有输入框 / 🔒 —— 这一格应用后就不存在了，改它、冻结它都没意义）。
    if (mvuedCanRemove(nd) && mvuedMarkedRemove(nd)) {
        row.classList.add('so-mvued-removed');
        row.appendChild(mvuedRemoveBtn(nd));
        return row;
    }

    const redirty = () => { row.classList.add('so-mvued-dirty'); };
    if (nd.options && nd.kind !== 'boolean' && nd.kind !== 'readonly') {
        // 扫描出的受限字段：下拉 + ✎ 自由输入逃生门（spec §6）。options 恒为字符串数组 → 数字槽经 mvuedMarkTyped 转。
        // readonly（null / 对象等非标量叶子）挡在门外：spec §4.2 说它 v1 只读，扫描若给这种路径配了 options，
        // 渲染成可改下拉就等于绕过只读约定 —— 一改就会把 null 写成字符串。
        const sel = document.createElement('select');
        for (const o of nd.options) {
            const op = document.createElement('option');
            op.value = o; op.textContent = o;
            sel.appendChild(op);
        }
        if (!nd.options.includes(String(cur))) {
            const op = document.createElement('option');
            op.value = String(cur); op.textContent = String(cur) + '（当前值）';
            sel.appendChild(op);
        }
        sel.value = String(cur);
        sel.addEventListener('change', () => { if (mvuedMarkTyped(nd, sel.value)) redirty(); });
        row.appendChild(sel);
        const pen = document.createElement('button');
        pen.type = 'button'; pen.className = 'so-lb-mini'; pen.textContent = '✎';
        pen.title = '自由输入（扫描结果可能不全）';
        pen.addEventListener('click', () => {
            const d = mvuedDirty.get(mvuedPathStr(nd.path));   // 已在下拉里改过 → 带着改后的值切文本框，别退回渲染时的旧值
            sel.replaceWith(mvuedTextInput(nd, d ? d.value : cur, redirty));
            pen.remove();
        });
        row.appendChild(pen);
    } else if (nd.kind === 'number') {
        const num = document.createElement('input');
        num.type = 'number';
        num.value = String(cur);
        let slider = null;
        if (nd.range) {
            slider = document.createElement('input');
            slider.type = 'range';
            slider.min = String(nd.range.min); slider.max = String(nd.range.max);
            slider.step = Number.isInteger(nd.range.min) && Number.isInteger(nd.range.max) ? '1' : 'any';
            // 滑杆只是【装饰】：区间是启发式认出来的、已知有误报（「每回合恢复 1~3 点」那类）。数字框才是
            // 唯一真值来源 —— 当前值超出区间时浏览器会把 slider.value 夹到端点，但这里【不】回写 num.value、
            // 【不】标脏（只有真正的 input 事件才标）。于是超范围的值原样显示、也能被改成别的超范围值。
            slider.value = String(cur);
            slider.addEventListener('input', () => {
                const v = mvuedToNumber(slider.value);
                if (!Number.isFinite(v)) return;
                num.value = slider.value;
                mvuedMarkDirty(nd, v);
                redirty();
            });
            row.appendChild(slider);
        }
        num.addEventListener('input', () => {
            const v = mvuedToNumber(num.value);
            if (!Number.isFinite(v)) return;   // 清空 / 半截输入不标脏，也不动滑杆
            if (slider) slider.value = num.value;
            mvuedMarkDirty(nd, v);
            redirty();
        });
        row.appendChild(num);
    } else if (nd.kind === 'boolean') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!cur;
        cb.addEventListener('change', () => { mvuedMarkDirty(nd, cb.checked); redirty(); });
        row.appendChild(cb);
    } else if (nd.kind === 'string') {
        row.appendChild(mvuedTextInput(nd, cur, redirty));
    } else {
        const ro = document.createElement('span');
        ro.className = 'so-mvued-ro';
        ro.textContent = String(nd.value);
        row.appendChild(ro);
    }
    if (nd.desc) {
        const d = document.createElement('span');
        d.className = 'so-mvued-desc';
        d.textContent = nd.desc;
        row.appendChild(d);
    }
    // 「≡ 当作列表」：本行其实是两项列表、被 VWD 判据认成了「数值+描述」时的翻正出口（canList 见
    // buildMvuedModel）。用户看到的现象（「我的背包怎么只剩一件、另一件跑到灰字里去了」）一眼看不懂，
    // 所以 title 得把话说完。开关是纯显示偏好 —— 只写 metadata 与重画，不标脏。
    if (nd.canList) {
        const asList = document.createElement('button');
        asList.type = 'button';
        asList.className = 'so-lb-mini';
        asList.textContent = '≡';
        asList.title = '当作列表显示——这其实是两项列表、不是数值+描述';
        asList.addEventListener('click', () => { mvuedSetListOverride(nd.path, true); });
        row.appendChild(asList);
    }
    // 🎛 修改器：🔒 一键冻结 + 规则标记（ENABLE_MVU_TRAINER）。
    // readonly 叶子不挂 —— 它们连手动都改不了，给个冻结钮只会误导。
    if (ENABLE_MVU_TRAINER && nd.kind !== 'readonly') {
        const myKey = mvuedPathStr(nd.path);
        const rules = trainerRulesForRender.filter(r => mvuedPathStr(r.path) === myKey);
        const frozen = rules.some(r => r.kind === 'freeze');
        const lock = document.createElement('button');
        lock.type = 'button';
        lock.className = 'so-lb-mini so-mvued-lock';
        // 「已冻结」的按下高亮复用 .so-lb-mini.active——切换型 mini 按钮（如「👁 内容预览」）的既有语言，
        // 不再自建一条 .so-mvued-lock-on。
        lock.classList.toggle('active', frozen);
        lock.textContent = '🔒';
        lock.title = frozen ? '已冻结——点一下解冻（每回合±X / 上下限不受影响）' : '冻结在当前值（每条新回复都会拉回来）';
        lock.addEventListener('click', () => {
            if (frozen) trainerRemoveRule(nd.path, 'freeze');
            // 冻结目标 = 用户【眼前】的值：脏表里有就用脏值（他正要改成那个数），否则用现值。
            else {
                const d = mvuedDirty.get(mvuedPathStr(nd.path));
                trainerSetRule(nd.path, 'freeze', { value: d ? d.value : cur });
            }
            renderMvuedBody();
        });
        row.appendChild(lock);
        // 规则标记：让「这个字段有规则」在树里也看得见（否则只能去 🎛 页找）。
        const marks = rules.map(r => r.kind === 'freeze' ? '已锁'
            : (r.kind === 'step' ? (r.delta >= 0 ? '+' : '') + r.delta
                : (r.min != null ? '≥' + r.min : '') + (r.max != null ? '≤' + r.max : '')));
        if (marks.length) {
            const tag = document.createElement('span');
            tag.className = 'so-mvued-rule-tag';
            tag.textContent = marks.join(' ');
            row.appendChild(tag);
        }
    }
    if (mvuedCanRemove(nd)) row.appendChild(mvuedRemoveBtn(nd));
    return row;
}

function mvuedTextInput(nd, cur, redirty) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = String(cur == null ? '' : cur);
    inp.addEventListener('input', () => { if (mvuedMarkTyped(nd, inp.value)) redirty(); });
    // 输入框 + ⤢ 一起以【片段】返回：两个调用点（字符串叶子 append / ✎ 逃生门 replaceWith）都吃
    // DocumentFragment，于是「每个可编辑文本框都带放大入口」这件事只需在这一处成立、不会漏掉某条路。
    const frag = document.createDocumentFragment();
    frag.appendChild(inp);
    frag.appendChild(mvuedBigEditBtn(inp, nd.label, nd.desc));
    return frag;
}

// 「⤢ 放大编辑」入口钮。挂在【某一个具体的 input 节点】上（不是路径）—— 弹层的写回口径就是往这个节点
// 塞值再派发 input 事件，标脏 / 数字强转 / 列表整体替换全复用它自己的 handler。
function mvuedBigEditBtn(input, label, desc) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'so-lb-mini';
    b.textContent = '⤢';
    b.title = '放大编辑';
    b.addEventListener('click', () => { openMvuedBigEdit(input, label, desc); });
    return b;
}

// 「⤢ 放大编辑」弹层（1.57.0）：编辑器里的文本框只有 8em 宽，长字段（尤其手机）根本没法看全 —— 点 ⤢
// 在卡内叠一张铺满的大文本框。刻意【自建】而不骑 ST 的 .editor_maximize：那是 document 级委托、对第三方
// 动态节点没有任何文档承诺，酒馆一改就会静默失灵。
// 承重设计（本函数唯一的巧劲）：确定时把值塞回【原来那个 input】再派发 input 事件 —— 标脏、✎ 数字槽的
// Number.isFinite 强转、列表行的整列表重建，全都走各自既有的 handler，这里一行业务逻辑都不复制。
// 逃生同卡片那套（✕ + 点遮罩 + 取消），Esc 【不】接管（全屏那套的消费者名单有意收窄，不动它）。
// ⚠ 单行 <input> 的「值净化算法」会吃掉换行（HTML 规范，各浏览器一致）→ 多行文本写回后会粘成一行。
//   本函数不自作主张改文本，但要如实说一句：静默把用户的分行粘掉是最坏的一种「成功」。
// ⚠ 目标节点可能在弹层开着时被重画掉（扫描完成 / ≡⇄ 切换 / 应用后重同步都会重画正文）：那时 input 已
//   detached，写进去谁也看不见、脏表也拿不到 —— 改为不写 + 状态行请用户重开，绝不假装写成功。
function openMvuedBigEdit(input, label, desc) {
    const card = document.getElementById('so-mvued-card');
    if (!card || !input) return;
    // 一次只开一张：弹层本身盖住全部 ⤢，正常操作下点不出第二张，这句是防「代码/自动化连发两次」的双保险。
    if (document.getElementById('so-mvued-bigedit')) return;

    const pop = document.createElement('div');
    pop.id = 'so-mvued-bigedit';
    pop.className = 'so-mvued-bigedit';
    pop.innerHTML = `
        <div class="so-mvued-bigedit-inner">
            <div class="so-mvued-bigedit-head">
                <span class="so-mvued-bigedit-label"></span>
                <span class="so-mvued-desc"></span>
                <div class="so-iconbtn so-warn-x" id="so-mvued-bigedit-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <textarea id="so-mvued-bigedit-text" spellcheck="false"></textarea>
            <div class="so-mvued-bigedit-foot">
                <button type="button" class="so-apply-btn" id="so-mvued-bigedit-cancel">取消</button>
                <button type="button" class="so-apply-btn" id="so-mvued-bigedit-ok">确定</button>
            </div>
        </div>`;
    // 标题与说明一律 textContent：字段名/描述来自角色卡的 stat_data，当 HTML 塞进去等于给卡片开注入口。
    pop.querySelector('.so-mvued-bigedit-label').textContent = String(label == null ? '' : label);
    pop.querySelector('.so-mvued-bigedit-head .so-mvued-desc').textContent = String(desc == null ? '' : desc);
    const ta = pop.querySelector('#so-mvued-bigedit-text');
    ta.value = input.value;   // 预填【输入框当下的值】而非模型里的原值：用户可能已经改过一半才想放大
    card.appendChild(pop);
    enhanceIconBtnNode(pop.querySelector('#so-mvued-bigedit-close'));

    const close = () => { pop.remove(); };
    pop.addEventListener('click', (ev) => { if (ev.target === pop) close(); });
    pop.querySelector('#so-mvued-bigedit-close').addEventListener('click', close);
    pop.querySelector('#so-mvued-bigedit-cancel').addEventListener('click', close);
    pop.querySelector('#so-mvued-bigedit-ok').addEventListener('click', () => {
        const status = card.querySelector('#so-mvued-status');
        const say = (t, err) => { if (!status) return; status.textContent = t; status.classList.toggle('so-hint-error', !!err); };
        // 空操作闸：一个字都没改就当场关掉，【什么都不派发】。两件事全靠它：
        //  ① mvuedMarkTyped 没有等值判据 —— 派发 input 会凭空造一条脏项（「已改 1 项」而那个字段其实没变）；
        //  ② 更阴的一种：库里那个字符串本来【就带换行】，渲染进单行 input 时已被净化算法剃掉；此时
        //     ta.value === input.value（两边都是剃过的），上面那句「换行已去掉」的如实提示根本不会触发 ——
        //     于是「只是打开看了一眼」就把多行原值悄悄压成一行写进脏表、随后被应用。闸在这里，两个坑一起没。
        if (ta.value === input.value) { close(); return; }
        if (!input.isConnected) { say('字段已刷新，请重新打开放大编辑。', true); close(); return; }
        const raw = ta.value;
        input.value = raw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // 净化算法改动过文本 → 如实说明（唯一会发生的是换行被吃掉）；没改动就把状态行清干净。
        say(input.value === raw ? '' : '已写回（单行输入框不保留换行，换行符已去掉）。');
        close();
    });
    // 放大编辑的全部意义就是「马上打字」，故这里【要】自动聚焦（与 toggleWindow 在手机上刻意不抢焦点不同：
    // 那是开窗的副作用，这是用户刚刚点下的明确手势）。光标落在末尾，接着写最顺手。
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* 老浏览器/非文本控件，无所谓 */ }
}

// 列表：任何 ➖ / ＋ / 项内编辑都折成一条【整列表替换】edit（Task 3 契约）。
// 当前列表值 = 脏表里的整列表（若有），否则模型里的现值（VWD 项还原成 pair 保描述）。
function mvuedListValue(nd) {
    const dirty = mvuedDirty.get(mvuedPathStr(nd.path));
    if (dirty) return JSON.parse(JSON.stringify(dirty.value));
    return nd.items.map(it => it.vwd ? [it.value, it.desc] : (it.type === 'leaf' ? it.value : mvuedNodeValue(it)));
}
function mvuedNodeValue(nd) {   // group/list 子树还原为普通值（对象项列表用）
    if (nd.type === 'leaf') return nd.vwd ? [nd.value, nd.desc] : nd.value;
    if (nd.type === 'list') return nd.items.map(mvuedNodeValue);
    const o = {};
    for (const c of nd.children) o[c.label] = mvuedNodeValue(c);
    return o;
}
// 新增项的空白值：按【末项的形状】造，绝不给数字列表塞空串（数字槽收字符串是 MVU 头号地雷）。
function mvuedBlankLike(last) {
    const scalarBlank = (v) => (typeof v === 'number' ? 0 : (typeof v === 'boolean' ? false : ''));
    if (mvuIsVwdPair(last)) return [scalarBlank(last[0]), last[1]];   // 保描述、只清值——VWD 列表新项仍是合法 pair
    if (last != null && typeof last === 'object') {                   // 对象项：克隆末项、逐层清值（保住键名结构）
        const blank = JSON.parse(JSON.stringify(last));
        const wipe = (o) => {
            for (const k of Object.keys(o)) {
                const v = o[k];
                if (mvuIsVwdPair(v)) v[0] = scalarBlank(v[0]);
                else if (v && typeof v === 'object') wipe(v);
                else o[k] = scalarBlank(v);
            }
        };
        wipe(blank);
        return blank;
    }
    return scalarBlank(last);
}
function renderMvuedList(nd, q) {
    const box = document.createElement('div');
    box.className = 'so-mvued-list';
    if (ENABLE_SCHEMA_DIAG) box.dataset.path = mvuedPathStr(nd.path);   // 🩺 1.89.0：跳到这一格的锚（旗关不加属性）
    if (q && !mvuedSelfHit(nd, q)) box.classList.add('so-mvued-miss');
    const listKey = mvuedPathStr(nd.path);
    if (mvuedDirty.has(listKey)) box.classList.add('so-mvued-dirty');
    const head = document.createElement('div');
    head.className = 'so-mvued-label';
    head.textContent = nd.label;
    // 「⇄ 当作数值+描述」：≡ 的反向出口，只对【被翻正过来的】节点出（forcedList；真列表没有可回退的
    // VWD 形态）。挂在标题里而不是 box 上：box 的直接子 <button> 是「＋ 添加一项」的定位口径。
    // 待删时不给 ⇄：mvuedSetListOverride 会删掉该路径的脏项，待删标记（连同它暂存的编辑）就被悄悄丢了。
    if (nd.forcedList && !mvuedMarkedRemove(nd)) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'so-lb-mini';
        back.textContent = '⇄';
        back.title = '当作数值+描述显示';
        back.addEventListener('click', () => { mvuedSetListOverride(nd.path, false); });
        head.appendChild(back);
    }
    box.appendChild(head);
    if (mvuedCanRemove(nd)) {
        head.appendChild(mvuedRemoveBtn(nd));
        // 待删：只留标题（划线 + ↩）。必须在 mvuedListValue 之前返回 —— 待删标记没有 value，读它会炸。
        if (mvuedMarkedRemove(nd)) { box.classList.add('so-mvued-removed'); return box; }
    }
    const val = mvuedListValue(nd);
    val.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'so-mvued-listrow';
        const isVwd = mvuIsVwdPair(item);
        const scalar = isVwd ? item[0] : item;
        if (scalar != null && typeof scalar === 'object') {
            const ro = document.createElement('span');
            ro.className = 'so-mvued-ro';
            ro.textContent = JSON.stringify(scalar);
            row.appendChild(ro);   // 对象项 v1 只支持删除 / 追加克隆，不逐字段编辑
        } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = String(scalar);
            inp.addEventListener('input', () => {
                let nv = inp.value;
                if (typeof scalar === 'number') {   // 数字项恒转；转不出有限数就【什么都不写】（不悄悄退化成字符串）
                    const n = mvuedToNumber(inp.value);
                    if (!Number.isFinite(n)) return;
                    nv = n;
                }
                const next = mvuedListValue(nd);   // 每次现读脏表：同一次渲染内改多项也不会互相覆盖
                next[i] = isVwd ? [nv, item[1]] : nv;
                mvuedMarkDirty({ path: nd.path, vwd: false }, next);
                box.classList.add('so-mvued-dirty');
            });
            row.appendChild(inp);
            // 列表项也吃 ⤢（标题带上第几项，弹层里才知道自己在改哪一格）。VWD 项的描述当说明摆出来。
            row.appendChild(mvuedBigEditBtn(inp, `${nd.label} · 第 ${i + 1} 项`, isVwd ? item[1] : ''));
        }
        if (isVwd) {
            const d = document.createElement('span');
            d.className = 'so-mvued-desc';
            d.textContent = item[1];
            row.appendChild(d);
        }
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'so-lb-mini'; del.textContent = '➖';
        del.title = '删除这一项';
        del.addEventListener('click', () => {
            const next = mvuedListValue(nd);
            next.splice(i, 1);
            mvuedMarkDirty({ path: nd.path, vwd: false }, next);
            renderMvuedBody();   // 下标全变了 → 整体重画（旧行上闭包里的 i 就此作废）
        });
        row.appendChild(del);
        box.appendChild(row);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'so-lb-mini'; add.textContent = '＋ 添加一项';
    add.addEventListener('click', () => {
        const next = mvuedListValue(nd);
        next.push(mvuedBlankLike(next[next.length - 1]));
        mvuedMarkDirty({ path: nd.path, vwd: false }, next);
        renderMvuedBody();
    });
    box.appendChild(add);
    return box;
}

// 纯函数：把「诊断前 → 诊断后」的 stat_data 差异折成一串【绝对值】JSONPatch 操作。
// 为什么不把模型出的补丁原样写进正文：模型的补丁常含相对量（delta），那是按【诊断当时】的状态算的；
// 一旦回放时的起点与当时不同（用户中途改过变量 / 别的扩展写过 / MVU 额外模型解析插过手），相对量就会漂。
// 写进正文的是【MVU 实际算出来的结果】而非模型的意图 —— 回放多少次都落在同一个值上，且天然幂等。
// 规则：VWD 对只出第一格标量；新增键出 add（MVU 的 set 碰到不存在的路径会直接跳过，只有 insert/add 建得了）；
// 删除出 remove；其余出 replace。$internal 是 MVU 自己塞进 stat_data 的运行期字段（update_variables.ts:682），跳过。
// 比较沿用本文件既有的 JSON.stringify 口径（同 autoApplyFix）。可单测。
export function diffMvuStat(oldStat, newStat, base) {
    const prefix = base || '';
    const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const a = isPlainObj(oldStat) ? oldStat : {};
    const b = isPlainObj(newStat) ? newStat : {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const keys = Object.keys(a);
    for (const k of Object.keys(b)) if (!has(a, k)) keys.push(k);
    const ops = [];
    for (const k of keys) {
        if (!prefix && k === '$internal') continue;
        const path = prefix + '/' + k;
        if (has(a, k) && !has(b, k)) { ops.push({ op: 'remove', path }); continue; }
        if (!has(a, k) && has(b, k)) { ops.push({ op: 'add', path, value: b[k] }); continue; }
        const va = a[k], vb = b[k];
        if (mvuIsVwdPair(va) && mvuIsVwdPair(vb)) {
            if (JSON.stringify(va[0]) !== JSON.stringify(vb[0])) ops.push({ op: 'replace', path, value: vb[0] });
            continue;
        }
        if (isPlainObj(va) && isPlainObj(vb)) { for (const op of diffMvuStat(va, vb, path)) ops.push(op); continue; }
        if (JSON.stringify(va) !== JSON.stringify(vb)) ops.push({ op: 'replace', path, value: vb });
    }
    return ops;
}

// 纯函数：把 ops 拼成要插进区块里的那段文本（含定界注释）。ops 为空 → ''（调用方据此不注入）。可单测。
export function buildDiagPatchPayload(ops) {
    if (!Array.isArray(ops) || !ops.length) return '';
    return DIAG_PATCH_OPEN + '\n<JSONPatch>\n' + JSON.stringify(ops) + '\n</JSONPatch>\n' + DIAG_PATCH_CLOSE + '\n';
}

// 纯函数：把 payload 插进【文本里最早那个】更新区块的闭标签之前（跨方言，取块沿用 extractUpdateBlock）。
// 闭标签靠【块尾】定位，不另写 `</name` 正则 —— 那会被 </update_analysis> 抢先命中（1.40.2 同款边界坑）。
// 没有干净闭标签（区块被截断）→ 返回 null，调用方【什么都不做】。可单测。
export function insertDiagPatchIntoBlock(text, payload) {
    const s = String(text == null ? '' : text);
    if (!payload) return null;
    const block = extractUpdateBlock(s);
    if (!block) return null;
    const tail = /<\/[A-Za-z_][\w.:-]*\s*>\s*$/.exec(block);
    if (!tail) return null;
    const at = s.indexOf(block);
    if (at < 0) return null;
    return s.slice(0, at + tail.index) + payload + s.slice(at + tail.index);
}

// 纯函数：把我们插进去的那段（含定界注释）整段摘掉，令正文【逐字节】回到插入前。幂等；没插过就原样返回。可单测。
export function stripDiagPatchFromText(text) {
    const s = String(text == null ? '' : text);
    return s.replace(new RegExp(DIAG_PATCH_OPEN + '[\\s\\S]*?' + DIAG_PATCH_CLOSE + '\\n?', 'g'), '');
}

// 纯函数：把我们自己会发的三种 op（replace / add / remove）按【MVU 的语义】重放到 base 上，返回新状态。
// 只需覆盖这三种——补丁是我们生成的，不会出现 move / delta。唯一的语义要点就是 VWD：路径当前值是
// `[值,"说明"]` 时，MVU 的 set 写的是第一格（update_variables.ts:767-786），这里照做。可单测。
function replayDiagOps(baseStat, ops) {
    const out = (baseStat == null) ? {} : JSON.parse(JSON.stringify(baseStat));
    for (const op of (Array.isArray(ops) ? ops : [])) {
        const segs = String((op && op.path) || '').split('/').slice(1);
        if (!segs.length) continue;
        let node = out;
        for (let i = 0; i < segs.length - 1 && node && typeof node === 'object'; i++) node = node[segs[i]];
        if (!node || typeof node !== 'object') continue;
        const last = segs[segs.length - 1];
        if (op.op === 'remove') { delete node[last]; continue; }
        if (op.op === 'replace' && mvuIsVwdPair(node[last])) { node[last][0] = op.value; continue; }
        node[last] = (op.value === undefined) ? null : JSON.parse(JSON.stringify(op.value));
    }
    return out;
}

// 纯函数：比对用的归一化 —— VWD 对折成它的第一格。理由：说明槽（第二格）不是状态，而且 MVU 的标量 set
// 【够不着】它，所以「说明变了」既不该判成差异、也不该拖累别的路径。其余结构原样递归。可单测。
export function normalizeForVerify(v) {
    if (mvuIsVwdPair(v)) return normalizeForVerify(v[0]);
    if (Array.isArray(v)) return v.map(normalizeForVerify);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) { if (k !== '$internal') out[k] = normalizeForVerify(v[k]); }
        return out;
    }
    return v;
}

// 纯函数：自检 —— 这串 ops 从「诊断前」按 MVU 语义重放，能不能精确落回「诊断后」？
// 卡片的变量形状千奇百怪（各种命名、嵌套、数组、VWD、甚至键名里带斜杠），与其写一份会算出别的结果的
// 补丁进用户存档，不如**一个字都不写**。这是本功能对「未知形状」的兜底闸门。可单测。
export function verifyDiagOps(beforeStat, afterStat, ops) {
    try {
        const got = normalizeForVerify(replayDiagOps(beforeStat, ops));
        const want = normalizeForVerify(afterStat == null ? {} : afterStat);
        return JSON.stringify(got) === JSON.stringify(want);
    } catch (e) { return false; }
}

/* ── 🩺 诊断加固纯函数四件套（陈旧判定 / 甲乙补充探针 / 摘块失败归因 / 逐 op 对账） ──
 * 四个都无副作用、不读全局，唯一依赖是本文件既有的口径函数（normalizeForVerify / mvuIsVwdPair /
 * detectMvuBlockDialect / MVU_BLOCK_DIALECTS）—— 口径只有一份，别另起炉灶。 */

// 纯函数：stat_data 指纹（陈旧判定口径）。折 VWD 取第一格、剥 $internal（沿用 normalizeForVerify），
// 说明槽变化 / MVU 运行期字段不算「状态变了」。可单测。
export function diagStatKey(stat) {
    try { return JSON.stringify(normalizeForVerify(stat == null ? null : stat)); }
    catch (e) { return 'null'; }
}

// 纯函数（1.83.0 🧩 允许与其他脚本并写 MVU）：把补丁裁到「没被别人动过」的那部分。snapStat = 诊断时拍的
// stat_data、liveStat = 写入前现读的那份；一条 op 的落点路径（path；move 类还看 from）在两份之间【值不同】
// = 别人在诊断期间动过它 → 丢弃并点名，其余照留。判据是逐路径取值比对、口径沿用 normalizeForVerify（VWD 折
// 第一格、剥 $internal），与 diagOpOutcomes 同源：整个父容器被换掉时子路径的值自然也不同，天然算冲突；新建键
// 两边都查不到 = 没人动过。只认 <JSONPatch> / <json_patch> 里的 JSON 数组（_.set 方言回 null，调用方退回整份
// 跳过）。ops 数组之外的字节一个不动（外壳原样，写回手法同 repairDiagPatch）。可单测。
export function diagScopePatchToUntouched(patchText, snapStat, liveStat) {
    const text = String(patchText == null ? '' : patchText);
    const got = diagPatchOpsOf(text);
    if (!got || !Array.isArray(got.ops)) return null;
    const fp = (stat, path) => {
        const r = diagResolvePath(stat, path, true);
        return (r && r.ok) ? JSON.stringify(normalizeForVerify(r.value)) : null;
    };
    const touched = (p) => typeof p === 'string' && p !== '' && fp(snapStat, p) !== fp(liveStat, p);
    const kept = [], dropped = [];
    for (const op of got.ops) {
        const dest = (op && typeof op.path === 'string') ? op.path : ((op && typeof op.to === 'string') ? op.to : '');
        const from = (op && typeof op.from === 'string') ? op.from : '';
        if (touched(dest) || touched(from)) dropped.push({ op: op && op.op, path: dest });
        else kept.push(op);
    }
    if (!dropped.length) return { text, kept: kept.length, dropped };
    const at = text.indexOf(got.inner, got.m.index);
    if (at < 0) return null;
    return {
        text: text.slice(0, at) + '\n' + JSON.stringify(kept, null, 2) + '\n' + text.slice(at + got.inner.length),
        kept: kept.length,
        dropped,
    };
}

// 纯函数：这段文本里有没有【裸】可执行 MVU 指令（不带已识别包装）——bare <json_patch> 或行首 _.set(。
// 只喂给 甲/乙 推导闸（detectMvuBlockDialect 之外的补充探针），绝不接到 extract/strip 等其它消费者上：
// MVU 按文本位置执行这两种形态（方言表注释），探不到就误入【乙·推导】= 已生效的回合被再算一遍。可单测。
export function detectBareMvuOps(text) {
    const s = String(text == null ? '' : text);
    // 已识别方言包装在场 → 不是「裸」指令，甲/乙 闸由方言探测负责。<update> 方言【本来就】装着
    // <json_patch>（1.40.2 重复计数那只 bug 的方言）——不先让路，整块规范回复会被误报成裸指令。
    if (detectMvuBlockDialect(s)) return false;
    if (/<json_patch\b/i.test(s)) return true;
    return /(^|[\n\r])\s*_\.set\(/.test(s);
}

// 纯函数：extractUpdateBlock 摘不到时，给「为什么摘不到」分类并点名缺了什么（Prince 点单：要能看出
// 缺哪个闭合标签）。宽松探测沿用 detectMvuBlockDialect / detectBareMvuOps；闭合标签清点只对已探测到的
// 包装族做（wrapper + 它的 inner + 经典内标签 JSONPatch/Analysis），开>闭 即记缺。可单测。
export function diagParseFailReason(finalText) {
    const s = String(finalText == null ? '' : finalText);
    if (!s.trim()) return { code: 'empty', detail: '模型没有返回内容（可能被拒答或截断）' };
    const wrapper = detectMvuBlockDialect(s);
    if (wrapper) {
        const suspects = [wrapper, 'JSONPatch', 'Analysis',
            ...(MVU_BLOCK_DIALECTS.find((d) => d.wrapper === wrapper) || { inner: [] }).inner];
        const missing = [];
        for (const t of suspects) {
            const opens = (s.match(new RegExp('<' + t + '\\b[^>]*>', 'gi')) || []).length;
            const closes = (s.match(new RegExp('<\\/' + t + '\\s*>', 'gi')) || []).length;
            if (opens > closes) missing.push('</' + t + '>');
        }
        return missing.length
            ? { code: 'unclosed', detail: '检测到 <' + wrapper + '> 区块，但缺少 ' + missing.join('、') + ' 闭合标签（换模型后常见）' }
            : { code: 'noblock', detail: '检测到 <' + wrapper + '> 标签，但没能按已知格式摘出完整区块' };
    }
    // 1.69.0：拼法对齐 —— MVU 的块正则写的是 `json_?patch`（下划线【可有可无】），而
    // detectBareMvuOps 的探针写死了下划线（它另有消费者，有意不动它，见其头注）。于是模型甩一段
    // 无包装的 <JSONPatch> 时，归因会掉到最后那句「模型没按格式输出更新区块」= 不实：它输出了，
    // 只是没套包装标签。这里补一道同族探针，只影响【归因文案】，不改任何闸门判定。
    if (detectBareMvuOps(s) || /<json_?patch\b/i.test(s)) {
        return { code: 'nonstd', detail: '检测到 <json_patch>/<JSONPatch>/_.set 指令，但没有标准包装标签' };
    }
    return { code: 'noblock', detail: '模型没按格式输出更新区块' };
}

// 纯函数：逐 op 对账（Prince 点单：告诉用户为什么没生效）。只认 <JSONPatch> 里的 JSON 数组（_.set 方言
// 回 null，调用方退回整体比较文案）。result 判定：「applied」= 这条 op 【自己那条路径】上、前后两份状态
// 的值变了没有；未变化的 op 再按 old 侧路径解析分类——路径解析不到且非 add = missing-path（set 不新建
// 键），解析到且值已等于目标 = noop-equal，其余 unknown（诚实：不懂就说不懂）。VWD 折第一格（说明槽
// 不是状态），口径沿用 normalizeForVerify。可单测。
// ⚠ 判据【有意】不走 diffMvuStat 的变化集：那份差异不进列表内部（数组不是 plain object，只在外层记一条
// 「/今日待办 变了」），于是打在列表项里的 op（/今日待办/0/状态）永远对不上自己的路径 —— 真生效了也
// 只能报「没能从状态变化里判断」。也【不能】退而用前缀命中：同一个列表上另一条 op 造成的变化会把这条
// 没动过的一起算成生效（diag-hardening-helpers.test.mjs 有反向钉）。逐路径取值比对两头都不沾。
export function diagOpOutcomes(patchBlock, oldStat, newStat) {
    let ops = null;
    try {
        const m = /<JSONPatch\s*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(String(patchBlock == null ? '' : patchBlock));
        if (m) ops = JSON.parse(m[1]);
    } catch (e) { ops = null; }
    if (!Array.isArray(ops)) return null;
    const resolve = (stat, path) => {
        const segs = String(path || '').split('/').filter(Boolean);
        let node = stat, ok = true;
        for (const seg of segs) {
            if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
            else { ok = false; break; }
        }
        return ok ? { ok, value: node } : { ok };
    };
    // 该路径上的可比指纹；解析不到回 null（JS null，与 JSON 串 'null' 不会撞）——于是「原本没有 → 现在
    // 有了」（insert 建键）与「原本有 → 现在没了」（remove）都天然算作变了。
    const fingerprint = (stat, path) => {
        const r = resolve(stat, path);
        return r.ok ? JSON.stringify(normalizeForVerify(r.value)) : null;
    };
    const outcomes = ops.map((op) => {
        const path = (op && op.path) || '';
        // path 为空（move 这类只有 from/to 的 op）→ 不比：拿根路径比等于「别处只要变过就算它生效」。
        if (path && fingerprint(oldStat, path) !== fingerprint(newStat, path)) {
            return { op: op && op.op, path, result: 'applied' };
        }
        const cur = resolve(oldStat, path);
        // 能建新键的动词只有 insert / add（diffMvuStat 注释同款口径：set 语义碰到不存在的路径直接跳过）。
        // insert 是【模型真会写】的那个——DIAGNOSE_SYSTEM_PROMPT 给的词表是 replace、delta、insert、
        // remove、move；add 是我们自己 diffMvuStat 出的。两者都不能因「路径当时不存在」判成没生效。
        if (!cur.ok && !(op && (op.op === 'add' || op.op === 'insert'))) return { op: op && op.op, path, result: 'missing-path' };
        if (cur.ok) {
            const curVal = mvuIsVwdPair(cur.value) ? cur.value[0] : cur.value;
            if (JSON.stringify(curVal) === JSON.stringify(op && op.value)) return { op: op && op.op, path, result: 'noop-equal' };
        }
        return { op: op && op.op, path, result: 'unknown' };
    });
    return { total: outcomes.length, applied: outcomes.filter((o) => o.result === 'applied').length, outcomes };
}

// 纯函数：把模型【开错根】的 JSONPatch 路径掰回 MVU 的路径空间（live 用户 2026-08-22 报「29 条指令中
// 0 条生效」，逐条都是「路径不存在」）。MVU 只剥掉开头那一个 '/' 就把整串当作 stat_data【内部】的 lodash
// 路径（update_variables.ts：jsonPatchPathToCommandPath → _.set(variables.stat_data, path, …)）——所以
// 模型写的 /stat_data/世界/时间 会被找成 stat_data.stat_data.世界.时间，恒不存在：replace/remove 被
// 静默跳过（一条都不落地），insert/add 更糟 —— _.set 会把整条父链造出来，存档里就长出一支垃圾
// stat_data.stat_data.*。提示词里已写明「根相对路径（例如 /主角状态/修为/进度百分比）」，模型照样会漏，
// 故硬保证放在代码侧。
// 动手条件（三条【全中】才改，宁可不改也绝不误改）：
//   ① 状态顶层【没有】真名叫 stat_data 的键 —— 少数卡真有，那种卡上 /stat_data/… 原样就是对的；
//   ② 这条路径按原样在当前状态里解析不到；
//   ③ 剥掉开头那个 stat_data 段之后解析得到（= 有证据说它只是开错根，而不是把名字写错了）。
// 判定落点按动词分：insert/add 建的就是【还不存在】的末段（数组追加更是 `-`），只能按【父容器】判，
// 否则这一档 —— 恰恰是唯一会污染存档的那一档 —— 永远救不了；其余（replace/delta/remove/move）按整条判。
// move 的 from/to 与 path 同等对待。
// 回 { text, fixed }：text = 掰过的区块（一条都没掰时【逐字节】原样返回）、fixed = 掰了几条。
// 摘不出 <JSONPatch> JSON 数组（_.set 方言）/ 拿不到状态 → 原样返回，绝不抛。可单测。
export function normalizeDiagPatchPaths(patchBlock, stat) {
    const text = String(patchBlock == null ? '' : patchBlock);
    const out = { text, fixed: 0 };
    if (!stat || typeof stat !== 'object') return out;
    if (Object.prototype.hasOwnProperty.call(stat, 'stat_data')) return out;   // 闸①
    let m = null, ops = null;
    try {
        m = /<JSONPatch\s*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(text);
        if (m) ops = JSON.parse(m[1]);
    } catch (e) { return out; }
    if (!m || !Array.isArray(ops)) return out;
    // 解析口径与 diagOpOutcomes 的 resolve 同源：own-property 逐段查，数组下标同样按 own-property 命中。
    const resolves = (path) => {
        const segs = String(path || '').split('/').filter(Boolean);
        let node = stat;
        for (const seg of segs) {
            if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
            else return false;
        }
        return true;
    };
    // 单段路径的父容器 = 根（空串）→ resolves('') 恒真，于是「往顶层插一个新键」那档也掰得动。
    const probe = (op, path) => {
        if (op !== 'insert' && op !== 'add') return path;
        const at = String(path).lastIndexOf('/');
        return at > 0 ? path.slice(0, at) : '';
    };
    const reroot = (op, path) => {
        if (typeof path !== 'string' || !/^\/stat_data\//.test(path)) return null;
        if (resolves(probe(op, path))) return null;                             // 闸②：原样就查得到 → 不是开错根
        const stripped = path.slice('/stat_data'.length);
        return resolves(probe(op, stripped)) ? stripped : null;                 // 闸③：剥了才查得到，才算有证据
    };
    const next = ops.map((op) => {
        if (!op || typeof op !== 'object') return op;
        const copy = Object.assign({}, op);
        for (const key of ['path', 'from', 'to']) {
            const fixed = reroot(op.op, copy[key]);
            if (fixed != null) { copy[key] = fixed; out.fixed++; }
        }
        return copy;
    });
    if (!out.fixed) return out;
    const at = text.indexOf(m[1], m.index);
    out.text = text.slice(0, at) + '\n' + JSON.stringify(next, null, 2) + '\n' + text.slice(at + m[1].length);
    return out;
}

/* ── 🩺 1.67.0：MVU「受理」预检 + 确定性修复流水线 ────────────────────────────────
 * 全部纯函数、零副作用、绝不抛。依据是 MagVarUpdate@beta 与 mvu_zod 的【真源码】（2026-08-24 逐条核过），
 * 不是设计稿推测 —— 改这一族之前请先回去核源码，别按印象改：
 *   ① 块正则 /<(json_?patch)>(?:\s*```.*)?…(?:```\s*)?<\/\1>/gim：大小写不敏感（<JSONPatch> 恒命中）、
 *      允许紧贴标签的 ``` 围栏，但标签里【一个空白都不容】——「<JSONPatch >」对 MVU 完全隐形，而我们
 *      自家的摘块正则写的是 \s*，恒容忍 → 我们看得见、MVU 看不见，这是最难自查的一档。
 *   ② 内文经 parseString（YAML → JSON5 → jsonrepair 三连）解析，【宽容】；失败被 catch 吞掉 = 空命令表。
 *      所以我们的 JSON.parse 挂了【不等于】MVU 也挂 —— 那一档只敢报「判不出」，绝不敢报「一定失败」。
 *   ③ isJsonPatch 是 every：数组 + 每个元素都是 plain object + op 是字符串 + path 是字符串（move 可只有
 *      to）。一颗坏元素 → 整块指令一起被丢，好 op 全部陪葬。这就是「剔除毒元素」那一类修复存在的理由。
 *   ④ 动词表只有 replace/delta/insert/add/remove/move；认不出的动词在 switch 里没有分支 = 逐条静默丢弃。
 *   ⑤ set（replace）先 _.has，路径不存在 → outError + continue，【绝不新建】；旧值是 VWD 对 [值,"说明"]
 *      时只写第一格（旧值是数字还会 Number(新值)）—— 把整对递回去 = Number([...]) = NaN。
 *   ⑥ add（delta）同样先 _.has；增量非数字 → outError + continue。
 *   ⑦ insert/add 在 extractJsonPatch 里被拆成（容器路径, 末段键, 值）三参 —— 判定落点是【父容器】；
 *      容器不是集合（含 undefined）→ 报 assignPrimitive 跳过。1.66.1 的 probe 用的就是同一条口径。
 *   ⑧ jsonPatchPathToCommandPath 只剥开头那【一个】'/'，其余按 '/' 切、逐段解 ~1/~0，【不丢空段】：
 *      末尾多一个斜杠 = 多一个空键名，_.has 恒假（我们自家的解析 filter(Boolean) 会容忍它 → 分歧之二）。
 *   ⑨ 很多卡在 MVU 之上还挂 mvu_zod（StageDog/tavern_resource dist/util/mvu_zod.js）：路径里只要有一段
 *      以 '_' 开头就 return null【静默】不执行；整批结果 safeParse 不过也是【静默】丢弃（只有 console
 *      错误）。那份 schema 我们看不见，所以这两条只出【提示】，绝不写成「一定失败」。
 */

// 纯函数：按 MVU 的路径语义把 JSONPatch 路径切成段。strict=true 忠实 MVU（不丢空段，见 ⑧）；
// strict=false 沿用本仓既有的宽容口径（filter(Boolean)，同 diagOpOutcomes 的 resolve），供「剥掉多余
// 斜杠之后查得到吗」这类证据闸使用。空串 = 根路径（MVU 的 set 允许 path === ''）。可单测。
export function diagPathSegs(path, strict) {
    const raw = String(path == null ? '' : path);
    if (raw === '') return [];
    const segs = (raw.startsWith('/') ? raw.slice(1) : raw).split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    return strict ? segs : segs.filter(Boolean);
}

// 纯函数：own-property 逐段走（口径同 diagOpOutcomes 的 resolve —— 数组下标同样按 own-property 命中）。
export function diagWalkSegs(stat, segs) {
    let node = stat;
    for (const seg of segs) {
        if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
        else return { ok: false };
    }
    return { ok: true, value: node };
}

// 纯函数：一条路径在当前状态里查不查得到。可单测。
export function diagResolvePath(stat, path, strict) {
    return diagWalkSegs(stat, diagPathSegs(path, strict));
}

// 纯函数：这个元素过不过得了 MVU 的 isJsonPatch 形状闸（③）。过不了的那一颗会拖着整块陪葬。可单测。
export function diagOpShapeOk(o) {
    return Object.prototype.toString.call(o) === '[object Object]'
        && typeof o.op === 'string'
        && (typeof o.path === 'string' || (o.op === 'move' && typeof o.to === 'string'));
}

// 纯函数：MVU 那条【严格】块正则现在看不看得见一块 json_patch —— 逐字照抄它的写法（标签里一个空白都
// 不容、允许紧贴标签的 ``` 围栏、内部不得再出现开标签）。这是「标签空白」那一类修复与预检的【唯一】
// 证据来源：看得见就说明这块 MVU 本来就吃得到，一个字节都不许动。可单测。
function mvuSeesPatchBlock(text) {
    return /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/i
        .test(String(text == null ? '' : text));
}

// 纯函数：把这块补丁【自己的】<json_patch> 开 / 闭标签里的多余空白抹掉（①）。回 { text, fixed }，
// 形状与姊妹件 normalizeDiagPatchPaths 一致；一处没动 → text 逐字节原样返回。
// ⚠ 有意【不】做全局替换：补丁的 value 里完全可能原样带着「<json_patch >」这几个字（比如把模型的
//   输出记进某个日志字段），全局替换会去改用户真正要写进状态的【正文】——「没有证据就不改写模型
//   原文」是本族的红线。所以只动我们摘到的那一块的两个定界标签，块内文字一个字节都不碰。
// 别的标签（<Analysis > 之类）的空格与 MVU 无关，同样不碰。大小写原样保留：开 / 闭两侧各自捕获、
// 不用反向引用，于是闭标签写成别的大小写时也保留它自己的写法（MVU 的块正则是 /i，本就不在乎）。可单测。
export function normalizeDiagPatchTags(text) {
    const s = String(text == null ? '' : text);
    // 证据闸（codex 复核 FINDING）：MVU 现在【已经】看得见一块 → 这里没有任何毛病可修，一个字节都不动。
    // 少了这道闸，`value` 里原样带着一个 `</JSONPatch >` 的补丁会被咬伤：我们的懒惰匹配会停在【值里】
    // 那个闭标签上、把它的空格抹掉，于是它变成一个【真的】闭标签 —— MVU 的块就此被从中间截断，一条
    // 本来跑得好好的补丁被我们改废。修坏比不修坏得多。
    if (mvuSeesPatchBlock(s)) return { text: s, fixed: 0 };
    const m = /<(json_?patch)(\s*)>([\s\S]*?)<\/(json_?patch)(\s*)>/i.exec(s);
    if (!m || (!m[2] && !m[5])) return { text: s, fixed: 0 };
    const rebuilt = '<' + m[1] + '>' + m[3] + '</' + m[4] + '>';
    return {
        text: s.slice(0, m.index) + rebuilt + s.slice(m.index + m[0].length),
        fixed: (m[2] ? 1 : 0) + (m[5] ? 1 : 0),
    };
}

/* ── 🩺 1.68.0：弱模型错误电池（768 判分格，2026-08-25）蒸馏出的三类新修复 ────────────────
 * 全部纯函数、零副作用、绝不抛，证据闸与 1.67.0 那七类同一条红线：拿不到证据宁可不改，
 * 一处没动就【逐字节】原样返回。语料频次见 tests/unit/_diag-battery/FINDINGS-2026-08-25.md。
 */

// 纯函数：MVU 真会执行的【每一块】的整块原文（含定界标签）。逐字照抄它那条【严格】块正则
// （标签里不容空白、允许紧贴围栏），/gim 全局切。MVU 的 extractCommands 用的正是 /gim ——
// 它把【所有】块都执行，而我们的预检 / 修复只看第一块。
// 1.69.0 起闸门要【逐块】判「这一块到底写成了没有」（第二块可以把整条回复救回甲），故切出块
// 本身而不只是计数；diagCountPatchBlocks 从此是它的一行包装，两处口径构造性同源。可单测。
export function diagMvuPatchBlocks(text) {
    const s = String(text == null ? '' : text);
    if (!s) return [];
    return s.match(/<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim) || [];
}

// 纯函数：MVU 真会执行几块？双区块因此既有「重复执行」的风险，又撞卡片显示正则的状态栏吞噬
// 地雷（CLAUDE.md 地雷条）—— 这是双区块拒绝闸的唯一判据。可单测。
export function diagCountPatchBlocks(text) {
    return diagMvuPatchBlocks(text).length;
}

// 纯函数：从这段文本里切出【第一个结构完整】的 JSON 数组跨度（字符串感知的括号配对 —— 值里的
// 方括号 / 花括号骗不动它）。配不平 → null。给下面两类定界符修补当证据闸。可单测。
function diagJsonArraySpan(text) {
    const s = String(text == null ? '' : text);
    const start = s.indexOf('[');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) return { start, end: i + 1 };
            if (depth < 0) return null;
        }
    }
    return null;
}

// 纯函数（修复类⑨）：补丁数组写完了、`</UpdateVariable>` 也在，就是【漏了 </JSONPatch>】——
// 于是 MVU 与我们的提取器全瞎，整条回复被判「没有区块」。语料 5/768，四例是 gemini 家族；
// 与 2026-08-15 异录战役钉死的 opus-4.8 漏闭合是同一物种（不是那只模型的怪癖，是弱模型通病）。
// 证据闸（四条【全中】才补，宁可不补也绝不误补）：
//   ① mvuSeesPatchBlock 现在【看不见任何块】—— 看得见就说明 MVU 本来就吃得到，一个字节都不许动。
//      这条闸顺带挡住 normalizeDiagPatchTags 头注里那口最险的咬：value 里原样带着一个 `</JSONPatch>`
//      时 MVU 的块正则会把它当真闭标签 → 它【看得见】一块 → 本类天生不动手。
//   ② 开标签在，且【本来就干净】（<json_patch> / <JSONPatch>，标签里没有空白）。带空白的那档是
//      类① 的活；开标签空白 + 缺闭合的双故障【有意】不修（两处都靠猜，风险不成比例）。
//   ③ 从开标签起、到 </UpdateVariable>（没有就到结尾）为止，切得出一个结构完整、能 JSON.parse 的数组；
//   ④ 数组里【每一个】元素都过得了 MVU 的 isJsonPatch 形状闸 —— 过不了的话补上闭合标签也是整块陪葬。
// 闭合标签的拼法【跟着开标签走】（用户写 <json_patch> 就补 </json_patch>）；数组之后若只剩一个紧贴
// 的 ``` 围栏，闭合标签排在围栏之后（MVU 的块正则明文允许围栏，排前面会把围栏甩出块外）。
// 回 { text, fixed }，形状与姊妹件 normalizeDiagPatchTags 一致。可单测。
export function repairDiagCloseTag(text) {
    const s = String(text == null ? '' : text);
    const out = { text: s, fixed: 0 };
    if (!s || mvuSeesPatchBlock(s)) return out;                       // 闸①
    const om = /<(json_?patch)>/i.exec(s);                            // 闸②（不容空白 = MVU 的口径）
    if (!om) return out;
    const after = om.index + om[0].length;
    const tail = s.slice(after);
    const endM = /<\/UpdateVariable\s*>/i.exec(tail);
    const zone = endM ? tail.slice(0, endM.index) : tail;
    const span = diagJsonArraySpan(zone);                             // 闸③
    if (!span) return out;
    let ops = null;
    try { ops = JSON.parse(zone.slice(span.start, span.end)); } catch (e) { return out; }
    if (!Array.isArray(ops) || !ops.every((o) => diagOpShapeOk(o))) return out;   // 闸④
    let at = span.end;
    const fence = /^\s*```\s*/.exec(zone.slice(at));
    if (fence) at += fence[0].length;
    out.text = s.slice(0, after + at) + '</' + om[1] + '>' + s.slice(after + at);
    out.fixed = 1;
    return out;
}

// 纯函数（修复类⑩）：块在、闭合标签也在，坏的是【JSON 容器本身】。语料两种形态（2/768，均 preview 臂）：
//   (a) 几条 op 逗号排开，忘了包 `[ ]`；(b) 开了 `[`、一条完整 op 之后忘了写 `]`。
// 旧路：JSON.parse 死 → 预检走 parse-uncertain（有意不 fatal）→ 零变化报告回 nodata → 侧聊写
// 「本回合无需改动」，而那几条【正确】的指令被静默扔掉。这是 1.67.0 诚实回归里最后一个撒谎的洞。
// 证据闸：补【之前】我们解析不动（got.ops === null），补【之后】解析得到一个【非空】的、每个元素都
// 过形状闸的数组。两种候选各试一次，互斥（包一层对 (b) 无效、补一个 ] 对 (a) 无效），谁成谁算。
// ⚠ 空数组【有意】不算成功：把 `[` 补成 `[]` 会伪造出一份「模型认为无需改动」——那是新的谎。
// ⚠ MVU 自己的 parseString 是【宽容】的（YAML → JSON5 → jsonrepair 三连），我们解析不动不代表它也
//   解析不动；但把定界符补齐【只会】让两边都更容易读懂，不会把它本来读得懂的东西改坏。
// 回 { text, fixed }。可单测。
export function repairDiagJsonWrap(text) {
    const s = String(text == null ? '' : text);
    const out = { text: s, fixed: 0 };
    const got = diagPatchOpsOf(s);
    if (!got || got.ops !== null) return out;
    const body = String(got.inner).replace(/^\s*```[^\n]*\n?/, '').replace(/```\s*$/, '').trim();
    if (!body) return out;
    for (const cand of ['[' + body + ']', body + ']']) {
        let ops = null;
        try { ops = JSON.parse(cand); } catch (e) { continue; }
        if (!Array.isArray(ops) || !ops.length || !ops.every((o) => diagOpShapeOk(o))) continue;
        const at = s.indexOf(got.inner, got.m.index);
        if (at < 0) return out;
        out.text = s.slice(0, at) + '\n' + JSON.stringify(ops, null, 2) + '\n' + s.slice(at + got.inner.length);
        out.fixed = 1;
        return out;
    }
    return out;
}

// 纯函数（修复类⑧）：把一条 move 拆成 insert(目标, 源值) + remove(源)。
// 依据：MagVarUpdate@beta 的 extractJsonPatch 会把 move 翻译成 type:'move' 命令，可执行 switch
// （update_variables.ts 760–1324）里【没有 case 'move'】—— 静默丢弃。1.67.0 的预检给它判 'ok' 是
// 假绿灯：37/768 格中招，且那 37 次 residual 文案（「问题在环境」）100% 是它，两条「常见原因」全不沾边。
// 对照组自己给出了修法：模型自发写成 remove+insert 两步的格【全部落地且意图达成】。
// 证据闸（全中才拆）：源路径解析得到（strict 切段、own-property 逐段走）+ 目标的【父容器】在且是集合。
// 另外三道保守闸：源与目标同路径、互为祖先、根路径 —— 拆了会把源头连带删掉，宁可不修。
// 值是【代码侧】从状态里深拷贝的，不经模型：VWD 的 [值,"说明"] 对整对搬走，说明槽不会掉。
// insert 排在 remove 【之前】是刻意的：中途失败只会留下一份多余的拷贝，绝不会把数据弄丢。
// 回 [insertOp, removeOp]；任一闸不过 → null（调用方原样保留那条 move）。可单测。
export function diagDecomposeMove(op, dest, stat) {
    if (!op || op.op !== 'move' || typeof op.from !== 'string' || typeof dest !== 'string') return null;
    if (!stat || typeof stat !== 'object') return null;
    const fromSegs = diagPathSegs(op.from, true);
    const destSegs = diagPathSegs(dest, true);
    if (!fromSegs.length || !destSegs.length) return null;
    if (JSON.stringify(fromSegs) === JSON.stringify(destSegs)) return null;
    const ancestor = (a, b) => a.length < b.length && a.every((s, i) => s === b[i]);
    if (ancestor(fromSegs, destSegs) || ancestor(destSegs, fromSegs)) return null;
    const src = diagWalkSegs(stat, fromSegs);
    if (!src.ok) return null;
    const parent = diagWalkSegs(stat, destSegs.slice(0, -1));
    if (!parent.ok || !parent.value || typeof parent.value !== 'object') return null;
    let value;
    try { value = JSON.parse(JSON.stringify(src.value)); } catch (e) { return null; }
    if (value === undefined) return null;
    return [{ op: 'insert', path: dest, value }, { op: 'remove', path: op.from }];
}

// 内部：摘出 <JSONPatch> 里的 JSON 数组。摘块正则脱胎于 diagOpOutcomes / normalizeDiagPatchPaths，
// 另兼容 <json_patch> 拼法与紧贴标签的 ``` 围栏（MVU 的块正则明文允许两者，见 ①）。
// ⚠ 已知的口径不对称（有意，1.67.0 不扩）：1.64.0 的 diagOpOutcomes 只认 <JSONPatch> 这一种拼法，
//   本族认两种（MVU 自己两种都执行）。后果只有一个方向：碰上 <json_patch> 拼法的块，本族照修
//   （对用户是净收益），而逐 op 对账仍回 null → 走「没有对账依据」那条老路，与 1.67.0 之前逐字一致。
//   要拉齐就得连 diagOpOutcomes 一起改，那是另一批的事。（开错根那一道闸已经拉齐了 —— repairDiagPatch
//   把 ops 包进合成外壳再喂 normalizeDiagPatchPaths，见那里的注释。）
// 回 null = 根本没有这种块（_.set 方言）；ops === null = 我们解析不动（MVU 未必也解析不动，见 ②）。
export function diagPatchOpsOf(text) {
    const s = String(text == null ? '' : text);
    // 先按 MVU 的【严格】块正则切一刀，切不到再退回宽容版。次序承重（codex 复核 FINDING）：宽容版的
    // `<\/\1\s*>` 会被【值里】一个 `</JSONPatch >` 骗停 —— 而 MVU 根本不认那个带空格的东西、照常读到
    // 整块。先严格后宽容 = 只要 MVU 读得到，我们就跟它读到同一段；MVU 也读不到时才轮到宽容版去救场。
    const m = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/i.exec(s)
        || /<(json_?patch)\s*>([\s\S]*?)<\/\1\s*>/i.exec(s);
    if (!m) return null;
    const body = m[2].replace(/^\s*```[^\n]*\n?/, '').replace(/```\s*$/, '').trim();
    try { return { m, inner: m[2], ops: JSON.parse(body) }; }
    catch (e) { return { m, inner: m[2], ops: null }; }
}

// 纯函数：值的类型对不对得上（⑨ 的启发式提示，不是判决）。任一侧 null/undefined → 不表态（MVU 明文
// 允许把数值字段设成 null）。数字 ↔ 【整串都是数字】的字符串不算不符：MVU 自己会强转。可单测。
export function diagTypeMismatch(cur, val) {
    if (cur == null || val == null) return false;
    const kind = (v) => (Array.isArray(v) ? 'array' : typeof v);
    const a = kind(cur), b = kind(val);
    if (a === b) return false;
    const numish = (v) => (typeof v === 'number' ? true
        : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))));
    if (numish(cur) && numish(val)) return false;
    return true;
}

/* ── 🩺 1.77.3：schema 感知的两条判定 ────────────────────────────────────────────
 * 我们手里【本来就有】那份 schema —— applyFix / autoApplyFix 的 snapshot 就是整份 MvuData，
 * 里面的 .schema 从 1.67.0 起一直没人看过。而 MVU 的 generateSchema 默认把每一个对象【和】数组都
 * 标成 extensible:false（除非卡片写了 $meta.extensible / recursiveExtensible / $__META_EXTENSIBLE__$），
 * 于是「往没标可扩展的容器里新增一个键」是一条【可预测】的失败 —— 1.77.2 之前它被判 'creates' →
 * 落进 residual → 文案甩锅给「酒馆助手版本偏旧 / mvu_zod」（2026-09-06 Discord 报障那一张）。
 * 【红线】schema 缺席、或不是普通对象（mvu_zod 每轮把它设成字符串 '没有用别管这个'）时，这两条判定
 * 一律不启用 —— 判定权那时不在 MVU 原生执行器手里，行为必须与 1.77.2 逐字节相同。
 */

// 纯函数：按 MVU 的 getSchemaForPath（schema.ts:209）逐段走 schema 树。纯数字段 → 数组节点的
// elementType；其余 → 对象节点的 properties[段]；走不到回 null（null 在 MVU 那边 = 【不做】schema
// 检查，只剩父路径存在性那道闸）。空段数组 = 根节点。可单测。
export function diagSchemaNodeAt(schema, segs) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
    let node = schema;
    for (const seg of (segs || [])) {
        if (!node || typeof node !== 'object') return null;
        const s = String(seg);
        if (/^\d+$/.test(s)) {
            if (node.type === 'array' && node.elementType) node = node.elementType;
            else return null;
        } else if (node.type === 'object' && node.properties && node.properties[s]) {
            node = node.properties[s];
        } else return null;
    }
    return (node && typeof node === 'object') ? node : null;
}

// 纯函数：MVU 的 add 执行器（update_variables.ts:1324，= JSONPatch 的 delta）认不认这个【现值】。
// 认：数字 / VWD 对的第一格是数字 / Date 对象 / 「new Date 解析得动且不是纯数字串」的字符串（按毫秒加减）。
// 都不是 → addUnsupportedValue 报错跳过，一个字都写不进去。可单测。
export function diagDeltaTargetOk(cur) {
    const v = mvuIsVwdPair(cur) ? cur[0] : cur;
    if (typeof v === 'number') return true;
    if (Object.prototype.toString.call(v) === '[object Date]') return true;
    if (typeof v === 'string') {
        const d = new Date(v);
        return !isNaN(d.getTime()) && isNaN(Number(v));   // 纯数字串【有意】不算日期（源码原话）
    }
    return false;
}