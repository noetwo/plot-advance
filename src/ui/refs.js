// 主窗口节点由 buildWindow 在建窗时登记；其余模块只读取这些 ESM 活绑定。
export let win;
export let messagesEl;
export let inputEl;
export let sendBtn;
export let modeBadge;

export function registerWindowRoot(element) {
    win = element;
}

export function registerWindowControls() {
    messagesEl = win.querySelector('#pad-messages');
    inputEl = win.querySelector('#pad-input');
    sendBtn = win.querySelector('#pad-send');
    modeBadge = win.querySelector('#pad-mode-badge');
}
