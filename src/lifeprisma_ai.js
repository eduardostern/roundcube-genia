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
            lpai_check_pending_reply();
            lpai_init_smart_compose();
            lpai_init_send_time();
        }

        if (task === 'mail' && (action === 'show' || action === 'preview')) {
            lpai_add_message_button();
            // Delayed follow-up detection (don't slow down page load)
            setTimeout(function() { lpai_init_followup_detection(); }, 1000);
        }

        if (task === 'settings') {
            // Init admin panel if on that section
            setTimeout(function() { if (window.lpai_init_admin) lpai_init_admin(); }, 300);
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

function lpai_check_pending_reply() {
    try {
        var pending = localStorage.getItem('lpai_pending_reply');
        if (pending) {
            localStorage.removeItem('lpai_pending_reply');
            // Wait for TinyMCE/compose to fully load, then open GenIA with reply
            setTimeout(function() {
                lpai_open_panel('compose');
                lpai_select_action('reply');
            }, 800);
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
        // Use admin-configured default provider if set
        var defaultProvider = rcmail.env.lpai_default_provider || '';
        if (defaultProvider && providers[defaultProvider]) {
            lpai_options.provider = defaultProvider;
            lpai_options.model = providers[defaultProvider].default_model;
        } else {
            lpai_options.provider = ids[0];
            lpai_options.model = providers[ids[0]].default_model;
        }
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
        attachments: lpai_get_attachments_json(),
        _token: rcmail.env.request_token
    };

    // Stream into a temporary container, then apply to editor
    var tempDiv = document.createElement('div');
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);

    lpai_stream_to_element(postData, tempDiv, lpai_compose_controller, function(fullText, tokens, model) {
        lpai_compose_controller = null;
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        document.body.removeChild(tempDiv);

        if (fullText) {
            lpai_set_editor_content(fullText);

            // Show undo bar with usage info
            var undoBar = document.getElementById('lpai-undo-bar');
            if (!undoBar) {
                undoBar = document.createElement('div');
                undoBar.id = 'lpai-undo-bar';
                document.body.appendChild(undoBar);
            }
            var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);
            undoBar.innerHTML = '<span>GenIA text applied' + (usageLabel ? ' \u00B7 ' + usageLabel : '') + '</span><button id="lpai-undo-global" type="button">Undo</button>';
            document.getElementById('lpai-undo-global').onclick = function() {
                lpai_undo();
                undoBar.style.display = 'none';
            };
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

    // Spam score badge
    var msgCtx = rcmail.env.lpai_msg_context || {};
    var spamScore = msgCtx.spam_score;
    if (spamScore !== null && spamScore !== undefined) {
        var scoreBadge = document.createElement('span');
        var scoreClass = 'lpai-spam-score';
        if (spamScore >= 4) scoreClass += ' lpai-spam-high';
        else if (spamScore >= 2) scoreClass += ' lpai-spam-med';
        else scoreClass += ' lpai-spam-low';
        scoreBadge.className = scoreClass;
        scoreBadge.title = 'Rspamd spam score (threshold: 4)';
        scoreBadge.textContent = 'Spam: ' + spamScore.toFixed(1);
        bar.appendChild(scoreBadge);
    }

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
                lpai_translate_to(lang.value, trBtn);
            };
            trMenu.appendChild(item);
        })(langs[i]);
    }

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
    replyBtn.onclick = function() {
        // Navigate to compose reply and auto-open GenIA there
        try { localStorage.setItem('lpai_pending_reply', '1'); } catch (e) {}
        rcmail.command('reply');
    };
    bar.appendChild(replyBtn);

    // --- Snippet extraction buttons ---
    lpai_add_snippet_buttons(bar);

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
    var titles = {
        'scam': 'Scam Analysis', 'thread_summarize': 'Thread Summary', 'summarize': 'Summary',
        'extract_actions': 'Action Items', 'extract_dates': 'Dates & Deadlines', 'extract_contacts': 'Contacts'
    };
    if (resultTitle) resultTitle.textContent = titles[action] || 'Result';

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
        attachments: lpai_get_attachments_json(),
        _token: rcmail.env.request_token
    };

    lpai_stream_to_element(postData, resultText, lpai_qa_controller, function(fullText, tokens, model) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        lpai_qa_controller = null;

        // Show usage info in result title
        if (resultTitle && (tokens || model)) {
            var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);
            if (usageLabel) resultTitle.textContent = (titles[action] || 'Result') + ' \u00B7 ' + usageLabel;
        }

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
// Translate (Read View — shows in result panel)
// ========================================
function lpai_translate_to(language, toggleBtn) {
    lpai_init_provider();

    var msgPart = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart, #messagebody');
    if (!msgPart) return;

    var resultPanel = document.getElementById('lpai-qa-result');
    var resultText = document.getElementById('lpai-qa-result-text');
    var resultTitle = document.getElementById('lpai-qa-result-title');

    if (!resultPanel || !resultText) return;

    resultPanel.style.display = 'block';
    resultPanel.className = 'lpai-qa-result';
    resultText.innerHTML = '';
    if (resultTitle) resultTitle.textContent = 'Translation (' + language + ')';

    var origLabel = toggleBtn.innerHTML;
    toggleBtn.disabled = true;
    toggleBtn.innerHTML = '&#9203; Translating...';

    if (lpai_qa_controller) lpai_qa_controller.abort();
    lpai_qa_controller = new AbortController();

    var bodyText = msgPart.innerText || msgPart.textContent || '';

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

    lpai_stream_to_element(postData, resultText, lpai_qa_controller, function(fullText, tokens, model) {
        toggleBtn.disabled = false;
        toggleBtn.innerHTML = origLabel;
        lpai_qa_controller = null;

        // Show usage info
        if (resultTitle && (tokens || model)) {
            var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);
            if (usageLabel) resultTitle.textContent = 'Translation (' + language + ') \u00B7 ' + usageLabel;
        }
    }, function(err) {
        toggleBtn.disabled = false;
        toggleBtn.innerHTML = origLabel;
        lpai_qa_controller = null;
    });
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
        var streamTokens = null;

        function readChunk() {
            return reader.read().then(function(result) {
                if (result.done) {
                    if (onDone) onDone(fullText, streamTokens, postData.model || '');
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
                        } else if (event.type === 'done') {
                            streamTokens = event.tokens || null;
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
            lpai_show_subject_picker(data.result, data.model, data.tokens);
        } else {
            if (rcmail.display_message) rcmail.display_message('Error: ' + (data.message || 'Failed'), 'error');
        }
    }).catch(function(err) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
        if (rcmail.display_message) rcmail.display_message('Error: ' + err.message, 'error');
    });
}

function lpai_show_subject_picker(text, model, tokens) {
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
    var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);
    header.innerHTML = '<span>Pick a subject line' + (usageLabel ? ' \u00B7 ' + usageLabel : '') + '</span>';
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

    // Only works in compose view
    if (rcmail.env.action !== 'compose') {
        rcmail.display_message('Save Draft is only available in compose view', 'notice');
        return;
    }

    // Apply content to editor
    lpai_undo_text = lpai_get_editor_content();
    lpai_set_editor_content(lpai_last_result);

    setTimeout(function() {
        // Sync TinyMCE content to the textarea
        var editor = window.tinyMCE && tinyMCE.activeEditor;
        if (editor) editor.save();

        // Invalidate compose hash so Roundcube sees a change
        rcmail.cmp_hash = null;

        lpai_close_panel();

        setTimeout(function() {
            rcmail.command('savedraft');
        }, 300);
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
        if (e.target.id === 'lpai-history-toggle' || e.target.id === 'lpai-history-arrow') {
            var histList = document.querySelector('#lpai-prompt-history .lpai-history-list');
            var histArrow = document.getElementById('lpai-history-arrow');
            if (histList) {
                var show = histList.style.display === 'none';
                histList.style.display = show ? 'block' : 'none';
                if (histArrow) histArrow.innerHTML = show ? '&#9660;' : '&#9654;';
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

    if (preview) preview.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';
    if (undoBtn) undoBtn.style.display = 'none';
    if (loading) loading.style.display = 'none';
    var readFollowup = document.getElementById('lpai-read-followup');
    if (readFollowup) readFollowup.style.display = 'none';

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

    // Check feature toggles
    var feat = rcmail.env.lpai_features || {};
    function showAction(btn, action, visible) {
        if (!btn) return;
        if (feat[action] === false) { btn.style.display = 'none'; return; }
        btn.style.display = visible ? '' : 'none';
    }

    var reasoningRow = document.getElementById('lpai-reasoning-row');
    var verbosityRow = document.getElementById('lpai-verbosity-row');
    var lengthRow = document.getElementById('lpai-length-row');

    if (context === 'read') {
        // ---- READ VIEW: dedicated reader layout ----
        // Hide ALL compose elements
        var hideEls = [input, langRow, toneRow, draftBtn, templatesRow, ctxPreview,
            reasoningRow, verbosityRow, lengthRow,
            document.getElementById('lpai-prompt-history'),
            document.getElementById('lpai-actions'),
            document.getElementById('lpai-submit')];
        hideEls.forEach(function(el) { if (el) el.style.display = 'none'; });

        // Build read-view action grid (once)
        var readGrid = document.getElementById('lpai-read-grid');
        if (!readGrid) {
            readGrid = document.createElement('div');
            readGrid.id = 'lpai-read-grid';
            readGrid.className = 'lpai-read-grid';

            var defaultLang = lpai_options.language || 'Portuguese';
            var langs = [
                { code: 'Portuguese', label: 'PT' }, { code: 'English', label: 'EN' },
                { code: 'Spanish', label: 'ES' }, { code: 'French', label: 'FR' },
                { code: 'German', label: 'DE' }, { code: 'Italian', label: 'IT' },
            ];

            // Language bar
            var langBar = document.createElement('div');
            langBar.className = 'lpai-read-lang-bar';
            var langLabel = document.createElement('span');
            langLabel.className = 'lpai-read-lang-label';
            langLabel.textContent = 'Language:';
            langBar.appendChild(langLabel);
            for (var li = 0; li < langs.length; li++) {
                var lb = document.createElement('button');
                lb.type = 'button';
                lb.className = 'lpai-read-lang-btn' + (langs[li].code === defaultLang ? ' active' : '');
                lb.dataset.lang = langs[li].code;
                lb.textContent = langs[li].label;
                lb.onclick = (function(lang) {
                    return function() {
                        lpai_options.language = lang;
                        langBar.querySelectorAll('.lpai-read-lang-btn').forEach(function(b) {
                            b.classList.toggle('active', b.dataset.lang === lang);
                        });
                        try { var p = JSON.parse(localStorage.getItem('lpai_prefs') || '{}'); p.language = lang; localStorage.setItem('lpai_prefs', JSON.stringify(p)); } catch(e) {}
                    };
                })(langs[li].code);
                langBar.appendChild(lb);
            }
            readGrid.appendChild(langBar);

            // Action buttons
            var actions = [
                { action: 'summarize', icon: '&#128220;', label: 'Summarize', feature: 'summarize' },
                { action: 'thread_summarize', icon: '&#128209;', label: 'Thread', feature: 'thread_summarize' },
                { action: 'translate', icon: '&#127760;', label: 'Translate', feature: 'translate' },
                { action: 'scam', icon: '&#128737;', label: 'Scam Check', feature: 'scam' },
            ];

            var btnRow = document.createElement('div');
            btnRow.className = 'lpai-read-btn-row';
            for (var ai = 0; ai < actions.length; ai++) {
                var a = actions[ai];
                if (feat[a.feature] === false) continue;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'lpai-read-action-btn';
                btn.dataset.action = a.action;
                btn.innerHTML = '<span class="lpai-read-action-icon">' + a.icon + '</span> ' + a.label;
                btn.onclick = (function(act) {
                    return function() {
                        document.querySelectorAll('.lpai-read-action-btn').forEach(function(b) { b.classList.remove('active'); });
                        this.classList.add('active');
                        // Clear stale input and history for fresh action
                        var mainInput = document.getElementById('lpai-input');
                        if (mainInput) mainInput.value = '';
                        lpai_history = [];
                        lpai_current_action = act;
                        lpai_submit();
                    };
                })(a.action);
                btnRow.appendChild(btn);
            }
            readGrid.appendChild(btnRow);

            // Reply with AI button
            var replyBtn = document.createElement('button');
            replyBtn.type = 'button';
            replyBtn.className = 'lpai-read-reply-btn';
            replyBtn.innerHTML = '&#10024; Reply with AI';
            replyBtn.onclick = function() {
                lpai_close_panel();
                try { localStorage.setItem('lpai_pending_reply', '1'); } catch (e) {}
                rcmail.command('reply');
            };
            readGrid.appendChild(replyBtn);

            // Insert into DOM
            var body = document.getElementById('lpai-body');
            var preview = document.getElementById('lpai-preview');
            if (body && preview) {
                body.insertBefore(readGrid, preview);
            }
        }
        readGrid.style.display = '';

    } else {
        // Hide read-view elements in compose
        var readGrid = document.getElementById('lpai-read-grid');
        if (readGrid) readGrid.style.display = 'none';
        var actionsRow = document.getElementById('lpai-actions');
        if (actionsRow) actionsRow.style.display = '';
        // ---- COMPOSE VIEW ----
        if (input) { input.value = ''; input.placeholder = 'What do you want GenIA to do?'; input.style.display = ''; }
        if (langRow) langRow.style.display = 'none';
        if (toneRow) toneRow.style.display = 'none';
        if (draftBtn) draftBtn.style.display = 'none';
        if (templatesRow) templatesRow.style.display = 'flex';
        if (ctxPreview) ctxPreview.style.display = 'none';

        lpai_load_templates();
        lpai_load_prompt_history();

        // Add length slider if not present
        if (!lengthRow) {
            if (verbosityRow) {
                lengthRow = lpai_create_length_slider();
                verbosityRow.parentNode.insertBefore(lengthRow, verbosityRow.nextSibling);
            }
        }
        if (lengthRow) lengthRow.style.display = 'none';

        // Add prompt history section if not present
        if (!document.getElementById('lpai-prompt-history')) {
            var ctx = document.getElementById('lpai-context-preview');
            if (ctx) {
                var histDiv = document.createElement('div');
                histDiv.id = 'lpai-prompt-history';
                histDiv.style.display = 'none';
                histDiv.innerHTML = '<div class="lpai-context-toggle" id="lpai-history-toggle">Recent Prompts <span id="lpai-history-arrow">&#9654;</span></div><div class="lpai-history-list lpai-context-body" style="display:none"></div>';
                ctx.parentNode.insertBefore(histDiv, ctx);
            }
        }
        lpai_render_prompt_history();

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

        // Show compose actions
        showAction(composeBtn, 'compose', true);
        showAction(rewriteBtn, 'rewrite', true);
        showAction(fixBtn, 'fix', true);
        showAction(translateBtn, 'translate', true);
        showAction(subjectLineBtn, 'suggest_subject', true);
        showAction(summarizeBtn, 'summarize', true);
        showAction(threadSumBtn, 'thread_summarize', false);
        showAction(replyBtn, 'reply', true);
        showAction(scamBtn, 'scam', true);

        // Hide reply-ai button in compose
        var replyAiBtn = document.getElementById('lpai-reply-ai-btn');
        if (replyAiBtn) replyAiBtn.style.display = 'none';

        // Show submit button
        var submitBtn = document.getElementById('lpai-submit');
        if (submitBtn) submitBtn.style.display = '';
    }

    panel.style.display = 'flex';
    overlay.style.display = 'block';

    if (context !== 'read' && input) setTimeout(function() { input.focus(); }, 100);
}

function lpai_show_read_followup() {
    var existing = document.getElementById('lpai-read-followup');
    if (existing) { existing.style.display = 'flex'; existing.querySelector('input').value = ''; existing.querySelector('input').focus(); return; }
    var bar = document.createElement('div');
    bar.id = 'lpai-read-followup';
    bar.className = 'lpai-read-followup';
    var fi = document.createElement('input');
    fi.type = 'text';
    fi.className = 'lpai-read-followup-input';
    fi.placeholder = 'Follow up: "make it shorter", "translate to english"...';
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'lpai-read-followup-send';
    sendBtn.innerHTML = '&#10148;';
    sendBtn.title = 'Send';
    var doSend = function() {
        var val = fi.value.trim();
        if (!val) return;
        var mainInput = document.getElementById('lpai-input');
        if (mainInput) mainInput.value = val;
        fi.value = '';
        lpai_submit();
    };
    sendBtn.onclick = doSend;
    fi.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });
    bar.appendChild(fi);
    bar.appendChild(sendBtn);
    var preview = document.getElementById('lpai-preview');
    if (preview && preview.parentNode) {
        preview.parentNode.insertBefore(bar, preview.nextSibling);
    }
    fi.focus();
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
    var showLength = ['compose', 'rewrite', 'reply'].indexOf(action) >= 0;
    if (langRow) langRow.style.display = showLang ? 'flex' : 'none';
    if (toneRow) toneRow.style.display = showTone ? 'flex' : 'none';
    var lengthRow = document.getElementById('lpai-length-row');
    if (lengthRow) lengthRow.style.display = showLength ? 'flex' : 'none';

    // Auto-detect tone and language when selecting reply
    if (action === 'reply') {
        lpai_detect_tone_and_language();
    }

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

    // Enhance instruction with word count if set
    var finalInstruction = instruction;
    if (lpai_word_count > 0 && ['compose', 'rewrite', 'reply'].indexOf(lpai_current_action) >= 0) {
        finalInstruction += (instruction ? '\n' : '') + 'Target length: approximately ' + lpai_word_count + ' words.';
    }

    // Save to prompt history
    if (instruction) {
        lpai_save_prompt_to_history(lpai_current_action, instruction);
    }

    var postData = {
        _action: 'plugin.lifeprisma_ai_stream',
        ai_action: lpai_current_action,
        instruction: finalInstruction,
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
        attachments: lpai_get_attachments_json(),
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

        // Keep loading spinner visible until first delta arrives
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
                        } else if (lpai_current_action) {
                            lpai_history.push({ role: 'user', content: '[Action: ' + lpai_current_action + ']' });
                        }
                        lpai_history.push({ role: 'assistant', content: fullText });

                        // Show copy button always
                        if (copyBtn) copyBtn.style.display = '';

                        if (['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                            if (applyBtn) applyBtn.style.display = '';
                            if (rcmail.env.action === 'compose') {
                                var draftBtn = document.getElementById('lpai-draft');
                                if (draftBtn) draftBtn.style.display = '';
                            }
                        }

                        // Auto-save draft if preference enabled (compose view only)
                        var sp = rcmail.env.lpai_user_prefs || {};
                        if (sp.auto_draft && rcmail.env.action === 'compose' && ['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                            lpai_undo_text = lpai_get_editor_content();
                            lpai_set_editor_content(fullText);
                            var editor = window.tinyMCE && tinyMCE.activeEditor;
                            if (editor) editor.save();
                            rcmail.cmp_hash = null;
                            setTimeout(function() { rcmail.command('savedraft'); }, 500);
                        }

                        // Show follow-up input
                        if (lpai_panel_context === 'read') {
                            lpai_show_read_followup();
                        } else {
                            var inp = document.getElementById('lpai-input');
                            if (inp) {
                                inp.value = '';
                                inp.placeholder = 'Follow up: "make it shorter", "translate to english"...';
                                inp.style.display = '';
                            }
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
                            if (loading && loading.style.display !== 'none') loading.style.display = 'none';
                            if (preview && preview.style.display === 'none') { preview.style.display = 'block'; if (previewText) previewText.textContent = ''; }
                            fullText += event.text;
                            if (previewText) previewText.innerHTML = lpai_md_to_html(fullText);
                            previewText.scrollTop = previewText.scrollHeight;
                        } else if (event.type === 'done') {
                            var label = 'Preview';
                            if (event.model) label += ' \u00B7 ' + event.model;
                            if (event.tokens) {
                                label += ' \u00B7 ' + event.tokens.input + ' in / ' + event.tokens.output + ' out';
                                var cost = lpai_estimate_cost(event.model || lpai_options.model, event.tokens.input, event.tokens.output);
                                if (cost) label += ' \u00B7 ' + cost;
                            }
                            if (event.cached) label += ' \u00B7 Cached';
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
                    label += ' \u00B7 ' + data.tokens.input + ' in / ' + data.tokens.output + ' out';
                    var cost = lpai_estimate_cost(lpai_options.model, data.tokens.input, data.tokens.output);
                    if (cost) label += ' \u00B7 ' + cost;
                }
                if (previewLabel) previewLabel.textContent = label;
                if (preview) preview.style.display = 'block';

                if (copyBtn) copyBtn.style.display = '';
                if (['summarize', 'scam', 'suggest_subject', 'thread_summarize'].indexOf(lpai_current_action) < 0) {
                    if (applyBtn) applyBtn.style.display = '';
                    if (rcmail.env.action === 'compose') {
                        var draftBtn = document.getElementById('lpai-draft');
                        if (draftBtn) draftBtn.style.display = '';
                    }
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

// ========================================
// Token Cost Estimation (#3)
// ========================================
var lpai_pricing = {
    // USD per 1M tokens [input, output]
    'gpt-5.4':         [2.50, 10.00],
    'gpt-4.1':         [2.00, 8.00],
    'gpt-4o':          [2.50, 10.00],
    'gpt-4o-mini':     [0.15, 0.60],
    'grok-4-1-fast':   [3.00, 15.00],
    'grok-4.1-fast':   [3.00, 15.00],
    'grok-3':          [3.00, 15.00],
    'grok-3-mini':     [0.30, 0.50],
    'claude-sonnet-4-6':        [3.00, 15.00],
    'claude-haiku-4-5-20251001': [0.80, 4.00],
    'claude-opus-4-6':  [15.00, 75.00],
};

function lpai_estimate_cost(model, inputTokens, outputTokens) {
    var rates = null;
    // Check provider-configured per-model pricing first
    var providers = rcmail.env.lpai_providers || {};
    var pids = Object.keys(providers);
    for (var i = 0; i < pids.length; i++) {
        var p = providers[pids[i]];
        var pricing = p.pricing || {};
        var mp = pricing[model];
        if (mp && mp.input && mp.output) {
            rates = [mp.input, mp.output];
            break;
        }
    }
    // Fallback to hardcoded pricing
    if (!rates) rates = lpai_pricing[model];
    if (!rates) return null;
    var cost = (inputTokens * rates[0] + outputTokens * rates[1]) / 1000000;
    if (cost < 0.0001) return '$' + cost.toFixed(6);
    return '$' + cost.toFixed(4);
}

function lpai_format_usage_label(model, tokens) {
    var parts = [];
    if (model) parts.push(model);
    if (tokens && (tokens.input || tokens.output)) {
        parts.push(tokens.input + ' in / ' + tokens.output + ' out');
        var cost = lpai_estimate_cost(model, tokens.input, tokens.output);
        if (cost) parts.push(cost);
    }
    return parts.join(' \u00B7 ');
}

// ========================================
// Tone Detection (#4) & Language Auto-Detect (#5)
// ========================================
function lpai_detect_tone_and_language() {
    lpai_init_provider();

    var emailText = lpai_get_reply_text() || lpai_get_editor_content();
    if (!emailText || emailText.trim().length < 20) return;

    var postData = {
        _action: 'plugin.lifeprisma_ai_request',
        ai_action: 'detect_tone',
        instruction: '',
        email_body: emailText.substring(0, 1000),
        reply_text: '',
        subject: lpai_get_subject(),
        language: 'English',
        tone: 'professional',
        sender_name: '',
        reasoning: 'none',
        verbosity: 'low',
        provider: lpai_options.provider,
        model: lpai_options.model,
        history: '[]',
        msg_uid: rcmail.env.uid || '',
        mbox: rcmail.env.mailbox || '',
        view_context: lpai_panel_context,
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
        if (data.status === 'success' && data.result) {
            try {
                var info = JSON.parse(data.result.replace(/```json\n?|\n?```/g, '').trim());

                // Auto-set tone if detected
                if (info.tone) {
                    var toneBtn = document.querySelector('.lpai-opt-btn[data-group="tone"][data-value="' + info.tone + '"]');
                    if (toneBtn) {
                        document.querySelectorAll('.lpai-opt-btn[data-group="tone"]').forEach(function(b) { b.classList.remove('active'); });
                        toneBtn.classList.add('active');
                        lpai_options.tone = info.tone;
                    }
                }

                // Auto-detect language for translation
                if (info.language) {
                    var langMap = { 'pt': 'Portuguese', 'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'it': 'Italian' };
                    var detected = langMap[info.language] || null;
                    if (detected) {
                        // Store detected source language
                        window.lpai_detected_language = detected;
                    }
                }
            } catch (e) {}
        }
    }).catch(function() {});
}

// ========================================
// Snippet Extraction (#6)
// ========================================
function lpai_add_snippet_buttons(bar) {
    var features = rcmail.env.lpai_features || {};

    if (features.snippet_extract === false) return;

    var snippets = [
        { action: 'extract_actions', label: '&#9745; Actions', title: 'Extract action items' },
        { action: 'extract_dates', label: '&#128197; Dates', title: 'Extract dates & deadlines' },
        { action: 'extract_contacts', label: '&#128101; Contacts', title: 'Extract contact info' }
    ];

    for (var i = 0; i < snippets.length; i++) {
        (function(s) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lpai-qa-btn';
            btn.innerHTML = s.label;
            btn.title = s.title;
            btn.onclick = function() { lpai_quick_action(s.action, btn); };
            bar.appendChild(btn);
        })(snippets[i]);
    }
}

// ========================================
// Attachment Awareness (#1)
// ========================================
function lpai_get_attachments_json() {
    var attachments = rcmail.env.lpai_attachments || [];
    if (attachments.length === 0) return '';
    return JSON.stringify(attachments);
}

// ========================================
// Response Length Slider (#7)
// ========================================
var lpai_word_count = 0; // 0 = use verbosity buttons

function lpai_create_length_slider() {
    var row = document.createElement('div');
    row.id = 'lpai-length-row';
    row.className = 'lpai-btn-group';
    row.style.display = 'none';

    var label = document.createElement('span');
    label.className = 'lpai-group-label';
    label.textContent = 'Length';
    row.appendChild(label);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'lpai-length-slider';
    slider.min = '0';
    slider.max = '500';
    slider.step = '25';
    slider.value = '0';
    slider.style.cssText = 'flex:1;max-width:160px;cursor:pointer;accent-color:#37beff';
    row.appendChild(slider);

    var valLabel = document.createElement('span');
    valLabel.id = 'lpai-length-value';
    valLabel.style.cssText = 'font-size:11px;color:#8b9fa7;min-width:50px';
    valLabel.textContent = 'Auto';
    row.appendChild(valLabel);

    slider.addEventListener('input', function() {
        var val = parseInt(slider.value);
        lpai_word_count = val;
        if (val === 0) {
            valLabel.textContent = 'Auto';
        } else {
            valLabel.textContent = '~' + val + ' words';
        }
    });

    return row;
}

// ========================================
// Prompt History (#8)
// ========================================
var lpai_prompt_history = [];

function lpai_load_prompt_history() {
    try {
        var saved = JSON.parse(localStorage.getItem('lpai_prompt_history'));
        if (Array.isArray(saved)) lpai_prompt_history = saved.slice(0, 10);
    } catch (e) {}
}

function lpai_save_prompt_to_history(action, instruction) {
    if (!instruction || instruction.trim().length < 3) return;
    // Remove duplicate
    lpai_prompt_history = lpai_prompt_history.filter(function(p) {
        return p.instruction !== instruction || p.action !== action;
    });
    lpai_prompt_history.unshift({ action: action, instruction: instruction, time: Date.now() });
    if (lpai_prompt_history.length > 10) lpai_prompt_history = lpai_prompt_history.slice(0, 10);
    try { localStorage.setItem('lpai_prompt_history', JSON.stringify(lpai_prompt_history)); } catch (e) {}
}

function lpai_render_prompt_history() {
    var container = document.getElementById('lpai-prompt-history');
    if (!container) return;

    if (lpai_prompt_history.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    var list = container.querySelector('.lpai-history-list');
    if (!list) return;
    list.innerHTML = '';

    for (var i = 0; i < lpai_prompt_history.length; i++) {
        (function(item) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lpai-qa-btn lpai-history-item';
            btn.style.cssText = 'display:block;width:100%;text-align:left;margin:2px 0;padding:4px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px';
            var label = item.action.charAt(0).toUpperCase() + item.action.slice(1);
            btn.innerHTML = '<strong>' + label + ':</strong> ' + item.instruction.substring(0, 60) + (item.instruction.length > 60 ? '...' : '');
            btn.onclick = function() {
                lpai_select_action(item.action);
                var input = document.getElementById('lpai-input');
                if (input) { input.value = item.instruction; input.style.display = ''; }
            };
            list.appendChild(btn);
        })(lpai_prompt_history[i]);
    }
}

// ========================================
// Admin Panel UI
// ========================================
function lpai_init_admin() {
    var root = document.getElementById('lpai-admin-root');
    if (!root) return;

    var urlConfig = root.dataset.urlConfig;
    var urlSave = root.dataset.urlSave;
    var token = root.dataset.token;

    root.innerHTML = '<div class="lpai-admin-loading"><div class="lpai-spinner"></div> Loading admin panel...</div>';

    fetch(urlConfig + '&op=get_config&_token=' + encodeURIComponent(token)).then(function(r) {
        return r.json();
    }).then(function(data) {
        if (data.status !== 'success') {
            root.innerHTML = '<div style="color:#e74c3c;padding:16px">Error: ' + (data.message || 'Failed to load') + '</div>';
            return;
        }
        lpai_render_admin(root, data, urlSave, token);
    }).catch(function(err) {
        root.innerHTML = '<div style="color:#e74c3c;padding:16px">Error: ' + err.message + '</div>';
    });
}

var lpai_admin_api_presets = {
    'openai_responses': { api_type: 'responses', api_url: 'https://api.openai.com/v1/responses', label: 'GPT', model: 'gpt-5.4', models: ['gpt-5.4', 'gpt-4.1', 'gpt-4o'], pricing: { 'gpt-5.4': { input: 2.50, output: 10.00 }, 'gpt-4.1': { input: 2.00, output: 8.00 }, 'gpt-4o': { input: 2.50, output: 10.00 } } },
    'xai_responses': { api_type: 'responses', api_url: 'https://api.x.ai/v1/responses', label: 'Grok', model: 'grok-4.1-fast', models: ['grok-4.1-fast', 'grok-3'], pricing: { 'grok-4.1-fast': { input: 3.00, output: 15.00 }, 'grok-3': { input: 3.00, output: 15.00 } } },
    'anthropic': { api_type: 'anthropic', api_url: 'https://api.anthropic.com/v1/messages', label: 'Claude', model: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], supports_reasoning: false, pricing: { 'claude-sonnet-4-6': { input: 3.00, output: 15.00 }, 'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 } } },
    'ollama': { api_type: 'chat_completions', api_url: 'http://localhost:11434/v1/chat/completions', label: 'Ollama', model: 'llama3.1', models: ['llama3.1'], supports_reasoning: false },
    'custom': { api_type: 'chat_completions', api_url: '', label: 'Custom', model: '', models: [] },
};

function lpai_admin_provider_html(pid, p) {
    var apiTypes = [
        { value: 'responses', label: 'OpenAI Responses API' },
        { value: 'anthropic', label: 'Anthropic Messages API' },
        { value: 'chat_completions', label: 'Chat Completions (Ollama, LM Studio, etc.)' },
    ];
    var apiTypeVal = p.api_type || 'responses';
    var html = '<div class="lpai-admin-provider" data-pid="' + pid + '">';
    html += '<div class="lpai-admin-provider-header">';
    html += '<strong>' + (p.label || pid) + '</strong>';
    html += '<span class="lpai-admin-key-status ' + (p.has_key ? 'lpai-admin-key-ok' : 'lpai-admin-key-missing') + '">' + (p.has_key ? 'Key configured' : 'No API key') + '</span>';
    html += '<button type="button" class="lpai-admin-remove-btn" data-pid="' + pid + '" title="Remove provider">&times;</button>';
    html += '</div>';
    html += '<div class="lpai-admin-field-row">';
    html += '<div class="lpai-admin-field lpai-admin-field-half"><label>Provider ID</label><input type="text" class="lpai-admin-input lpai-admin-pid" value="' + pid + '" readonly></div>';
    html += '<div class="lpai-admin-field lpai-admin-field-half"><label>Display Label</label><input type="text" class="lpai-admin-input lpai-admin-label" data-pid="' + pid + '" value="' + (p.label || '') + '"></div>';
    html += '</div>';
    html += '<div class="lpai-admin-field"><label>API Protocol</label><select class="lpai-admin-input lpai-admin-apitype" data-pid="' + pid + '">';
    for (var t = 0; t < apiTypes.length; t++) {
        html += '<option value="' + apiTypes[t].value + '"' + (apiTypeVal === apiTypes[t].value ? ' selected' : '') + '>' + apiTypes[t].label + '</option>';
    }
    html += '</select></div>';
    html += '<div class="lpai-admin-field"><label>API Endpoint URL</label><input type="text" class="lpai-admin-input lpai-admin-apiurl" data-pid="' + pid + '" value="' + (p.api_url || '') + '" placeholder="https://api.openai.com/v1/responses"></div>';
    html += '<div class="lpai-admin-field"><label>API Key</label><input type="password" class="lpai-admin-input lpai-admin-apikey" data-pid="' + pid + '" placeholder="' + (p.api_key_masked || 'Enter API key...') + '"></div>';
    html += '<div class="lpai-admin-field"><label>Default Model</label><input type="text" class="lpai-admin-input lpai-admin-model" data-pid="' + pid + '" value="' + (p.model || '') + '"></div>';
    html += '<div class="lpai-admin-field"><label>Available Models (comma-separated)</label><input type="text" class="lpai-admin-input lpai-admin-models" data-pid="' + pid + '" value="' + ((p.models || []).join(', ')) + '"></div>';
    html += '<div class="lpai-admin-field"><label><input type="checkbox" class="lpai-admin-reasoning-cb" data-pid="' + pid + '"' + (p.supports_reasoning !== false ? ' checked' : '') + '> Supports reasoning/verbosity controls</label></div>';
    var unsupRaw = p.unsupported_params || {};
    // Normalize: legacy flat array → apply to all models
    var unsupMap = {};
    if (Array.isArray(unsupRaw)) {
        var pModels = p.models || [p.model || ''];
        for (var um = 0; um < pModels.length; um++) { if (pModels[um]) unsupMap[pModels[um]] = unsupRaw; }
    } else {
        unsupMap = unsupRaw;
    }
    var models = p.models || [p.model || ''];
    html += '<div class="lpai-admin-field"><label>Unsupported parameters (per model):</label>';
    html += '<div class="lpai-admin-unsup-models" data-pid="' + pid + '">';
    for (var mi = 0; mi < models.length; mi++) {
        var m = models[mi]; if (!m) continue;
        var mu = unsupMap[m] || [];
        html += '<div class="lpai-admin-unsup-row" data-model="' + m + '"><span class="lpai-admin-unsup-model">' + m + '</span>';
        html += ' <label class="lpai-admin-unsup"><input type="checkbox" class="lpai-admin-unsup-cb" data-param="temperature"' + (mu.indexOf('temperature') >= 0 ? ' checked' : '') + '> temperature</label>';
        html += ' <label class="lpai-admin-unsup"><input type="checkbox" class="lpai-admin-unsup-cb" data-param="reasoning_none"' + (mu.indexOf('reasoning_none') >= 0 ? ' checked' : '') + '> reasoning=none</label>';
        html += '</div>';
    }
    html += '</div></div>';
    var pricing = p.pricing || {};
    html += '<div class="lpai-admin-field"><label>Token Pricing (USD per 1M tokens)</label>';
    html += '<div class="lpai-admin-pricing-models" data-pid="' + pid + '">';
    for (var pi = 0; pi < models.length; pi++) {
        var pm = models[pi]; if (!pm) continue;
        var mp = pricing[pm] || {};
        html += '<div class="lpai-admin-pricing-row" data-model="' + pm + '">';
        html += '<span class="lpai-admin-unsup-model">' + pm + '</span>';
        html += '<div class="lpai-admin-field-row" style="flex:1">';
        html += '<div class="lpai-admin-field-half"><input type="text" class="lpai-admin-input lpai-admin-price-in" value="' + (mp.input || '') + '" placeholder="Input"></div>';
        html += '<div class="lpai-admin-field-half"><input type="text" class="lpai-admin-input lpai-admin-price-out" value="' + (mp.output || '') + '" placeholder="Output"></div>';
        html += '</div></div>';
    }
    html += '</div></div>';
    html += '</div>';
    return html;
}

function lpai_render_admin(root, data, urlSave, token) {
    var providers = data.providers || {};
    var settings = data.settings || {};
    var features = data.features || {};
    var usage = data.usage || {};

    var html = '<div class="lpai-admin">';

    // Usage Stats
    html += '<div class="lpai-admin-section">';
    html += '<h3 class="lpai-admin-title">Usage Overview</h3>';
    html += '<div class="lpai-admin-stats">';
    html += '<div class="lpai-admin-stat"><span class="lpai-admin-stat-num">' + (usage.total_users || 0) + '</span><span class="lpai-admin-stat-label">Total Users</span></div>';
    html += '<div class="lpai-admin-stat"><span class="lpai-admin-stat-num">' + (usage.active_users || 0) + '</span><span class="lpai-admin-stat-label">Configured Users</span></div>';
    html += '</div></div>';

    // Providers
    html += '<div class="lpai-admin-section">';
    html += '<h3 class="lpai-admin-title">AI Providers</h3>';
    html += '<div id="lpai-admin-providers">';
    var pids = Object.keys(providers);
    for (var i = 0; i < pids.length; i++) {
        html += lpai_admin_provider_html(pids[i], providers[pids[i]]);
    }
    html += '</div>';
    html += '<button type="button" id="lpai-admin-add-provider" class="lpai-admin-add-btn">+ Add Provider</button>';
    html += '</div>';

    // Global Settings
    html += '<div class="lpai-admin-section">';
    html += '<h3 class="lpai-admin-title">Global Settings</h3>';
    html += '<div class="lpai-admin-field"><label>Max Tokens</label><input type="number" id="lpai-admin-max-tokens" class="lpai-admin-input" value="' + (settings.max_tokens || 2000) + '"></div>';
    html += '<div class="lpai-admin-field"><label>Temperature (0.0-1.0)</label><input type="number" id="lpai-admin-temperature" class="lpai-admin-input" step="0.1" min="0" max="1" value="' + (settings.temperature || 0.5) + '"></div>';
    html += '<div class="lpai-admin-field"><label>Rate Limit (seconds between requests)</label><input type="number" id="lpai-admin-rate-limit" class="lpai-admin-input" value="' + (settings.rate_limit || 3) + '"></div>';
    html += '<div class="lpai-admin-field"><label>Default Language</label><select id="lpai-admin-language" class="lpai-admin-input">';
    var langs = ['Portuguese', 'English', 'Spanish', 'French', 'German', 'Italian'];
    for (var li = 0; li < langs.length; li++) {
        html += '<option value="' + langs[li] + '"' + (settings.default_language === langs[li] ? ' selected' : '') + '>' + langs[li] + '</option>';
    }
    html += '</select></div>';
    html += '<div class="lpai-admin-field"><label>Default AI Provider</label><select id="lpai-admin-default-provider" class="lpai-admin-input">';
    html += '<option value=""' + (!settings.default_provider ? ' selected' : '') + '>First available</option>';
    for (var di = 0; di < pids.length; di++) {
        var dp = providers[pids[di]];
        html += '<option value="' + pids[di] + '"' + (settings.default_provider === pids[di] ? ' selected' : '') + '>' + (dp.label || pids[di]) + '</option>';
    }
    html += '</select></div>';

    // Follow-up detection provider + model
    var fuProvider = settings.followup_provider || '';
    var fuModel = settings.followup_model || '';
    html += '<div class="lpai-admin-field"><label>Follow-up Detection — Provider</label><select id="lpai-admin-fu-provider" class="lpai-admin-input">';
    html += '<option value=""' + (!fuProvider ? ' selected' : '') + '>Same as user selection</option>';
    for (var fi = 0; fi < pids.length; fi++) {
        var fp = providers[pids[fi]];
        html += '<option value="' + pids[fi] + '"' + (fuProvider === pids[fi] ? ' selected' : '') + '>' + (fp.label || pids[fi]) + '</option>';
    }
    html += '</select></div>';
    html += '<div class="lpai-admin-field"><label>Follow-up Detection — Model</label><select id="lpai-admin-fu-model" class="lpai-admin-input">';
    html += '<option value="">Default for provider</option>';
    if (fuProvider && providers[fuProvider]) {
        var fuModels = providers[fuProvider].models || [];
        for (var fm = 0; fm < fuModels.length; fm++) {
            html += '<option value="' + fuModels[fm] + '"' + (fuModel === fuModels[fm] ? ' selected' : '') + '>' + fuModels[fm] + '</option>';
        }
    }
    html += '</select></div></div>';

    // Feature Toggles
    html += '<div class="lpai-admin-section">';
    html += '<h3 class="lpai-admin-title">Feature Toggles</h3>';
    html += '<div class="lpai-admin-features">';
    var featureList = [
        { id: 'compose', label: 'Compose' }, { id: 'rewrite', label: 'Rewrite' },
        { id: 'reply', label: 'Reply' }, { id: 'translate', label: 'Translate' },
        { id: 'summarize', label: 'Summarize' }, { id: 'fix', label: 'Fix Grammar' },
        { id: 'scam', label: 'Scam Check' }, { id: 'suggest_subject', label: 'Subject Line' },
        { id: 'thread_summarize', label: 'Thread Summary' }, { id: 'snippet_extract', label: 'Snippet Extraction' },
    ];
    for (var fi = 0; fi < featureList.length; fi++) {
        var f = featureList[fi];
        var checked = features[f.id] !== false ? ' checked' : '';
        html += '<label class="lpai-admin-feature"><input type="checkbox" class="lpai-admin-feature-cb" data-feature="' + f.id + '"' + checked + '> ' + f.label + '</label>';
    }
    html += '</div></div>';

    // Save button
    html += '<div class="lpai-admin-actions">';
    html += '<button type="button" id="lpai-admin-save" class="lpai-admin-save-btn">Save Settings</button>';
    html += '<span id="lpai-admin-status"></span>';
    html += '</div>';
    html += '</div>';

    root.innerHTML = html;

    // Add provider handler
    document.getElementById('lpai-admin-add-provider').onclick = function() {
        var presetMenu = document.getElementById('lpai-admin-preset-menu');
        if (presetMenu) { presetMenu.remove(); return; }

        var menu = document.createElement('div');
        menu.id = 'lpai-admin-preset-menu';
        menu.className = 'lpai-admin-preset-menu';
        var presets = [
            { key: 'openai_responses', label: 'OpenAI (Responses API)' },
            { key: 'xai_responses', label: 'xAI / Grok (Responses API)' },
            { key: 'anthropic', label: 'Anthropic / Claude' },
            { key: 'ollama', label: 'Ollama (Local)' },
            { key: 'custom', label: 'Custom Provider' },
        ];
        for (var pi = 0; pi < presets.length; pi++) {
            (function(preset) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'lpai-admin-preset-item';
                btn.textContent = preset.label;
                btn.onclick = function() {
                    menu.remove();
                    var tpl = lpai_admin_api_presets[preset.key];
                    var newPid = prompt('Provider ID (lowercase, no spaces):', preset.key.replace('_responses', ''));
                    if (!newPid) return;
                    newPid = newPid.toLowerCase().replace(/[^a-z0-9_]/g, '');
                    if (!newPid) return;
                    var existing = document.querySelector('.lpai-admin-provider[data-pid="' + newPid + '"]');
                    if (existing) { alert('Provider ID "' + newPid + '" already exists'); return; }
                    var container = document.getElementById('lpai-admin-providers');
                    var newP = { label: tpl.label, api_type: tpl.api_type, api_url: tpl.api_url, model: tpl.model, models: tpl.models, supports_reasoning: tpl.supports_reasoning !== false, has_key: false, api_key_masked: '' };
                    container.insertAdjacentHTML('beforeend', lpai_admin_provider_html(newPid, newP));
                    // Bind remove handler for new entry
                    var removeBtn = container.querySelector('.lpai-admin-provider[data-pid="' + newPid + '"] .lpai-admin-remove-btn');
                    if (removeBtn) removeBtn.onclick = function() {
                        if (confirm('Remove provider "' + newPid + '"?')) this.closest('.lpai-admin-provider').remove();
                    };
                    // Update provider dropdowns
                    ['lpai-admin-default-provider', 'lpai-admin-fu-provider'].forEach(function(id) {
                        var sel = document.getElementById(id);
                        if (sel) {
                            var opt = document.createElement('option');
                            opt.value = newPid;
                            opt.textContent = tpl.label;
                            sel.appendChild(opt);
                        }
                    });
                };
                menu.appendChild(btn);
            })(presets[pi]);
        }
        this.parentNode.insertBefore(menu, this.nextSibling);
    };

    // Remove provider handlers
    document.querySelectorAll('.lpai-admin-remove-btn').forEach(function(btn) {
        btn.onclick = function() {
            var pid = this.dataset.pid;
            if (confirm('Remove provider "' + pid + '"?')) {
                this.closest('.lpai-admin-provider').remove();
                // Remove from provider dropdowns
                ['#lpai-admin-default-provider', '#lpai-admin-fu-provider'].forEach(function(sel) {
                    var opt = document.querySelector(sel + ' option[value="' + pid + '"]');
                    if (opt) opt.remove();
                });
            }
        };
    });

    // Follow-up provider → update model dropdown
    document.getElementById('lpai-admin-fu-provider').onchange = function() {
        var sel = this.value;
        var mSel = document.getElementById('lpai-admin-fu-model');
        mSel.innerHTML = '<option value="">Default for provider</option>';
        if (sel) {
            // Read models from the provider card
            var card = document.querySelector('.lpai-admin-provider[data-pid="' + sel + '"]');
            if (card) {
                var modelsVal = card.querySelector('.lpai-admin-models');
                var models = modelsVal ? modelsVal.value.split(',').map(function(m){return m.trim();}).filter(Boolean) : [];
                for (var i = 0; i < models.length; i++) {
                    var o = document.createElement('option');
                    o.value = models[i]; o.textContent = models[i];
                    mSel.appendChild(o);
                }
            }
        }
    };

    // Save handler
    document.getElementById('lpai-admin-save').onclick = function() {
        var saveData = { providers: {}, settings: {}, features: {} };

        // Collect provider data
        document.querySelectorAll('.lpai-admin-provider').forEach(function(el) {
            var pid = el.dataset.pid;
            var keyInput = el.querySelector('.lpai-admin-apikey');
            var labelInput = el.querySelector('.lpai-admin-label');
            var apiTypeInput = el.querySelector('.lpai-admin-apitype');
            var apiUrlInput = el.querySelector('.lpai-admin-apiurl');
            var modelInput = el.querySelector('.lpai-admin-model');
            var modelsInput = el.querySelector('.lpai-admin-models');
            var reasoningCb = el.querySelector('.lpai-admin-reasoning-cb');

            var unsupported = {};
            el.querySelectorAll('.lpai-admin-unsup-row').forEach(function(row) {
                var mdl = row.dataset.model;
                var params = [];
                row.querySelectorAll('.lpai-admin-unsup-cb:checked').forEach(function(cb) {
                    params.push(cb.dataset.param);
                });
                if (params.length > 0) unsupported[mdl] = params;
            });

            var pricing = {};
            el.querySelectorAll('.lpai-admin-pricing-row').forEach(function(row) {
                var mdl = row.dataset.model;
                var pIn = row.querySelector('.lpai-admin-price-in');
                var pOut = row.querySelector('.lpai-admin-price-out');
                if ((pIn && pIn.value) || (pOut && pOut.value)) {
                    pricing[mdl] = {
                        input: parseFloat(pIn ? pIn.value : 0) || 0,
                        output: parseFloat(pOut ? pOut.value : 0) || 0,
                    };
                }
            });

            saveData.providers[pid] = {
                label: labelInput ? labelInput.value : pid,
                api_url: apiUrlInput ? apiUrlInput.value : '',
                api_type: apiTypeInput ? apiTypeInput.value : 'responses',
                api_key: keyInput ? keyInput.value : '',
                model: modelInput ? modelInput.value : '',
                models: (modelsInput ? modelsInput.value : '').split(',').map(function(m) { return m.trim(); }).filter(Boolean),
                supports_reasoning: reasoningCb ? reasoningCb.checked : true,
                unsupported_params: unsupported,
                pricing: pricing,
            };
        });

        // Collect settings
        saveData.settings = {
            max_tokens: parseInt(document.getElementById('lpai-admin-max-tokens').value) || 2000,
            temperature: parseFloat(document.getElementById('lpai-admin-temperature').value) || 0.5,
            rate_limit: parseInt(document.getElementById('lpai-admin-rate-limit').value) || 3,
            default_language: document.getElementById('lpai-admin-language').value || 'English',
            default_provider: document.getElementById('lpai-admin-default-provider').value || '',
            followup_provider: document.getElementById('lpai-admin-fu-provider').value || '',
            followup_model: document.getElementById('lpai-admin-fu-model').value || '',
        };

        // Collect features
        document.querySelectorAll('.lpai-admin-feature-cb').forEach(function(cb) {
            saveData.features[cb.dataset.feature] = cb.checked;
        });

        var status = document.getElementById('lpai-admin-status');
        status.textContent = 'Saving...';
        status.style.color = '#37beff';

        fetch(urlSave + '&_token=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveData)
        }).then(function(r) { return r.json(); }).then(function(res) {
            if (res.status === 'success') {
                status.textContent = 'Saved!';
                status.style.color = '#41b849';
                setTimeout(function() { status.textContent = ''; }, 3000);
            } else {
                status.textContent = 'Error: ' + (res.message || 'Failed');
                status.style.color = '#e74c3c';
            }
        }).catch(function(err) {
            status.textContent = 'Error: ' + err.message;
            status.style.color = '#e74c3c';
        });
    };
}

// Make admin init globally available
window.lpai_init_admin = lpai_init_admin;

// ========================================
// Smart Compose — AI Autocomplete (#1)
// ========================================
var lpai_sc_timer = null;
var lpai_sc_controller = null;
var lpai_sc_suggestion = '';
var lpai_sc_ghost = null;
var lpai_sc_active = false;
var lpai_sc_delay = 1500; // ms pause before triggering

function lpai_init_smart_compose() {
    if (!rcmail.env.lpai_smart_compose) return;
    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) return;

    // Wait for TinyMCE to be ready
    var attempts = 0;
    var waitInterval = setInterval(function() {
        attempts++;
        var editor = window.tinyMCE && tinyMCE.activeEditor;
        if (editor && editor.getBody()) {
            clearInterval(waitInterval);
            lpai_attach_smart_compose(editor);
        }
        if (attempts > 50) clearInterval(waitInterval);
    }, 200);
}

function lpai_attach_smart_compose(editor) {
    // Create ghost overlay element
    lpai_sc_ghost = document.createElement('span');
    lpai_sc_ghost.id = 'lpai-sc-ghost';
    lpai_sc_ghost.style.cssText = 'color:#adb5bd;pointer-events:none;font-style:italic;';
    lpai_sc_ghost.contentEditable = 'false';

    editor.on('keyup', function(e) {
        // Ignore Tab, Enter, Shift, Ctrl, Alt, arrows, etc.
        if ([9, 13, 16, 17, 18, 27, 37, 38, 39, 40].indexOf(e.keyCode) >= 0) return;

        lpai_sc_dismiss();

        if (lpai_sc_timer) clearTimeout(lpai_sc_timer);
        lpai_sc_timer = setTimeout(function() {
            lpai_sc_request(editor);
        }, lpai_sc_delay);
    });

    editor.on('keydown', function(e) {
        // Tab to accept suggestion
        if (e.keyCode === 9 && lpai_sc_active && lpai_sc_suggestion) {
            e.preventDefault();
            e.stopPropagation();
            lpai_sc_accept(editor);
            return false;
        }
        // Escape to dismiss
        if (e.keyCode === 27 && lpai_sc_active) {
            lpai_sc_dismiss();
        }
    });

    // Dismiss on click
    editor.on('click', function() {
        lpai_sc_dismiss();
    });
}

function lpai_sc_request(editor) {
    lpai_init_provider();

    var text = editor.getContent({ format: 'text' });
    if (!text || text.trim().length < 10) return;

    // Don't autocomplete if text ends with a period/complete sentence feel + newline
    var trimmed = text.trimEnd();
    if (!trimmed || trimmed.length < 5) return;

    if (lpai_sc_controller) lpai_sc_controller.abort();
    lpai_sc_controller = new AbortController();

    var postData = {
        _action: 'plugin.lifeprisma_ai_request',
        ai_action: 'autocomplete',
        instruction: '',
        email_body: text,
        reply_text: '',
        subject: lpai_get_subject(),
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
        body: encoded.join('&'),
        signal: lpai_sc_controller.signal
    }).then(function(r) { return r.json(); }).then(function(data) {
        lpai_sc_controller = null;
        if (data.status === 'success' && data.result) {
            var suggestion = data.result.trim();
            if (suggestion && suggestion.length > 2) {
                lpai_sc_show(editor, suggestion);
            }
        }
    }).catch(function(err) {
        lpai_sc_controller = null;
    });
}

function lpai_sc_show(editor, suggestion) {
    lpai_sc_dismiss();
    lpai_sc_suggestion = suggestion;
    lpai_sc_active = true;

    // Insert ghost text at cursor position
    var body = editor.getBody();
    if (!body) return;

    var ghost = editor.getDoc().createElement('span');
    ghost.id = 'lpai-sc-ghost';
    ghost.style.cssText = 'color:#adb5bd;pointer-events:none;font-style:italic;';
    ghost.contentEditable = false;
    ghost.setAttribute('data-mce-bogus', '1');
    ghost.textContent = suggestion;

    // Insert at cursor
    var sel = editor.selection;
    if (sel) {
        sel.collapse(false);
        sel.getRng().insertNode(ghost);
        // Keep cursor before the ghost
        var rng = editor.getDoc().createRange();
        rng.setStartBefore(ghost);
        rng.collapse(true);
        sel.setRng(rng);
    }

    // Show hint
    lpai_sc_show_hint();
}

function lpai_sc_show_hint() {
    var existing = document.getElementById('lpai-sc-hint');
    if (existing) existing.remove();

    var hint = document.createElement('div');
    hint.id = 'lpai-sc-hint';
    hint.className = 'lpai-sc-hint';
    hint.innerHTML = '<kbd>Tab</kbd> to accept &middot; <kbd>Esc</kbd> to dismiss';

    var bar = document.getElementById('lpai-qa-bar-compose');
    if (bar) {
        bar.parentNode.insertBefore(hint, bar.nextSibling);
    }
}

function lpai_sc_accept(editor) {
    if (!lpai_sc_suggestion || !lpai_sc_active) return;

    // Remove ghost and insert real text
    var ghost = editor.getDoc().getElementById('lpai-sc-ghost');
    if (ghost) {
        var textNode = editor.getDoc().createTextNode(lpai_sc_suggestion);
        ghost.parentNode.replaceChild(textNode, ghost);
        // Place cursor at end of inserted text
        var rng = editor.getDoc().createRange();
        rng.setStartAfter(textNode);
        rng.collapse(true);
        editor.selection.setRng(rng);
    }

    lpai_sc_suggestion = '';
    lpai_sc_active = false;
    var hint = document.getElementById('lpai-sc-hint');
    if (hint) hint.remove();
}

function lpai_sc_dismiss() {
    lpai_sc_suggestion = '';
    lpai_sc_active = false;

    if (lpai_sc_controller) {
        lpai_sc_controller.abort();
        lpai_sc_controller = null;
    }
    if (lpai_sc_timer) {
        clearTimeout(lpai_sc_timer);
        lpai_sc_timer = null;
    }

    // Remove ghost from TinyMCE
    var editor = window.tinyMCE && tinyMCE.activeEditor;
    if (editor) {
        var ghost = editor.getDoc().getElementById('lpai-sc-ghost');
        if (ghost) ghost.remove();
    }

    var hint = document.getElementById('lpai-sc-hint');
    if (hint) hint.remove();
}

// ========================================
// Send Time Suggestion (#2)
// ========================================
function lpai_init_send_time() {
    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) return;

    var bar = document.getElementById('lpai-qa-bar-compose');
    if (!bar) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lpai-qa-btn';
    btn.id = 'lpai-send-time-btn';
    btn.innerHTML = '&#128337; Best Time';
    btn.title = 'Suggest best time to send';
    btn.onclick = function() { lpai_suggest_send_time(btn); };
    bar.appendChild(btn);
}

function lpai_suggest_send_time(clickedBtn) {
    lpai_init_provider();

    var editorContent = lpai_get_editor_content();
    if (!editorContent.trim()) {
        if (rcmail.display_message) rcmail.display_message('Write something first', 'notice');
        return;
    }

    // Get recipients
    var toField = document.getElementById('_to') || document.querySelector('input[name="_to"]');
    var recipients = toField ? toField.value : '';

    var origLabel = clickedBtn.innerHTML;
    clickedBtn.disabled = true;
    clickedBtn.innerHTML = '&#9203; Analyzing...';

    var postData = {
        _action: 'plugin.lifeprisma_ai_request',
        ai_action: 'suggest_send_time',
        instruction: recipients,
        email_body: editorContent,
        reply_text: '',
        subject: lpai_get_subject(),
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
            try {
                var info = JSON.parse(data.result.replace(/```json\n?|\n?```/g, '').trim());
                lpai_show_send_time_badge(info, data.model, data.tokens);
            } catch (e) {
                lpai_show_send_time_badge({ suggestion: data.result }, data.model, data.tokens);
            }
        }
    }).catch(function(err) {
        clickedBtn.disabled = false;
        clickedBtn.innerHTML = origLabel;
    });
}

function lpai_show_send_time_badge(info, model, tokens) {
    var existing = document.getElementById('lpai-send-time-badge');
    if (existing) existing.remove();

    var badge = document.createElement('div');
    badge.id = 'lpai-send-time-badge';
    badge.className = 'lpai-send-time-badge';

    var text = info.suggestion || ('Send ' + (info.day || 'today') + ' at ' + (info.time || ''));
    var reason = info.reason || '';

    var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);

    badge.innerHTML = '<div class="lpai-send-time-content">' +
        '<span class="lpai-send-time-icon">&#128337;</span>' +
        '<span class="lpai-send-time-text">' + text + '</span>' +
        (reason ? '<span class="lpai-send-time-reason">' + reason + '</span>' : '') +
        '</div>' +
        (usageLabel ? '<div class="lpai-usage-footer">' + usageLabel + '</div>' : '') +
        '<button type="button" class="lpai-send-time-close" onclick="this.parentNode.remove()">&times;</button>';

    var bar = document.getElementById('lpai-qa-bar-compose');
    if (bar) {
        bar.parentNode.insertBefore(badge, bar.nextSibling);
    }
}

// ========================================
// Follow-up Reminders (#3)
// ========================================
function lpai_init_followup_detection() {
    // Check user preference
    var sp = rcmail.env.lpai_user_prefs || {};
    if (sp.followup_check === 0 || sp.followup_check === '0') return;

    var providers = rcmail.env.lpai_providers || {};
    if (Object.keys(providers).length === 0) return;

    var msgContext = rcmail.env.lpai_msg_context;
    if (!msgContext) return;

    // Get message body text
    var msgPart = document.querySelector('#messagebody .message-part, #messagebody .message-htmlpart, #messagebody');
    if (!msgPart) return;

    var bodyText = msgPart.innerText || msgPart.textContent || '';
    if (bodyText.trim().length < 5) return;

    var msgUid = rcmail.env.uid || '';
    var mbox = rcmail.env.mailbox || '';
    var cacheKey = 'lpai_fu_' + mbox + '_' + msgUid;

    // Check cache first
    try {
        var cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            var c = JSON.parse(cached);
            lpai_show_email_analysis(c.info, c.model, c.tokens, true);
            return;
        }
    } catch (e) {}

    // Show running indicator
    lpai_followup_indicator(true);

    // Call AI to confirm and get details
    lpai_init_provider();

    // Use admin-configured follow-up provider/model, or fall back to user selection
    var fuProvider = rcmail.env.lpai_followup_provider || lpai_options.provider;
    var fuModel = rcmail.env.lpai_followup_model || '';
    if (!fuModel && fuProvider) {
        var fp = (rcmail.env.lpai_providers || {})[fuProvider];
        fuModel = fp ? fp.default_model : lpai_options.model;
    }

    var postData = {
        _action: 'plugin.lifeprisma_ai_request',
        ai_action: 'detect_followup',
        instruction: '',
        email_body: bodyText.substring(0, 2000),
        reply_text: bodyText.substring(0, 2000),
        subject: msgContext.subject || lpai_get_subject(),
        language: lpai_options.language,
        tone: 'professional',
        sender_name: '',
        reasoning: 'none',
        verbosity: 'low',
        provider: fuProvider,
        model: fuModel,
        history: '[]',
        msg_uid: msgUid,
        mbox: mbox,
        view_context: 'read',
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
        lpai_followup_indicator(false);
        if (data.status === 'success' && data.result) {
            try {
                var info = JSON.parse(data.result.replace(/```json\n?|\n?```/g, '').trim());
                // Cache the result
                try { sessionStorage.setItem(cacheKey, JSON.stringify({ info: info, model: data.model, tokens: data.tokens })); } catch (e) {}
                lpai_show_email_analysis(info, data.model, data.tokens);
            } catch (e) {}
        } else {
            // Cache negative result
            try { sessionStorage.setItem(cacheKey, JSON.stringify({ info: {}, model: '', tokens: null })); } catch (e) {}
            lpai_followup_indicator_ok();
        }
    }).catch(function() {
        lpai_followup_indicator(false);
    });
}

function lpai_followup_indicator(show) {
    var label = document.querySelector('.lpai-qa-label');
    if (!label) return;
    var dot = label.querySelector('.lpai-fu-dot');
    if (show && !dot) {
        dot = document.createElement('span');
        dot.className = 'lpai-fu-dot';
        dot.title = 'Analyzing email...';
        label.appendChild(dot);
    } else if (!show && dot) {
        dot.remove();
    }
}

function lpai_followup_indicator_ok() {
    var label = document.querySelector('.lpai-qa-label');
    if (!label) return;
    // Remove pulsing dot if present
    var dot = label.querySelector('.lpai-fu-dot');
    if (dot) dot.remove();
    // Add checkmark if not already there
    if (label.querySelector('.lpai-fu-ok')) return;
    var ok = document.createElement('span');
    ok.className = 'lpai-fu-ok';
    ok.title = 'Email OK — no follow-up, spam, or scam detected';
    ok.textContent = '\u2713';
    label.appendChild(ok);
}

function lpai_show_email_analysis(info, model, tokens, fromCache) {
    if (!info) { lpai_followup_indicator_ok(); return; }
    var hasAlert = false;

    if (info.is_spam || info.is_scam) {
        lpai_show_alert_banner(info, model, tokens, fromCache);
        hasAlert = true;
    }
    if (info.needs_followup) {
        lpai_show_followup_banner(info, model, tokens, fromCache);
        hasAlert = true;
    }
    if (!hasAlert) {
        lpai_followup_indicator_ok();
    }
}

function lpai_show_alert_banner(info, model, tokens, fromCache) {
    var existing = document.getElementById('lpai-alert-banner');
    if (existing) existing.remove();

    var isScam = info.is_scam;
    var bannerClass = isScam ? 'lpai-followup-high' : 'lpai-alert-spam';
    var icon = isScam ? '&#9888;' : '&#9940;';
    var title = isScam ? 'Possible scam/phishing' : 'Possible spam';
    var reason = isScam ? (info.scam_reason || '') : '';

    var banner = document.createElement('div');
    banner.id = 'lpai-alert-banner';
    banner.className = 'lpai-followup-banner ' + bannerClass;

    var html = '<div class="lpai-followup-content">';
    html += '<span class="lpai-followup-icon">' + icon + '</span>';
    html += '<div class="lpai-followup-info">';
    html += '<strong>' + title + '</strong>';
    if (reason) html += ' &mdash; ' + reason;
    if (info.is_spam && info.is_scam) html += '<br><span class="lpai-followup-deadline">Also detected as spam</span>';
    html += '</div>';
    html += '</div>';
    html += '<div class="lpai-followup-actions">';
    if (info.is_spam) {
        html += '<button type="button" class="lpai-qa-btn lpai-alert-spam-btn" onclick="rcmail.command(\'move\',\'Junk\')">Move to Spam</button>';
    }
    html += '<button type="button" class="lpai-followup-dismiss" onclick="this.parentNode.parentNode.remove()">Dismiss</button>';
    html += '</div>';
    var usageLabel = lpai_format_usage_label(model, tokens);
    if (fromCache) usageLabel = (usageLabel ? usageLabel + ' · ' : '') + 'Cached';
    if (usageLabel) {
        html += '<div class="lpai-usage-footer">' + usageLabel + '</div>';
    }

    banner.innerHTML = html;
    var msgBody = document.getElementById('messagebody');
    if (msgBody) {
        msgBody.parentNode.insertBefore(banner, msgBody);
    }
}

function lpai_show_followup_banner(info, model, tokens, fromCache) {
    var existing = document.getElementById('lpai-followup-banner');
    if (existing) existing.remove();

    var urgencyClass = 'lpai-followup-' + (info.urgency || 'medium');
    var urgencyIcon = info.urgency === 'high' ? '&#9888;' : info.urgency === 'low' ? '&#128172;' : '&#128276;';

    var banner = document.createElement('div');
    banner.id = 'lpai-followup-banner';
    banner.className = 'lpai-followup-banner ' + urgencyClass;

    var html = '<div class="lpai-followup-content">';
    html += '<span class="lpai-followup-icon">' + urgencyIcon + '</span>';
    html += '<div class="lpai-followup-info">';
    html += '<strong>Follow-up needed</strong>';
    if (info.reason) html += ' &mdash; ' + info.reason;
    if (info.deadline) html += '<br><span class="lpai-followup-deadline">Deadline: ' + info.deadline + '</span>';
    if (info.suggested_action) html += '<br><span class="lpai-followup-action">' + info.suggested_action + '</span>';
    html += '</div>';
    html += '</div>';
    html += '<div class="lpai-followup-actions">';
    html += '<button type="button" class="lpai-qa-btn lpai-qa-reply" onclick="try{localStorage.setItem(\'lpai_pending_reply\',\'1\')}catch(e){}rcmail.command(\'reply\')">Reply Now</button>';
    html += '<button type="button" class="lpai-followup-dismiss" onclick="this.parentNode.parentNode.remove()">Dismiss</button>';
    html += '</div>';
    var usageLabel = lpai_format_usage_label(model || lpai_options.model, tokens);
    if (fromCache) usageLabel = (usageLabel ? usageLabel + ' · ' : '') + 'Cached';
    if (usageLabel) {
        html += '<div class="lpai-usage-footer">' + usageLabel + '</div>';
    }

    banner.innerHTML = html;

    var msgBody = document.getElementById('messagebody');
    if (msgBody) {
        msgBody.parentNode.insertBefore(banner, msgBody);
    }
}
