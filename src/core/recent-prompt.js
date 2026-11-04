export let lastPrompt = null;
export let lastPromptMeta = null;

export function recordLastPrompt(prompt, meta = lastPromptMeta) {
    lastPrompt = prompt;
    lastPromptMeta = meta;
    return lastPrompt;
}
