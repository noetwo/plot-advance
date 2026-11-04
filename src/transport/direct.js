import { getCtx, getSettings, save } from '../core/settings.js';
import { sharedState } from '../core/state.js';
import { updateBadge } from '../ui/settings.js';

/* ---- transports (all OpenAI Chat Completions shaped) ---- */
function normalizeUrl(u, raw) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u;          // full path given
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';  // ends in /v1, /v2 ...
    if (raw) return u + '/chat/completions';                // 1.22.0 地址原样使用：裸地址不补 /v1（原生化自二创「最终模式」）
    return u + '/v1/chat/completions';                      // bare host or base
}

// 直连端点最终 URL：normalizeUrl + 「地址原样使用」开关。所有直连 / 转发调用点统一走这里，
// 开关只需读设置一处，不必在 13 个调用点各自透传。纯函数 → 单测。
export function resolveEndpointUrl(s) {
    return normalizeUrl(s.endpoint, !!s.directRawUrl);
}

function directHeaders(apiKey) {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    return h;
}

// ---- 附加参数（1.70.0）：ST「自定义（兼容 OpenAI）」源「附加参数」面板的神谕版 ----
// 三份文本原样存设置（extraIncludeBody / extraExcludeBody / extraIncludeHeaders）；发送前
// resolveExtraParams 统一校验，坏文本【抛错点名是哪个框】、绝不静默跳过（静默 no-op 是本仓地雷）。
// 生效面：直连（浏览器 fetch 客户端合并 / 后端转发把原文透传给 ST 的 custom 分支）+ profile
// （经 overridePayload 透传，仅「自定义（兼容 OpenAI）」源的配置档会被 ST 后端读取）。

// PURE：解析一份附加参数文本。kind='object'（包括主体参数 / 请求头）| 'array'（排除列表）。
// 空白 → {ok:true, value:null}=未设置；解析失败 / 形状不符 → {ok:false, error}。
// lib 缺省取 SillyTavern.libs.yaml（ST 前端打包的真 yaml 库）；旧版 ST 拿不到就退 JSON.parse
// ——JSON 本就是合法 YAML，两种写法都吃。
function parseExtraParams(text, kind, lib) {
    const t = String(text ?? '').trim();
    if (!t) return { ok: true, value: null };
    if (lib === undefined) lib = (globalThis.SillyTavern && globalThis.SillyTavern.libs && globalThis.SillyTavern.libs.yaml) || null;
    let value;
    try {
        value = (lib && typeof lib.parse === 'function') ? lib.parse(t) : JSON.parse(t);
    } catch (e) {
        return { ok: false, error: `解析失败：${e?.message || e}` };
    }
    if (kind === 'array') {
        if (!Array.isArray(value)) return { ok: false, error: '需要一个字符串列表（每行一个「- 参数名」）' };
        if (!value.every((v) => typeof v === 'string')) return { ok: false, error: '列表里只能是参数名字符串' };
        return { ok: true, value };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: '需要一个「键: 值」对象' };
    }
    return { ok: true, value };
}

// 发送前统一校验闸：读设置三框 → {include, exclude, headers}（未填 = null）。任一框不合法 → 抛
// 中文错点名该框。stream 恒被剥（include 键 + exclude 项）：流式开关是神谕自己的 SSE 读取机制，
// 被参数翻转 = 读取器空手而归的静默空回复地雷；其余键（含 model / max_tokens / messages）都可
// 覆盖 / 剔除 = ST 后端同款脚枪容忍度（requestBody 里 ...bodyParams 排在 messages 之后、exclude
// 跑在最后，见 src/endpoints/backends/chat-completions.js 的 custom 分支）。
function resolveExtraParams(s, lib) {
    const boxes = [
        ['extraIncludeBody', 'object', '包括主体参数'],
        ['extraExcludeBody', 'array', '排除主体参数'],
        ['extraIncludeHeaders', 'object', '包含请求标头'],
    ];
    const vals = {};
    for (const [key, kind, label] of boxes) {
        const r = parseExtraParams(s?.[key], kind, lib);
        if (!r.ok) throw new Error(`附加参数「${label}」不可用——${r.error}。请到 设置 → 连接 → 附加参数 修正或清空该框。`);
        vals[key] = r.value;
    }
    let include = vals.extraIncludeBody;
    if (include && ('stream' in include)) {
        include = { ...include };
        delete include.stream;
        if (!Object.keys(include).length) include = null;
    }
    let exclude = vals.extraExcludeBody;
    if (exclude) {
        exclude = exclude.filter((k) => k !== 'stream');
        if (!exclude.length) exclude = null;
    }
    return { include, exclude, headers: vals.extraIncludeHeaders };
}

// PURE：附加参数并进直连请求体。未设置 → 返回【原引用】（零行为变化）。include 盖既有键、
// exclude 最后删（同键双写 = 删）——与 ST 后端的组装顺序一致。绝不变异入参。
function applyExtraBody(body, extra) {
    if (!extra || (!extra.include && !extra.exclude)) return body;
    const out = { ...body, ...(extra.include || {}) };
    for (const k of (extra.exclude || [])) delete out[k];
    return out;
}

// PURE：附加请求头并进直连 headers。未设置 → 原引用。用户填的头（含 Authorization）覆盖默认
// ——专家逃生舱，且与 ST 后端「custom_include_headers 合并在 secret 派生头之后」同语义。
function applyExtraHeaders(headers, extra) {
    if (!extra || !extra.headers) return headers;
    return { ...headers, ...extra.headers };
}

// PURE：为 profile 路生成 ST 后端认识的三个透传键（JSON.stringify——JSON 是合法 YAML，服务器
// mergeObjectWithYaml / excludeKeysByYaml 走的与 ST 自家「附加参数」同一条路）。未设键不出现，
// 三框全空恒返回 {} = overridePayload 零污染。
function extraParamsOverride(extra) {
    const o = {};
    if (extra?.include) o.custom_include_body = JSON.stringify(extra.include);
    if (extra?.exclude) o.custom_exclude_body = JSON.stringify(extra.exclude);
    if (extra?.headers) o.custom_include_headers = JSON.stringify(extra.headers);
    return o;
}

// 附加参数弹窗：仿 ST 的按钮弹出三框（标签用 ST 官方中文译名——包括主体参数 / 排除主体参数 /
// 包含请求标头——用户在两边对得上号）。文本原样存设置、输入即持久化；这里只做即时提示不拦截，
// 发送时 resolveExtraParams 统一抛错。骨架 / 逃生阀仿 #so-curate（顶部 ✕ + 点遮罩关闭，卡片
// 高度被窗口封顶、正文内部滚动——短视口手机不锁死）。
export function openExtraParams() {
    const s = getSettings();
    let modal = sharedState.win.querySelector('#so-extraparams');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'so-extraparams';
        sharedState.win.appendChild(modal);
    }
    modal.innerHTML = `
        <div id="so-xp-card">
            <div id="so-xp-head">
                <div id="so-xp-title"><i class="fa-solid fa-sliders"></i> 附加参数</div>
                <div class="so-iconbtn" id="so-xp-x" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div id="so-xp-body">
                <div id="so-xp-warn">⚠️ 生效范围：<b>直连模式</b>（含「经酒馆后端转发」）全部生效；<b>连接配置文件</b>模式下，只有 API 类型为「自定义（兼容 OpenAI）」的配置档才会生效——OpenAI / Claude / Gemini 等官方接口会忽略这里的全部内容。</div>
                <label class="so-xp-field"><span>包括主体参数</span>
                    <textarea id="so-extra-include-body" rows="4" placeholder="随每次请求一起发送的参数（YAML 或 JSON 对象）&#10;&#10;例：给 DeepSeek 类中转关掉思维链&#10;enable_thinking: false"></textarea>
                    <div class="so-hint so-xp-err" data-box="extraIncludeBody"></div>
                </label>
                <label class="so-xp-field"><span>排除主体参数</span>
                    <textarea id="so-extra-exclude-body" rows="3" placeholder="要从请求里剔除的参数名（YAML 列表）&#10;&#10;例：&#10;- frequency_penalty&#10;- presence_penalty"></textarea>
                    <div class="so-hint so-xp-err" data-box="extraExcludeBody"></div>
                </label>
                <label class="so-xp-field"><span>包含请求标头</span>
                    <textarea id="so-extra-include-headers" rows="3" placeholder="额外的请求头（YAML 或 JSON 对象）&#10;&#10;例：&#10;X-Custom-Header: some-value"></textarea>
                    <div class="so-hint so-xp-err" data-box="extraIncludeHeaders"></div>
                </label>
            </div>
            <div id="so-xp-foot"><button type="button" class="so-cur-btn" id="so-xp-close">完成</button></div>
        </div>`;

    const FIELDS = [
        ['#so-extra-include-body', 'extraIncludeBody', 'object'],
        ['#so-extra-exclude-body', 'extraExcludeBody', 'array'],
        ['#so-extra-include-headers', 'extraIncludeHeaders', 'object'],
    ];
    const showErr = (key, kind) => {
        const el = modal.querySelector(`.so-xp-err[data-box="${key}"]`);
        if (!el) return;
        const r = parseExtraParams(getSettings()[key], kind);
        el.textContent = r.ok ? '' : `⚠ ${r.error}`;
        el.classList.toggle('so-hint-error', !r.ok);
    };
    for (const [sel, key, kind] of FIELDS) {
        const ta = modal.querySelector(sel);
        ta.value = s[key] || '';
        ta.addEventListener('input', () => {
            getSettings()[key] = ta.value;
            save();
            showErr(key, kind);
            updateExtraParamsHint();
            updateBadge();   // 附加参数也随存档走：改了要马上显示「已修改」
        });
        showErr(key, kind);
    }
    const close = () => { modal.style.display = 'none'; };
    modal.querySelector('#so-xp-x').addEventListener('click', close);
    modal.querySelector('#so-xp-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.style.display = 'flex';
    updateExtraParamsHint();
}

// 设置行的一句状态读数：让「设了没设」在不打开弹窗时也看得见（静默设置是地雷）。
export function updateExtraParamsHint() {
    const hint = sharedState.win?.querySelector?.('#so-extraparams-hint');
    if (!hint) return;
    const s = getSettings();
    const parts = [];
    if (String(s.extraIncludeBody || '').trim()) parts.push('包括主体参数');
    if (String(s.extraExcludeBody || '').trim()) parts.push('排除主体参数');
    if (String(s.extraIncludeHeaders || '').trim()) parts.push('包含请求标头');
    hint.textContent = parts.length ? `已设置：${parts.join('、')}` : '';
}

// PURE：为「经酒馆后端转发的直连」（s.directViaBackend）构造 ChatCompletionService.processRequest 的 requestData。
// 背景（2026-07-01 用户 xxw / 若葉睦）：直连=浏览器→端点，会撞第三方端点的 CORS（opencode 等 → failed to fetch）；
// 配置文件模式又因【无自带密钥的配置档回退到激活连接的密钥】而 401（只有神谕选档 == 酒馆当前激活档才不报错）。
// 这条路复用用户【已在直连里填好的】端点+密钥，但让【酒馆服务器】去发（无浏览器 CORS）：走 ST 的 custom 源，把密钥
// 作为显式 Authorization 头随 custom_include_headers 送——ST 后端把 custom_include_headers 合并在 secret 派生的
// 'Authorization: Bearer '+apiKey 之【后】故覆盖生效，且 custom 源豁免「缺密钥」400 守卫
// （src/endpoints/backends/chat-completions.js:2516 / 2579）。→ 不需要连接配置文件、不需要在 ST 里存 secret、与激活连接无关。
// 入参 url = 直连规范化后的 .../chat/completions（callDirect/streamDirect 收到的那个）；后端会对 custom_url 再追加
// /chat/completions，故这里剥掉后缀，保证 custom_url + '/chat/completions' == 原直连 URL（端点逐字一致）。
// custom_include_headers 必须是【字符串】（后端 mergeObjectWithYaml → yaml.parse；JSON 是合法 YAML 流式映射）。
// extra（1.70.0 可选第 5 参 = resolveExtraParams 的产物）：include / exclude 以 JSON 字符串透传
// 给 ST 后端 custom 分支的 mergeObjectWithYaml / excludeKeysByYaml（与 ST 自家「附加参数」同一条
// 路，语义逐字一致）；headers 直接并进 Authorization 头对象（用户填的覆盖默认）。不传 / 全空 →
// 输出与旧 4 参调用逐字节一致（backend-forward.test.mjs 8 腿 + extra-params.test.mjs 守身钉）。
function buildBackendForwardPayload(url, apiKey, body, stream, extra) {
    const customUrl = String(url || '').replace(/\/chat\/completions\/?$/, '');
    const headers = { ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}), ...(extra?.headers || {}) };
    const { model, messages, max_tokens, stream: _drop, ...rest } = (body || {});
    const payload = {
        chat_completion_source: 'custom',
        custom_url: customUrl,
        custom_include_headers: JSON.stringify(headers),
        model,
        messages,
        max_tokens,
        stream: !!stream,
        ...rest,
    };
    if (extra?.include) payload.custom_include_body = JSON.stringify(extra.include);
    if (extra?.exclude) payload.custom_exclude_body = JSON.stringify(extra.exclude);
    return payload;
}

// 经酒馆后端转发的「直连」——非流式。复用直连的 (url, apiKey, body)，走 ST 的 ChatCompletionService（custom 源 + 显式
// Authorization 头），由酒馆服务器发出 → 无浏览器 CORS、无需连接配置文件 / secret。见 buildBackendForwardPayload。
async function callBackendForward(url, apiKey, body, signal) {
    const ctx = getCtx();
    if (typeof ctx?.ChatCompletionService?.processRequest !== 'function') {
        throw new Error('此 SillyTavern 版本缺少 ChatCompletionService，无法用后端转发——请取消勾选“经酒馆后端转发”，或改用连接配置文件。');
    }
    const extra = resolveExtraParams(getSettings()); // 附加参数（1.70.0）：坏文本在此抛错、绝不静默
    const payload = buildBackendForwardPayload(url, apiKey, body, false, extra);
    const result = await ctx.ChatCompletionService.processRequest(payload, { presetName: undefined }, true, signal);
    return result?.content ?? '';
}

// 同上——流式。ChatCompletionService 流式返回一个「创建 AsyncGenerator 的函数」，每个 chunk.text 是【累计】全文；
// 为与 streamDirect 的回调契约一致（onDelta 收【增量】），这里按累计差分算增量再回调。
async function streamBackendForward(url, apiKey, body, signal, onDelta) {
    const ctx = getCtx();
    if (typeof ctx?.ChatCompletionService?.processRequest !== 'function') {
        throw new Error('此 SillyTavern 版本缺少 ChatCompletionService，无法用后端转发——请取消勾选“经酒馆后端转发”，或改用连接配置文件。');
    }
    const extra = resolveExtraParams(getSettings()); // 附加参数（1.70.0）
    const payload = buildBackendForwardPayload(url, apiKey, body, true, extra);
    const gen = await ctx.ChatCompletionService.processRequest(payload, { presetName: undefined }, true, signal);
    const iterator = (typeof gen === 'function') ? gen() : gen;
    let prev = '';
    for await (const chunk of iterator) {
        if (chunk && typeof chunk.text === 'string') {
            const delta = chunk.text.slice(prev.length);
            prev = chunk.text;
            if (delta) onDelta(delta);
        }
    }
    return prev;
}


// Derive the OpenAI-compatible models endpoint from whatever the user typed.
function modelsUrl(u, raw) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u.replace(/\/chat\/completions$/, '/models');
    if (/\/models$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/models';
    if (raw) return u + '/models';   // 1.22.0 地址原样使用：裸地址不补 /v1（与 normalizeUrl 同一开关）
    return u + '/v1/models';
}

// PURE：为「经酒馆后端转发的获取模型」（s.directViaBackend）构造 /api/backends/chat-completions/status 的
// requestData。背景（2026-07-02 若葉睦回访）：1.17.23 只把【聊天调用】接上了后端转发，onFetchModels 仍是浏览器
// 直连 fetch → 勾了转发、拉千帆模型列表照样撞 CORS（Allow-CORS 浏览器扩展也救不了带 Authorization 的预检）。
// ST 的 /status 路由对 custom 源与 /generate 同一套豁免：缺密钥不 400、custom_include_headers 合并在 secret
// 派生 Authorization 之【后】故显式密钥覆盖生效（src\endpoints\backends\chat-completions.js:1982/1993）。
// 后端会对 custom_url 做 urlJoin(custom_url, '/models')，故这里传 modelsUrl(端点) 剥掉尾部 /models ——
// 保证【服务器代发打到的 URL】与【浏览器直连本会打到的 URL】逐字一致（四种端点形状皆然）。
function buildBackendModelsPayload(endpoint, apiKey, raw) {
    const customUrl = modelsUrl(endpoint, raw).replace(/\/models$/, '');
    const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
    return {
        chat_completion_source: 'custom',
        custom_url: customUrl,
        custom_include_headers: JSON.stringify(headers),
    };
}

// 经酒馆后端转发的「获取模型」——由 ST 服务器去 GET <端点>/models（无浏览器 CORS），返回服务商的模型列表 JSON。
// /status 的失败不走 HTTP 状态码：上游非 2xx / 网络异常 → 200 + { error: true }，所以这里显式检查再报人话。
async function fetchModelsViaBackend(endpoint, apiKey, raw, signal) {
    const ctx = getCtx();
    if (typeof ctx?.getRequestHeaders !== 'function') {
        throw new Error('此 SillyTavern 版本无法经后端转发获取模型——请取消勾选“经酒馆后端转发”，或手动填写模型名。');
    }
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(buildBackendModelsPayload(endpoint, apiKey, raw)),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data && data.error) throw new Error('酒馆服务器代发模型请求失败——请核对直连地址与密钥（酒馆服务器控制台有详情）。');
    return data;
}

export async function onFetchModels() {
    const s = getSettings();
    const hint = sharedState.win.querySelector('#so-model-hint');
    const sel = sharedState.win.querySelector('#so-model-list');
    const btn = sharedState.win.querySelector('#so-model-fetch');

    if (!s.endpoint) { hint.textContent = '请先填写端点 URL。'; hint.classList.add('so-hint-error'); return; }

    hint.classList.remove('so-hint-error');
    hint.textContent = '正在加载模型…';
    btn.classList.add('so-busy');

    try {
        const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
        let data;
        if (s.directViaBackend) {
            // 经酒馆后端转发（1.18.1）：与聊天调用同一开关——服务器代发 GET <端点>/models，无浏览器 CORS。
            data = await fetchModelsViaBackend(s.endpoint, s.apiKey, !!s.directRawUrl, signal);
        } else {
            const url = modelsUrl(s.endpoint, !!s.directRawUrl);
            const res = await fetch(url, { method: 'GET', headers: directHeaders(s.apiKey), signal });
            if (!res.ok) {
                const t = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
            }
            data = await res.json();
        }
        // OpenAI: { data: [{id}] }. Tolerate top-level arrays and { models: [...] }.
        let list = Array.isArray(data?.data) ? data.data
            : Array.isArray(data) ? data
            : Array.isArray(data?.models) ? data.models
            : [];
        const ids = [...new Set(
            list.map((m) => (typeof m === 'string' ? m : (m?.id || m?.name))).filter(Boolean)
        )].sort((a, b) => a.localeCompare(b));

        if (!ids.length) { hint.textContent = '服务商未返回任何模型。'; sel.style.display = 'none'; return; }

        sel.innerHTML = '';
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = `— 选择一个模型（共 ${ids.length} 个）—`;
        sel.appendChild(ph);
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            sel.appendChild(opt);
        }
        // pre-select the current model if it's in the list
        if (s.model && ids.includes(s.model)) sel.value = s.model;
        sel.style.display = '';
        hint.textContent = `共 ${ids.length} 个模型 —— 选择其一，或继续输入自定义名称。`;
    } catch (err) {
        const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        hint.textContent = aborted ? '请求超时。' : `获取模型失败：${err?.message || err}`;
        hint.classList.add('so-hint-error');
        sel.style.display = 'none';
        console.error('[Story Oracle] model fetch failed:', err);
    } finally {
        btn.classList.remove('so-busy');
    }
}

/* ------------------------------------------------------------------ *
 * 柚月记忆（yuzuki-Memory）兼容垫（1.77.1）
 * ------------------------------------------------------------------ */
// 它的 config/request-probe.js 包了 window.fetch：凡 URL 含 /v1/chat/completions 或
// /api/backends/chat-completions/generate（神谕直连 / 后端转发 / 配置文件三条路全中）、又不是酒馆自己
// 前台生成发出的请求，一律先过 sanitizeMemoryFromBody → removeExistingMemoryInjections：正文含下面五个
// 记忆标题之一的消息被【整条删掉】（它把那当成自己上次注入的残留）。神谕把整段上下文装在一条 system
// 里——故事记录里只要有一条 AI 回复抄过它注入的「【当前世界状态参考 - 角色档案】」标题，整条提示词
// 就没了，端点只收到用户那一句（卡比兽 2026-09-06 报「诊断不修」：截图里模型把「状态栏错误」当手机
// 故障来答，正是没有 system 的形态；scratchpad 拿它真源码复现 = 发 2 条收 1 条）。
// 垫法：只在柚月在场时，给出站【副本】里这五个子串的「【」后各插一个零宽空格（U+200B）——它的判据是
// text.includes(标题)，拆开就不认；模型读到的字面不变、存档 / 主聊天 / 世界书一字不动；柚月不在场时
// 原引用原样返回（出站字节全同）。标题表抄自 yuzuki-Memory 0.9.2 config/prompt-ready-injector.js
// MEMORY_INJECTION_MARKERS（commit 2e4a23d7），yzm-shield.test.mjs 钉。它升级改了表就得跟着改。
const YZM_MEMORY_MARKERS = ['【前情提要 -', '【前情提要】', '【当前世界状态参考 -', '【记忆只读数据库 -', '【剧情摘要】'];
const YZM_SHIELD_CHAR = '\u200B';

function yzmMemoryPresent() {
    try { return !!(window.YuzukiMemory && window.YuzukiMemory.loaded); } catch (e) { return false; }
}

// 纯函数：把文本里每个记忆标题从「【」后拆开；没有标题时原字符串返回。幂等（拆开的标题不再命中）。
function yzmShieldText(text) {
    let out = String(text);
    for (const m of YZM_MEMORY_MARKERS) {
        if (out.includes(m)) out = out.split(m).join('【' + YZM_SHIELD_CHAR + m.slice(1));
    }
    return out;
}

// 运行时绊线：它把自己的删除器导出成 YuzukiMemory.PromptReadyInjector.sanitizeMemoryFromChat（0.9.2 起）。窄垫完后
// 拿【副本】过一遍它——还会被删 = 它改了标题表（我们钉的是 0.9.2 那五条）→ 那一条改用兜底 yzmShieldTextWide（每个
// 「【」后都插 U+200B：它的标题一律以「【」开头），并 console.warn 一次提醒更新 YZM_MEMORY_MARKERS；兜底后仍会被删 →
// 第二种 warn（判据已不是「【」开头的子串）。导出缺失 / 不是函数 / 抛错 → 当没有绊线（回到钉死的表）。只喂副本：它会
// 就地 splice 数组、改写 content（stripMemoryVars）。柚月不在场时 yzmShieldMessages 起手就返回，这里根本不会被调到。
function yzmWouldDelete(m) {
    try {
        const yz = window.YuzukiMemory;
        const fn = yz && yz.PromptReadyInjector && yz.PromptReadyInjector.sanitizeMemoryFromChat;
        if (typeof fn !== 'function') return false;
        const probe = [{ ...m }];
        const out = fn(probe);
        return (Array.isArray(out) ? out : probe).length === 0;
    } catch (e) { return false; }
}

// 兜底：每个还没拆开的「【」后插 U+200B。幂等（已拆开的不再插）。
function yzmShieldTextWide(text) {
    return String(text).replace(new RegExp('【(?!' + YZM_SHIELD_CHAR + ')', 'g'), '【' + YZM_SHIELD_CHAR);
}

const yzmTripwireWarned = { list: false, hard: false };   // 每种各提醒一次，别刷屏
function yzmTripwireWarn(kind) {
    if (yzmTripwireWarned[kind]) return;
    yzmTripwireWarned[kind] = true;
    console.warn(kind === 'list'
        ? '[Story Oracle] 柚月记忆的清理函数仍会删掉已垫过的消息——它的记忆标题表大概改了（神谕钉的是 0.9.2 那五条）；本条已改用兜底（每个「【」后插零宽空格）。请更新 YZM_MEMORY_MARKERS。'
        : '[Story Oracle] 柚月记忆的清理函数连兜底后的消息也会删——它的判据已不是「【」开头的子串匹配；兼容垫已失效，请对着它的新源码重做。');
}

// 消息数组：柚月不在场 / 没有一条含标题 → 原数组原引用；否则新数组、只复制被改的那几条（原对象不动）。
function yzmShieldMessages(messages) {
    if (!Array.isArray(messages) || !yzmMemoryPresent()) return messages;
    let changed = false;
    const out = messages.map((m) => {
        if (!m || typeof m.content !== 'string') return m;
        let c = yzmShieldText(m.content);
        if (yzmWouldDelete({ ...m, content: c })) {   // 绊线：它的删除器仍认得 → 兜底
            c = yzmShieldTextWide(c);
            yzmTripwireWarn('list');
            if (yzmWouldDelete({ ...m, content: c })) yzmTripwireWarn('hard');
        }
        if (c === m.content) return m;
        changed = true;
        return { ...m, content: c };
    });
    return changed ? out : messages;
}

// 请求体：messages 没变就原 body 原引用。
function yzmShieldBody(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    const messages = yzmShieldMessages(body.messages);
    return messages === body.messages ? body : { ...body, messages };
}

/* ------------------------------------------------------------------ *
 * Gemini 错误面加固（2026-09-15，_gemini-errors/REPORT.md）——出站前的纯消毒/归一层。
 * 与柚月垫共处同一个传输咽喉（yzmShieldBody / yzmShieldMessages 之后）。
 * ------------------------------------------------------------------ */

// FIX 1（cause A）：把出站内容变成【格式良好】的 Unicode。落单代理项（伴生预设的反截断脚本在 emoji 中途截断
// 会留下半个 emoji，如 \ud83d）+ C0（保留 \t\n\r）/C1/U+FDD0–FDEF/U+FFFE/U+FFFF 都换成 U+FFFD。宽松中转（navy）
// 会静默修复，严格中转 / DeepSeek 直接 400。格式良好的文本逐字节不动。纯函数、可单测。
function sanitizeOutgoingText(s) {
    if (typeof s !== 'string' || !s) return s;
    let out = s;
    // 落单代理项：优先用引擎自带 toWellFormed()（配对的星平面字符不动、只替落单的）；缺席则用正则回退。
    if (typeof out.toWellFormed === 'function') out = out.toWellFormed();
    else out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
    // 控制符（保留制表/换行/回车）+ C1 + 非字符码点
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F﷐-﷯￾￿]/g, '�');
    return out === s ? s : out;
}

// 出站消息数组：逐条把字符串 content 过 sanitizeOutgoingText；只在真有改动时新建对象/数组（引用稳定，与柚月垫同款）。
function sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    let changed = false;
    const out = messages.map((m) => {
        if (!m || typeof m.content !== 'string') return m;
        const c = sanitizeOutgoingText(m.content);
        if (c === m.content) return m;
        changed = true;
        return { ...m, content: c };
    });
    return changed ? out : messages;
}

// FIX 2（cause B）：出站前合并相邻同角色回合。生成失败会把玩家楼留在 convo，反复失败堆出
// [system,user,user,…]，而原生 Gemini / 严格中转要求 user/model 交替（宽松中转合并、严格中转 400）。
// 只合并【连续的 user】与【连续的 assistant】——system 绝不合并、也绝不跨 system 边界合并，以保住内置破限
// 领头的多 system 段与贴合注入（1.75）的字节钉（两者都是纯函数层、byte-pinned）。纯函数、可单测。
function mergeAdjacentSameRole(messages, sep = '\n\n') {
    if (!Array.isArray(messages) || messages.length < 2) return messages;
    const out = [];
    let changed = false;
    for (const m of messages) {
        const prev = out[out.length - 1];
        const mergeable = prev && m
            && (m.role === 'user' || m.role === 'assistant')
            && prev.role === m.role
            && typeof prev.content === 'string' && typeof m.content === 'string';
        if (mergeable) {
            out[out.length - 1] = { ...prev, content: prev.content + sep + m.content };
            changed = true;
        } else {
            out.push(m);
        }
    }
    return changed ? out : messages;
}

// FIX 1+2 出站咽喉：直连体（body.messages）与配置文件（messages 数组）各自的形状包装。先消毒（良构）再合并同角色。
function normalizeOutgoingBody(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    const messages = mergeAdjacentSameRole(sanitizeMessages(body.messages));
    return messages === body.messages ? body : { ...body, messages };
}
function normalizeOutgoingMessages(messages) {
    return mergeAdjacentSameRole(sanitizeMessages(messages));
}

// FIX 3（cause C）：把一行 SSE 的 data 载荷分类。中转会在 HTTP 200 的流里中途插一个 error 块
// （`{choices:[{delta:{},finish_reason:"error"}],error:{message:"…high demand…",code:503}}`）再发 [DONE]。
// 旧解析只读 delta.content、对 error 视而不见 → 用户拿到被腰斩的回复且界面无任何错误。这个纯函数让流循环认得它。
// 返回 {done} / {skip} / {content, reasoning, error, finishReason}。纯函数、可单测。
function classifySseData(payload) {
    if (payload === '[DONE]') return { done: true };
    let json;
    try { json = JSON.parse(payload); } catch (e) { return { skip: true }; }
    const choice = json && json.choices && json.choices[0];
    const delta = (choice && choice.delta) ? choice.delta : {};
    const content = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '')
        || (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    const finishReason = choice ? choice.finish_reason : undefined;
    let error = '';
    if (json && json.error) {
        error = (typeof json.error === 'string')
            ? json.error
            : (json.error && typeof json.error.message === 'string' ? json.error.message : 'stream error');
    } else if (finishReason === 'error') {
        error = 'stream error';
    }
    return { content, reasoning, error, finishReason };
}

// FIX 4（cause D）：判「HTTP 200 但正文空/纯空白，且 finish_reason 是 length/MAX_TOKENS」。Gemini 3.x 把思考 token
// 记进 max_tokens，顶棚太小 → 思考吃光预算 → 200 空回复（不是 400）。纯函数、可单测。
export function isEmptyLengthReply(text, finishReason) {
    if (text && String(text).trim()) return false;
    return /length|max_?tokens|max_output_tokens/i.test(String(finishReason || ''));
}

// FIX 4：gemini-3 系专用输出地板。思考记在 max_tokens 里，顶棚 <4096 极易被思考吃光。只对 model 命中 /gemini-3/i
// 且当前有效值是【正数且 <4096】时，把【本次请求】抬到 4096——只升不降、不落盘、不改设置；未设 / 非法值不动。纯函数、可单测。
export function gemini3MaxTokensFloor(model, maxTokens) {
    if (!/gemini-3/i.test(String(model || ''))) return maxTokens;
    const n = Number(maxTokens);
    if (!Number.isFinite(n) || n <= 0) return maxTokens;
    return n < 4096 ? 4096 : maxTokens;
}

// FIX 5：两类确定性 400 的错误体 → 追加一句中文提示（原文照留、只在末尾追加，绝不替换；判据对【响应体文本】不对状态码）。
// 直连 catch 里用它包 errChainMessage 的结果。纯函数、可单测。
export function explainProviderError(rawMessage) {
    const msg = String(rawMessage == null ? '' : rawMessage);
    const hints = [];
    if (/Requests ending with a model turn/i.test(msg)) {
        // 文案待 Prince 否决权
        hints.push('Gemini 不接受以 AI 回合（assistant 预填）结尾的请求——请在预设里关掉末尾的预填块，或改用 3.1-pro / 2.5 档。');
    }
    if (/input token count exceeds/i.test(msg) || /Cannot truncate to/i.test(msg)) {
        // 文案待 Prince 否决权
        hints.push('上下文超过该模型上限——请调小「上下文深度」楼层数，或缩小世界书范围。');
    }
    return hints.length ? `${msg}（提示：${hints.join(' ')}）` : msg;
}

export async function callDirect(url, apiKey, body, signal) {
    body = yzmShieldBody(body);   // 柚月记忆兼容垫（1.77.1）：在分流到后端转发之前垫，两条路共用
    body = normalizeOutgoingBody(body);   // Gemini 加固（2026-09-15）：良构消毒 + 相邻同角色合并，同一咽喉
    if (getSettings().directViaBackend) return callBackendForward(url, apiKey, body, signal); // 经酒馆后端转发（避免 CORS）
    const extra = resolveExtraParams(getSettings()); // 附加参数（1.70.0）：坏文本在此抛错、绝不静默
    const res = await fetch(url, {
        method: 'POST',
        headers: applyExtraHeaders(directHeaders(apiKey), extra),
        body: JSON.stringify({ ...applyExtraBody(body, extra), stream: false }),
        signal,
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const data = unwrapCompletion(await res.json());
    sharedState.soLastFinishReason = data?.choices?.[0]?.finish_reason || '';   // FIX 4：留给空回复判据（cause D）
    return data?.choices?.[0]?.message?.content ?? '';
}

// 有的中转把补全结果再包一层 { data: { choices… } }（2026-10-30 实测：cline 中转的非流式回复）。顶层没有 choices、
// 里面那层有时拆开用，其余原样返回。纯函数。
function unwrapCompletion(data) {
    return (data && !data.choices && data.data && Array.isArray(data.data.choices)) ? data.data : data;
}

// 有些中转 / 代理会【无视 stream:true】，直接回一个普通 JSON 补全（不是 SSE 事件流）。逐行找 data: 会一无所获、
// 返回空串 → 上层只能报「空回复」。这个纯函数把那种普通 JSON 正文里的 content 取出来作回退；
// 既不是 SSE、也不是合法补全 JSON 时返回 ''（交给上层报「空回复」）。纯函数 → 可单测。
function extractNonStreamContent(raw) {
    if (!raw || !raw.trim()) return '';
    try {
        const data = unwrapCompletion(JSON.parse(raw));
        return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } catch (e) {
        return '';
    }
}

export async function streamDirect(url, apiKey, body, signal, onDelta) {
    body = yzmShieldBody(body);   // 柚月记忆兼容垫（1.77.1）
    body = normalizeOutgoingBody(body);   // Gemini 加固（2026-09-15）：良构消毒 + 相邻同角色合并，同一咽喉
    if (getSettings().directViaBackend) return streamBackendForward(url, apiKey, body, signal, onDelta); // 经酒馆后端转发（避免 CORS）
    const extra = resolveExtraParams(getSettings()); // 附加参数（1.70.0）：坏文本在此抛错、绝不静默
    const { default: EventSourceStream } = await import('/scripts/sse-stream.js');
    const res = await fetch(url, {
        method: 'POST',
        headers: applyExtraHeaders(directHeaders(apiKey), extra),
        body: JSON.stringify({ ...applyExtraBody(body, extra), stream: true }),
        signal,
    });
    if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const dec = new TextDecoder();
    let full = '';
    let raw = '', sawData = false, streamErr = '';
    // 留下原始回包供普通 JSON 回退；SSE 分帧与多行 data 合并交给酒馆。
    // 流结束时补一个空行：酒馆的 EventSourceStream 只在遇到空行时才发出事件、没有收尾处理，
    // 中转最后一个事件后面不带空行时，那一段会被丢掉（旧的逐行解析不会丢）。
    const reader = res.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            raw += dec.decode(chunk, { stream: true });
            controller.enqueue(chunk);
        },
        flush(controller) {
            raw += dec.decode();
            controller.enqueue(new TextEncoder().encode('\n\n'));
        },
    }), { signal }).pipeThrough(new EventSourceStream()).getReader();
    try {
        let doneSeen = false;
        while (!doneSeen) {
            const { value, done } = await reader.read();
            if (done) break;
            sawData = true;
            const data = value.data.trim();
            // 不规范的中转只用单个换行分隔事件：按规范会被并成一个多行 data。整体解析不了时逐行再解析
            //（规范的多行 data——一个 JSON 分几行写——整体就能解析，走不到这里）。
            const payloads = (data.includes('\n') && classifySseData(data).skip)
                ? data.split(/\r?\n/).map((x) => x.replace(/^data:\s?/, '').trim()).filter(Boolean)
                : [data];
            for (const payload of payloads) {
                const cl = classifySseData(payload);
                if (cl.finishReason) sharedState.soLastFinishReason = cl.finishReason;   // FIX 4：留给空回复判据
                if (cl.error && !streamErr) streamErr = cl.error;            // FIX 3：记下首个中途 error，攒完当前内容后统一裁决
                if (cl.done) { doneSeen = true; break; }
                if (cl.skip) continue;
                if (cl.content) { full += cl.content; onDelta(cl.content); }
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    // FIX 3（cause C）：流里出现过 error 块 → 别静默返回被腰斩的正文；抛出去让 catch 显示错误 + 挂「↻ 重试」。
    if (streamErr) {
        // 文案待 Prince 否决权
        throw new Error(full.trim()
            ? `中转中途报错，回复可能不完整（可点 ↻ 重试）：${streamErr}`
            : `中转报错：${streamErr}`);
    }
    // 回退：没有 SSE 事件（端点无视了 stream:true、回了普通 JSON）→ 按普通补全解析，别返回空串。
    if (!sawData && !full) {
        const content = extractNonStreamContent(raw);
        if (content) { onDelta(content); return content; }
    }
    return full;
}


export async function callProfile(profileId, messages, maxTokens, overridePayload, signal) {
    messages = yzmShieldMessages(messages);   // 柚月记忆兼容垫（1.77.1）：配置文件路也经它包过的 fetch
    messages = normalizeOutgoingMessages(messages);   // Gemini 加固（2026-09-15）：良构消毒 + 相邻同角色合并，同一咽喉
    const ctx = getCtx();
    // 附加参数（1.70.0）：经 overridePayload 透传三键——仅「自定义（兼容 OpenAI）」源的配置档会被
    // ST 后端读取（其余源忽略，弹窗警示行有言在先）。排在展开序前面 = 调用点显式 override 恒赢。
    const extra = resolveExtraParams(getSettings());
    const result = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: false, extractData: true, signal },
        { ...extraParamsOverride(extra), ...(overridePayload || {}) },
    );
    return result?.content ?? '';
}

export async function callProfileStream(profileId, messages, maxTokens, overridePayload, signal, onText) {
    messages = yzmShieldMessages(messages);   // 柚月记忆兼容垫（1.77.1）
    messages = normalizeOutgoingMessages(messages);   // Gemini 加固（2026-09-15）：良构消毒 + 相邻同角色合并，同一咽喉
    const ctx = getCtx();
    const extra = resolveExtraParams(getSettings()); // 附加参数（1.70.0）：仅 custom 源配置档生效，同 callProfile
    // With stream:true, sendRequest resolves to a function that creates an
    // AsyncGenerator. Each chunk's `.text` is the CUMULATIVE text so far.
    const gen = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: true, signal },
        { ...extraParamsOverride(extra), ...(overridePayload || {}) },
    );
    const iterator = (typeof gen === 'function') ? gen() : gen;
    let full = '';
    for await (const chunk of iterator) {
        if (chunk && typeof chunk.text === 'string') {
            full = chunk.text;
            onText(full);
        }
    }
    return full;
}