/**
 * LifePrisma AI Assistant Plugin for Roundcube
 * Multi-provider support (OpenAI, xAI/Grok, etc.) with streaming, reasoning & verbosity controls
 */
if (window.rcmail) {
    rcmail.addEventListener('init', function() {
        var task = rcmail.env.task;
        var action = rcmail.env.action;

        if (task === 'mail' && action === 'compose') {
            lpai_add_compose_button();
        }

        if (task === 'mail' && (action === 'show' || action === 'preview')) {
            lpai_add_message_button();
        }

        lpai_apply_server_prefs();
        lpai_restore_prefs();
        lpai_bind_events();
    });
}

var lpai_current_action = null;
var lpai_last_result = null;
var lpai_undo_text = null;
var lpai_panel_context = 'compose';
var lpai_history = [];
var lpai_stream_controller = null;

var lpai_options = {
    provider: '',
    model: '',
    language: 'Portuguese',
    tone: 'professional',
    reasoning: 'none',
    verbosity: 'medium'
};

// ========================================
// LocalStorage Persistence
// ========================================
function lpai_save_prefs() {
    try {
        localStorage.setItem('lpai_prefs', JSON.stringify({
            provider: lpai_options.provider,
            model: lpai_options.model,
            language: lpai_options.language,
            tone: lpai_options.tone,
            reasoning: lpai_options.reasoning,
            verbosity: lpai_options.verbosity
        }));
    } catch (e) {}
}

function lpai_restore_prefs() {
    try {
        var saved = JSON.parse(localStorage.getItem('lpai_prefs'));
        if (saved) {
            if (saved.language) lpai_options.language = saved.language;
            if (saved.tone) lpai_options.tone = saved.tone;
            if (saved.reasoning) lpai_options.reasoning = saved.reasoning;
            if (saved.verbosity) lpai_options.verbosity = saved.verbosity;
            if (saved.provider) lpai_options.provider = saved.provider;
            if (saved.model) lpai_options.model = saved.model;
        }
    } catch (e) {}
}

function lpai_apply_server_prefs() {
    var sp = rcmail.env.lpai_user_prefs || {};
    if (sp.language && !localStorage.getItem('lpai_prefs')) lpai_options.language = sp.language;
    if (sp.tone && !localStorage.getItem('lpai_prefs')) lpai_options.tone = sp.tone;
}

// ========================================
// Templates
// ========================================
var lpai_templates = [];

function lpai_load_templates() {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', rcmail.url('plugin.lifeprisma_ai_templates'));
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        try {
            var data = JSON.parse(xhr.responseText);
            if (data.status === 'success') {
                lpai_templates = data.templates || [];
                lpai_render_templates();
            }
        } catch (e) {}
    };
    xhr.send('op=list&_token=' + encodeURIComponent(rcmail.env.request_token));
}

function lpai_render_templates() {
    var sel = document.getElementById('lpai-template-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select template...</option>';
    for (var i = 0; i < lpai_templates.length; i++) {
        var opt = document.createElement('option');
        opt.value = i;
        opt.textContent = lpai_templates[i].name;
        sel.appendChild(opt);
    }
}

function lpai_save_template() {
    var input = document.getElementById('lpai-input');
    var instruction = input ? input.value.trim() : '';
    var action = lpai_current_action || 'compose';

    var name = prompt('Template name:');
    if (!name) return;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', rcmail.url('plugin.lifeprisma_ai_templates'));
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        try {
            var data = JSON.parse(xhr.responseText);
            if (data.status === 'success') {
                lpai_templates = data.templates || [];
                lpai_render_templates();
                if (rcmail.display_message) rcmail.display_message('Template saved', 'confirmation');
            }
        } catch (e) {}
    };
    xhr.send('op=save&name=' + encodeURIComponent(name) + '&tpl_action=' + encodeURIComponent(action) + '&instruction=' + encodeURIComponent(instruction) + '&_token=' + encodeURIComponent(rcmail.env.request_token));
}

function lpai_delete_template(idx) {
    if (idx < 0 || idx >= lpai_templates.length) return;
    var tpl = lpai_templates[idx];

    var xhr = new XMLHttpRequest();
    xhr.open('POST', rcmail.url('plugin.lifeprisma_ai_templates'));
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        try {
            var data = JSON.parse(xhr.responseText);
            if (data.status === 'success') {
                lpai_templates = data.templates || [];
                lpai_render_templates();
                if (rcmail.display_message) rcmail.display_message('Template deleted', 'confirmation');
            }
        } catch (e) {}
    };
    xhr.send('op=delete&id=' + encodeURIComponent(tpl.id) + '&_token=' + encodeURIComponent(rcmail.env.request_token));
}

// ========================================
// Provider Initialization
// ========================================
function lpai_init_provider() {
    var providers = rcmail.env.lpai_providers || {};
    var ids = Object.keys(providers);
    if (ids.length === 0) return;

    // Validate saved provider still exists
    if (lpai_options.provider && !providers[lpai_options.provider]) {
        lpai_options.provider = '';
        lpai_options.model = '';
    }

    if (!lpai_options.provider) {
        lpai_options.provider = ids[0];
        lpai_options.model = providers[ids[0]].default_model;
    }

    // Validate saved model exists for provider
    if (lpai_options.model) {
        var p = providers[lpai_options.provider];
        if (p && p.models && p.models.indexOf(lpai_options.model) < 0) {
            lpai_options.model = p.default_model;
        }
    }
}

// ========================================
// Markdown to HTML
// ========================================
function lpai_md_to_html(text) {
    var html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    html = html.replace(/```[\s\S]*?```/g, function(m) {
        var code = m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        return '<pre style="background:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:13px;overflow-x:auto">' + code + '</pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:13px">$1</code>');
    html = html.replace(/^###### (.+)$/gm, '<strong style="font-size:14px">$1</strong>');
    html = html.replace(/^##### (.+)$/gm, '<strong style="font-size:14px">$1</strong>');
    html = html.replace(/^#### (.+)$/gm, '<strong style="font-size:15px">$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<strong style="font-size:15px">$1</strong>');
    html = html.replace(/^## (.+)$/gm, '<strong style="font-size:16px">$1</strong>');
    html = html.replace(/^# (.+)$/gm, '<strong style="font-size:17px">$1</strong>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    html = html.replace(/^[-*+] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul style="margin:4px 0;padding-left:20px">$1</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #e2e8f0;margin:8px 0">');
    // Markdown tables
    html = html.replace(/((?:^\|.+\|$\n?)+)/gm, function(table) {
        var rows = table.trim().split('\n');
        var out = '<table style="border-collapse:collapse;width:100%;margin:8px 0;font-size:13px">';
        var isHeader = true;
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r].trim();
            if (/^\|[\s\-:|]+\|$/.test(row)) { isHeader = false; continue; }
            var cells = row.split('|').filter(function(c, i, a) { return i > 0 && i < a.length - 1; });
            var tag = isHeader ? 'th' : 'td';
            var bgStyle = isHeader ? 'background:#f4f4f4;font-weight:600;' : '';
            out += '<tr>';
            for (var c = 0; c < cells.length; c++) {
                out += '<' + tag + ' style="' + bgStyle + 'border:1px solid #ddd;padding:4px 8px;text-align:left">' + cells[c].trim() + '</' + tag + '>';
            }
            out += '</tr>';
            if (isHeader) isHeader = false;
        }
        out += '</table>';
        return out;
    });
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/<\/(ul|pre|hr|table)><br>/g, '</$1>');
    html = html.replace(/<br><(ul|pre|table)/g, '<$1');
    return html;
}

// ========================================
// Buttons
// ========================================
function lpai_add_compose_button() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lpai-floating-btn';
    btn.innerHTML = '<span class="lpai-btn-icon">&#9733;</span> GenIA';
    btn.title = 'GenIA Assistant (Alt+A)';
    btn.onclick = function() { lpai_open_panel('compose'); };
    document.body.appendChild(btn);

    // Quick actions toolbar above compose editor
    lpai_add_compose_quick_actions();
}

var lpai_compose_controller = null;

function lpai_add_compose_quick_actions() {
    var container = document.getElementById('composebodycontainer');
    if (!container) return;
    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) return;

    var bar = document.createElement('div');
    bar.className = 'lpai-qa-bar lpai-qa-bar-compose';
    bar.id = 'lpai-qa-bar-compose';

    // Label
    var label = document.createElement('span');
    label.className = 'lpai-qa-label';
    label.innerHTML = '&#9733; GenIA';
    bar.appendChild(label);

    // --- Translate dropdown ---
    var trWrap = document.createElement('div');
    trWrap.className = 'lpai-qa-dropdown';

    var trBtn = document.createElement('button');
    trBtn.type = 'button';
    trBtn.className = 'lpai-qa-btn';
    trBtn.innerHTML = '&#127760; Translate &#9662;';
    trBtn.onclick = function(e) {
        e.stopPropagation();
        var menu = document.getElementById('lpai-compose-tr-menu');
        document.querySelectorAll('.lpai-qa-menu.open').forEach(function(m) {
            if (m.id !== 'lpai-compose-tr-menu') m.classList.remove('open');
        });
        if (menu) menu.classList.toggle('open');
    };
    trWrap.appendChild(trBtn);

    var trMenu = document.createElement('div');
    trMenu.id = 'lpai-compose-tr-menu';
    trMenu.className = 'lpai-qa-menu';

    var langs = [
        { code: 'PT', value: 'Portuguese', flag: '\uD83C\uDDE7\uD83C\uDDF7' },
        { code: 'EN', value: 'English', flag: '\uD83C\uDDFA\uD83C\uDDF8' },
        { code: 'ES', value: 'Spanish', flag: '\uD83C\uDDEA\uD83C\uDDF8' },
        { code: 'FR', value: 'French', flag: '\uD83C\uDDEB\uD83C\uDDF7' },
        { code: 'DE', value: 'German', flag: '\uD83C\uDDE9\uD83C\uDDEA' },
        { code: 'IT', value: 'Italian', flag: '\uD83C\uDDEE\uD83C\uDDF9' }
    ];

    for (var i = 0; i < langs.length; i++) {
        (function(lang) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'lpai-qa-menu-item';
            item.innerHTML = lang.flag + ' ' + lang.value;
            item.onclick = function() {
                trMenu.classList.remove('open');
                lpai_compose_quick('translate', lang.value, trBtn);
            };
            trMenu.appendChild(item);
        })(langs[i]);
    }

    trWrap.appendChild(trMenu);
    bar.appendChild(trWrap);

    // --- Fix Grammar button ---
    var fixBtn = document.createElement('button');
    fixBtn.type = 'button';
    fixBtn.className = 'lpai-qa-btn';
    fixBtn.innerHTML = '&#128295; Fix Grammar';
    fixBtn.onclick = function() { lpai_compose_quick('fix', '', fixBtn); };
    bar.appendChild(fixBtn);

    // --- Rewrite button ---
    var rewriteBtn = document.createElement('button');
    rewriteBtn.type = 'button';
    rewriteBtn.className = 'lpai-qa-btn';
    rewriteBtn.innerHTML = '&#9998; Rewrite';
    rewriteBtn.onclick = function() { lpai_open_panel('compose'); lpai_select_action('rewrite'); };
    bar.appendChild(rewriteBtn);

    // --- Suggest Subject button ---
    var subjectBtn = document.createElement('button');
    subjectBtn.type = 'button';
    subjectBtn.className = 'lpai-qa-btn';
    subjectBtn.innerHTML = '&#128221; Subject';
    subjectBtn.onclick = function() { lpai_suggest_subject(subjectBtn); };
    bar.appendChild(subjectBtn);

    // --- Compose with AI button ---
    var composeBtn = document.createElement('button');
    composeBtn.type = 'button';
    composeBtn.className = 'lpai-qa-btn lpai-qa-reply';
    composeBtn.innerHTML = '&#10024; Compose with AI';
    composeBtn.onclick = function() { lpai_open_panel('compose'); };
    bar.appendChild(composeBtn);

    container.parentNode.insertBefore(bar, container);

    // Close menus on outside click
    document.addEventListener('click', function() {
        var menu = document.getElementById('lpai-compose-tr-menu');
        if (menu) menu.classList.remove('open');
    });
    bar.addEventListener('click', function(e) { e.stopPropagation(); });
}

function lpai_compose_quick(action, language, clickedBtn) {
    lpai_init_provider();

    var editorContent = lpai_get_editor_content();
    if (!editorContent.trim()) {
        if (rcmail.display_message) {
            rcmail.display_message('Write something first, then use GenIA', 'notice');
        }
        return;
    }

    // Save undo
    lpai_undo_text = editorContent;

    var origLabel = clickedBtn.innerHTML;
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = '&#9203; Working...';

    if (lpai_compose_controller) lpai_compose_controller.abort();
    lpai_compose_controller = new AbortController();

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: action,
        instruction: '',
        email_body: editorContent,
        reply_text: '',
        subject: lpai_get_subject(),
        language: language || lpai_options.language,
        tone: lpai_options.tone,
        sender_name: lpai_get_sender_name(),
        reasoning: 'none',
        verbosity: 'medium',
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: '[]',
        msg_uid: '',
        mbox: '',
        view_context: 'compose',
        _token: rcmail.env.request_token
    };

    // Stream into a temporary container, then apply to editor
    var tempDiv = document.createElement('div');
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);

    lpai_stream_to_element(postData, tempDiv, lpai_compose_controller, function(fullText) {
        lpai_compose_controller = null;
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        document.body.removeChild(tempDiv);

        if (fullText) {
            lpai_set_editor_content(fullText);

            // Show undo bar
            var undoBar = document.getElementById('lpai-undo-bar');
            if (!undoBar) {
                undoBar = document.createElement('div');
                undoBar.id = 'lpai-undo-bar';
                undoBar.innerHTML = '<span>GenIA text applied</span><button id="lpai-undo-global" type="button">Undo</button>';
                document.body.appendChild(undoBar);
                document.getElementById('lpai-undo-global').onclick = function() {
                    lpai_undo();
                    undoBar.style.display = 'none';
                };
            }
            undoBar.style.display = 'flex';
            setTimeout(function() {
                if (undoBar) undoBar.style.display = 'none';
            }, 8000);

            if (rcmail.display_message) {
                var msg = action === 'translate' ? 'Translated' : 'Grammar fixed';
                rcmail.display_message('GenIA: ' + msg, 'confirmation');
            }
        }
    }, function(err) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        document.body.removeChild(tempDiv);
        lpai_compose_controller = null;
    });
}

function lpai_add_message_button() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lpai-floating-btn';
    btn.innerHTML = '<span class="lpai-btn-icon">&#9733;</span> GenIA';
    btn.title = 'GenIA Assistant (Alt+A)';
    btn.onclick = function() { lpai_open_panel('read'); };
    document.body.appendChild(btn);

    // Quick actions toolbar above message body
    lpai_add_quick_actions();
}

// ========================================
// Quick Actions Toolbar (Read View)
// ========================================
var lpai_translate_original = null;
var lpai_translate_controller = null;
var lpai_qa_controller = null;

function lpai_add_quick_actions() {
    var msgBody = document.getElementById('messagebody');
    if (!msgBody) return;
    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) return;

    var bar = document.createElement('div');
    bar.className = 'lpai-qa-bar';
    bar.id = 'lpai-qa-bar';

    // Label
    var label = document.createElement('span');
    label.className = 'lpai-qa-label';
    label.innerHTML = '&#9733; GenIA';
    bar.appendChild(label);

    // --- Translate dropdown ---
    var trWrap = document.createElement('div');
    trWrap.className = 'lpai-qa-dropdown';

    var trBtn = document.createElement('button');
    trBtn.type = 'button';
    trBtn.className = 'lpai-qa-btn';
    trBtn.id = 'lpai-qa-translate';
    trBtn.innerHTML = '&#127760; Translate &#9662;';
    trBtn.onclick = function(e) {
        e.stopPropagation();
        var menu = document.getElementById('lpai-tr-menu');
        // Close other menus
        document.querySelectorAll('.lpai-qa-menu.open').forEach(function(m) {
            if (m.id !== 'lpai-tr-menu') m.classList.remove('open');
        });
        if (menu) menu.classList.toggle('open');
    };
    trWrap.appendChild(trBtn);

    var trMenu = document.createElement('div');
    trMenu.id = 'lpai-tr-menu';
    trMenu.className = 'lpai-qa-menu';

    var langs = [
        { code: 'PT', value: 'Portuguese', flag: '\uD83C\uDDE7\uD83C\uDDF7' },
        { code: 'EN', value: 'English', flag: '\uD83C\uDDFA\uD83C\uDDF8' },
        { code: 'ES', value: 'Spanish', flag: '\uD83C\uDDEA\uD83C\uDDF8' },
        { code: 'FR', value: 'French', flag: '\uD83C\uDDEB\uD83C\uDDF7' },
        { code: 'DE', value: 'German', flag: '\uD83C\uDDE9\uD83C\uDDEA' },
        { code: 'IT', value: 'Italian', flag: '\uD83C\uDDEE\uD83C\uDDF9' }
    ];

    for (var i = 0; i < langs.length; i++) {
        (function(lang) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'lpai-qa-menu-item';
            item.innerHTML = lang.flag + ' ' + lang.value;
            item.onclick = function() {
                trMenu.classList.remove('open');
                lpai_translate_inline(lang.value, trBtn);
            };
            trMenu.appendChild(item);
        })(langs[i]);
    }

    // Show original
    var origItem = document.createElement('button');
    origItem.type = 'button';
    origItem.className = 'lpai-qa-menu-item lpai-qa-menu-orig';
    origItem.id = 'lpai-tr-orig';
    origItem.innerHTML = '\u21A9 Show Original';
    origItem.style.display = 'none';
    origItem.onclick = function() {
        trMenu.classList.remove('open');
        lpai_translate_show_original();
    };
    trMenu.appendChild(origItem);

    trWrap.appendChild(trMenu);
    bar.appendChild(trWrap);

    // --- Summarize button ---
    var sumBtn = document.createElement('button');
    sumBtn.type = 'button';
    sumBtn.className = 'lpai-qa-btn';
    sumBtn.innerHTML = '&#128203; Summarize';
    sumBtn.onclick = function() { lpai_quick_action('summarize', sumBtn); };
    bar.appendChild(sumBtn);

    // --- Thread Summary button ---
    var threadBtn = document.createElement('button');
    threadBtn.type = 'button';
    threadBtn.className = 'lpai-qa-btn';
    threadBtn.innerHTML = '&#128209; Thread Summary';
    threadBtn.onclick = function() { lpai_quick_action('thread_summarize', threadBtn); };
    bar.appendChild(threadBtn);

    // --- Scam Check button ---
    var scamBtn = document.createElement('button');
    scamBtn.type = 'button';
    scamBtn.className = 'lpai-qa-btn lpai-qa-scam';
    scamBtn.innerHTML = '&#128737; Scam Check';
    scamBtn.onclick = function() { lpai_quick_action('scam', scamBtn); };
    bar.appendChild(scamBtn);

    // --- Reply with AI button ---
    var replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'lpai-qa-btn lpai-qa-reply';
    replyBtn.innerHTML = '&#10024; Reply with AI';
    replyBtn.onclick = function() { lpai_open_panel('read'); lpai_select_action('reply'); };
    bar.appendChild(replyBtn);

    // --- Result panel (hidden) ---
    var resultPanel = document.createElement('div');
    resultPanel.id = 'lpai-qa-result';
    resultPanel.className = 'lpai-qa-result';
    resultPanel.style.display = 'none';

    var resultHeader = document.createElement('div');
    resultHeader.className = 'lpai-qa-result-header';
    resultHeader.innerHTML = '<span id="lpai-qa-result-title">Result</span>';

    var resultClose = document.createElement('button');
    resultClose.type = 'button';
    resultClose.className = 'lpai-qa-result-close';
    resultClose.innerHTML = '&times;';
    resultClose.onclick = function() { resultPanel.style.display = 'none'; };
    resultHeader.appendChild(resultClose);

    var resultCopy = document.createElement('button');
    resultCopy.type = 'button';
    resultCopy.className = 'lpai-qa-result-copy';
    resultCopy.innerHTML = '&#128203; Copy';
    resultCopy.onclick = function() {
        var text = document.getElementById('lpai-qa-result-text');
        if (text) {
            navigator.clipboard.writeText(text.innerText || text.textContent).then(function() {
                resultCopy.innerHTML = '&#10003; Copied';
                setTimeout(function() { resultCopy.innerHTML = '&#128203; Copy'; }, 2000);
            });
        }
    };
    resultHeader.appendChild(resultCopy);

    resultPanel.appendChild(resultHeader);

    var resultText = document.createElement('div');
    resultText.id = 'lpai-qa-result-text';
    resultText.className = 'lpai-qa-result-text';
    resultPanel.appendChild(resultText);

    // Insert bar and result panel before message body
    msgBody.parentNode.insertBefore(bar, msgBody);
    msgBody.parentNode.insertBefore(resultPanel, msgBody);

    // Close menus on outside click
    document.addEventListener('click', function() {
        document.querySelectorAll('.lpai-qa-menu.open').forEach(function(m) {
            m.classList.remove('open');
        });
    });
    bar.addEventListener('click', function(e) { e.stopPropagation(); });
}

// ========================================
// Quick Action: Summarize / Scam Check (inline streaming)
// ========================================
function lpai_quick_action(action, clickedBtn) {
    lpai_init_provider();

    var msgPart = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart, #messagebody');
    if (!msgPart) return;

    var resultPanel = document.getElementById('lpai-qa-result');
    var resultText = document.getElementById('lpai-qa-result-text');
    var resultTitle = document.getElementById('lpai-qa-result-title');

    if (!resultPanel || !resultText) return;

    // Show result panel
    resultPanel.style.display = 'block';
    resultPanel.className = 'lpai-qa-result' + (action === 'scam' ? ' lpai-qa-result-scam' : '');
    resultText.innerHTML = '';
    if (resultTitle) resultTitle.textContent = action === 'scam' ? 'Scam Analysis' : action === 'thread_summarize' ? 'Thread Summary' : 'Summary';

    // Disable button
    var origLabel = clickedBtn.innerHTML;
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = '&#9203; Analyzing...';

    // Abort previous
    if (lpai_qa_controller) lpai_qa_controller.abort();
    lpai_qa_controller = new AbortController();

    var bodyText = msgPart.innerText || msgPart.textContent || '';

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: action,
        instruction: '',
        email_body: bodyText,
        reply_text: bodyText,
        subject: lpai_get_subject(),
        language: lpai_options.language,
        tone: 'professional',
        sender_name: '',
        reasoning: action === 'scam' ? 'high' : 'none',
        verbosity: 'medium',
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: '[]',
        msg_uid: rcmail.env.uid || '',
        mbox: rcmail.env.mailbox || '',
        view_context: 'read',
        _token: rcmail.env.request_token
    };

    lpai_stream_to_element(postData, resultText, lpai_qa_controller, function() {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        lpai_qa_controller = null;

        // Color the scam result panel based on verdict
        if (action === 'scam') {
            var text = (resultText.innerText || '').toUpperCase();
            if (text.indexOf('DANGEROUS') >= 0) {
                resultPanel.className = 'lpai-qa-result lpai-qa-verdict-danger';
            } else if (text.indexOf('SUSPICIOUS') >= 0) {
                resultPanel.className = 'lpai-qa-result lpai-qa-verdict-warn';
            } else if (text.indexOf('SAFE') >= 0) {
                resultPanel.className = 'lpai-qa-result lpai-qa-verdict-safe';
            }
        }
    }, function(err) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        lpai_qa_controller = null;
    });
}

// ========================================
// Translate Inline (Read View)
// ========================================
function lpai_translate_inline(language, toggleBtn) {
    lpai_init_provider();

    var msgPart = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart, #messagebody');
    if (!msgPart) return;

    if (!lpai_translate_original) {
        lpai_translate_original = msgPart.innerHTML;
    }

    var origItem = document.getElementById('lpai-tr-orig');

    toggleBtn.disabled = true;
    toggleBtn.innerHTML = '&#9203; Translating...';

    if (lpai_translate_controller) lpai_translate_controller.abort();
    lpai_translate_controller = new AbortController();

    var bodyText = (lpai_translate_original ? (function() {
        var tmp = document.createElement('div');
        tmp.innerHTML = lpai_translate_original;
        return tmp.innerText || tmp.textContent || '';
    })() : msgPart.innerText || msgPart.textContent || '');

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: 'translate',
        instruction: '',
        email_body: bodyText,
        reply_text: '',
        subject: lpai_get_subject(),
        language: language,
        tone: 'professional',
        sender_name: '',
        reasoning: 'none',
        verbosity: 'medium',
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: '[]',
        msg_uid: rcmail.env.uid || '',
        mbox: rcmail.env.mailbox || '',
        view_context: 'read',
        _token: rcmail.env.request_token
    };

    lpai_stream_to_element(postData, msgPart, lpai_translate_controller, function() {
        lpai_translate_controller = null;
        toggleBtn.disabled = false;
        toggleBtn.innerHTML = '&#127760; Translated &#10003;';
        toggleBtn.classList.add('translated');
        if (origItem) origItem.style.display = '';
    }, function(err) {
        toggleBtn.disabled = false;
        toggleBtn.innerHTML = '&#127760; Translate &#9662;';
        lpai_translate_controller = null;
    });
}

function lpai_translate_show_original() {
    var msgPart = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart, #messagebody');
    if (msgPart && lpai_translate_original) {
        msgPart.innerHTML = lpai_translate_original;
        lpai_translate_original = null;
    }
    var toggle = document.getElementById('lpai-qa-translate');
    if (toggle) {
        toggle.innerHTML = '&#127760; Translate &#9662;';
        toggle.classList.remove('translated');
    }
    var origItem = document.getElementById('lpai-tr-orig');
    if (origItem) origItem.style.display = 'none';
}

// ========================================
// Shared streaming helper
// ========================================
function lpai_stream_to_element(postData, targetEl, controller, onDone, onError) {
    var encoded = [];
    for (var key in postData) {
        encoded.push(encodeURIComponent(key) + '=' + encodeURIComponent(postData[key]));
    }

    fetch(rcmail.url('plugin.lifeprisma_ai_stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encoded.join('&'),
        signal: controller.signal
    }).then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var fullText = '';

        function readChunk() {
            return reader.read().then(function(result) {
                if (result.done) {
                    if (onDone) onDone(fullText);
                    return;
                }

                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop();

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || !line.startsWith('data: ')) continue;
                    var jsonStr = line.substring(6);
                    if (jsonStr === '[DONE]') continue;
                    try {
                        var event = JSON.parse(jsonStr);
                        if (event.type === 'delta') {
                            fullText += event.text;
                            targetEl.innerHTML = lpai_md_to_html(fullText);
                        } else if (event.type === 'error') {
                            targetEl.innerHTML = '<span style="color:#ef4444">Error: ' + (event.message || 'Unknown') + '</span>';
                        }
                    } catch (e) {}
                }
                return readChunk();
            });
        }
        return readChunk();
    }).catch(function(err) {
        if (err.name === 'AbortError') return;
        targetEl.innerHTML = '<span style="color:#ef4444">Error: ' + err.message + '</span>';
        if (onError) onError(err);
    });
}

// ========================================
// Subject Line Generator
// ========================================
function lpai_suggest_subject(clickedBtn) {
    lpai_init_provider();

    var editorContent = lpai_get_editor_content();
    if (!editorContent.trim()) {
        if (rcmail.display_message) rcmail.display_message('Write something first, then suggest a subject', 'notice');
        return;
    }

    var origLabel = clickedBtn.innerHTML;
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = '&#9203; Thinking...';

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: 'suggest_subject',
        instruction: '',
        email_body: editorContent,
        reply_text: '',
        subject: '',
        language: lpai_options.language,
        tone: lpai_options.tone,
        sender_name: lpai_get_sender_name(),
        reasoning: 'none',
        verbosity: 'low',
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: '[]',
        msg_uid: '',
        mbox: '',
        view_context: 'compose',
        _token: rcmail.env.request_token
    };

    var encoded = [];
    for (var key in postData) {
        encoded.push(encodeURIComponent(key) + '=' + encodeURIComponent(postData[key]));
    }

    fetch(rcmail.url('plugin.lifeprisma_ai_request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encoded.join('&')
    }).then(function(r) { return r.json(); }).then(function(data) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;

        if (data.status === 'success' && data.result) {
            lpai_show_subject_picker(data.result);
        } else {
            if (rcmail.display_message) rcmail.display_message('Error: ' + (data.message || 'Failed'), 'error');
        }
    }).catch(function(err) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        if (rcmail.display_message) rcmail.display_message('Error: ' + err.message, 'error');
    });
}

function lpai_show_subject_picker(text) {
    var existing = document.getElementById('lpai-subject-picker');
    if (existing) existing.remove();

    var lines = text.split('\n').filter(function(l) { return l.trim().match(/^\d+[\.\)]/); });
    if (lines.length === 0) lines = text.split('\n').filter(function(l) { return l.trim().length > 0; });

    var picker = document.createElement('div');
    picker.id = 'lpai-subject-picker';
    picker.className = 'lpai-qa-result';
    picker.style.margin = '0 0 4px 0';

    var header = document.createElement('div');
    header.className = 'lpai-qa-result-header';
    header.innerHTML = '<span>Pick a subject line</span>';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'lpai-qa-result-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = function() { picker.remove(); };
    header.appendChild(closeBtn);
    picker.appendChild(header);

    var body = document.createElement('div');
    body.className = 'lpai-qa-result-text';
    body.style.padding = '4px 8px';

    for (var i = 0; i < lines.length; i++) {
        (function(line) {
            var cleaned = line.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim();
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lpai-qa-btn';
            btn.style.cssText = 'display:block;width:100%;text-align:left;margin:3px 0;padding:6px 10px;white-space:normal';
            btn.textContent = cleaned;
            btn.onclick = function() {
                var subjectInput = document.getElementById('compose-subject') || document.querySelector('input[name="_subject"]');
                if (subjectInput) {
                    subjectInput.value = cleaned;
                    if (rcmail.display_message) rcmail.display_message('Subject line applied', 'confirmation');
                }
                picker.remove();
            };
            body.appendChild(btn);
        })(lines[i]);
    }

    picker.appendChild(body);

    var bar = document.getElementById('lpai-qa-bar-compose');
    if (bar) bar.parentNode.insertBefore(picker, bar.nextSibling);
}

// ========================================
// Context Preview
// ========================================
function lpai_update_context_preview() {
    var ctx = document.getElementById('lpai-context-preview');
    var body = document.getElementById('lpai-context-body');
    if (!ctx || !body) return;

    if (!lpai_current_action) {
        ctx.style.display = 'none';
        return;
    }

    var emailBody = lpai_get_editor_content();
    var replyText = lpai_get_reply_text();
    var subject = lpai_get_subject();
    var parts = [];

    if (subject) parts.push('<strong>Subject:</strong> ' + subject.replace(/</g, '&lt;'));
    if (['reply', 'summarize', 'scam', 'thread_summarize'].indexOf(lpai_current_action) >= 0 && replyText) {
        var preview = replyText.substring(0, 300);
        if (replyText.length > 300) preview += '...';
        parts.push('<strong>Original email:</strong> ' + preview.replace(/</g, '&lt;').replace(/\n/g, '<br>'));
    }
    if (['rewrite', 'fix', 'translate'].indexOf(lpai_current_action) >= 0 && emailBody) {
        var preview = emailBody.substring(0, 300);
        if (emailBody.length > 300) preview += '...';
        parts.push('<strong>Current draft:</strong> ' + preview.replace(/</g, '&lt;').replace(/\n/g, '<br>'));
    }

    if (parts.length > 0) {
        body.innerHTML = parts.join('<hr style="border:none;border-top:1px solid #eee;margin:6px 0">');
        ctx.style.display = 'block';
    } else {
        ctx.style.display = 'none';
    }
}

// ========================================
// Draft Integration
// ========================================
function lpai_save_as_draft() {
    if (!lpai_last_result) return;

    lpai_undo_text = lpai_get_editor_content();
    lpai_set_editor_content(lpai_last_result);
    lpai_close_panel();

    setTimeout(function() {
        if (rcmail.command) rcmail.command('savedraft');
        if (rcmail.display_message) rcmail.display_message('GenIA content saved as draft', 'confirmation');
    }, 300);
}

// ========================================
// Model Buttons
// ========================================
function lpai_update_model_buttons() {
    var provider = lpai_options.provider;
    var providers = rcmail.env.lpai_providers || {};
    var providerConfig = providers[provider] || {};
    var modelBtns = document.querySelectorAll('.lpai-model-btn');
    var firstVisible = null;

    modelBtns.forEach(function(btn) {
        if (btn.dataset.provider === provider) {
            btn.style.display = '';
            if (!firstVisible) firstVisible = btn;
        } else {
            btn.style.display = 'none';
            btn.classList.remove('active');
        }
    });

    var activeModel = document.querySelector('.lpai-model-btn.active[data-provider="' + provider + '"]');
    if (!activeModel && firstVisible) {
        firstVisible.classList.add('active');
        lpai_options.model = firstVisible.dataset.value;
    } else if (activeModel) {
        lpai_options.model = activeModel.dataset.value;
    }

    var reasoningRow = document.getElementById('lpai-reasoning-row');
    var verbosityRow = document.getElementById('lpai-verbosity-row');
    var supportsReasoning = providerConfig.supports_reasoning !== false;

    if (reasoningRow) reasoningRow.style.display = supportsReasoning ? 'flex' : 'none';
    if (verbosityRow) verbosityRow.style.display = supportsReasoning ? 'flex' : 'none';
}

// ========================================
// Event Binding
// ========================================
function lpai_bind_events() {
    document.addEventListener('click', function(e) {
        if (e.target.id === 'lpai-close' || e.target.id === 'lpai-overlay') {
            lpai_close_panel();
        }
        if (e.target.classList.contains('lpai-action-btn')) {
            lpai_select_action(e.target.dataset.action);
        }
        var providerBtn = e.target.closest('.lpai-provider-btn');
        if (providerBtn) {
            lpai_options.provider = providerBtn.dataset.value;
            var siblings = document.querySelectorAll('.lpai-provider-btn');
            siblings.forEach(function(b) { b.classList.remove('active'); });
            providerBtn.classList.add('active');
            lpai_update_model_buttons();
            lpai_save_prefs();
        }
        if (e.target.classList.contains('lpai-opt-btn')) {
            var group = e.target.dataset.group;
            var value = e.target.dataset.value;

            if (group === 'model') {
                lpai_options.model = value;
                var provider = lpai_options.provider;
                var siblings = document.querySelectorAll('.lpai-model-btn[data-provider="' + provider + '"]');
                siblings.forEach(function(b) { b.classList.remove('active'); });
                e.target.classList.add('active');
            } else {
                lpai_options[group] = value;
                var siblings = document.querySelectorAll('.lpai-opt-btn[data-group="' + group + '"]');
                siblings.forEach(function(b) { b.classList.remove('active'); });
                e.target.classList.add('active');
            }
            lpai_save_prefs();
        }
        if (e.target.id === 'lpai-submit') {
            lpai_submit();
        }
        if (e.target.id === 'lpai-apply') {
            lpai_apply_result();
        }
        if (e.target.id === 'lpai-copy') {
            lpai_copy_result();
        }
        if (e.target.id === 'lpai-undo') {
            lpai_undo();
        }
        if (e.target.id === 'lpai-draft') {
            lpai_save_as_draft();
        }
        if (e.target.id === 'lpai-template-save') {
            lpai_save_template();
        }
        if (e.target.id === 'lpai-template-delete') {
            var sel = document.getElementById('lpai-template-select');
            if (sel && sel.value !== '') lpai_delete_template(parseInt(sel.value));
        }
        if (e.target.id === 'lpai-context-toggle' || e.target.id === 'lpai-context-arrow') {
            var body = document.getElementById('lpai-context-body');
            var arrow = document.getElementById('lpai-context-arrow');
            if (body) {
                var show = body.style.display === 'none';
                body.style.display = show ? 'block' : 'none';
                if (arrow) arrow.innerHTML = show ? '&#9660;' : '&#9654;';
            }
        }
    });

    // Template select change
    document.addEventListener('change', function(e) {
        if (e.target.id === 'lpai-template-select') {
            var idx = parseInt(e.target.value);
            var delBtn = document.getElementById('lpai-template-delete');
            if (isNaN(idx) || idx < 0 || idx >= lpai_templates.length) {
                if (delBtn) delBtn.style.display = 'none';
                return;
            }
            if (delBtn) delBtn.style.display = '';
            var tpl = lpai_templates[idx];
            if (tpl.action) lpai_select_action(tpl.action);
            var input = document.getElementById('lpai-input');
            if (input && tpl.instruction) {
                input.value = tpl.instruction;
                input.style.display = '';
            }
        }
    });

    document.addEventListener('keydown', function(e) {
        if (e.target.id === 'lpai-input' && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            lpai_submit();
        }
        if (e.key === 'Escape') {
            lpai_close_panel();
        }
        // Alt+A to toggle panel
        if (e.altKey && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            var panel = document.getElementById('lpai-panel');
            if (panel && panel.style.display !== 'none') {
                lpai_close_panel();
            } else {
                var action = rcmail.env.action;
                var ctx = (action === 'show' || action === 'preview') ? 'read' : 'compose';
                lpai_open_panel(ctx);
            }
        }
    });
}

// ========================================
// Panel Open/Close
// ========================================
function lpai_show_setup_message(container) {
    container.innerHTML =
        '<div style="text-align:center;padding:32px 20px;color:#64748b">' +
        '<div style="font-size:40px;margin-bottom:12px">&#9881;</div>' +
        '<div style="font-size:16px;font-weight:600;color:#334155;margin-bottom:8px">GenIA is not configured yet</div>' +
        '<div style="font-size:13px;line-height:1.6;max-width:360px;margin:0 auto">' +
        'Your server admin needs to add API keys to the plugin config file:<br>' +
        '<code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:12px;display:inline-block;margin:8px 0">' +
        'plugins/lifeprisma_ai/config.inc.php</code><br>' +
        'Supports <strong>OpenAI</strong> (GPT) and <strong>xAI</strong> (Grok).<br>' +
        '<a href="https://github.com/eduardostern/roundcube-genia#configuration" target="_blank" ' +
        'style="color:#6366f1;text-decoration:underline;margin-top:8px;display:inline-block">Setup guide &rarr;</a>' +
        '</div></div>';
}

function lpai_open_panel(context) {
    var panel = document.getElementById('lpai-panel');
    var overlay = document.getElementById('lpai-overlay');
    if (!panel || !overlay) return;

    lpai_init_provider();

    lpai_panel_context = context || 'compose';
    lpai_current_action = null;
    lpai_last_result = null;
    lpai_history = [];

    var input = document.getElementById('lpai-input');
    var preview = document.getElementById('lpai-preview');
    var applyBtn = document.getElementById('lpai-apply');
    var copyBtn = document.getElementById('lpai-copy');
    var undoBtn = document.getElementById('lpai-undo');
    var loading = document.getElementById('lpai-loading');
    var langRow = document.getElementById('lpai-lang-row');
    var toneRow = document.getElementById('lpai-tone-row');

    // Check if providers are configured
    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) {
        panel.style.display = 'flex';
        overlay.style.display = 'block';
        var body = panel.querySelector('.lpai-panel-body') || panel;
        lpai_show_setup_message(body);
        return;
    }

    var draftBtn = document.getElementById('lpai-draft');
    var templatesRow = document.getElementById('lpai-templates-row');
    var ctxPreview = document.getElementById('lpai-context-preview');

    if (input) { input.value = ''; input.placeholder = 'What do you want GenIA to do?'; input.style.display = ''; }
    if (preview) preview.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';
    if (undoBtn) undoBtn.style.display = 'none';
    if (draftBtn) draftBtn.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (langRow) langRow.style.display = 'none';
    if (toneRow) toneRow.style.display = 'none';
    if (templatesRow) templatesRow.style.display = 'flex';
    if (ctxPreview) ctxPreview.style.display = 'none';

    lpai_load_templates();

    // Restore saved option buttons
    document.querySelectorAll('.lpai-opt-btn[data-group="language"]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.value === lpai_options.language);
    });
    document.querySelectorAll('.lpai-opt-btn[data-group="tone"]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.value === lpai_options.tone);
    });
    document.querySelectorAll('.lpai-opt-btn[data-group="reasoning"]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.value === lpai_options.reasoning);
    });
    document.querySelectorAll('.lpai-opt-btn[data-group="verbosity"]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.value === lpai_options.verbosity);
    });

    // Restore provider button
    document.querySelectorAll('.lpai-provider-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.value === lpai_options.provider);
    });

    var btns = document.querySelectorAll('.lpai-action-btn');
    btns.forEach(function(b) { b.classList.remove('active'); });

    var providers = rcmail.env.lpai_providers || {};
    var providerRow = document.getElementById('lpai-provider-row');
    var modelRow = document.getElementById('lpai-model-row');
    var providerCount = Object.keys(providers).length;
    if (providerRow) providerRow.style.display = providerCount > 1 ? 'flex' : 'none';

    lpai_update_model_buttons();
    if (modelRow) {
        var visibleModels = document.querySelectorAll('.lpai-model-btn[data-provider="' + lpai_options.provider + '"]');
        modelRow.style.display = visibleModels.length > 1 ? 'flex' : 'none';
    }

    var summarizeBtn = document.querySelector('[data-action="summarize"]');
    var replyBtn = document.querySelector('[data-action="reply"]');
    var composeBtn = document.querySelector('[data-action="compose"]');
    var rewriteBtn = document.querySelector('[data-action="rewrite"]');
    var fixBtn = document.querySelector('[data-action="fix"]');
    var translateBtn = document.querySelector('[data-action="translate"]');
    var scamBtn = document.querySelector('[data-action="scam"]');
    var subjectLineBtn = document.querySelector('[data-action="suggest_subject"]');
    var threadSumBtn = document.querySelector('[data-action="thread_summarize"]');

    if (context === 'read') {
        if (composeBtn) composeBtn.style.display = 'none';
        if (rewriteBtn) rewriteBtn.style.display = 'none';
        if (fixBtn) fixBtn.style.display = 'none';
        if (translateBtn) translateBtn.style.display = 'none';
        if (subjectLineBtn) subjectLineBtn.style.display = 'none';
        if (summarizeBtn) summarizeBtn.style.display = '';
        if (threadSumBtn) threadSumBtn.style.display = '';
        if (replyBtn) replyBtn.style.display = '';
        if (scamBtn) scamBtn.style.display = '';
    } else {
        if (composeBtn) composeBtn.style.display = '';
        if (rewriteBtn) rewriteBtn.style.display = '';
        if (fixBtn) fixBtn.style.display = '';
        if (translateBtn) translateBtn.style.display = '';
        if (subjectLineBtn) subjectLineBtn.style.display = '';
        if (summarizeBtn) summarizeBtn.style.display = '';
        if (threadSumBtn) threadSumBtn.style.display = 'none';
        if (replyBtn) replyBtn.style.display = '';
        if (scamBtn) scamBtn.style.display = '';
    }

    panel.style.display = 'flex';
    overlay.style.display = 'block';

    if (input) setTimeout(function() { input.focus(); }, 100);
}

function lpai_close_panel() {
    if (lpai_stream_controller) {
        lpai_stream_controller.abort();
        lpai_stream_controller = null;
    }
    var panel = document.getElementById('lpai-panel');
    var overlay = document.getElementById('lpai-overlay');
    if (panel) panel.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// ========================================
// Action Selection
// ========================================
function lpai_select_action(action) {
    lpai_current_action = action;

    var btns = document.querySelectorAll('.lpai-action-btn');
    btns.forEach(function(b) {
        b.classList.toggle('active', b.dataset.action === action);
    });

    var input = document.getElementById('lpai-input');
    var langRow = document.getElementById('lpai-lang-row');
    var toneRow = document.getElementById('lpai-tone-row');
    var preview = document.getElementById('lpai-preview');
    var applyBtn = document.getElementById('lpai-apply');
    var copyBtn = document.getElementById('lpai-copy');

    if (preview) preview.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';

    var showLang = ['compose', 'rewrite', 'reply', 'translate', 'summarize'].indexOf(action) >= 0;
    var showTone = ['compose', 'rewrite', 'reply'].indexOf(action) >= 0;
    if (langRow) langRow.style.display = showLang ? 'flex' : 'none';
    if (toneRow) toneRow.style.display = showTone ? 'flex' : 'none';

    if (action === 'scam') {
        lpai_options.reasoning = 'high';
        var reasonBtns = document.querySelectorAll('.lpai-opt-btn[data-group="reasoning"]');
        reasonBtns.forEach(function(b) {
            b.classList.toggle('active', b.dataset.value === 'high');
        });
    }

    if (input) {
        switch (action) {
            case 'compose':
                input.placeholder = 'Describe the email you want to write...';
                input.style.display = '';
                break;
            case 'rewrite':
                input.placeholder = 'How should it be rewritten? (optional)';
                input.style.display = '';
                break;
            case 'reply':
                input.placeholder = 'What should the reply say?';
                input.style.display = '';
                break;
            case 'suggest_subject':
                input.style.display = 'none';
                break;
            case 'thread_summarize':
            case 'translate':
            case 'summarize':
            case 'fix':
            case 'scam':
                input.style.display = 'none';
                break;
        }
        if (input.style.display !== 'none') input.focus();
    }

    lpai_update_context_preview();
}

// ========================================
// Content Helpers
// ========================================
function lpai_get_editor_content() {
    if (window.tinyMCE && tinyMCE.activeEditor) {
        return tinyMCE.activeEditor.getContent({ format: 'text' });
    }
    var textarea = document.getElementById('composebody') || document.querySelector('textarea[name="_message"]');
    if (textarea) return textarea.value;
    return '';
}

function lpai_set_editor_content(text) {
    if (window.tinyMCE && tinyMCE.activeEditor) {
        tinyMCE.activeEditor.setContent(lpai_md_to_html(text));
        return;
    }
    var plain = text
        .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/_(.+?)_/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/```[\s\S]*?```/g, function(m) {
            return m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        });
    var textarea = document.getElementById('composebody') || document.querySelector('textarea[name="_message"]');
    if (textarea) textarea.value = plain;
}

function lpai_get_reply_text() {
    // In read view, prefer original content over translated content
    if (lpai_translate_original) {
        var tmp = document.createElement('div');
        tmp.innerHTML = lpai_translate_original;
        return tmp.innerText || tmp.textContent || '';
    }

    // Try to get just the message content, not the full #messagebody container
    var msgBody = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart');
    if (msgBody) return msgBody.innerText || msgBody.textContent || '';

    // Fallback: full messagebody
    var fullBody = document.getElementById('messagebody');
    if (fullBody) return fullBody.innerText || fullBody.textContent || '';

    // Compose view: extract quoted text
    var content = lpai_get_editor_content();
    var lines = content.split('\n');
    var quoted = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].match(/^>/) || lines[i].match(/^On .+ wrote:/)) {
            quoted.push(lines[i].replace(/^>\s?/, ''));
        }
    }
    return quoted.length > 0 ? quoted.join('\n') : '';
}

function lpai_get_subject() {
    var subjectInput = document.getElementById('compose-subject') || document.querySelector('input[name="_subject"]');
    if (subjectInput) return subjectInput.value;
    var subjectHeader = document.querySelector('.subject span, h2.subject');
    if (subjectHeader) return subjectHeader.textContent;
    return '';
}

function lpai_get_sender_name() {
    var fromSelect = document.getElementById('_from') || document.querySelector('select[name="_from"]');
    if (fromSelect) {
        var text = fromSelect.options[fromSelect.selectedIndex].text;
        var match = text.match(/^([^<]+)/);
        return match ? match[1].trim() : text;
    }
    return '';
}

// ========================================
// Submit (Main Panel)
// ========================================
function lpai_submit() {
    if (!lpai_current_action) {
        var content = lpai_get_editor_content();
        lpai_current_action = content ? 'rewrite' : 'compose';
        var btn = document.querySelector('[data-action="' + lpai_current_action + '"]');
        if (btn) btn.classList.add('active');
    }

    var input = document.getElementById('lpai-input');
    var instruction = input ? input.value.trim() : '';
    var loading = document.getElementById('lpai-loading');
    var loadingText = document.getElementById('lpai-loading-text');
    var submitBtn = document.getElementById('lpai-submit');
    var preview = document.getElementById('lpai-preview');
    var previewText = document.getElementById('lpai-preview-text');
    var previewLabel = document.getElementById('lpai-preview-label');
    var applyBtn = document.getElementById('lpai-apply');
    var copyBtn = document.getElementById('lpai-copy');

    if (['compose', 'reply'].indexOf(lpai_current_action) >= 0 && !instruction) {
        if (input) {
            input.style.borderColor = '#e74c3c';
            input.focus();
            setTimeout(function() { input.style.borderColor = ''; }, 2000);
        }
        return;
    }

    if (loading) { loading.style.display = 'flex'; }
    if (loadingText) { loadingText.textContent = lpai_options.reasoning !== 'none' ? 'Reasoning...' : 'Thinking...'; }
    if (submitBtn) submitBtn.disabled = true;
    if (preview) preview.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: lpai_current_action,
        instruction: instruction,
        email_body: lpai_get_editor_content(),
        reply_text: lpai_get_reply_text(),
        subject: lpai_get_subject(),
        language: lpai_options.language,
        tone: lpai_options.tone,
        sender_name: lpai_get_sender_name(),
        reasoning: lpai_options.reasoning,
        verbosity: lpai_options.verbosity,
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: JSON.stringify(lpai_history),
        msg_uid: rcmail.env.uid || '',
        mbox: rcmail.env.mailbox || '',
        view_context: lpai_panel_context,
        _token: rcmail.env.request_token
    };

    var encoded = [];
    for (var key in postData) {
        encoded.push(encodeURIComponent(key) + '=' + encodeURIComponent(postData[key]));
    }

    lpai_stream_controller = new AbortController();

    fetch(rcmail.url('plugin.lifeprisma_ai_stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encoded.join('&'),
        signal: lpai_stream_controller.signal
    }).then(function(response) {
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var fullText = '';

        if (loading) loading.style.display = 'none';
        if (preview) preview.style.display = 'block';
        if (previewText) previewText.textContent = '';
        if (previewLabel) previewLabel.textContent = 'Preview';

        function readChunk() {
            return reader.read().then(function(result) {
                if (result.done) {
                    lpai_stream_controller = null;
                    if (submitBtn) submitBtn.disabled = false;

                    if (fullText) {
                        lpai_last_result = fullText;
                        if (instruction) {
                            lpai_history.push({ role: 'user', content: instruction });
                        }
                        lpai_history.push({ role: 'assistant', content: fullText });

                        // Show copy button always
                        if (copyBtn) copyBtn.style.display = '';

                        if (['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                            if (applyBtn) applyBtn.style.display = '';
                            var draftBtn = document.getElementById('lpai-draft');
                            if (draftBtn) draftBtn.style.display = '';
                        }

                        // Auto-save draft if preference enabled
                        var sp = rcmail.env.lpai_user_prefs || {};
                        if (sp.auto_draft && ['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                            lpai_undo_text = lpai_get_editor_content();
                            lpai_set_editor_content(fullText);
                            setTimeout(function() { if (rcmail.command) rcmail.command('savedraft'); }, 300);
                        }

                        // Show follow-up hint
                        var inp = document.getElementById('lpai-input');
                        if (inp) {
                            inp.value = '';
                            inp.placeholder = 'Follow up: "make it shorter", "translate to english"...';
                            inp.style.display = '';
                        }
                    }
                    return;
                }

                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop();

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || !line.startsWith('data: ')) continue;
                    var jsonStr = line.substring(6);
                    if (jsonStr === '[DONE]') continue;

                    try {
                        var event = JSON.parse(jsonStr);
                        if (event.type === 'delta') {
                            fullText += event.text;
                            if (previewText) previewText.innerHTML = lpai_md_to_html(fullText);
                            previewText.scrollTop = previewText.scrollHeight;
                        } else if (event.type === 'done') {
                            var label = 'Preview';
                            if (event.tokens) {
                                label += ' \u00B7 ' + event.tokens.input + ' in / ' + event.tokens.output + ' out tokens';
                            }
                            if (previewLabel) previewLabel.textContent = label;
                        } else if (event.type === 'error') {
                            if (previewText) previewText.textContent = 'Error: ' + (event.message || 'Unknown error');
                            if (previewLabel) previewLabel.textContent = 'Error';
                        }
                    } catch (e) {}
                }

                return readChunk();
            });
        }

        return readChunk();
    }).catch(function(err) {
        if (err.name === 'AbortError') return;

        if (loading) loading.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
        if (preview) preview.style.display = 'block';
        if (previewText) previewText.textContent = 'Error: ' + err.message;
        if (previewLabel) previewLabel.textContent = 'Error';
        lpai_stream_controller = null;

        lpai_submit_fallback(postData);
    });
}

function lpai_submit_fallback(postData) {
    postData._action = 'plugin.lifeprisma_ai_request';
    var encoded = [];
    for (var key in postData) {
        encoded.push(encodeURIComponent(key) + '=' + encodeURIComponent(postData[key]));
    }

    var preview = document.getElementById('lpai-preview');
    var previewText = document.getElementById('lpai-preview-text');
    var previewLabel = document.getElementById('lpai-preview-label');
    var applyBtn = document.getElementById('lpai-apply');
    var copyBtn = document.getElementById('lpai-copy');
    var submitBtn = document.getElementById('lpai-submit');
    var loading = document.getElementById('lpai-loading');

    if (loading) loading.style.display = 'flex';
    if (preview) preview.style.display = 'none';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', rcmail.url('plugin.lifeprisma_ai_request'));
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;

        if (loading) loading.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;

        try {
            var data = JSON.parse(xhr.responseText);
            if (data.status === 'success' && data.result) {
                lpai_last_result = data.result;
                if (previewText) previewText.innerHTML = lpai_md_to_html(data.result);

                var label = 'Preview';
                if (data.tokens) {
                    label += ' \u00B7 ' + data.tokens.input + ' in / ' + data.tokens.output + ' out tokens';
                }
                if (previewLabel) previewLabel.textContent = label;
                if (preview) preview.style.display = 'block';

                if (copyBtn) copyBtn.style.display = '';
                if (['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                    if (applyBtn) applyBtn.style.display = '';
                    var draftBtn = document.getElementById('lpai-draft');
                    if (draftBtn) draftBtn.style.display = '';
                }
            } else {
                var msg = data.message || 'An error occurred';
                if (previewText) previewText.textContent = 'Error: ' + msg;
                if (previewLabel) previewLabel.textContent = 'Error';
                if (preview) preview.style.display = 'block';
            }
        } catch (e) {
            if (previewText) previewText.textContent = 'Error: Invalid response from server';
            if (previewLabel) previewLabel.textContent = 'Error';
            if (preview) preview.style.display = 'block';
        }
    };
    xhr.send(encoded.join('&'));
}

// ========================================
// Apply / Copy / Undo
// ========================================
function lpai_copy_result() {
    if (!lpai_last_result) return;
    navigator.clipboard.writeText(lpai_last_result).then(function() {
        var btn = document.getElementById('lpai-copy');
        if (btn) {
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
        }
        if (rcmail.display_message) {
            rcmail.display_message('Copied to clipboard', 'confirmation');
        }
    });
}

function lpai_apply_result() {
    if (!lpai_last_result) return;

    var isReadView = rcmail.env.action === 'show' || rcmail.env.action === 'preview';

    if (isReadView) {
        lpai_close_panel();

        window.lpai_pending_apply = lpai_last_result;
        rcmail.command('reply');

        var attempts = 0;
        var applyInterval = setInterval(function() {
            attempts++;
            var editor = (window.tinyMCE && tinyMCE.activeEditor) ||
                         document.getElementById('composebody') ||
                         document.querySelector('textarea[name="_message"]');

            if (editor && window.lpai_pending_apply) {
                setTimeout(function() {
                    lpai_set_editor_content(window.lpai_pending_apply);
                    window.lpai_pending_apply = null;
                    if (rcmail.display_message) {
                        rcmail.display_message('GenIA reply applied', 'confirmation');
                    }
                }, 500);
                clearInterval(applyInterval);
            }

            if (attempts > 40) {
                clearInterval(applyInterval);
                if (window.lpai_pending_apply) {
                    navigator.clipboard.writeText(window.lpai_pending_apply).then(function() {
                        rcmail.display_message('Reply copied to clipboard - paste it in the editor', 'notice');
                    });
                    window.lpai_pending_apply = null;
                }
            }
        }, 200);
        return;
    }

    lpai_undo_text = lpai_get_editor_content();
    lpai_set_editor_content(lpai_last_result);
    lpai_close_panel();

    var undoBar = document.getElementById('lpai-undo-bar');
    if (!undoBar) {
        undoBar = document.createElement('div');
        undoBar.id = 'lpai-undo-bar';
        undoBar.innerHTML = '<span>GenIA text applied</span><button id="lpai-undo-global" type="button">Undo</button>';
        document.body.appendChild(undoBar);
        document.getElementById('lpai-undo-global').onclick = function() {
            lpai_undo();
            undoBar.style.display = 'none';
        };
    }
    undoBar.style.display = 'flex';
    setTimeout(function() {
        if (undoBar) undoBar.style.display = 'none';
    }, 8000);

    if (rcmail.display_message) {
        rcmail.display_message('GenIA text applied', 'confirmation');
    }
}

function lpai_undo() {
    if (lpai_undo_text === null) return;
    lpai_set_editor_content(lpai_undo_text);
    lpai_undo_text = null;

    var undoBar = document.getElementById('lpai-undo-bar');
    if (undoBar) undoBar.style.display = 'none';

    if (rcmail.display_message) {
        rcmail.display_message('Undo successful', 'confirmation');
    }
}
