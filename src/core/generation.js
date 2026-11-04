let generationStateObserver = null;

export let isGenerating = false;
export let abortCtl = null;
export let liveForge = null;
export let liveCondense = null;

function publishGenerationState() {
    if (generationStateObserver) generationStateObserver(isGenerating);
}

// UI 在窗口建好后登记一次；控制器本身不依赖 DOM。
export function observeGenerationState(observer) {
    generationStateObserver = typeof observer === 'function' ? observer : null;
    publishGenerationState();
}

// 开始一轮前调用；返回的 controller 也是当前停止按钮唯一会中止的 controller。
export function beginGeneration() {
    abortCtl = new AbortController();
    isGenerating = true;
    publishGenerationState();
    return abortCtl;
}

// 保留旧 finally 的无条件释放语义：调用者结束时总是放下生成锁并清空当前 controller。
export function finishGeneration() {
    isGenerating = false;
    abortCtl = null;
    publishGenerationState();
}

export function stopGeneration() {
    try { abortCtl?.abort(); } catch (e) { /* ignore */ }
}

export function registerLiveForge(run) {
    liveForge = run;
    return liveForge;
}

export function clearLiveForge(expectedRun) {
    if (arguments.length === 0 || liveForge === expectedRun) liveForge = null;
}

export function registerLiveCondense(run) {
    liveCondense = run;
    return liveCondense;
}

export function clearLiveCondense(expectedRun) {
    if (arguments.length === 0 || liveCondense === expectedRun) liveCondense = null;
}

// 切聊天 / 清空房间沿用旧语义：两种后台保活槽都无条件作废。
export function clearLiveGenerations() {
    liveForge = null;
    liveCondense = null;
}
