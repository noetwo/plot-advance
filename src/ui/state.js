// ui 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let settingsTab = 'conn';
export function setSettingsTab(value) { settingsTab = value; return settingsTab; }

export let promptEditId = 'chat.system';
export function setPromptEditId(value) { promptEditId = value; return promptEditId; }

export let qpMenuOpen = false;
export function setQpMenuOpen(value) { qpMenuOpen = value; return qpMenuOpen; }

export let qpManageMode = null;
export function setQpManageMode(value) { qpManageMode = value; return qpManageMode; }

export let modelMenuOpen = false;
export function setModelMenuOpen(value) { modelMenuOpen = value; return modelMenuOpen; }

export let soFollowStream = false;
export function setSoFollowStream(value) { soFollowStream = value; return soFollowStream; }

export let soBulkRenderDepth = 0;
export function setSoBulkRenderDepth(value) { soBulkRenderDepth = value; return soBulkRenderDepth; }
export function incrementSoBulkRenderDepth() { return soBulkRenderDepth++; }
export function decrementSoBulkRenderDepth() { return soBulkRenderDepth--; }

export let fixSelBarObserver = null;
export function setFixSelBarObserver(value) { fixSelBarObserver = value; return fixSelBarObserver; }

export let fixSelBarTimer = null;
export function setFixSelBarTimer(value) { fixSelBarTimer = value; return fixSelBarTimer; }

export let soQrObserver = null;
export function setSoQrObserver(value) { soQrObserver = value; return soQrObserver; }

export let soQrObservedForm = null;
export function setSoQrObservedForm(value) { soQrObservedForm = value; return soQrObservedForm; }

export let soQrPoll = null;
export function setSoQrPoll(value) { soQrPoll = value; return soQrPoll; }

export let _soPreFsGeom = null;
export function setSoPreFsGeom(value) { _soPreFsGeom = value; return _soPreFsGeom; }

export let _ensureInViewPending = false;
export function setEnsureInViewPending(value) { _ensureInViewPending = value; return _ensureInViewPending; }

export let curationState = null;
export function setCurationState(value) { curationState = value; return curationState; }

export let connPickerOpen = false;
export function setConnPickerOpen(value) { connPickerOpen = value; return connPickerOpen; }

export let connPickerQuery = '';
export function setConnPickerQuery(value) { connPickerQuery = value; return connPickerQuery; }

export let promptGroup = null;
export function setPromptGroup(value) { promptGroup = value; return promptGroup; }

export let promptEditorOpen = false;
export function setPromptEditorOpen(value) { promptEditorOpen = value; return promptEditorOpen; }

export let win = undefined;
export function setWin(value) { win = value; return win; }

export let messagesEl = undefined;
export function setMessagesEl(value) { messagesEl = value; return messagesEl; }

export let inputEl = undefined;
export function setInputEl(value) { inputEl = value; return inputEl; }

export let sendBtn = undefined;
export function setSendBtn(value) { sendBtn = value; return sendBtn; }

export let modeBadge = undefined;
export function setModeBadge(value) { modeBadge = value; return modeBadge; }

export let peFleshAbort = null;
export function setPeFleshAbort(value) { peFleshAbort = value; return peFleshAbort; }

export let peFleshUndo = null;
export function setPeFleshUndo(value) { peFleshUndo = value; return peFleshUndo; }
