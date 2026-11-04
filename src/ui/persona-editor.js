import { soCallModel } from '../bootstrap.js';
import { getSettings, save, uiConfirm } from '../core/settings.js';
import { CUSTOM_PERSONA_CAPS, ENABLE_CUSTOM_PERSONAS, PERSONAS } from '../prompts/builtins.js';
import { allPersonasView, buildPersonaFleshMessages, findPersonaById, parsePersonaFleshReply } from '../prompts/helpers.js';
import { win } from './refs.js';

let fleshAbort = null;
let fleshUndo = null;

function personaEditorElements() {
    return {
        editor: win.querySelector('#so-persona-editor'),
        sel: win.querySelector('#so-pe-sel'),
        name: win.querySelector('#so-pe-name'),
        voice: win.querySelector('#so-pe-voice'),
        example: win.querySelector('#so-pe-example'),
        flesh: win.querySelector('#so-pe-flesh'),
        undo: win.querySelector('#so-pe-undo'),
        save: win.querySelector('#so-pe-save'),
        del: win.querySelector('#so-pe-del'),
    };
}

function populatePersonaEditorSelect(keepId) {
    const elements = personaEditorElements();
    if (!elements.sel) return;
    elements.sel.innerHTML = '';
    const newOption = document.createElement('option');
    newOption.value = '';
    newOption.textContent = '＋ 新建人格';
    elements.sel.appendChild(newOption);
    for (const persona of getSettings().customPersonas) {
        const option = document.createElement('option');
        option.value = persona.id;
        option.textContent = persona.label;
        elements.sel.appendChild(option);
    }
    elements.sel.value = (keepId && getSettings().customPersonas.some((persona) => persona.id === keepId)) ? keepId : '';
}

function loadPersonaEditorFields() {
    const elements = personaEditorElements();
    const current = findPersonaById(getSettings().customPersonas, elements.sel.value);
    elements.name.value = current ? current.label : '';
    elements.voice.value = current ? current.voice : '';
    elements.example.value = current ? (current.example || '') : '';
    fleshUndo = null;
    elements.undo.style.display = 'none';
    elements.del.style.display = current ? '' : 'none';
}

function openPersonaEditor() {
    if (!ENABLE_CUSTOM_PERSONAS) return;
    const elements = personaEditorElements();
    if (!elements.editor) return;
    if (elements.editor.style.display !== 'none') {
        elements.editor.style.display = 'none';
        fleshUndo = null;
        return;
    }
    elements.editor.style.display = '';
    const settings = getSettings();
    const currentIsCustom = settings.customPersonas.some((persona) => persona.id === settings.personaId);
    populatePersonaEditorSelect(currentIsCustom ? settings.personaId : '');
    loadPersonaEditorFields();
}

function savePersonaFromEditor() {
    const elements = personaEditorElements();
    const settings = getSettings();
    const name = elements.name.value.trim();
    const voice = elements.voice.value.trim();
    const example = elements.example.value.trim();
    if (!name || !voice) { toastr.info('名称与人格描述都不能为空'); return; }
    if (voice.length > CUSTOM_PERSONA_CAPS.voice) { toastr.info(`人格描述最长 ${CUSTOM_PERSONA_CAPS.voice} 字`); return; }
    if (example.length > CUSTOM_PERSONA_CAPS.example) { toastr.info(`示例对话最长 ${CUSTOM_PERSONA_CAPS.example} 字`); return; }
    const editingId = elements.sel.value;
    const nameTaken = allPersonasView(settings).some((persona) => persona.id !== editingId && persona.label.toLowerCase() === name.toLowerCase());
    if (nameTaken) { toastr.info('已有同名人格，换个名字吧'); return; }
    let id = editingId;
    if (editingId) {
        const current = findPersonaById(settings.customPersonas, editingId);
        if (!current) { toastr.warning('要编辑的人格不存在了'); populatePersonaEditorSelect(''); loadPersonaEditorFields(); return; }
        current.label = name;
        current.voice = voice;
        current.example = example;
    } else {
        if (settings.customPersonas.length >= CUSTOM_PERSONA_CAPS.count) {
            toastr.info(`自定义人格最多 ${CUSTOM_PERSONA_CAPS.count} 个，先删一个吧`);
            return;
        }
        id = 'cp-' + Date.now();
        settings.customPersonas.push({ id, label: name, voice, example });
        settings.personaId = id;
    }
    save();
    populatePersonas();
    populatePersonaEditorSelect(id);
    loadPersonaEditorFields();
    toastr.success(`已保存人格「${name}」`);
}

async function deletePersonaFromEditor() {
    const elements = personaEditorElements();
    const settings = getSettings();
    const current = findPersonaById(settings.customPersonas, elements.sel.value);
    if (!current) { toastr.info('先选一个要删的自定义人格'); return; }
    if (!(await uiConfirm(`删除自定义人格「${current.label}」？`))) return;
    settings.customPersonas = settings.customPersonas.filter((persona) => persona.id !== current.id);
    if (settings.personaId === current.id) settings.personaId = 'plain';
    save();
    populatePersonas();
    populatePersonaEditorSelect('');
    loadPersonaEditorFields();
    toastr.success(`已删除人格「${current.label}」`);
}

async function fleshPersonaFromEditor() {
    const elements = personaEditorElements();
    if (fleshAbort) { fleshAbort.abort(); return; }
    const name = elements.name.value.trim();
    const seedText = elements.voice.value.trim();
    if (!name && !seedText) { toastr.info('先写一两句想要的感觉（名称或描述任填其一）'); return; }
    fleshUndo = { voice: elements.voice.value, example: elements.example.value };
    const controller = new AbortController();
    fleshAbort = controller;
    const timer = setTimeout(() => controller.abort(), 120000);
    const previousLabel = elements.flesh.textContent;
    elements.flesh.textContent = '⏹ 取消';
    elements.save.disabled = true;
    elements.del.disabled = true;
    try {
        const settings = getSettings();
        const reply = await soCallModel(buildPersonaFleshMessages(name, seedText), {
            maxTokens: Math.max(Number(settings.maxTokens) || 0, 4096),
            signal: controller.signal,
        });
        const parsed = parsePersonaFleshReply(reply);
        if (!parsed.voice) { toastr.warning('模型没有返回可用内容'); fleshUndo = null; return; }
        elements.voice.value = parsed.voice;
        if (parsed.example) elements.example.value = parsed.example;
        elements.undo.style.display = '';
        if (parsed.fallback) toastr.info('回复格式不标准，已原样填入（可手动修剪）');
    } catch (error) {
        if (!controller.signal.aborted) toastr.error('扩写失败：' + ((error && error.message) || error));
        fleshUndo = null;
    } finally {
        clearTimeout(timer);
        fleshAbort = null;
        elements.flesh.textContent = previousLabel;
        elements.save.disabled = false;
        elements.del.disabled = false;
    }
}

export function bindPersonaEditor() {
    if (!ENABLE_CUSTOM_PERSONAS) return;
    win.querySelector('#so-persona-edit')?.addEventListener('click', openPersonaEditor);
    win.querySelector('#so-pe-sel')?.addEventListener('change', loadPersonaEditorFields);
    win.querySelector('#so-pe-save')?.addEventListener('click', savePersonaFromEditor);
    win.querySelector('#so-pe-del')?.addEventListener('click', deletePersonaFromEditor);
    win.querySelector('#so-pe-flesh')?.addEventListener('click', fleshPersonaFromEditor);
    win.querySelector('#so-pe-undo')?.addEventListener('click', () => {
        const elements = personaEditorElements();
        if (!fleshUndo) return;
        elements.voice.value = fleshUndo.voice;
        elements.example.value = fleshUndo.example;
        fleshUndo = null;
        elements.undo.style.display = 'none';
    });
}

export function populatePersonas() {
    const select = win.querySelector('#so-persona');
    if (!select) return;
    select.innerHTML = '';
    for (const persona of PERSONAS) {
        const option = document.createElement('option');
        option.value = persona.id;
        option.textContent = persona.label;
        select.appendChild(option);
    }
    const settings = getSettings();
    const customPersonas = allPersonasView(settings).filter((persona) => persona.custom);
    if (customPersonas.length) {
        const group = document.createElement('optgroup');
        group.label = '── 自定义 ──';
        for (const persona of customPersonas) {
            const option = document.createElement('option');
            option.value = persona.id;
            option.textContent = persona.label;
            group.appendChild(option);
        }
        select.appendChild(group);
    }
    select.value = findPersonaById(allPersonasView(settings), settings.personaId) ? settings.personaId : 'plain';
}
