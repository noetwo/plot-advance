import { getSettings } from '../core/settings.js';

import { getLatestAiMessage } from '../modes/diagnose/mvu.js';
import { FIXSEL_BAR_BTN_ID, FIXSEL_BAR_OWN_CLASS, injectChatBarButton, removeChatBarButton, soDropEntries, soEntryIsLive, soMarkEntryLive } from '../modes/diagnose/schema.js';
import { onFixChatEntryClick } from '../modes/fix/selection.js';
import { ENABLE_FIXSEL_CHAT_ENTRY, ENABLE_FIX_SELECT, ENABLE_REPLY_FIX } from '../prompts/builtins.js';
import { toggleWindow } from './mode-shell.js';
let fixSelBarObserver = null;
let fixSelBarTimer = null;
let soQrObserver = null;
let soQrObservedForm = null;
let soQrPoll = null;

// 只给【我们自建】的条打标：撤按钮时据此回收，绝不误删 ST 自己的



// 取（或建）`#qr--bar`，返回挂按钮用的 `.qr--buttons` 容器。用遍历比对 id 而非 `#qr--bar` 选择器：
// 快速回复弹出模式会在 body 上另留一条同 id 的，document.querySelector 会挑错那一条。
function fixSelBarHolder(sendForm) {
    let bar = Array.from(sendForm.querySelectorAll('div')).find((d) => d.id === 'qr--bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'qr--bar';
        bar.className = FIXSEL_BAR_OWN_CLASS + ' flex-container flexGap5';
        sendForm.prepend(bar);
    }
    let holder = bar.querySelector('.qr--buttons');
    if (!holder) {   // 原生条在「未组合」模式下可能没有这层
        holder = document.createElement('div');
        holder.className = 'qr--buttons';
        bar.appendChild(holder);
    }
    return holder;
}

// 注入（幂等）。#send_form 尚未渲染 → 返回 false，由 syncFixSelBarButton 的轮询重试。
function injectFixSelBarButton() {
    if (!ENABLE_FIXSEL_CHAT_ENTRY || !ENABLE_REPLY_FIX || !ENABLE_FIX_SELECT) return false;
    const sendForm = document.getElementById('send_form');
    if (!sendForm) return false;
    // 【先拔光再插】而不是「已存在就返回」：有的扩展会把整条快速回复条搬进自己的容器，搬动过程中
    // 我们的按钮一度不可达，观察者据此判定「按钮没了」又插一颗 → 两颗（实机 race，已复现）。
    // 恰好一颗 = 常态，直接返回、一个字节都不碰 DOM（碰了会让观察者自激）。
    const existing = document.querySelectorAll('#' + FIXSEL_BAR_BTN_ID);
    if (existing.length === 1) return true;
    existing.forEach((b) => b.remove());
    const btn = document.createElement('div');
    btn.id = FIXSEL_BAR_BTN_ID;
    btn.className = 'qr--button menu_button interactable';
    btn.setAttribute('tabindex', '0');
    btn.title = '选段校正 —— 在最新一条回复里划选一段再点我（不划选 = 直接开卡）';
    btn.textContent = '✂️ 选段校正';
    const go = (e) => {
        if (e && e.preventDefault) { e.preventDefault(); e.stopPropagation(); }
        // 这颗按钮【常驻】，可能在还没有 AI 回复时被点到——楼层入口那颗不会（它只长在 AI 楼层上）。
        // 静默 no-op 会让人以为按钮坏了，故这里出声。
        const latest = getLatestAiMessage();
        if (!latest || latest.idx < 0) {
            if (window.toastr) window.toastr.info('还没有可校正的 AI 回复', '剧情推进');
            return;
        }
        Promise.resolve(onFixChatEntryClick()).catch((err) => console.warn('[Story Oracle] 选段入口点击失败：', err));
    };
    btn.addEventListener('click', go);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
    fixSelBarHolder(sendForm).appendChild(btn);
    return true;
}

function removeFixSelBarButton() {
    const btn = document.getElementById(FIXSEL_BAR_BTN_ID);
    if (btn) btn.remove();
    // 只回收【我们自建】的那条空壳（没装快速回复的人不该被留下一条空白条）；ST 自己的条一个字节都不动。
    const own = document.querySelector('div#qr--bar.' + FIXSEL_BAR_OWN_CLASS);
    if (own && !(own.querySelector('.qr--buttons')?.children.length)) own.remove();
}

// 盯住 #send_form：ST 重建 `#qr--bar` 会把我们的按钮冲掉，掉了就补回。不会自激——补回后
// getElementById 即命中，回调直接返回。
function startFixSelBarObserver() {
    if (fixSelBarObserver) return;
    const sendForm = document.getElementById('send_form');
    if (!sendForm) return;
    fixSelBarObserver = new MutationObserver(() => {
        injectFixSelBarButton();   // 自带「恰好一颗就什么都不做」的常态短路 + 多了就收敛，故可无条件调
    });
    fixSelBarObserver.observe(sendForm, { childList: true, subtree: true });
}

function stopFixSelBarObserver() {
    if (fixSelBarObserver) fixSelBarObserver.disconnect();
    fixSelBarObserver = null;
}

// 按设置同步（init 时 + 设置里勾选 / 取消时调用；幂等）。#send_form 懒加载 → 轮询等它出现，
// 封顶 40 次（~20s）后放弃，绝不常驻空转。
export function syncFixSelBarButton() {
    if (fixSelBarTimer) { clearInterval(fixSelBarTimer); fixSelBarTimer = null; }
    if (!getSettings().fixSelBarButton) { stopFixSelBarObserver(); removeFixSelBarButton(); return; }
    if (injectFixSelBarButton()) { startFixSelBarObserver(); return; }
    let attempts = 0;
    fixSelBarTimer = setInterval(() => {
        if (injectFixSelBarButton() || ++attempts > 40) {
            clearInterval(fixSelBarTimer);
            fixSelBarTimer = null;
            if (document.getElementById(FIXSEL_BAR_BTN_ID)) startFixSelBarObserver();
        }
    }, 500);
}


/**
 * 窗口配色三档（1.45.0）。在 <body> 上挂恰好一个 so-skin-* 类；'theme'（跟随酒馆主题）
 * 时一个都不挂 —— 不挂类 = 不命中任何皮肤规则 = 与 1.44.x 逐值相同的渲染。
 *
 * 放在 body 而不是各个根上：一次写入同时覆盖 #so-window / #so-plan-float
 * 两个 body 级根，以后新增根也免费。特异度 body.so-skin-x #so-window (1,1,1) 压过
 * #so-window (1,0,0)，故皮肤块不需要 !important。
 *
 * 无效值一律按 'theme' 处理（fail-open）：配色出错不该把窗口变成没法用的样子。
 *
 * @param {{windowSkin?: string}} s 设置对象（getSettings() 的返回）
 */
export function applyWindowSkin(s) {
    const b = document.body;
    if (!b) return;
    b.classList.remove('so-skin-dark', 'so-skin-light');
    const skin = s && s.windowSkin;
    if (skin === 'dark') b.classList.add('so-skin-dark');
    else if (skin === 'light') b.classList.add('so-skin-light');
}

// 按设置同步聊天栏按钮的有无（init 时 + 设置里勾选 / 取消时调用）。
export function syncChatBarButton() {
    if (getSettings().showChatBarButton) injectChatBarButton();
    else removeChatBarButton();
}

// 精简版 1.2：在输入框上方的快捷回复栏（#qr--bar，「柏宝书」「重新处理变量」那一排）放一个「剧情推进」
// 文字按钮，一键开 / 关窗口。外观全靠酒馆快捷回复自带的 .qr--button 类，而它的样式挂在祖先选择器
// #qr--bar > .qr--buttons 上，所以按钮必须落在这个结构里：有 #qr--bar 就复用，没有（没装 / 关了快捷
// 回复）就自建一条同款，打上 so-qr-bar 标记，撤按钮时一并回收。快捷回复在换聊天 / 改设置时会整条
// 重建 #qr--bar、把按钮冲掉，故用 MutationObserver 盯住 #send_form 补回（同柏宝书 / JS-Slash-Runner）。
const SO_QR_BAR_CLASS = 'so-qr-bar';



function injectQrButton() {
    const form = document.getElementById('send_form');
    if (!form) return false;
    if (soEntryIsLive('so-qr-button', form)) return true;
    soDropEntries('so-qr-button');
    // id 理应唯一，但别的扩展可能也自建过一条——按属性找、只认 #send_form 里的
    let bar = [...form.querySelectorAll('div')].find((d) => d.id === 'qr--bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'qr--bar';
        bar.className = SO_QR_BAR_CLASS + ' flex-container flexGap5';
        form.prepend(bar);
    }
    let holder = bar.querySelector('.qr--buttons');
    if (!holder) {
        holder = document.createElement('div');
        holder.className = 'qr--buttons';
        bar.appendChild(holder);
    }
    const btn = document.createElement('div');
    btn.id = 'so-qr-button';
    btn.className = 'qr--button menu_button interactable';
    btn.tabIndex = 0;
    btn.title = '剧情推进 —— 点击开 / 关窗口';
    btn.textContent = '剧情推进';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleWindow(); });
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWindow(); }
    });
    holder.appendChild(soMarkEntryLive(btn));
    return true;
}
function removeQrButton() {
    soDropEntries('so-qr-button');
    // 自建的那条（原本没有快捷回复栏）撤完按钮若已空就一并收走，别留一条空栏
    const bar = document.querySelector('#qr--bar.' + SO_QR_BAR_CLASS);
    const holder = bar && bar.querySelector('.qr--buttons');
    if (bar && (!holder || !holder.children.length)) bar.remove();
}
function watchQrBar() {
    const form = document.getElementById('send_form');
    if (!form || typeof MutationObserver !== 'function') return;
    if (soQrObserver && soQrObservedForm === form) return;
    if (soQrObserver) soQrObserver.disconnect();
    soQrObservedForm = form;
    soQrObserver = new MutationObserver(() => {
        // 我们自己插按钮也会触发一次回调——那时按钮已活着，O(1) 早返回，不会自激
        if (getSettings().showQrButton && !soEntryIsLive('so-qr-button', form)) injectQrButton();
    });
    soQrObserver.observe(form, { childList: true, subtree: true });
}
// 按设置放 / 撤（init、设置勾选、楼层渲染与换聊天事件都会调；按钮活着时不碰 DOM）。
export function syncQrButton() {
    if (soQrPoll) { clearInterval(soQrPoll); soQrPoll = null; }
    if (!getSettings().showQrButton) {
        if (soQrObserver) { soQrObserver.disconnect(); soQrObserver = null; soQrObservedForm = null; }
        removeQrButton();
        return;
    }
    if (injectQrButton()) { watchQrBar(); return; }
    // 输入区是懒加载的：每 0.5 秒等一次，最多约 20 秒；等不到就算了，之后的渲染 / 换聊天事件还会再补
    let tries = 0;
    soQrPoll = setInterval(() => {
        if (injectQrButton() || ++tries > 40) {
            clearInterval(soQrPoll);
            soQrPoll = null;
            if (document.getElementById('so-qr-button')) watchQrBar();
        }
    }, 500);
}