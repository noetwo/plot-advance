import { sendBtn } from './refs.js';

export function renderGenerationState(on) {
    if (!sendBtn) return;
    sendBtn.innerHTML = on ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>';
    sendBtn.title = on ? '停止' : '发送';
    sendBtn.classList.toggle('so-generating', on);
}
