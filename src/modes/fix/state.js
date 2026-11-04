// fix 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let fixTargetIdx = -1;
export function setFixTargetIdx(value) { fixTargetIdx = value; return fixTargetIdx; }

export let fixOriginalReply = '';
export function setFixOriginalReply(value) { fixOriginalReply = value; return fixOriginalReply; }

export let fixTargetProse = '';
export function setFixTargetProse(value) { fixTargetProse = value; return fixTargetProse; }

export let fixCardBlock = '';
export function setFixCardBlock(value) { fixCardBlock = value; return fixCardBlock; }

export let fixContextBlock = '';
export function setFixContextBlock(value) { fixContextBlock = value; return fixContextBlock; }

export let fixWorldBlock = '';
export function setFixWorldBlock(value) { fixWorldBlock = value; return fixWorldBlock; }

export let fixSummaryBlock = '';
export function setFixSummaryBlock(value) { fixSummaryBlock = value; return fixSummaryBlock; }

export let fixExtraKeep = [];
export function setFixExtraKeep(value) { fixExtraKeep = value; return fixExtraKeep; }

export let fixThinkProtected = 0;
export function setFixThinkProtected(value) { fixThinkProtected = value; return fixThinkProtected; }

export let fixScope = { active: false };
export function setFixScope(value) { fixScope = value; return fixScope; }

export let fixScopeDecision = null;
export function setFixScopeDecision(value) { fixScopeDecision = value; return fixScopeDecision; }

export let fixPieceDecision = null;
export function setFixPieceDecision(value) { fixPieceDecision = value; return fixPieceDecision; }

export let fixPieceTable = null;
export function setFixPieceTable(value) { fixPieceTable = value; return fixPieceTable; }

export let fixCustomJoin = null;
export function setFixCustomJoin(value) { fixCustomJoin = value; return fixCustomJoin; }

export let fixCaptured = null;
export function setFixCaptured(value) { fixCaptured = value; return fixCaptured; }

export let fixActiveMode = 'manual';
export function setFixActiveMode(value) { fixActiveMode = value; return fixActiveMode; }

export let fixCustomTemplateText = '';
export function setFixCustomTemplateText(value) { fixCustomTemplateText = value; return fixCustomTemplateText; }

export let fixTplDirty = false;
export function setFixTplDirty(value) { fixTplDirty = value; return fixTplDirty; }

export let fixTplDirtyFor = '';
export function setFixTplDirtyFor(value) { fixTplDirtyFor = value; return fixTplDirtyFor; }

export let fixAutoPromptVersion = 'light';
export function setFixAutoPromptVersion(value) { fixAutoPromptVersion = value; return fixAutoPromptVersion; }

export let fixAutoPromptFlavor = 'deepseek';
export function setFixAutoPromptFlavor(value) { fixAutoPromptFlavor = value; return fixAutoPromptFlavor; }

export let fixChatSelSnap = null;
export function setFixChatSelSnap(value) { fixChatSelSnap = value; return fixChatSelSnap; }

export let fixSelState = null;
export function setFixSelState(value) { fixSelState = value; return fixSelState; }

export let fixSelCard = null;
export function setFixSelCard(value) { fixSelCard = value; return fixSelCard; }

export let fixSelStored = null;
export function setFixSelStored(value) { fixSelStored = value; return fixSelStored; }

export let fixSelMode = 'drag';
export function setFixSelMode(value) { fixSelMode = value; return fixSelMode; }

export let fixSelExpandArmed = false;
export function setFixSelExpandArmed(value) { fixSelExpandArmed = value; return fixSelExpandArmed; }

export let fixSelDebug = false;
export function setFixSelDebug(value) { fixSelDebug = value; return fixSelDebug; }

export let fixSelDebugLines = [];
export function setFixSelDebugLines(value) { fixSelDebugLines = value; return fixSelDebugLines; }

export let fixSelGate = { down: null, lastScrollAt: -1e9, active: new Set() };
export function setFixSelGate(value) { fixSelGate = value; return fixSelGate; }

export let fixSelSegOk = false;
export function setFixSelSegOk(value) { fixSelSegOk = value; return fixSelSegOk; }

export let fixHubSkipWarned = false;
export function setFixHubSkipWarned(value) { fixHubSkipWarned = value; return fixHubSkipWarned; }

export let fixHubState = { lib: null, source: '', fetchedAt: 0, tag: '', q: '', open: new Set(), pending: '' };
export function setFixHubState(value) { fixHubState = value; return fixHubState; }

export let fixShareOpenSeq = 0;
export function setFixShareOpenSeq(value) { fixShareOpenSeq = value; return fixShareOpenSeq; }
export function nextFixShareOpenSeq() { return ++fixShareOpenSeq; }

export let fixSelSegmenterCache = null;
export function setFixSelSegmenterCache(value) { fixSelSegmenterCache = value; return fixSelSegmenterCache; }
