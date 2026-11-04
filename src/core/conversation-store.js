export let convo = [];
export let cidSeq = 0;
export let convoStreamKey = 'main';

export function replaceConvo(messages) {
    convo = messages;
    return convo;
}
export function appendConvo(entry) {
    convo.push(entry);
    return entry;
}

export function removeConvoRange(start, count) {
    return arguments.length > 1 ? convo.splice(start, count) : convo.splice(start);
}

export function ensureCidSeqAtLeast(value) {
    cidSeq = Math.max(cidSeq, Number(value) || 0);
    return cidSeq;
}

export function nextCid() {
    return ++cidSeq;
}

export function selectConvoStream(streamKey) {
    convoStreamKey = streamKey;
    return convoStreamKey;
}
