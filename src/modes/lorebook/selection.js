export let lbEntryFilter = {};

export function serializeEntrySel(filter) {
    const out = {};
    for (const [book, sel] of Object.entries(filter || {})) {
        if (sel instanceof Set) out[book] = [...sel].sort((a, b) => a - b);
    }
    return out;
}

export function hydrateLorebookEntrySelection(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [book, uids] of Object.entries(saved)) {
        if (Array.isArray(uids)) lbEntryFilter[book] = new Set(uids);
    }
}

export function selectLorebookEntries(book, selection) {
    lbEntryFilter[book] = selection;
}

export function selectLorebookEntry(book, uid, checked, allUids) {
    let selected = lbEntryFilter[book];
    if (!(selected instanceof Set)) selected = new Set(allUids);
    if (checked) selected.add(uid); else selected.delete(uid);
    lbEntryFilter[book] = selected;
}

export function pruneLorebookEntrySelection(book, validUids) {
    const selected = lbEntryFilter[book];
    if (!(selected instanceof Set)) return false;
    const valid = new Set(validUids);
    const kept = new Set([...selected].filter((uid) => valid.has(uid)));
    if (kept.size === selected.size) return false;
    lbEntryFilter[book] = kept;
    return true;
}

export function replaceLorebookEntrySelection(selection) {
    for (const book of Object.keys(lbEntryFilter)) delete lbEntryFilter[book];
    for (const [book, value] of Object.entries(selection || {})) {
        lbEntryFilter[book] = value;
    }
}

export function filterBookEntries(listSelector, query, onFiltered, root) {
    const needle = (query || '').trim().toLowerCase();
    const list = root?.querySelector(listSelector);
    if (!list) return;
    for (const row of list.querySelectorAll('.pad-lb-ent')) {
        row.style.display = (!needle || (row.dataset.hay || '').includes(needle)) ? '' : 'none';
    }
    // Hide a book header (+ its "empty" sub-line) when none of its rows are visible.
    for (const head of list.querySelectorAll('.pad-lb-book-head, .pad-lb-ent-empty-sub')) {
        if (!needle) { head.style.display = ''; continue; }
        const book = head.dataset.book || '';
        const headMatches = (head.dataset.hay || '').includes(needle);
        const anyRowVisible = [...list.querySelectorAll('.pad-lb-ent')]
            .some((row) => (row.dataset.book || '') === book && row.style.display !== 'none');
        head.style.display = (headMatches || anyRowVisible) ? '' : 'none';
    }
    if (typeof onFiltered === 'function') onFiltered();
}
