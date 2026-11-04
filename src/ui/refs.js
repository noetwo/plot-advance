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
    messagesEl = win.querySelector('#so-messages');
    inputEl = win.querySelector('#so-input');
    sendBtn = win.querySelector('#so-send');
    modeBadge = win.querySelector('#so-mode-badge');
}
