import { applyBlockToCurrentSwipe, awaitMvuIdle, mvuIsBusy, refreshMessageBar } from '../../core/post-reply.js';
import { getCtx } from '../../core/settings.js';
import { DIAG_SEED_GRACE_MS, STATUS_PLACEHOLDER } from '../../prompts/builtins.js';
import { P } from '../../prompts/registry.js';

/* ── 🩺 楼层播种（1.77.2，ENABLE_DIAG_FLOOR_SEED）────────────────────────────────────────
 * MVU 的状态是【按楼】存的：每一楼在酒馆助手的 `variables[swipe_id]` 槽里放自己那份 MvuData，「当前状态」= 最末楼那份。
 * 正常配置下 MVU 在 MESSAGE_RECEIVED 时自己把上一份复制到新楼（handleVariablesInMessage：回溯到最近一楼有效数据、
 * klona、对整条正文跑 updateVariables、写到本楼、补 <StatusPlaceHolderImpl/>）。「额外模型解析 + 不自动请求」这一档它
 * 什么都不做，于是最末楼是空槽、酒馆助手读回 {}、神谕全套逻辑都在一份空状态上空转。下面三件套就是把 MVU 那一步照做一遍。
 * 只在【目标楼空 + 更早有有效楼】时动手；任何一步拿不准（无 API / 无种源 / 解析抛错 / 期间 MVU 自己写了 / 切了聊天）
 * 都原样退出 = 与 1.77.1 逐字相同。单测 diag-floor-seed.test.mjs。
 */

// 纯函数：这一楼的 MVU 槽是不是【空】的。酒馆助手对没有槽的楼回 `{}`（variables.ts `?? {}`）——只认这种「一无所有」；
// 有 stat_data 的楼当然不空，退化形状（变量摊在顶层、没有 stat_data —— mvuStatOf 的 FIX 5 那类卡）也【不空】，
// 绝不能拿「没有 stat_data 键」当判据去覆盖它们。null / undefined 视同空。
function mvuFloorDataEmpty(data) {
    if (data == null || typeof data !== 'object') return true;
    try { return Object.keys(data).length === 0; } catch (e) { return true; }
}

// 纯函数：从 targetIdx 往前找【种源】—— 镜像 MVU 的 getLastValidMessageId：[0, target) 逐楼倒序、不跳系统楼、
// 只认【同时有 stat_data 与 schema】的楼（MVU 的 isMvuData 口径；缺 schema 的楼 MVU 自己下次回溯也会跳过，
// 我们若拿它当种源，种出来的楼 MVU 同样不认）。readAt(i) 由调用方给（运行期 = Mvu.getMvuData 数字楼号）；
// 读某楼抛错（酒馆助手数字楼号越界会抛）→ 当作无效楼继续。回 { idx, data } 或 null。
function mvuFindSeedSource(targetIdx, readAt) {
    const end = Number(targetIdx);
    if (!Number.isInteger(end) || end <= 0 || typeof readAt !== 'function') return null;
    for (let i = end - 1; i >= 0; i--) {
        let d;
        try { d = readAt(i); } catch (e) { continue; }
        if (d && typeof d === 'object' && d.stat_data !== undefined && d.schema !== undefined) return { idx: i, data: d };
    }
    return null;
}

// 替 MVU 做它本该做的那一步。回 { seeded, reason, srcIdx? }；绝不抛。
// opts：graceMs（宽限窗，缺省 DIAG_SEED_GRACE_MS）· isCancelled（中断谓词）· anchorOk（聊天身份仍是起跑时那个）。
// 顺序（承重）：空判 → 找种源 → 宽限窗（MVU 自己种好 / 转忙就让它）→ 深拷贝种源 → parseMessage(整条正文) → 写前三道
// 复核（未中断 / 未切聊天 / 目标楼未被改 / MVU 没在等待期间写过）→ replaceMvuData → 补占位符 + saveChat → 重渲染。
export async function diagSeedTargetFloor(Mvu, ctx, idx, opts = {}) {
    const out = { seeded: false, reason: '' };
    try {
        if (!Mvu || typeof Mvu.getMvuData !== 'function' || typeof Mvu.replaceMvuData !== 'function' || typeof Mvu.parseMessage !== 'function') {
            out.reason = 'no-api'; return out;
        }
        const chat = (ctx && ctx.chat) || [];
        const m = chat[idx];
        if (!m || m.is_user || m.is_system || typeof m.mes !== 'string') { out.reason = 'bad-target'; return out; }
        const readAt = (i) => Mvu.getMvuData({ type: 'message', message_id: i });
        const isCancelled = (typeof opts.isCancelled === 'function') ? opts.isCancelled : () => false;
        const anchorOk = (typeof opts.anchorOk === 'function') ? opts.anchorOk : () => true;
        if (!mvuFloorDataEmpty(readAt(idx))) { out.reason = 'has-data'; return out; }
        const src = mvuFindSeedSource(idx, readAt);
        if (!src) { out.reason = 'no-source'; return out; }
        // 宽限窗：MVU 的处理可能只是迟到（3s throttle）。它在窗内把楼种好 → 让它；转忙（额外模型解析起跑）→ 等它闲，
        // 闲下来楼有数据 → 让它；窗内两样都没发生 → 这一楼真的没人管，我们种。
        const graceMs = (opts.graceMs == null) ? DIAG_SEED_GRACE_MS : Math.max(0, Number(opts.graceMs) || 0);
        const pollMs = Math.max(20, Math.min(250, Math.floor(graceMs / 5) || 20));
        const t0 = Date.now();
        while (Date.now() - t0 < graceMs) {
            if (isCancelled()) { out.reason = 'cancelled'; return out; }
            if (mvuIsBusy(Mvu)) {
                await awaitMvuIdle(Mvu, { isCancelled });
                if (isCancelled()) { out.reason = 'cancelled'; return out; }
                if (!mvuFloorDataEmpty(readAt(idx))) { out.reason = 'mvu-seeded'; return out; }
                break;                                       // 它跑完了仍留空楼 → 轮到我们
            }
            if (!mvuFloorDataEmpty(readAt(idx))) { out.reason = 'mvu-seeded'; return out; }
            await new Promise((r) => setTimeout(r, pollMs));
        }
        if (!mvuFloorDataEmpty(readAt(idx))) { out.reason = 'mvu-seeded'; return out; }
        if (isCancelled() || !anchorOk()) { out.reason = 'cancelled'; return out; }
        const textAtStart = m.mes;
        let data = JSON.parse(JSON.stringify(src.data));
        try {
            // = MVU 的 handleVariablesInMessage 对这一楼会做的事：从种源副本出发，对【整条正文】跑一遍更新引擎——
            // 正文里若自带更新块 / 裸 _.set，此刻就是它【唯一】一次被执行（这一楼没数据 = MVU 确实没跑过）；没有指令
            // 则原样得到副本（MVU 会顺手重算 display_data / delta_data、剥 $internal，与官方形状一致）。
            const parsed = await Mvu.parseMessage(textAtStart, data);
            if (parsed && typeof parsed === 'object') data = parsed;
        } catch (e) {
            console.warn('[剧情推进] 自动诊断楼层播种：parseMessage 失败，本楼不播种（按旧行为继续）：', e);
            out.reason = 'parse-error'; return out;
        }
        if (isCancelled() || !anchorOk()) { out.reason = 'cancelled'; return out; }
        if (chat[idx] !== m || m.mes !== textAtStart) { out.reason = 'target-moved'; return out; }
        if (!mvuFloorDataEmpty(readAt(idx))) { out.reason = 'mvu-seeded'; return out; }   // 等待期间 MVU 自己写了 → 让它
        await Mvu.replaceMvuData(data, { type: 'message', message_id: idx });
        const before = m.mes;
        applyBlockToCurrentSwipe(m, null, STATUS_PLACEHOLDER);   // 只补占位符（幂等；镜像到当前 swipe 槽）
        if (m.mes !== before) {
            try { if (ctx && typeof ctx.saveChat === 'function') await ctx.saveChat(); }
            catch (e) { console.warn('[剧情推进] 自动诊断楼层播种：补占位符后保存失败：', e); }
        }
        refreshMessageBar(idx);
        out.seeded = true; out.srcIdx = src.idx; out.reason = 'seeded';
        console.debug(`[剧情推进] 自动诊断：第 ${idx} 楼没有 MVU 数据，已按第 ${src.idx} 楼播种（MVU 未处理这一楼）。`);
        return out;
    } catch (e) {
        console.warn('[剧情推进] 自动诊断楼层播种失败（已跳过，按旧行为继续）：', e);
        out.reason = 'error'; return out;
    }
}


/* ── MVU 楼层解析（F4，1.63.0）────────────────────────────────────────
 * TavernHelper 的 message 分支读写不对称（variables.ts:65-69 vs :131-135）：
 *   'latest' 读 → chat.filter(m => !m.is_system).at(-1)   ← 滤系统楼
 *   'latest' 写 → chat.at(-1)                             ← 不滤
 * 尾楼是系统楼时（/sys 追加、手动 /hide 最末楼、工具调用），按 'latest' 读写就会【读 X 楼、写 Y 楼】。
 * 修法：自己解析成【数字】楼号交给两侧 —— TH 的 numeric 分支两侧同为 chat.at(n)，
 * 读写对称是构造性的。本函数的口径【刻意与读侧逐字一致】，所以只读调用点换过去
 * 是等价变换（精简版只剩只读调用点）。
 */
function mvuResolveLatestId(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_system) return i;
    }
    return null;
}

// 读 ctx 的薄封装。解析不出可用楼（空聊天 / 全系统楼）→ null，调用方回退 'latest'：
// 那种情形下两条分支本就都拿不到东西，保持旧行为即可，绝不新造一种失败。
export function mvuLatestMsgId() {
    try { return mvuResolveLatestId((getCtx() || {}).chat || []); } catch (e) { return null; }
}

// 全仓 MVU 定位参数的唯一构造口。⚠ 必须在【紧邻每次 MVU 调用处】现调，不要在函数顶部解析一次
// 用到底：数字楼号会被 TH 做范围校验（variables.ts:132 的 _.inRange），若解析与写入之间删了楼
// 就会抛——现调把这个窗口压到零。
export function mvuMsgOpts() {
    const id = mvuLatestMsgId();
    return { type: 'message', message_id: id == null ? 'latest' : id };
}

// 落点是【用户自己那一楼】时的提示（Task 7，审计簇 D）。写入本身是【对的】——MVU 的 'latest' 就是
// 最末那条非系统楼，用户消息也算数，下一条回复正是以它为底；看不见只是因为状态栏住在最后一条【AI】
// 楼的 iframe 里，那个 iframe 结构上只看得到它自己那一层及更早的变量（TavernHelper 合并的是
// chat.slice(0, id+1)）。不说这句，用户唯一能得出的结论是「这个修复没生效」，然后再修一遍。
// Prince 点单：必须把【记在哪】（你发的那条消息）与【显示在哪】（AI 回复上的状态栏）分开说清楚——
// 变量编辑器那句「状态栏要等下一条回复才会显示新值」被他判为太含糊。【文案待 Prince 定】
// ⚠ 系统楼永远成不了这里的落点：mvuResolveLatestId 与 MVU 读侧同口径、跳过 is_system，所以解析出的
//   楼要么是用户楼、要么是 AI 楼，不必特判。
// 这【不是】纯函数（读 ctx）：每个调用点都在真要显示的那一刻现调，绝不缓存——楼层随时会变。
// 判不出来（读不到 ctx / 解析不出楼）就不说这句：绝不因为读不到东西把一次成功的写入说得像有问题。
export function diagUserFloorNotice() {
    try {
        const id = mvuLatestMsgId();
        const m = id == null ? null : ((getCtx() || {}).chat || [])[id];
        if (!m || m.is_user !== true) return '';
        return '（修复已记录在你发的那条消息上；AI 回复上的状态栏只显示到它自己那一楼，要等下一条 AI 回复出现才会显示新值。）';
    } catch (e) { return ''; }
}

// 纯函数：这个值是不是 MVU 的 ValueWithDescription 对 —— [值, "说明"]（第二格是字符串、第一格不是数组）。
// MVU 的 set 分支对这种路径【只写第一格】、保留说明（update_variables.ts:767-786）；所以给这类路径出补丁
// 必须写【标量】，把整对写回去会变成 [[值,"说明"],"说明"]（或触发它紧随其后的 assertVWD）。生命值 / 好感度 /
// 法力这类最常见的数值恰恰多是这种形状 —— 这是本功能唯一与变量【类型】相关的地方。可单测。
export function mvuIsVwdPair(v) {
    return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && !Array.isArray(v[0]);
}

/* ── 🎛 变量编辑器（ENABLE_MVU_EDITOR）纯函数核 ──────────────────────
 * path 一律是相对 stat_data 根的数组（键名 / 数组下标）；pathStr = JSON.stringify(path)
 * 作为 schema / 脏表的规范键。返回值全部用普通对象（jsdom 跨 realm：不要 Map/Set）。 */
export function mvuedPathStr(path) { return JSON.stringify(path); }

export function mvuedLeafKind(v) {
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'boolean') return 'boolean';
    return 'readonly';
}

// 从 VWD 描述 / 字段名里【保守地】认出数值范围（spec §5）。认错比认不出危险得多，三道闸：
// ① 显式区间写法（A-B / A~B / A到B / A至B / [A,B]）；② min < max（顺带排掉 2024-06 这类日期）；
// ③ 当前值必须落在区间内（描述里随手出现的一对数字大多过不了这道）。全过才给滑杆。
function mvuedRangeFromDesc(desc, name, current) {
    const tryOne = (src) => {
        const s = String(src == null ? '' : src);
        const m = /[\[［]\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*[\]］]/.exec(s)
            || /(-?\d+(?:\.\d+)?)\s*(?:[-~～—]|到|至)\s*(-?\d+(?:\.\d+)?)/.exec(s);
        if (!m) return null;
        const min = parseFloat(m[1]);
        const max = parseFloat(m[2]);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) return null;
        if (typeof current === 'number' && (current < min || current > max)) return null;
        return { min, max };
    };
    return tryOne(desc) || tryOne(name);
}

// 扫描 schema / 描述启发式 → 给叶子补 options / range。schema 赢过描述启发式（spec §5）。
function mvuedDecorateLeaf(leaf, fields) {
    const sc = fields ? fields[mvuedPathStr(leaf.path)] : null;
    if (sc) {
        if (Array.isArray(sc.options) && sc.options.length) leaf.options = sc.options.slice();
        if (typeof sc.min === 'number' && typeof sc.max === 'number' && sc.min < sc.max) {
            leaf.range = { min: sc.min, max: sc.max };
        }
    }
    if (!leaf.range && leaf.kind === 'number') {
        leaf.range = mvuedRangeFromDesc(leaf.desc, leaf.label, leaf.value);
    }
    return leaf;
}

// stat_data → { tabs: [{ key, label, nodes }] }。分页规则见 spec §4.1/§6：
// 根级对象/数组（非 VWD 对）各成一页、页内直接摆它的子节点（不重复一层组标题）；
// 根级散标量 / VWD 对聚到首页「基础」；schema.groups 只对那些散字段再分页，没匹配上的留在基础。
// ⚠ VWD 判定一律走 mvuIsVwdPair（全仓同一口径，写入侧 diffMvuStat/applyFix 与之对齐）：
//    「恰好两格、第二格是字符串」的数组【就是】 VWD 对——真列表恰好长这样时也按 VWD 显示，
//    这是 MVU 数据本身的歧义，编辑器有意不另立分歧判定（分歧才会写坏值）。
// listOverrides（第三参，MVUED_LIST_META_KEY 的内容，缺省 []）= 用户逐字段翻正过的 pathStr 清单：
//    命中的 VWD 对改建成【普通列表】节点（forcedList:true），其余一切照旧。这是纯显示层的补救——
//    翻正后的编辑走既有列表机制（整列表替换），写入侧一个字都不用改。
export function buildMvuedModel(statData, schema, listOverrides) {
    const fields = (schema && schema.fields) || null;
    // 普通对象而非 Set：jsdom 跨 realm 下 `instanceof Set` 会假失败（harness 约定）。脏 metadata
    // （不是数组 / 混进非字符串）一律当没有覆盖，绝不让它炸掉整棵树。
    const forced = Object.create(null);
    for (const p of (Array.isArray(listOverrides) ? listOverrides : [])) {
        if (typeof p === 'string') forced[p] = true;
    }
    const node = (key, v, path) => {
        if (mvuIsVwdPair(v)) {
            // 翻正命中：整对改建成两项列表（下标 path 与任何真列表逐字同款）。必须【先于】叶子分支返回——
            // 顺带也就绕过了 mvuedDecorateLeaf：扫描 schema 认「两格数组」是叶子、完全可能给它配了
            // options/min/max，而一个下拉去改两行列表就是写坏形状。
            if (forced[mvuedPathStr(path)]) {
                return { type: 'list', label: String(key), path, forcedList: true, items: v.map((it, i) => node(i, it, path.concat(i))) };
            }
            const leaf = mvuedDecorateLeaf({ type: 'leaf', label: String(key), path, kind: mvuedLeafKind(v[0]), value: v[0], desc: String(v[1]), vwd: true, range: null, options: null }, fields);
            // canList = 渲染器据此出「≡ 当作列表」开关。口径：**只给 [字符串, 字符串] 对**。
            // 真正会撞上这个歧义的是【两项字符串列表】（背包 = ['长剑','皮甲']）；而 [数值,'文本']
            // （好感度 = [40,'好感 0-100']）近乎必然是真的「数值+描述」——那恰恰是本编辑器最常见的
            // 一类字段，给它们统统挂上 ≡ 等于邀请用户去把好端端的 VWD 掰坏。代价是「真的两项数值列表」
            // 拿不到开关：那是边缘的边缘（真列表同质，不会是「数字 + 一句中文」），且描述那一格照常显示、
            // 现象本身仍看得见。[对象,"描述"] 同理排除（翻过去第一行还是个只读对象项）。
            // ⚠ 这只挡【入口】：metadata 里已有的覆盖仍照常生效（见上面的 forced 分支——用户意图优先，
            //    且数值对翻正后两行分别是数字项与字符串项，列表机制原样支持）。
            if (typeof v[0] === 'string') leaf.canList = true;
            return leaf;
        }
        if (Array.isArray(v)) {
            return { type: 'list', label: String(key), path, items: v.map((it, i) => node(i, it, path.concat(i))) };
        }
        if (v && typeof v === 'object') {
            return { type: 'group', label: String(key), path, children: Object.keys(v).filter(k => k !== '$internal').map(k => node(k, v[k], path.concat(k))) };
        }
        return mvuedDecorateLeaf({ type: 'leaf', label: String(key), path, kind: mvuedLeafKind(v), value: v, desc: '', vwd: false, range: null, options: null }, fields);
    };

    const tabs = [];
    const loose = [];
    if (statData && typeof statData === 'object' && !Array.isArray(statData)) {
        for (const k of Object.keys(statData)) {
            if (k === '$internal') continue;
            const v = statData[k];
            // 分页只看【数据形状】，不看 listOverrides：被翻正的根级两格数组仍留在「基础」页，
            // 不跟着变成独立页签——否则点一下 ≡ 整页就换掉，加/删一项（真变成三项数组之后）还会再跳一次。
            if (v && typeof v === 'object' && !mvuIsVwdPair(v)) {
                const n = node(k, v, [k]);
                tabs.push({ key: k, label: k, nodes: n.type === 'group' ? n.children : [n] });
            } else {
                loose.push(node(k, v, [k]));
            }
        }
    }
    // schema.groups 只对根级散字段（loose）分组（spec §6）；没匹配上的留在 基础。
    const groupTabs = [];
    let remaining = loose;
    for (const g of ((schema && Array.isArray(schema.groups)) ? schema.groups : [])) {
        const want = new Set((g.paths || []));
        const mine = remaining.filter(n => want.has(mvuedPathStr(n.path)));
        if (!mine.length) continue;
        remaining = remaining.filter(n => !want.has(mvuedPathStr(n.path)));
        groupTabs.push({ key: '-g:' + g.label, label: String(g.label), nodes: mine });
    }
    if (remaining.length) tabs.unshift({ key: '-base', label: '基础', nodes: remaining });
    tabs.splice(remaining.length ? 1 : 0, 0, ...groupTabs);
    return { tabs };
}

// 批量应用编辑到 stat_data 的【副本】上（spec §7）。按 path 落点：应用时重读的 fresh 数据里路径
// 已消失（编辑器开着时自动诊断动过状态等）→ 跳过并上报，绝不为缺失路径造新键。vwd:true 表示目标
// 必须仍是 [值,"描述"] 对——写 [0] 保 [1]；形状变了同样跳过（写对进标量位是 MVU 头号地雷）。
export function applyMvuedEdits(statData, edits) {
    const stat = JSON.parse(JSON.stringify(statData == null ? {} : statData));
    // 写进去的值再克隆一遍：编辑项里的数组/对象是 UI 手上的活对象，直接挂上去就与入参共享引用，
    // UI 之后再动它会悄悄改到已应用的结果。undefined 不是合法 JSON —— 统一落成 null。
    const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
    // 落点必须是【自有】属性：用 `in` 的话 toString / constructor 这类继承键会假装存在，
    //「绝不为缺失路径造新键」就被绕过了。（数组的 length 是自有属性、不在此闸内，但 path
    // 由 buildMvuedModel 生成，只会是真键名 / 数字下标。）
    const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
    let applied = 0;
    const skipped = [];
    for (const e of (Array.isArray(edits) ? edits : [])) {
        const path = (e && Array.isArray(e.path)) ? e.path : [];
        const label = path.join('.');
        if (!path.length) { skipped.push(label); continue; }
        let parent = stat;
        let ok = true;
        for (let i = 0; i < path.length - 1; i++) {
            if (!own(parent, path[i])) { ok = false; break; }
            parent = parent[path[i]];
        }
        const last = path[path.length - 1];
        if (!ok || !own(parent, last)) { skipped.push(label); continue; }
        if (e.remove) {
            // 🗑 删除（1.88.0）：只在【对象】父上删键。数组父跳过 —— delete 会留空洞、下标也会整体漂；
            // 列表项另有 ➖（整列表替换），UI 也从不对数组元素发 remove。
            if (Array.isArray(parent)) { skipped.push(label); continue; }
            delete parent[last];
        } else if (e.vwd) {
            const cur = parent[last];
            if (!mvuIsVwdPair(cur)) { skipped.push(label); continue; }
            cur[0] = clone(e.value);
        } else {
            parent[last] = clone(e.value);
        }
        applied++;
    }
    return { stat, applied, skipped };
}

// 解析「分析取值规则」扫描回复（spec §6）。宽进严出：定界块 + 去围栏；每个条目逐段沿 statData 走真
// 路径核实，走不到 / 落在容器上 / 范围不合法 / 选项非标量 → 丢弃该条，绝不让模型幻觉进 UI。
// 核实闸认的「真路径」= buildMvuedModel 会发节点的那些，四条一致口径：自有属性（`in` 会让
// toString/constructor 假装存在）、数组只认数字下标、不钻进 [值,"描述"] 对（它整对才是一个叶子）、
// $internal 不是路径。核不严的后果不是报错而是长死键 —— 那种 bug 只会表现为「扫描过了但没生效」。
export function parseMvuedSchema(text, statData) {
    const m = /<MvuSchema>([\s\S]*?)<\/MvuSchema>/i.exec(String(text == null ? '' : text));
    if (!m) return null;
    const raw = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;

    // dot path → 数组 path；沿 statData 核实。回 {path, leaf} 或 null。
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const resolve = (dotPath) => {
        const segs = String(dotPath == null ? '' : dotPath).split('.').filter(Boolean);
        if (!segs.length) return null;
        let cur = statData;
        const path = [];
        for (const seg of segs) {
            if (cur == null || typeof cur !== 'object' || mvuIsVwdPair(cur)) return null;
            if (seg === '$internal') return null;
            const isArr = Array.isArray(cur);
            if (isArr && !/^\d+$/.test(seg)) return null;
            const key = isArr ? Number(seg) : seg;
            if (!own(cur, key)) return null;
            cur = cur[key];
            path.push(key);
        }
        return { path, leaf: cur };
    };
    const isLeaf = (v) => mvuIsVwdPair(v) || v == null || typeof v !== 'object';

    const fields = {};
    for (const f of (Array.isArray(obj.fields) ? obj.fields : [])) {
        const hit = f && resolve(f.path);
        if (!hit || !isLeaf(hit.leaf)) continue;
        const out = {};
        if (Array.isArray(f.options)) {
            const opts = f.options.filter(o => typeof o === 'string' || typeof o === 'number');
            if (opts.length && opts.length === f.options.length) out.options = opts.map(String);
        }
        if (typeof f.min === 'number' && typeof f.max === 'number' && f.min < f.max) {
            out.min = f.min; out.max = f.max;
        }
        if (Object.keys(out).length) fields[mvuedPathStr(hit.path)] = out;
    }

    const groups = [];
    for (const g of (Array.isArray(obj.groups) ? obj.groups : [])) {
        if (!g || typeof g.label !== 'string') continue;
        const paths = (Array.isArray(g.paths) ? g.paths : [])
            .map(resolve)
            .filter(h => h && h.path.length === 1 && isLeaf(h.leaf))
            .map(h => mvuedPathStr(h.path));
        if (paths.length) groups.push({ label: g.label, paths });
    }
    return { fields, groups };
}

// 纯函数：这段扫描回复看起来是【被截断】的吗 —— 开了 `<MvuSchema` 却没有收尾的 `</MvuSchema>`。
// 只在 parseMvuedSchema 已经返回 null 之后才问它，用来把「模型答非所问」和「答对了但没说完」分成两句人话
// （前者叫用户重试是对的，后者得告诉他预算被思考吃光了）。
// 为什么判据是【开了没闭合】而不是「有开标签 + 解析失败」：开闭都在、只是 JSON 写坏 = 格式错，不是截断，
// 那种情况报「可能被截断」会把用户支使去调 max_tokens（白费力气）。真截断必然缺收尾标签 —— 故本判据是
// 「有开标签且解析失败」的严格子集，宁可漏报也不错报。
// 电池实录：GM 的原生思考吃光 4096 预算后正是停在 `"min": -100,`（块开着没收尾），见
// tests/unit/_mvued-tuning/FINDINGS.md —— 那次也正是把地板抬到 8192 的由来。可单测。
export function mvuedScanLooksTruncated(text) {
    const s = String(text == null ? '' : text);
    return /<MvuSchema\b/i.test(s) && !/<\/MvuSchema\s*>/i.test(s);
}

// 可编辑叶子的 dot 路径清单（喂给扫描提示词）。口径必须与 parseMvuedSchema 的核实闸【逐条同款】，
// 否则模型照着清单写出来的路径会被解析器丢掉、该字段静默失去 schema（扫了等于没扫）：
//   · [值,"描述"] 对整对算【一个】字段 —— 发 好感度 而不是 好感度.0（后者落在对内部，resolve 直接 return null）；
//   · 列表整体算一个字段（编辑器按整列表替换编辑，不逐项发路径）；
//   · $internal 永不外露（既不是可编辑字段，也不是合法路径）。
export function mvuedFieldPathList(statData) {
    const out = [];
    const walk = (v, path) => {
        if (mvuIsVwdPair(v)) { out.push(path.join('.')); return; }
        if (Array.isArray(v)) { out.push(path.join('.')); return; }
        if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) { if (k !== '$internal') walk(v[k], path.concat(k)); }
            return;
        }
        if (path.length) out.push(path.join('.'));
    };
    walk(statData, []);
    return out;
}

// 扫描提示词（spec §6）：数据抽取式指令，无人格 / 无破限 / 无预设。输出契约与 parseMvuedSchema 严格对齐。
// 末尾两条「输出纪律」封的是 Task 4 复盘钉下的两个真实翻车模式，两条都是【解析器层面无法补救】的：
//   ① 模型爱先写一版再补一版 —— parseMvuedSchema 只取【第一个】 <MvuSchema> 块，后面那版（往往才是好的）
//      整块被丢；② 模型爱把 [值,"描述"] 对当数组、按 好感度.0 寻址 —— 那条路径核实不过、整条被丢弃，
//      用户看到的是「扫描完成」却没有下拉框。两条都只能在提示词侧关死。
export function buildMvuedScanPrompt(rulesBlock, fieldPaths) {
    return P('mvued.scan', { rules: String(rulesBlock || ''), fields: (fieldPaths || []).join('\n') });
}

// 纯函数：拼一条「🎛 手动编辑」侧聊记录的正文（spec §7.6；仿 autoDiagNoteContent 的写法，不读时钟）。
// ops 来自 diffMvuStat（JSON-pointer 风格 path），是【应用前后的真实差异】而非脏表条数 —— 用户把值改回
// 原样再点应用时，脏表里那条是空操作，记录绝不能吹成「改了 1 项」。VWD 写值可能带 /0 尾段，展示时隐去
// （用户视角改的是「好感度」，不是「好感度/0」）。skipped = 应用时路径已消失的字段，必须写进记录：
// 静默吞掉会让用户以为改到了。可单测。
export function mvuedNoteContent({ ops, skipped, stamp } = {}) {
    const list = (Array.isArray(ops) ? ops : []).map((o) => {
        const p = String((o && o.path) || '').replace(/^\//, '').replace(/\/0$/, '').replace(/\//g, '.');
        if (o && o.op === 'remove') return `· ${p}（已删除）`;
        const v = o ? o.value : undefined;
        return `· ${p} → ${(v !== null && typeof v === 'object') ? JSON.stringify(v) : v}`;
    });
    let s = `🎛 手动编辑（${stamp || ''}）：改了 ${list.length} 项`;
    if (list.length) s += '\n' + list.join('\n');
    if (Array.isArray(skipped) && skipped.length) s += `\n⚠ 跳过 ${skipped.length} 项（字段已不存在）：${skipped.join('、')}`;
    return s;
}