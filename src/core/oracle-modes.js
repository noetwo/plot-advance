export let diagnoseMode = false;
export let lorebookMode = false;
export let advisorMode = false;
export let fixMode = false;
export let builderMode = false;
export let priorOracleMode = 'chat';

export function activateOracleMode(mode) {
    diagnoseMode = mode === 'diagnose';
    lorebookMode = mode === 'lorebook';
    advisorMode = mode === 'advisor';
    fixMode = mode === 'fix';
    builderMode = mode === 'builder';
}

export function rememberPriorOracleMode(mode) {
    priorOracleMode = mode;
}

export function resetPriorOracleMode() {
    priorOracleMode = 'chat';
}
