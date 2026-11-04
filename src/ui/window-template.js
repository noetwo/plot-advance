import { ENABLE_AUTO_DIAGNOSE, ENABLE_BBS_BRIDGE, ENABLE_CHAR_BUILDER, ENABLE_CUSTOM_PERSONAS, ENABLE_DIAG_BODY_INJECT, ENABLE_FIXSEL_CHAT_ENTRY, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_SELECT, ENABLE_FIX_TEMPLATE_HUB, ENABLE_LWB_BRIDGE, ENABLE_MVU_EDITOR, ENABLE_SCHEMA_DIAG, ENABLE_WI_CUSTOM_PICK, ENABLE_WI_EJS_RENDER } from '../prompts/builtins.js';

export function applyWindowMarkup(win) {
    win.innerHTML = `
        <div id="pad-header">
            <div id="pad-title"><i class="fa-solid fa-moon"></i> 剧情推进 <span id="pad-mode-badge"></span><span id="pad-diag-pill">诊断</span><span id="pad-lb-pill">世界书</span><span id="pad-adv-pill">参谋</span></div>
            <div id="pad-header-btns">
                <div class="pad-iconbtn" id="pad-advisor-btn" title="剧情参谋 —— 构思新剧情走向，并引导主线靠近它"><i class="fa-solid fa-compass"></i></div>
                <div class="pad-iconbtn" id="pad-lorebook-btn" title="世界书模式 —— 聊聊或修改世界书"><i class="fa-solid fa-book"></i></div>
                <div class="pad-iconbtn" id="pad-diagnose-btn" title="诊断模式 —— 修复 MVU 状态变量（再点一次开启自动模式）"><i class="fa-solid fa-stethoscope"></i><span class="pad-auto-tag">A</span></div>
                <div class="pad-iconbtn" id="pad-fix-btn" title="校正模式 —— 修一修最新这条回复（AI 味 / 对话 / 设定 / 详略…），应用后原文仍在"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                <span class="pad-hdr-div" aria-hidden="true"></span>
                <div class="pad-tools-wrap">
                    <div class="pad-iconbtn" id="pad-tools-btn" aria-haspopup="true" aria-expanded="false" title="更多 —— 剧情概要 / 调试提示词 / 设置"><i class="fa-solid fa-ellipsis"></i></div>
                    <div id="pad-tools-menu" aria-label="更多工具">
                        <div class="pad-iconbtn pad-tools-item" id="pad-normalchat-btn" title="回到普通聊天（自动诊断如已开启会继续在后台运行）"><i class="fa-solid fa-comment"></i><span>普通聊天</span></div>
                        <div class="pad-iconbtn pad-tools-item" id="pad-summary-btn" title="剧情概要 —— 粘贴你的运行总结 / 前情提要，剧情推进会在最近对话前读到它"><i class="fa-solid fa-scroll"></i><span>剧情概要</span></div>
                        <div class="pad-iconbtn pad-tools-item" id="pad-debug-btn" title="查看上一次发送的提示词"><i class="fa-solid fa-bug"></i><span>调试提示词</span></div>
                        ${ENABLE_CHAR_BUILDER ? '<div class="pad-iconbtn pad-tools-item" id="pad-builder-btn" title="角色工坊 —— 和我一起打造 / 完善一个角色，写进 Persona 或世界书"><i class="fa-solid fa-masks-theater"></i><span>角色工坊</span></div>' : ''}
                        <div class="pad-iconbtn pad-tools-item" id="pad-settings-btn" title="设置"><i class="fa-solid fa-gear"></i><span>设置</span></div>
                    </div>
                </div>
                <span class="pad-hdr-div" aria-hidden="true"></span>
                <div class="pad-iconbtn" id="pad-clear-btn" title="清空对话"><i class="fa-solid fa-trash-can"></i></div>
                <div class="pad-iconbtn" id="pad-fullscreen-btn" title="全屏" aria-label="全屏" aria-pressed="false"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></div>
                <div class="pad-iconbtn" id="pad-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>

        <div id="pad-settings" class="pad-tabbed">
            <div class="pad-set-tabbar" role="tablist">
                <button type="button" class="pad-set-tab" data-tab="conn" role="tab"><i class="fa-solid fa-plug"></i>连接</button>
                <button type="button" class="pad-set-tab" data-tab="ctx" role="tab"><i class="fa-solid fa-layer-group"></i>上下文</button>
                <button type="button" class="pad-set-tab" data-tab="persona" role="tab"><i class="fa-solid fa-masks-theater"></i>人格</button>
                <button type="button" class="pad-set-tab" data-tab="prompt" role="tab"><i class="fa-solid fa-file-pen"></i>提示词</button>
                <button type="button" class="pad-set-tab" data-tab="qp" role="tab"><i class="fa-solid fa-bolt"></i>快捷指令</button>
                <button type="button" class="pad-set-tab" data-tab="ui" role="tab"><i class="fa-solid fa-palette"></i>界面</button>
                <span class="pad-set-tabbar-spacer"></span>
                <button type="button" class="pad-icon-btn" id="pad-settings-close" title="关闭设置，回到聊天"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="pad-set-page" data-tab="conn" role="tabpanel">
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-bookmark"></i>连接存档<span class="pad-set-title-aside">输入框上方也能一键切换</span></div>
                    <div class="pad-preset-list" id="pad-conn-preset-list"></div>
                    <div class="pad-preset-add">
                        <input id="pad-conn-preset-name" type="text" placeholder="给当前连接起个名字">
                        <button type="button" class="pad-mini-btn" id="pad-conn-preset-save">存为新存档</button>
                    </div>
                    <div class="pad-hint">存档记下端点、密钥、模型，以及下面的高级选项和生成参数，切换存档时一起换。</div>
                </div>
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-plug"></i>当前连接</div>
                    <div class="pad-seg" id="pad-mode-seg">
                        <button type="button" data-mode="direct">直连（自定义地址）</button>
                        <button type="button" data-mode="profile">酒馆连接配置文件</button>
                    </div>
                    <select id="pad-mode" hidden>
                        <option value="direct">直连（自定义 URL）</option>
                        <option value="profile">连接配置文件</option>
                    </select>
                    <div id="pad-direct-fields" class="pad-set-stack">
                        <label class="pad-field"><span>端点 URL</span>
                            <input id="pad-endpoint" type="text" placeholder="https://your-proxy.com/v1">
                        </label>
                        <label class="pad-field"><span>API 密钥</span>
                            <input id="pad-apikey" type="password" placeholder="sk-...">
                        </label>
                        <label class="pad-field"><span>模型</span>
                            <div class="pad-model-row">
                                <input id="pad-model" type="text" placeholder="gpt-4o-mini">
                                <div class="pad-iconbtn" id="pad-model-fetch" title="从服务商获取可用模型列表"><i class="fa-solid fa-cloud-arrow-down"></i></div>
                            </div>
                            <select id="pad-model-list" style="display:none"></select>
                            <div class="pad-hint" id="pad-model-hint"></div>
                        </label>
                    </div>
                    <div id="pad-profile-fields" class="pad-set-stack">
                        <label class="pad-field"><span>配置文件</span>
                            <div class="pad-profile-row">
                                <select id="pad-profile"></select>
                                <div class="pad-iconbtn" id="pad-profile-refresh" title="刷新配置文件列表"><i class="fa-solid fa-rotate-right"></i></div>
                            </div>
                        </label>
                        <div class="pad-hint" id="pad-profile-hint">使用酒馆里保存的连接配置文件，经酒馆服务器转发（无 CORS 问题）。</div>
                    </div>
                    <details class="pad-adv-fold"><summary>高级选项（跨域转发、原样地址、附加参数）</summary><div class="pad-adv-fold-body">
                        <div id="pad-direct-adv" class="pad-set-stack">
                            <div class="pad-opt"><label class="pad-check" title="打开后，直连请求改由酒馆服务器代发——避免浏览器跨域(CORS)，用的还是上面这个端点和密钥。"><input id="pad-direct-backend" type="checkbox"><span>经酒馆后端转发</span></label><div class="pad-hint">直连报 <b>CORS / failed to fetch</b> 时勾上，改由酒馆服务器代发；获取模型也一样。</div></div>
                            <div class="pad-opt"><label class="pad-check" title="打开后，填什么地址就用什么地址：不再自动补 /v1，请求直接打到 地址/chat/completions（获取模型打到 地址/models）。"><input id="pad-raw-url" type="checkbox"><span>地址原样使用（不自动补 /v1）</span></label><div class="pad-hint">地址明明填对了却 404 / 拉不到模型时勾上，常和上面的转发一起用。</div></div>
                        </div>
                        <label class="pad-row" title="像 ST「自定义（兼容 OpenAI）」接口的「附加参数」面板：给每次请求附加 / 剔除自定义参数、附加请求头（YAML 或 JSON）——例如给 DeepSeek 类中转关掉思维链。">
                            <span>附加参数</span>
                            <div class="pad-iconbtn" id="pad-extraparams-btn" title="打开附加参数设置"><i class="fa-solid fa-sliders"></i></div>
                        </label>
                        <div class="pad-hint" id="pad-extraparams-hint"></div>
                    </div></details>
                </div>
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-sliders"></i>生成参数<span class="pad-set-title-aside">随连接存档保存</span></div>
                    <div class="pad-grid2">
                        <label class="pad-field"><span>温度</span>
                            <input id="pad-temp" type="number" step="0.05" min="0" max="2">
                        </label>
                        <label class="pad-field"><span>最大 tokens 数</span>
                            <input id="pad-maxtok" type="number" step="50" min="1">
                        </label>
                    </div>
                    <label class="pad-check"><input id="pad-stream" type="checkbox"><span>流式输出</span></label>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-sendtemp" type="checkbox"><span>发送温度参数</span></label><div class="pad-hint">个别模型拒收温度参数时关掉。</div></div>
                </div>
            </div>

            <div class="pad-set-page" data-tab="ctx" role="tabpanel">
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-comments"></i>对话记录</div>
                    <label class="pad-field"><span>读取最近多少条（-1 全部，0 不读）</span>
                        <input id="pad-depth" type="number" step="1" min="-1">
                    </label>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-hidden" type="checkbox"><span>读取隐藏楼层</span></label><div class="pad-hint">被 /hide 隐藏的消息也读进来（不影响世界书关键词扫描）。</div></div>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-regex" type="checkbox"><span>应用剧情正则</span></label><div class="pad-hint">和主聊天一样剥掉思维链、状态栏，使用总结。</div></div>
                </div>
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-id-card"></i>角色与状态</div>
                    <label class="pad-check"><input id="pad-card" type="checkbox"><span>角色卡（描述 / 性格 / 场景）</span></label>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-stat" type="checkbox"><span>变量状态（MVU）</span></label><div class="pad-hint">普通聊天问数值时以它为准；关掉则如实说看不到。参谋始终会读。</div></div>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-world" type="checkbox"><span>世界引擎的后台世界状态</span></label><div class="pad-hint">目前只适配世界引擎（World Engine）；数据较大、比较费 token，没装时没有任何开销。</div></div>
                </div>
                ${ENABLE_BBS_BRIDGE || ENABLE_LWB_BRIDGE ? `<div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-brain"></i>记忆扩展</div>
                    ${ENABLE_BBS_BRIDGE ? '<div class="pad-opt"><label class="pad-check"><input id="pad-bbs" type="checkbox"><span>柏宝书的剧情总结</span></label><div class="pad-hint">让剧情推进也记得住早期剧情。需已安装柏宝书（ST-BaiBai-Book）。</div></div>' : ''}
                    ${ENABLE_LWB_BRIDGE ? '<div class="pad-opt"><label class="pad-check"><input id="pad-lwb" type="checkbox"><span>小白X 的剧情总结</span></label><div class="pad-hint">需已安装小白X（LittleWhiteBox）并开启其「剧情总结」。</div></div>' : ''}
                </div>` : ''}
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-book"></i>世界书</div>
                    <label class="pad-field"><span>读取范围</span>
                        <select id="pad-wi">
                            <option value="off">关闭</option>
                            <option value="st">常驻 + 关键词匹配（ST 默认行为）</option>
                            <option value="char">仅角色相关世界书（排除全局）</option>
                            <option value="all">全部条目（规划用 —— 忽略关键词）</option>
                            ${ENABLE_WI_CUSTOM_PICK ? '<option value="custom">自定义（手动挑书和条目）</option>' : ''}
                        </select>
                    </label>
                    <div class="pad-hint" id="pad-wi-hint"></div>
                    ${ENABLE_WI_CUSTOM_PICK ? `
                    <div id="pad-wi-custom" hidden>
                        <div class="pad-lb-row">
                            <i class="fa-solid fa-book pad-lb-icon"></i>
                            <details id="pad-wic-bookpick" class="pad-lb-bookpick">
                                <summary id="pad-wic-bookpick-sum" title="选择要发给剧情推进的世界书（可多选；不选＝当前激活的全部）">全部激活的世界书</summary>
                                <div class="pad-lb-bookpick-tools">
                                    <button type="button" class="pad-lb-mini" id="pad-wic-book-all">全选</button>
                                    <button type="button" class="pad-lb-mini" id="pad-wic-book-none">全不选（＝全部激活）</button>
                                </div>
                                <input type="text" id="pad-wic-book-filter" class="pad-lb-book-filter" placeholder="筛选世界书（名称）…">
                                <div id="pad-wic-book-list" class="pad-lb-book-list"></div>
                                <div id="pad-wic-book-empty" class="pad-lb-book-empty" hidden>（没有匹配的世界书）</div>
                            </details>
                            <div class="pad-iconbtn" id="pad-wic-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
                        </div>
                        <label class="pad-check pad-lb-check"><input id="pad-wic-hybrid" type="checkbox"><span>混合模式：勾选的条目 + 已选世界书里当前触发的绿灯条目</span></label>
                        <div id="pad-wic-entries" class="pad-lb-entries">
                            <div class="pad-lb-entries-head">
                                <span id="pad-wic-entries-summary">条目：全部</span>
                                <div class="pad-iconbtn pad-lb-ent-toggle" id="pad-wic-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                            </div>
                            <div class="pad-lb-entries-tools">
                                <button type="button" class="pad-lb-mini" id="pad-wic-all">全选</button>
                                <button type="button" class="pad-lb-mini" id="pad-wic-none">全不选</button>
                                <button type="button" class="pad-lb-mini" id="pad-wic-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                                <button type="button" class="pad-lb-mini pad-lb-mini-blue" id="pad-wic-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                                <button type="button" class="pad-lb-mini pad-lb-mini-green" id="pad-wic-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                                <button type="button" class="pad-lb-mini pad-lb-mini-off" id="pad-wic-disabled" title="只选已禁用条目">仅禁用</button>
                            </div>
                            <input type="text" id="pad-wic-entries-filter" class="pad-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                            <div id="pad-wic-entries-list" class="pad-lb-entries-list"></div>
                        </div>
                        <div class="pad-hint" id="pad-wic-hint"></div>
                    </div>` : ''}
                    ${ENABLE_WI_EJS_RENDER ? '<div class="pad-opt"><label class="pad-check"><input id="pad-wi-ejs" type="checkbox"><span>支持 EJS 世界书条目</span></label><div class="pad-hint">⚠ 含「写变量」的条目会被额外执行、可能影响卡内变量，遇异常请关闭。</div></div>' : ''}
                </div>
            </div>

            <div class="pad-set-page" data-tab="persona" role="tabpanel">
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-masks-theater"></i>说话人格</div>
                    <div class="pad-profile-row">
                        <select id="pad-persona"></select>
                        ${ENABLE_CUSTOM_PERSONAS ? '<div class="pad-iconbtn" id="pad-persona-edit" title="管理自定义人格"><i class="fa-solid fa-pen"></i></div>' : ''}
                    </div>
                    <div class="pad-hint">只改变剧情推进说话的语气与文采，不改变它的分析职责；参谋 / 世界书 / 角色工坊模式下同样叠加（方案与条目正文的格式不受影响），诊断与校正模式下不生效。选「普通」即不套人格。用了补全预设时，人格叠加在预设之上。</div>
                    ${ENABLE_CUSTOM_PERSONAS ? `
                    <div id="pad-persona-editor" style="display:none">
                        <label class="pad-row"><span>选择</span>
                            <select id="pad-pe-sel"></select>
                        </label>
                        <label class="pad-row"><span>名称</span>
                            <input type="text" id="pad-pe-name" maxlength="30" placeholder="如：嘻嘻哈哈的损友">
                        </label>
                        <div class="pad-pe-field"><span>人格描述</span>
                            <textarea id="pad-pe-voice" rows="5" placeholder="只写性格、态度与说话腔调（例：一个嘻嘻哈哈爱起哄的损友）。职责规则（准确、知无不言）由剧情推进自带，不用写。"></textarea>
                        </div>
                        <div class="pad-pe-field"><span>示例对话（可选）</span>
                            <textarea id="pad-pe-example" rows="3" placeholder="示例问：……　示例答：……"></textarea>
                        </div>
                        <div class="pad-pe-btns">
                            <button type="button" id="pad-pe-flesh" class="pad-fix-run-btn">✨ AI 帮我完善</button>
                            <button type="button" id="pad-pe-undo" class="pad-fix-run-btn" style="display:none">↩ 撤销</button>
                            <span class="pad-pe-spacer"></span>
                            <button type="button" id="pad-pe-save" class="pad-fix-run-btn">保存</button>
                            <button type="button" id="pad-pe-del" class="pad-fix-run-btn">删除</button>
                        </div>
                        <div class="pad-hint">改动只在点「保存」时生效；切换人格或收起编辑器会丢弃未保存的修改。「✨ AI 帮我完善」用当前连接的模型把你的点子扩写成完整描述。</div>
                    </div>` : ''}
                </div>
            </div>

            <div class="pad-set-page" data-tab="prompt" role="tabpanel">
                <div class="pad-set-section" id="pad-sysprompt-preset-wrap">
                    <div class="pad-set-title"><i class="fa-solid fa-file-lines"></i>普通聊天的系统提示词来源</div>
                    <div class="pad-profile-row">
                        <select id="pad-sysprompt-preset"></select>
                        <div class="pad-iconbtn" id="pad-sysprompt-preset-recurate" title="重新挑选要保留的块"><i class="fa-solid fa-list-check"></i></div>
                        <div class="pad-iconbtn" id="pad-sysprompt-preset-refresh" title="刷新预设列表"><i class="fa-solid fa-rotate-right"></i></div>
                    </div>
                    <div class="pad-hint" id="pad-sysprompt-preset-hint"></div>
                </div>
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-pen-to-square"></i>提示词<span class="pad-set-title-aside" id="pad-prompt-summary"></span></div>
                    <div class="pad-hint">剧情推进各模式发给模型的每一段文字都在这里。先选分组，再点条目查看或修改；改过的会标出来，随时可以恢复默认。</div>
                    <div class="pad-pgroups" id="pad-pgroups"></div>
                    <div class="pad-plist" id="pad-plist"></div>
                    <div class="pad-peditor" id="pad-peditor" hidden>
                        <div class="pad-peditor-head"><span id="pad-peditor-title"></span><button type="button" class="pad-mini-btn" id="pad-sysprompt-reset" title="把这一条恢复为内置默认">↺ 恢复默认</button></div>
                        <textarea id="pad-sysprompt" rows="8" spellcheck="false"></textarea>
                        <div class="pad-pvars" id="pad-pvars"></div>
                        <div class="pad-hint" id="pad-sysprompt-which-hint"></div>
                    </div>
                </div>
            </div>

            <div class="pad-set-page" data-tab="qp" role="tabpanel">
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-bolt"></i>快捷指令<span class="pad-set-title-aside" id="pad-qp-summary"></span></div>
                    <div class="pad-hint">显示在输入框上方、模型右边：点名字直接发送，点 ✎ 先填进输入框。每个模式只显示自己的。内容里可以写 {{user}}、{{char}}，发送时换成当前的名字。</div>
                    <div class="pad-pgroups" id="pad-qp-modes"></div>
                    <div id="pad-qp-list"></div>
                    <div class="pad-qp-actions">
                        <button type="button" class="pad-mini-btn" id="pad-qp-add"><i class="fa-solid fa-plus"></i> 新建一条</button>
                        <button type="button" class="pad-mini-btn" id="pad-qp-restore" title="把预置的快捷指令（如「杀古风」）补回来，已有的不动">↺ 补回预置的</button>
                    </div>
                </div>
            </div>

            <div class="pad-set-page" data-tab="ui" role="tabpanel">
                <div class="pad-set-section">
                    <div class="pad-set-title"><i class="fa-solid fa-palette"></i>外观与行为</div>
                    <label class="pad-field"><span>窗口配色</span><select id="pad-window-skin" title="深色 / 浅色为固定配色，不跟随酒馆主题"><option value="dark">深色</option><option value="light">浅色</option><option value="theme">跟随酒馆主题</option></select></label>
                    <label class="pad-check"><input id="pad-qr-toggle" type="checkbox"><span>输入框上方的快捷回复栏里放一个「剧情推进」按钮</span></label>
                    <label class="pad-check"><input id="pad-chatbar-toggle" type="checkbox"><span>在聊天输入栏放一个 🌙 快捷按钮（一键开 / 关剧情推进）</span></label>
                    <label class="pad-check"><input id="pad-clickout-toggle" type="checkbox"><span>点击窗外自动收起</span></label>
                    <div class="pad-opt"><label class="pad-check"><input id="pad-tools-header-toggle" type="checkbox"><span>把 ⋯ 里的工具按钮移到标题栏</span></label><div class="pad-hint">关闭后刷新页面恢复 ⋯ 菜单。</div></div>
                </div>
            </div>
        </div>

        <div id="pad-diag-bar">
            <details class="pad-mode-collapse" id="pad-diag-collapse" open>
                <summary class="pad-mode-collapse-sum"><i class="fa-solid fa-stethoscope"></i><span>诊断设置</span></summary>
                <div class="pad-mode-collapse-body">
            ${ENABLE_AUTO_DIAGNOSE ? '<label class="pad-check pad-lb-check"><input id="pad-diag-auto" type="checkbox"><span>自动诊断每条新回复（后台自动检查并修复 MVU）</span></label>\n            <div class="pad-hint">每收到一条新的 AI 回复就在后台检查其中的变量更新，发现问题自动修复，并在诊断记录里留一条可撤销的记录。窗口关着也照常工作——诊断按钮变红就表示它在后台跑着。每条回复会多发一次模型请求。</div>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-mvu-compat" type="checkbox"><span>⏳ 兼容 MVU「额外模型解析」</span></label>\n            <div class="pad-hint">只有同时使用自动诊断与 TavernHelper / MVU 的「额外模型解析」时才勾选。每条 AI 回复先观察 4 秒启动窗；一旦外部解析启动，会等完整重试批次结束。成功写出更新块就核验；失败或没有有效更新块，就由自动诊断照常推导。最多等 10 分钟，仍未收尾则本轮安全跳过、不抢写。若自动校正也开启，它会在落新 swipe 前共享这次等待并合并更新块。</div>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-cowrite" type="checkbox"><span>🧩 允许与其他脚本并写 MVU</span></label>\n            <div class="pad-hint">某些卡脚本 / 扩展会在诊断期间改写 MVU。勾选后自动诊断仍会执行，但只写入未被改动的值，被改动的值跳过不写。</div>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-retry" type="checkbox"><span>🔁 失败自动重试</span></label>\n            <div class="pad-hint">自动诊断这一轮没跑成时自动再试（每次重试都会重新读取当前状态、再发一次模型请求）。在下方勾选哪些失败情形需要重试；成功、无需改动、以及安全跳过（切聊天 / 状态已变 / 手动中断）永不重试。</div>\n            <div id="pad-diag-retry-opts">\n            <label class="pad-field"><span>最多重试次数</span><input id="pad-diag-retry-count" type="number" step="1" min="1" max="99"></label>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-retry-empty" type="checkbox"><span>空白回复（模型没返回内容）</span></label>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-retry-format" type="checkbox"><span>格式错误（没能读懂 / 拒收模型给的更新）</span></label>\n            <label class="pad-check pad-lb-check"><input id="pad-diag-retry-error" type="checkbox"><span>调用失败（网络错误 / 超时等）</span></label>\n            </div>' : ''}
            ${ENABLE_DIAG_BODY_INJECT ? '<label class="pad-check pad-lb-check"><input id="pad-diag-inject" type="checkbox"><span>把诊断修正写进正文 —— 开启后，诊断的修正（自动与手动）会写进这条回复的更新区块——撤销时一并移除。</span></label>' : ''}
            <label class="pad-check pad-lb-check"><input id="pad-diag-preset" type="checkbox"><span>套用我的补全预设（诊断指令叠加其上）</span></label>
            <div class="pad-hint pad-diag-preset-warn">⚠ 仅在诊断确实被模型拒绝时才勾选：预设的额外内容会分散模型注意力、影响诊断精度。</div>${ENABLE_SCHEMA_DIAG ? '\n            <label class="pad-check pad-lb-check"><input id="pad-diag-schema-retry" type="checkbox"><span>被拒时让模型自动重写一次（多花一次调用）</span></label>' : ''}
            ${ENABLE_MVU_EDITOR ? '<div class="pad-mvued-row"><button type="button" class="pad-lb-mini" id="pad-mvued-btn">🎛 变量编辑器 —— 直接查看 / 修改当前变量</button></div>' : ''}${ENABLE_SCHEMA_DIAG ? '\n            <div class="pad-mvued-row"><button type="button" class="pad-lb-mini" id="pad-diag-health-btn">🩺 检查存档</button></div>' : ''}
            <div id="pad-diag-wisel">
            <label class="pad-check pad-lb-check"><input id="pad-diag-usesel" type="checkbox"><span>诊断使用精选世界书条目（关闭则用默认扫描）</span></label>
            <div class="pad-hint">开启后可【按本聊天】挑选要喂给诊断的世界书条目，无视其在 ST 里的启用 / 禁用状态——解决「禁用了变量规则条目后诊断就看不到」与「全量太吵」的两难。首次开启会按当前激活情况预选一份，之后随你增删、按聊天记忆。</div>
            <div id="pad-diag-picker">
                <label class="pad-check pad-lb-check"><input id="pad-diag-hybrid" type="checkbox"><span>混合模式：精选条目 + 主聊天当前触发的绿灯条目</span></label>
                <div class="pad-lb-row">
                    <i class="fa-solid fa-book pad-lb-icon"></i>
                    <select id="pad-diag-book" title="选择要从哪本世界书里挑条目"></select>
                    <div class="pad-iconbtn" id="pad-diag-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
                </div>
                <div id="pad-diag-entries" class="pad-lb-entries">
                    <div class="pad-lb-entries-head">
                        <span id="pad-diag-entries-summary">条目：全部</span>
                        <div class="pad-iconbtn pad-lb-ent-toggle" id="pad-diag-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                    </div>
                    <div class="pad-lb-entries-tools">
                        <button type="button" class="pad-lb-mini" id="pad-diag-all">全选</button>
                        <button type="button" class="pad-lb-mini" id="pad-diag-none">全不选</button>
                        <button type="button" class="pad-lb-mini" id="pad-diag-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                        <button type="button" class="pad-lb-mini pad-lb-mini-blue" id="pad-diag-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                        <button type="button" class="pad-lb-mini pad-lb-mini-green" id="pad-diag-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                        <button type="button" class="pad-lb-mini pad-lb-mini-off" id="pad-diag-disabled" title="只选已禁用条目">仅禁用</button>
                    </div>
                    <input type="text" id="pad-diag-entries-filter" class="pad-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                    <div id="pad-diag-entries-list" class="pad-lb-entries-list"></div>
                </div>
                <div class="pad-hint" id="pad-diag-hint"></div>
            </div>
            </div>
                </div>
            </details>
        </div>

        <div id="pad-fix-bar">
            <details class="pad-mode-collapse" id="pad-fix-collapse" open>
                <summary class="pad-mode-collapse-sum"><i class="fa-solid fa-wand-magic-sparkles"></i><span>校正设置</span></summary>
                <div class="pad-mode-collapse-body">
                    <label class="pad-check pad-lb-check"><span>校正模式</span>&nbsp;<select id="pad-fix-mode-select" title="手动 = 在输入框直接说要改什么（单稿、快）；去 AI 味 = 按目标去八股 / 每条新回复后台跑（双稿收紧）"><option value="manual">手动（说要改哪里）</option><option value="auto">去 AI 味（按目标 / 每条新回复）</option>${ENABLE_FIX_CUSTOM_TASK ? '<option value="custom">自定义（用自己的模板处理每条回复）</option>' : ''}</select></label>
                    <!-- ✨ 判定预览行（1.18.0 迁出 #pad-fix-auto-wrap，修 P8）：本聊天开了自动校正就该看得见
                         「这条回复会被怎么处理」，不再被「面板正显示手动视图」这个全局偏好埋没。 -->
                    <div id="pad-fix-verdict" class="pad-fix-verdict" hidden></div>

                    <!-- 手动模式：在下方输入框直接说要改什么。默认带上丰富上下文（一次性精修、质量优先）。单稿、无目标。 -->
                    <div id="pad-fix-manual">
                        <label class="pad-check pad-lb-check"><input id="pad-fixm-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                        <div class="pad-hint">仅当模型拒绝校正请求时才开（需先在【设置】里精选一个补全预设）。</div>
                        <div class="pad-hint pad-fixm-warn">⚠ 部分模型（如 DeepSeek、Gemini）在高上下文下会认不准要改哪一条回复、把前文内容混进结果——下面几项默认关闭，仅在确有需要（对齐设定 / 前情）时再逐项开启。若确要带前文，更建议改用 ✂️ 选段校正：只把你划选的一段发给模型，高上下文下更稳，也绝不动没划到的部分。</div>
                        <label class="pad-check pad-lb-check"><span>只改此标签内的正文</span>&nbsp;<input id="pad-fixm-scope" type="text" style="width:110px;" placeholder="留空 = 整条"></label>
                        <div class="pad-hint">填正文所在的标签名（如 <code>Interleaving</code>，不用写尖括号）：模型只看到、只改这个标签里的正文，标签外的构建块、状态栏、占位符原样保留。留空，或这条回复里没有这个标签时，按整条回复处理。</div>
                        <label class="pad-check pad-lb-check"><span>加载前文条数（0 = 不带，-1 = 全部）</span>&nbsp;<input id="pad-fixm-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                        <label class="pad-check pad-lb-check"><input id="pad-fixm-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                        <label class="pad-check pad-lb-check"><input id="pad-fixm-world" type="checkbox"><span>带上当前激活世界书</span></label>
                        <label class="pad-check pad-lb-check"><input id="pad-fixm-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                        <div class="pad-hint">柏宝书 / 小白X 的总结要先在「设置 → 上下文 → 记忆扩展」里打开才会带上；柏宝书只提供已经隐藏的旧楼层的摘要（和它注入主聊天的是同一份）。</div>
                        <!-- ✨ 思考块保护（W1 2026-08-16 §3.1 修复）。文案待 Prince 过目（行文案 + title 候选见 REPORT-FIXROUND） -->
                        <label class="pad-check pad-lb-check"><input id="pad-fixm-protectthink" type="checkbox"><span>保护思考区块（&lt;think&gt; 思维链等，校正时原样保留）</span></label>
                        <div class="pad-hint">部分模型改整条回复时会顺手把卡片的思考区块整块删掉——开着时系统先把它收走、校正后原样接回（校正卡会注明）。想让校正连思考块一起改时再关。</div>
                        <label class="pad-check pad-lb-check"><span>校正回复上限</span>&nbsp;<input id="pad-fix-maxtok" type="number" min="0" step="1024" style="width:6em" placeholder="自动·4096" title="校正调用的 max_tokens 下限自动为 4096；长楼层（约 3000 字以上）改写被截断、校正总失败时可调高（如 8192/12288）。对手动与自动校正都生效。注意：超过服务商单次输出上限会被直接拒绝——报错就调回来。留空 = 自动。"></label>
                        <div class="pad-hint">手动：在下方输入框直接说要改哪里（如「换种写法重写这段」「她这里不该笑」），只改最新这一条回复，单稿、更快。</div>
                        ${ENABLE_FIX_SELECT ? '<button type="button" id="pad-fixsel-open" class="pad-fix-run-btn" title="划选回复里的一段，只把这段发给模型改——弱模型 / 长聊天下更稳，绝不动你没选的部分（状态栏 / 面板等）"><i class="fa-solid fa-scissors"></i> 选段校正（只改划选的一段）</button>' : ''}
                        ${ENABLE_FIXSEL_CHAT_ENTRY && ENABLE_FIX_SELECT ? '<label class="pad-check pad-lb-check"><input id="pad-fixsel-barbtn" type="checkbox"><span>在聊天输入框上方放一个「✂️ 选段校正」快捷按钮</span></label><div class="pad-hint">免去每次开窗切模式：在主聊天里划选一段，点它即可直接打开选段卡（不划选 = 直接开卡）。</div><label class="pad-check pad-lb-check"><input id="pad-fixsel-rowbtn" type="checkbox"><span>在最新一条 AI 回复的右上角放「✂️」选段按钮</span></label><div class="pad-hint">不想看到回复上的小剪刀就取消勾选；输入框上方的快捷按钮不受影响。</div>' : ''}
                    </div>

                    <!-- 自动模式（1.18.3 新手优先重排）：判定行 → 跑一次 / 每条 → 目标 → 强度 → 警告盒 → 进阶折叠 → 恢复推荐。 -->
                    <div id="pad-fix-auto-wrap">
                        <button type="button" id="pad-fix-run" class="pad-fix-run-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> 按目标给最新回复去 AI 味</button>
                        <label class="pad-check pad-lb-check"><input id="pad-fix-auto" type="checkbox"><span>每条新回复自动去 AI 味</span></label>
                        <div class="pad-fix-targets-head">校正目标</div>
                        <div class="pad-fix-tgt-grid">
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-slop" type="checkbox"><span>AI 八股 / 套话</span></label>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-dialogue" type="checkbox"><span>对话机械 / 不自然</span></label>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-precision" type="checkbox"><span>过度精确（数学论文腔）</span></label>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-magic" type="checkbox"><span>魔法被写成理科（仅奇幻设定）</span></label>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-pacing" type="checkbox"><span>描写拖沓 / 流水账</span></label>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-tgt-archaic" type="checkbox"><span>古风词混入（仅西幻 / 现代设定）</span></label>
                        </div>
                        <label class="pad-check pad-lb-check"><span>强度</span>&nbsp;<select id="pad-fix-prompt-version" title="轻校＝现行提示词（较克制）；精校＝更彻底的三道工序校正"><option value="light">轻校（默认）</option><option value="thorough">精校（更彻底）</option></select></label>
                        <label class="pad-check pad-lb-check" id="pad-fix-prompt-flavor-row"><span>精校侧重</span>&nbsp;<select id="pad-fix-prompt-flavor" title="按你用的模型选侧重：DeepSeek / 国产模型选 DeepSeek 类；Claude / Opus 选 Opus 类；Gemini 选 Gemini 类"><option value="deepseek">DeepSeek 类（默认）</option><option value="opus">Opus 类</option><option value="gemini">Gemini 类</option></select></label>
                        <div class="pad-hint">轻校 = 克制（默认）。精校 = 更彻底的三道工序；按你用的模型选侧重：DeepSeek / 国产模型选「DeepSeek 类」，Claude / Opus 选「Opus 类」，Gemini 选「Gemini 类」。</div>
                        <div id="pad-fix-warnings" class="pad-hint" hidden></div>
                        <details class="pad-mode-collapse" id="pad-fix-adv">
                            <summary class="pad-fix-targets-head" style="cursor:pointer;">进阶设置（一般不用动）</summary>
                            <label class="pad-check pad-lb-check"><span>只校正此标签内的正文</span>&nbsp;<input id="pad-fix-scope" type="text" style="width:110px;"></label>
                            <div class="pad-hint">通常不用动：会自动识别卡片的正文标签（默认 <code>content</code>），认不准时会请你确认一次。识别错了才在这里改（<strong>手填后自动识别会停用</strong>，交还给你）；<strong>留空</strong> = 校正整条回复。</div>
                            <button type="button" id="pad-fix-scan" class="pad-fix-run-btn"><i class="fa-solid fa-magnifying-glass"></i> 重新扫描正文标签（识别不对时用）</button>
                            <div id="pad-fix-scan-panel" class="pad-fix-scan-panel" hidden></div>
                            <div class="pad-fix-targets-head">保留区 / 丢弃区：结构块会自动识别并原样保留——下面是<strong>本条回复</strong>实际识别到的。没认出的块，点它加进保留区（或手动填，每行一个<strong>起始</strong>标记；支持嵌套同名标签与 <code>[IMG_GEN]</code> 方括号块）；丢弃区 = 直接删掉、不放回。识别不对的格式欢迎在 Discord 私信 <strong>@Prince</strong>，会加进测试集修复。标签写法：&lt;thinking&gt; 或 thinking 都行，不用写闭合标签；方括号块写 [IMG_GEN]；同一标签两边都填按保留处理。</div>
                            <div id="pad-fix-receipts" class="pad-hint" hidden></div>
                            <textarea id="pad-fix-keep" rows="3" placeholder="保留区标签：每行一个，只写开标签或名字即可——例如 <status> 或 status（不用写 </status>）；方括号块写 [IMG_GEN]"></textarea>
                            <textarea id="pad-fix-drop" rows="3" placeholder="丢弃区标签：每行一个，只写开标签或名字即可——例如 <thinking>（不用写 </thinking>）；方括号块写 [IMG_GEN]。命中的块直接删掉、不放回"></textarea>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-join" type="checkbox"><span>整体校正（默认开）：正文合并为 1 次调用，结构块用锚点原位保留</span></label>
                            <div class="pad-hint">开 = 省调用、整篇更连贯；结构块位置靠锚点标记保留（模型极偶尔挪动锚点时内容不丢、位置兜底接到正文末尾，记录里会如实说明）。关 = 每段正文各发一次调用（位置由代码百分百把控、单段失败只损失那一段，调用更多）。</div>
                            <label class="pad-check pad-lb-check"><input id="pad-fix-wait-mvu" type="checkbox"><span>⏳ 与 MVU「额外模型更新」并用（避免抢写冲突）</span></label>
                            <div class="pad-hint">仅当你开了 MVU 的「额外模型更新」（用另一个模型异步解析变量）时才勾。勾上后：校正<strong>照常立刻开跑</strong>（与 MVU 并行、几乎不多等），只在<strong>生成新回复稿之前</strong>等 MVU 把变量写完再合并进来——两者不再抢写同一条消息、数据不错乱。没开额外模型更新就<strong>保持不勾</strong>。</div>
                            <label class="pad-check pad-lb-check"><input id="pad-fixa-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>
                            <div class="pad-hint">⚠ 仅在你的模型 / 中转会【拒绝】校正请求、需要破限 / 越狱时才开。需先在【设置】里选好并「精选」一个补全预设。手动与自动【各自独立】开关；开启的那一套会套上该预设的文本块与角色（跳过角色卡 / 世界书等 RP 内容标记），可能更慢 / 更贵。不需要破限就别开。</div>
                            <textarea id="pad-fix-know" rows="2" placeholder="角色知识边界（可空）：例如「主角不知道自己的真实身世」"></textarea>
                            <textarea id="pad-fix-guard" rows="2" placeholder="剧情护栏 / 自定义（可空）：例如「保持慢热，不要时间跳跃」"></textarea>
                            <details class="pad-mode-collapse" id="pad-fix-ctx-adv">
                                <summary class="pad-fix-targets-head" style="cursor:pointer;">上下文（默认关，点开）</summary>
                                <div class="pad-hint">⚠ 默认关闭以省时间。仅当你的「知识边界 / 剧情护栏」需要参考前文 / 角色卡 / 世界书才能判断时，才勾选。</div>
                                <label class="pad-check pad-lb-check"><input id="pad-fix-card" type="checkbox"><span>带上角色卡（描述 / 性格 / 场景）</span></label>
                                <label class="pad-check pad-lb-check"><input id="pad-fix-ctx" type="checkbox"><span>带上前文上下文（最近若干条主聊天）</span></label>
                                <label class="pad-check pad-lb-check" style="margin-left:18px;"><span>条数（-1=全部）</span>&nbsp;<input id="pad-fix-ctx-depth" type="number" min="-1" max="100" style="width:64px;"></label>
                                <label class="pad-check pad-lb-check"><input id="pad-fix-world" type="checkbox"><span>带上激活世界书（蓝灯 + 本条命中的绿灯）</span></label>
                                <label class="pad-check pad-lb-check"><input id="pad-fixa-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                                <div class="pad-hint">柏宝书 / 小白X 的总结要先在「设置 → 上下文 → 记忆扩展」里打开才会带上；柏宝书只提供已经隐藏的旧楼层的摘要（和它注入主聊天的是同一份）。</div>
                            </details>
                            <div class="pad-fix-bundle-row">
                                <select id="pad-fix-bundle" title="已存的校正套餐（全局，跨聊天可用）"></select>
                                <button type="button" id="pad-fix-bundle-load" class="pad-fix-run-btn">加载</button>
                                <button type="button" id="pad-fix-bundle-save" class="pad-fix-run-btn">保存为…</button>
                                <button type="button" id="pad-fix-bundle-del" class="pad-fix-run-btn">删除</button>
                            </div>
                            <div class="pad-hint">套餐＝把当前这套自动校正配置（目标 / 约束 / 上下文）存成一个名字（如「硬核西幻」），换聊天后一键加载回来。</div>
                        </details>
                        <button type="button" id="pad-fix-reset" class="pad-fix-run-btn"><i class="fa-solid fa-rotate-left"></i> 恢复推荐设置</button>
                        <div class="pad-hint">把本聊天的自动校正设置一键还原成推荐值：作用域 = <code>content</code>、默认校正目标、排除区清空、自动关、任务切回校正（也会清掉已确认的正文形态，回到自动识别）。</div>
                    </div>

                    ${ENABLE_FIX_CUSTOM_TASK ? ''
                    // 📋 自定义模式（1.77.0）：用自己的模板处理每条回复。整块由 ENABLE_FIX_CUSTOM_TASK 门控——
                    // 关着时下面一个节点都不渲染（与「旗关 = 与上一版 DOM 全同」的统一语义一致）。
                    // ⚠ 这段说明【必须】留在插值表达式里、写成 JS 注释：写成模板字面量正文里的 <!-- --> 会变成
                    //   一个真的 DOM 注释节点，旗关时 DOM 就不再与 1.76.0 逐字节相同（评审 F5a）。
                    + '<div id="pad-fix-custom-wrap">'
                    + '<button type="button" id="pad-fixc-run" class="pad-fix-run-btn"><i class="fa-solid fa-clipboard-list"></i> 用模板处理最新回复</button>'
                    + '<label class="pad-check pad-lb-check"><input id="pad-fixc-auto" type="checkbox"><span>每条新回复自动运行模板</span></label>'
                    + '<div class="pad-fix-targets-head">模板</div>'
                    + '<div class="pad-fix-bundle-row">'
                    // 📋 下拉里除了用户自己的模板，末尾还有一个 optgroup「内置示例」装两份现成的
                    // （populateFixTemplates 填；2026-09-05 产品负责人裁定：示例直接列进下拉，不再有「示例…」按钮）。
                    + '<select id="pad-fixc-template" title="已存的模板（全局，跨聊天可用）；末尾「内置示例」两份可直接选用"></select>'
                    + '<button type="button" id="pad-fixc-tpl-new" class="pad-fix-run-btn">新建…</button>'
                    + '<button type="button" id="pad-fixc-tpl-save" class="pad-fix-run-btn">保存</button>'
                    + '<button type="button" id="pad-fixc-tpl-del" class="pad-fix-run-btn">删除</button>'
                    // 🌐 模板广场（1.86.0）：旗关时这里是空串。📤 分享（2026-09-29 起只剩复制分享文本、纯本地）不受旗管。
                    + (ENABLE_FIX_TEMPLATE_HUB ? '<button type="button" id="pad-fixc-hub" class="pad-fix-run-btn" title="浏览、下载大家分享的模板">🌐 广场</button>' : '')
                    + '<button type="button" id="pad-fixc-share" class="pad-fix-run-btn" title="复制分享文本，发到神谕 Discord 的模板分享频道">📤 分享</button>'
                    + '</div>'
                    // 「未保存」标记：fixTplDirty 的唯一可视化（updateFixTplDirtyMarker 是唯一写它的地方）。
                    // 默认 hidden——旗关时这一整段本就不渲染，旗开而不脏时它也不占视觉。
                    + '<span id="pad-fixc-dirty" class="pad-hint" hidden>未保存</span>'
                    + '<textarea id="pad-fixc-prompt" rows="6" placeholder="只写你要它做的事（例：把正文完整翻译成日文）。输出格式与保留标记由剧情推进自动附上。"></textarea>'
                    + '<label class="pad-check pad-lb-check"><input id="pad-fixc-mech" type="checkbox"><span>沿用校正的正文识别</span></label>'
                    + '<div class="pad-hint">开：只处理剧情正文，状态栏、变量块等原样保留。关：整条回复交给模板，输出原样替换。</div>'
                    + '<div class="pad-fix-targets-head">保留区 / 丢弃区（本档自己的）</div>'
                    // 标签写法提示（1.77.0 UI 二波）：自动面板把同一句追加在它那段长说明末尾，这里因为没有那段
                    // 说明，单独起一行 pad-hint 放在两个 textarea 之上。
                    + '<div class="pad-hint">标签写法：&lt;thinking&gt; 或 thinking 都行，不用写闭合标签；方括号块写 [IMG_GEN]；同一标签两边都填按保留处理。</div>'
                    + '<textarea id="pad-fixc-keep" rows="3" placeholder="保留区标签：每行一个，只写开标签或名字即可——例如 <status> 或 status（不用写 </status>）；方括号块写 [IMG_GEN]"></textarea>'
                    + '<textarea id="pad-fixc-drop" rows="3" placeholder="丢弃区标签：每行一个，只写开标签或名字即可——例如 <thinking>（不用写 </thinking>）；方括号块写 [IMG_GEN]。命中的块直接删掉、不放回"></textarea>'
                    + '<div id="pad-fixc-warnings" class="pad-hint" hidden></div>'
                    + '<label class="pad-check pad-lb-check"><input id="pad-fixc-preset" type="checkbox"><span>经自定义补全预设发送（破限 / 越狱用）</span></label>'
                    + '<label class="pad-check pad-lb-check"><span>最少字数（更短的回复不处理）</span>&nbsp;<input id="pad-fixc-minchars" type="number" min="50" max="2000" style="width:72px;"></label>'
                    + '</div>' : ''}
                </div>
            </details>
        </div>

        <div id="pad-bld-bar">
            <details class="pad-mode-collapse" id="pad-bld-collapse" open>
                <summary class="pad-mode-collapse-sum"><i class="fa-solid fa-masks-theater"></i><span>角色工坊</span></summary>
                <div class="pad-mode-collapse-body">
                    <label class="pad-check pad-lb-check"><span>打造目标</span>&nbsp;<select id="pad-bld-target" title="用户角色 = 写进 Persona（抢话:AI 也扮演你 / 不抢话:AI 只回应你）；NPC = 写进世界书条目"></select></label>
                    <div class="pad-bld-chips-row"><span class="pad-bld-chips-label">草稿包含：<button type="button" id="pad-bld-chips-help" title="每个部分是什么？点开看说明">?</button></span><div id="pad-bld-chips"></div></div>
                    <div id="pad-bld-chips-legend" style="display:none"></div>
                    <details class="pad-lb-books"><summary id="pad-bld-bookpick-sum">世界书：当前激活的</summary><div class="pad-lb-bookpick-tools"><button type="button" class="pad-lb-mini" id="pad-bld-books-active" title="清空选择、回到「跟随当前所有激活的世界书」">用当前激活的</button></div><input type="text" id="pad-bld-book-filter" class="pad-lb-book-filter" placeholder="筛选世界书（名称）…"><div id="pad-bld-book-list"></div><div id="pad-bld-book-empty" class="pad-lb-book-empty" hidden>（没有匹配的世界书）</div></details>
                    <details class="pad-lb-books"><summary id="pad-bld-entries-sum">条目：全部发送</summary>
                        <div class="pad-lb-entries-tools"><button type="button" class="pad-lb-mini" id="pad-bld-ent-all">全选</button><button type="button" class="pad-lb-mini" id="pad-bld-ent-none">全不选</button><button type="button" class="pad-lb-mini" id="pad-bld-ent-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在搜索框输入关键词）">全选筛选</button><button type="button" class="pad-lb-mini pad-lb-mini-blue" id="pad-bld-ent-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button><button type="button" class="pad-lb-mini pad-lb-mini-green" id="pad-bld-ent-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button><input id="pad-bld-ent-filter" type="text" placeholder="搜索条目…"></div>
                        <div id="pad-bld-entry-list"></div>
                    </details>
                    <label class="pad-check pad-lb-check"><span>上下文深度</span>&nbsp;<input id="pad-bld-depth" type="number" min="0" step="10" style="width:5em">&nbsp;<label class="pad-check"><input id="pad-bld-depth-all" type="checkbox"><span>全部</span></label></label>
                    <label class="pad-check pad-lb-check"><input id="pad-bld-summary" type="checkbox"><span>带上 📜剧情概要（含柏宝书 / 小白X 总结）</span></label>
                    <label class="pad-check pad-lb-check"><input id="pad-bld-stat" type="checkbox"><span>带上状态栏数据（stat_data）</span></label>
                    <label class="pad-check pad-lb-check"><input id="pad-bld-scanwi" type="checkbox"><span>关键词触发世界书（把聊天与访谈里提到的设定条目作参考补充）</span></label>
                    <label class="pad-check pad-lb-check" title="锻造时把台词写得更丰满自然——每句都是当面说出口的完整人话，保留角色个性与说话习惯（话少的角色照旧话少，但开口的句子完整）。各家模型都验证过；不改条数与结构。"><input id="pad-bld-dlgrich" type="checkbox"><span>台词丰满（锻造台词写成完整人话）</span></label>
                    <label class="pad-check pad-lb-check"><span>锻造回复上限</span>&nbsp;<input id="pad-bld-maxtok" type="number" min="0" step="1024" style="width:6em" placeholder="自动·16384" title="锻造调用的 max_tokens 下限自动为 16384；超大世界书导致思考+成稿被截断时可调高。注意：超过服务商单次输出上限会被直接拒绝——报错就调回来。留空 = 自动。"></label>
                    <label class="pad-check pad-lb-check" title="勾选后，访谈对话走你在设置面板策展的预设（文本块保留、RP标记去除，工坊指令注入历史位）。锻造调用不受影响——始终使用内置锻造工序。"><input id="pad-bld-preset" type="checkbox"><span>用自定义预设（设置面板所选）</span></label>
                    <label class="pad-check pad-lb-check" id="pad-bld-autocond-row" title="锻造成功后自动跑一遍「✂️ 精简」（拆长句、删跨节重复；守卫不过=原稿原样保留）。只在 NPC 草稿、且原稿明显冗长时触发——本就精炼的稿子不会白花调用。强输出模型（如 Claude）建议开。"><input id="pad-bld-autocond" type="checkbox"><span>锻造后自动精简</span></label>
                    <div class="pad-hint" id="pad-bld-condinfo" style="margin:4px 0">✂️✂️ 深度精简仅适合 <b>Opus 类</b>模型（DeepSeek / Gemini 的锻造稿本就精炼，收益不大）；会分多次流式调用，通常要等上几分钟才跑完。</div>
                    <div id="pad-bld-card" style="display:none"></div>
                </div>
            </details>
        </div>

        <div id="pad-lb-bar">
            <details class="pad-mode-collapse" id="pad-lb-collapse" open>
                <summary class="pad-mode-collapse-sum"><i class="fa-solid fa-book"></i><span>世界书设置</span></summary>
                <div class="pad-mode-collapse-body">
            <div class="pad-lb-row">
                <i class="fa-solid fa-book pad-lb-icon"></i>
                <details id="pad-lb-bookpick" class="pad-lb-bookpick">
                    <summary id="pad-lb-bookpick-sum" title="选择要聊 / 编辑的世界书（可多选；不选＝当前激活的全部）">全部激活的世界书</summary>
                    <div class="pad-lb-bookpick-tools">
                        <button type="button" class="pad-lb-mini" id="pad-lb-book-all">全选</button>
                        <button type="button" class="pad-lb-mini" id="pad-lb-book-none">全不选（＝全部激活）</button>
                    </div>
                    <input type="text" id="pad-lb-book-filter" class="pad-lb-book-filter" placeholder="筛选世界书（名称）…">
                    <div id="pad-lb-book-list" class="pad-lb-book-list"></div>
                    <div id="pad-lb-book-empty" class="pad-lb-book-empty" hidden>（没有匹配的世界书）</div>
                </details>
                <div class="pad-iconbtn" id="pad-lb-refresh" title="刷新世界书列表"><i class="fa-solid fa-rotate-right"></i></div>
            </div>
            <label class="pad-check pad-lb-check"><input id="pad-lb-story" type="checkbox"><span>同时带上最近剧情对话</span></label>
            <label class="pad-check pad-lb-check"><input id="pad-lb-preset" type="checkbox"><span>套用我的补全预设（指令叠加其上）</span></label>
            <div class="pad-hint pad-lb-preset-warn">⚠ 勾选后，世界书管家指令会叠加在你选定的补全预设之上（用于越狱）。预设内容会分散模型注意力、可能影响编辑精度——仅在确实需要越狱时才勾选。</div>
            <div id="pad-lb-entries" class="pad-lb-entries">
                <div class="pad-lb-entries-head">
                    <span id="pad-lb-entries-summary">条目：全部</span>
                    <div class="pad-iconbtn pad-lb-ent-toggle" id="pad-lb-entries-toggle" title="展开 / 折叠条目列表"><i class="fa-solid fa-chevron-down"></i></div>
                </div>
                <div class="pad-lb-entries-tools">
                    <button type="button" class="pad-lb-mini" id="pad-lb-all">全选</button>
                    <button type="button" class="pad-lb-mini" id="pad-lb-none">全不选</button>
                    <button type="button" class="pad-lb-mini" id="pad-lb-filtered" disabled title="只选中当前筛选 / 搜索结果里的条目（先在下方筛选框输入关键词）">全选筛选</button>
                    <button type="button" class="pad-lb-mini pad-lb-mini-blue" id="pad-lb-blue" title="只选常驻（蓝灯）条目，不含已禁用">仅蓝灯</button>
                    <button type="button" class="pad-lb-mini pad-lb-mini-green" id="pad-lb-green" title="只选关键词触发（绿灯）条目，不含已禁用">仅绿灯</button>
                    <button type="button" class="pad-lb-mini pad-lb-mini-off" id="pad-lb-disabled" title="只选已禁用条目">仅禁用</button>
                    <button type="button" class="pad-lb-mini pad-lb-mini-eye" id="pad-lb-preview-toggle" title="显示 / 隐藏每条条目的内容预览">👁 内容预览</button>
                </div>
                <input type="text" id="pad-lb-entries-filter" class="pad-lb-entries-filter" placeholder="筛选条目（标题 / 关键词 / uid）…">
                <div id="pad-lb-entries-list" class="pad-lb-entries-list"></div>
            </div>
            <div class="pad-hint" id="pad-lb-hint"></div>
                </div>
            </details>
        </div>

        <div id="pad-adv-bar">
            <details class="pad-mode-collapse" id="pad-adv-collapse" open>
                <summary class="pad-mode-collapse-sum"><i class="fa-solid fa-compass"></i><span>参谋设置</span></summary>
                <div class="pad-mode-collapse-body">
            <label class="pad-check pad-adv-check"><input id="pad-adv-preset" type="checkbox"><span>套用我的补全预设（参谋指令叠加其上）</span></label>
            <div class="pad-hint pad-adv-preset-warn">⚠ 仅在确实需要预设里的越狱时才勾选：预设的额外内容会分散模型注意力。未整理过预设时勾它不报错，会自动退回内置参谋提示词。</div>
            <label class="pad-field pad-adv-field"><span>剧情引导注入深度（方案指令插入主聊天的深度）——模型不听引导时调低，最低 0</span>
                <input id="pad-adv-depth" type="number" step="1" min="0">
            </label>
            <div class="pad-adv-field"><span>剧情脉络里，后面节点的详细什么时候写</span>
                <div class="pad-seg" id="pad-adv-detail-seg"><button type="button" data-v="all">一次写全</button><button type="button" data-v="later">到了再写</button></div>
            </div>
            <div class="pad-hint" id="pad-adv-detail-hint"></div>
                </div>
            </details>
        </div>

        <div id="pad-plan-bar">
            <div class="pad-plan-head">
                <i class="fa-solid fa-compass pad-plan-icon"></i>
                <span class="pad-plan-label" id="pad-plan-label">引导中</span>
                <span id="pad-plan-goal"></span>
                <button type="button" class="pad-plan-collapse-btn" id="pad-plan-collapse" title="收起 / 展开引导条"><i class="fa-solid fa-chevron-up"></i></button>
            </div>
            <div class="pad-plan-intensity" id="pad-plan-intensity"></div>
            <div class="pad-hint" id="pad-plan-caption"></div>
            <div class="pad-plan-actions">
                <button type="button" class="pad-plan-mini" id="pad-plan-show">▸ 查看注入内容</button>
                <button type="button" class="pad-plan-mini" id="pad-plan-edit" title="修改当前目标"><i class="fa-solid fa-pencil"></i></button>
                <button type="button" class="pad-plan-mini" id="pad-plan-pause" title="暂停引导：主聊天先不注入，进度都保留，随时继续"><i class="fa-solid fa-pause"></i> 暂停</button>
                <span class="pad-plan-spacer"></span>
                <button type="button" class="pad-plan-mini pad-plan-done" id="pad-plan-done" title="目标已达成，停止引导">完成</button>
                <button type="button" class="pad-plan-mini" id="pad-seq-sendback" title="回参谋房继续聊——当前目标照常引导着，聊好可以只重排剩下的部分">💬 找参谋改改</button>
                <button type="button" class="pad-plan-mini pad-plan-drop" id="pad-plan-drop" title="不再需要，停止引导">放弃</button>
            </div>
            <pre id="pad-plan-directive"></pre>
            <div id="pad-seq-list"></div>
        </div>

        <div id="pad-messages"></div>

        <div id="pad-model-bar"></div>
        <div id="pad-footer">
            <textarea id="pad-input" rows="2" placeholder="就当前剧情提问…（Enter 发送，Shift+Enter 换行）"></textarea>
            <div class="pad-iconbtn" id="pad-send" title="发送"><i class="fa-solid fa-paper-plane"></i></div>
        </div>

        <div id="pad-debug">
            <div id="pad-debug-head">
                <span><i class="fa-solid fa-bug"></i> 上一次发送的提示词 <span id="pad-debug-meta"></span></span>
                <div style="display:flex;gap:2px;">
                    <div class="pad-iconbtn" id="pad-debug-copy" title="复制完整提示词"><i class="fa-solid fa-copy"></i></div>
                    <div class="pad-iconbtn" id="pad-debug-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <pre id="pad-debug-body"></pre>
        </div>

        <div id="pad-summary">
            <div id="pad-summary-head">
                <span><i class="fa-solid fa-scroll"></i> 剧情概要（本聊天）</span>
                <div style="display:flex;gap:2px;">
                    <div class="pad-iconbtn" id="pad-summary-clear" title="清空概要"><i class="fa-solid fa-trash-can"></i></div>
                    <div class="pad-iconbtn" id="pad-summary-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <div id="pad-summary-sub">粘贴你的运行总结 / 前情提要（比如存在补全预设或别处、剧情推进本来读不到的剧情梗概）。它随【本聊天】保存，并在【普通聊天】与【剧情参谋】模式下插入到最近对话记录的正前方。留空即不启用。</div>
            <textarea id="pad-summary-text" placeholder="在此粘贴剧情概要 / 前情提要…"></textarea>
            <div id="pad-summary-foot"><span id="pad-summary-count"></span></div>
        </div>

        <div id="pad-autowarn">
            <div id="pad-autowarn-card">
                <div id="pad-autowarn-head"><span class="pad-warn-title"><i class="fa-solid fa-triangle-exclamation"></i> 开启自动诊断模式？</span><div class="pad-iconbtn pad-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>
                <div id="pad-autowarn-body">
                    <p>开启后，每当主聊天收到一条新的 AI 回复，剧情推进都会在后台自动处理它的 MVU 变量，并<strong>自动应用</strong>（无需点击确认，每次都会弹出可撤销提示；窗口关着也照常工作）：</p>
                    <p>· 回复里<strong>带有</strong> &lt;UpdateVariable&gt; 更新 → 核验并修正它；<br>· 回复里<strong>没有</strong>更新区块 → 直接据剧情<strong>推导</strong>出本回合应有的变量更新并补上。</p>
                    <p>因此它既能<strong>替代</strong> MVU 的「额外模型解析」，也能在需要时与它配合：外部解析成功后做核验，外部解析失败 / 没有写出有效更新块时接手推导。</p>
                    <p class="pad-autowarn-danger">⚠ 若要与「额外模型解析」<strong>同时</strong>使用，请在诊断设置里勾选「⏳ 兼容 MVU『额外模型解析』」。兼容开关会识别完整重试批次并在写入前协调自动校正；不勾时仍按普通自动诊断时序运行，可能与外部解析抢写。</p>
                    <p class="pad-autowarn-note">自动模式每条回复都会多发一次模型请求，会额外消耗 token。</p>
                </div>
                <label class="pad-autowarn-check"><input type="checkbox" id="pad-autowarn-never"><span>不再提示</span></label>
                <div id="pad-autowarn-btns">
                    <button type="button" id="pad-autowarn-cancel">取消</button>
                    <button type="button" id="pad-autowarn-ok">开启自动模式</button>
                </div>
            </div>
        </div>

        <div id="pad-fixwarn">
            <div id="pad-fixwarn-card">
                <div id="pad-fixwarn-head"><span class="pad-warn-title"><i class="fa-solid fa-circle-info"></i> ✨ 自动校正：一键去 AI 味</span><div class="pad-iconbtn pad-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>
                <div id="pad-fixwarn-body">
                    <p>「自动校正」会把回复里的<strong>故事正文</strong>重写得更像人写的——去 AI 八股 / 套话、让对白自然、收紧读感——并作为<strong>新的一条 swipe</strong> 放进来：原回复永远留在左滑，随时能滑回去，<strong>不破坏存档</strong>。</p>
                    <p class="pad-autowarn-danger"><strong>常见的卡片格式会自动识别</strong>：正文在哪、状态栏 / 选项菜单 / 面板 / 图生指令这些结构块该原样保留，通常不用你设置；认不准时它会<strong>问你一次</strong>（面板出现「✋ 需要确认」点一下就好）。</p>
                    <p>格式特别的卡可能有漏网。遇到识别不对：打开「进阶设置」可以看到<strong>这条回复实际识别到了哪些结构块</strong>，没认出的块点一下（或手动填）加进保留区就行；也欢迎<strong>把那条回复原文在 Discord 私信发给作者 @Prince</strong>——这种格式会加进测试集，之后的版本就能自动认出。</p>
                    <p>面板顶部的<strong>判定行</strong>随时告诉你：最新这条回复会被怎么处理（校正哪几段、保留多少块、还是跳过）。</p>
                    <p>校正只改文字表达：<strong>不</strong>翻译、<strong>不</strong>改设定、<strong>不</strong>算数值、<strong>不</strong>修卡片本身的问题。</p>
                    <p class="pad-autowarn-note">成本：开「每条新回复自动去 AI 味」后每条回复多发一次模型请求；很短 / 很干净的回复自动跳过。只想偶尔用，就用「按目标给最新回复去 AI 味」，点一次跑一次。</p>
                </div>
                <label class="pad-autowarn-check"><input type="checkbox" id="pad-fixwarn-never"><span>不再提示</span></label>
                <div id="pad-fixwarn-btns">
                    <button type="button" id="pad-fixwarn-ok">知道了</button>
                </div>
            </div>
        </div>
        <div id="pad-resize-grip" title="拖动调整大小" aria-label="调整窗口大小"></div>
    `;

}
