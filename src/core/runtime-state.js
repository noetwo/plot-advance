// core 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let convoStreamKey = 'main';
export function setConvoStreamKey(value) { convoStreamKey = value; return convoStreamKey; }

export let postReplyBusy = false;
export function setPostReplyBusy(value) { postReplyBusy = value; return postReplyBusy; }

export let autoDiagErrorToasted = false;
export function setAutoDiagErrorToasted(value) { autoDiagErrorToasted = value; return autoDiagErrorToasted; }

export let postReplyAbortCtl = null;
export function setPostReplyAbortCtl(value) { postReplyAbortCtl = value; return postReplyAbortCtl; }

export let postReplyCancelled = false;
export function setPostReplyCancelled(value) { postReplyCancelled = value; return postReplyCancelled; }

export let activePostReplyRun = null;
export function setActivePostReplyRun(value) { activePostReplyRun = value; return activePostReplyRun; }

export let pendingPostReplyRun = null;
export function setPendingPostReplyRun(value) { pendingPostReplyRun = value; return pendingPostReplyRun; }

export let convo = [];
export function setConvo(value) { convo = value; return convo; }

export let cidSeq = 0;
export function setCidSeq(value) { cidSeq = value; return cidSeq; }
export function nextCid() { return ++cidSeq; }

export let isGenerating = false;
export function setIsGenerating(value) { isGenerating = value; return isGenerating; }

export let abortCtl = null;
export function setAbortCtl(value) { abortCtl = value; return abortCtl; }

export let liveForge = null;
export function setLiveForge(value) { liveForge = value; return liveForge; }

export let liveCondense = null;
export function setLiveCondense(value) { liveCondense = value; return liveCondense; }

export let diagnoseMode = false;
export function setDiagnoseMode(value) { diagnoseMode = value; return diagnoseMode; }

export let lorebookMode = false;
export function setLorebookMode(value) { lorebookMode = value; return lorebookMode; }

export let advisorMode = false;
export function setAdvisorMode(value) { advisorMode = value; return advisorMode; }

export let fixMode = false;
export function setFixMode(value) { fixMode = value; return fixMode; }

export let builderMode = false;
export function setBuilderMode(value) { builderMode = value; return builderMode; }

export let priorOracleMode = 'chat';
export function setPriorOracleMode(value) { priorOracleMode = value; return priorOracleMode; }

export let lastPrompt = null;
export function setLastPrompt(value) { lastPrompt = value; return lastPrompt; }

export let lastPromptMeta = null;
export function setLastPromptMeta(value) { lastPromptMeta = value; return lastPromptMeta; }
