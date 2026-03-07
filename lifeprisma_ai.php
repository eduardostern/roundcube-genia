<?php

class lifeprisma_ai extends rcube_plugin
{
    public $task = 'mail|settings';

    public function init()
    {
        $this->load_config();
        $this->add_texts('localization/', true);
        $this->include_stylesheet($this->local_skin_path() . '/style.min.css');
        $this->include_script('lifeprisma_ai.min.js');

        $this->register_action('plugin.lifeprisma_ai_request', [$this, 'handle_request']);
        $this->register_action('plugin.lifeprisma_ai_stream', [$this, 'handle_stream']);
        $this->register_action('plugin.lifeprisma_ai_templates', [$this, 'handle_templates']);

        $this->add_hook('render_page', [$this, 'render_page']);
        $this->add_hook('preferences_sections_list', [$this, 'preferences_sections']);
        $this->add_hook('preferences_list', [$this, 'preferences_list']);
        $this->add_hook('preferences_save', [$this, 'preferences_save']);
    }

    public function render_page($args)
    {
        if ($args['template'] === 'compose' || $args['template'] === 'message') {
            $rcmail = rcmail::get_instance();

            // Pass provider list to JS (without API keys, only configured ones)
            $providers = $this->get_providers();
            $js_providers = [];
            foreach ($providers as $id => $p) {
                $ptype = $p['api_type'] ?? 'responses';
                $is_local = $ptype === 'chat_completions' && strpos($p['api_url'] ?? '', 'localhost') !== false;
                if (empty($p['api_key']) && !$is_local) continue;
                $js_providers[$id] = [
                    'label' => $p['label'],
                    'models' => $p['models'] ?? [$p['model']],
                    'default_model' => $p['model'],
                    'supports_reasoning' => $p['supports_reasoning'] ?? true,
                ];
            }
            $rcmail->output->set_env('lpai_providers', $js_providers);

            // Pass user preferences to JS
            $prefs = $rcmail->user->get_prefs();
            $rcmail->output->set_env('lpai_user_prefs', [
                'language' => $prefs['genia_language'] ?? '',
                'tone' => $prefs['genia_tone'] ?? '',
                'auto_draft' => $prefs['genia_auto_draft'] ?? 0,
            ]);

            $rcmail->output->add_footer($this->get_ai_panel_html($js_providers));
        }
        return $args;
    }

    /**
     * Get configured providers — supports both old flat config and new multi-provider format
     */
    private function get_providers()
    {
        $rcmail = rcmail::get_instance();
        $providers = $rcmail->config->get('lifeprisma_ai_providers');

        if (!empty($providers) && is_array($providers)) {
            return $providers;
        }

        // Fallback: build single provider from old flat config
        $api_key = $rcmail->config->get('lifeprisma_ai_api_key', '');
        $model = $rcmail->config->get('lifeprisma_ai_model', 'gpt-4o');
        $api_url = $rcmail->config->get('lifeprisma_ai_api_url', 'https://api.openai.com/v1/responses');

        return [
            'openai' => [
                'label' => 'OpenAI',
                'api_url' => $api_url,
                'api_key' => $api_key,
                'model' => $model,
                'models' => [$model],
            ],
        ];
    }

    /**
     * Resolve provider config by ID
     */
    private function get_provider_config($provider_id = '')
    {
        $providers = $this->get_providers();

        if (!empty($provider_id) && isset($providers[$provider_id])) {
            return $providers[$provider_id];
        }

        // Return first provider as default
        return reset($providers);
    }

    private function get_ai_panel_html($js_providers)
    {
        // SVG icons per provider — OpenAI hexagon/sparkle, xAI X logo
        $icons = [
            'openai' => '<svg class="lpai-provider-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M22.28 9.37a5.93 5.93 0 00-.51-4.88 6.01 6.01 0 00-6.47-2.91A5.93 5.93 0 0010.84.02a6.01 6.01 0 00-5.73 3.93 5.93 5.93 0 00-3.97 2.88 6.01 6.01 0 00.74 7.05 5.93 5.93 0 00.51 4.88 6.01 6.01 0 006.47 2.91 5.93 5.93 0 004.46 1.56 6.01 6.01 0 005.73-3.93 5.93 5.93 0 003.97-2.88 6.01 6.01 0 00-.74-7.05zM13.3 21.54a4.5 4.5 0 01-2.89-1.05l.14-.08 4.8-2.77a.78.78 0 00.39-.68v-6.77l2.03 1.17a.07.07 0 01.04.06v5.6a4.51 4.51 0 01-4.51 4.52zM3.6 17.6a4.49 4.49 0 01-.54-3.02l.14.09 4.8 2.77a.78.78 0 00.78 0l5.86-3.38v2.34a.07.07 0 01-.03.06l-4.85 2.8A4.51 4.51 0 013.6 17.6zM2.34 7.87A4.49 4.49 0 014.7 5.9v5.7a.78.78 0 00.39.68l5.86 3.38-2.03 1.17a.07.07 0 01-.07 0L4 14.03a4.51 4.51 0 01-1.66-6.16zm17.17 4l-5.86-3.38 2.03-1.17a.07.07 0 01.07 0l4.85 2.8a4.51 4.51 0 01-.7 8.13v-5.7a.78.78 0 00-.39-.68zm2.02-3.03l-.14-.09-4.8-2.77a.78.78 0 00-.78 0L9.95 9.36V7.02a.07.07 0 01.03-.06l4.85-2.8a4.51 4.51 0 016.7 4.68zM8.83 12.68L6.8 11.51a.07.07 0 01-.04-.06V5.85a4.51 4.51 0 017.4-3.47l-.14.08-4.8 2.77a.78.78 0 00-.39.68v6.77zm1.1-2.37L12 9.06l2.07 1.19v2.38L12 13.82l-2.07-1.19v-2.38z"/></svg>',
            'xai' => '<svg class="lpai-provider-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M13.98 10.93L21.39 2h-1.75l-6.43 7.76L7.95 2H2l7.77 11.72L2 23h1.75l6.8-8.2L17.05 23H23l-9.02-12.07zM11.54 13.6l-.79-1.17L4.45 3.41h2.7l5.07 7.53.79 1.17 6.59 9.78h-2.7l-5.36-7.29z"/></svg>',
            'anthropic' => '<svg class="lpai-provider-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M13.83 2 22 22h-4.2l-1.67-4.2H9.55L14 6.5l2.91 7.3H13.1L11.44 18h5.73L18.83 22H22L13.83 2ZM8.6 2H4.43L2 8.25 6.17 22h4.17L2 2h6.6Z"/></svg>',
        ];

        // Build provider card buttons
        $provider_buttons = '';
        $first = true;
        foreach ($js_providers as $id => $p) {
            $active = $first ? ' active' : '';
            $icon = $icons[$id] ?? '<svg class="lpai-provider-icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>';
            $provider_buttons .= '<button type="button" class="lpai-provider-btn' . $active . '" data-group="provider" data-value="' . htmlspecialchars($id) . '" data-provider-id="' . htmlspecialchars($id) . '">' . $icon . '<span class="lpai-provider-name">' . htmlspecialchars($p['label']) . '</span></button>';
            $first = false;
        }

        // Build model buttons for all providers (JS will show/hide)
        $model_buttons = '';
        foreach ($js_providers as $id => $p) {
            foreach ($p['models'] as $m) {
                $is_default = ($m === $p['default_model']) ? ' active' : '';
                $model_buttons .= '<button type="button" class="lpai-opt-btn lpai-model-btn' . $is_default . '" data-group="model" data-value="' . htmlspecialchars($m) . '" data-provider="' . htmlspecialchars($id) . '">' . htmlspecialchars($m) . '</button>';
            }
        }

        return '
<div id="lpai-overlay" style="display:none"></div>
<div id="lpai-panel" style="display:none">
    <div id="lpai-header">
        <span id="lpai-title">GenIA Assistant</span>
        <button id="lpai-close" type="button">&times;</button>
    </div>
    <div id="lpai-body">
        <div id="lpai-provider-row">
            ' . $provider_buttons . '
        </div>
        <div id="lpai-actions">
            <button type="button" class="lpai-action-btn" data-action="compose">Compose</button>
            <button type="button" class="lpai-action-btn" data-action="rewrite">Rewrite</button>
            <button type="button" class="lpai-action-btn" data-action="reply">Reply</button>
            <button type="button" class="lpai-action-btn" data-action="translate">Translate</button>
            <button type="button" class="lpai-action-btn" data-action="summarize">Summarize</button>
            <button type="button" class="lpai-action-btn" data-action="fix">Fix Grammar</button>
            <button type="button" class="lpai-action-btn lpai-action-scam" data-action="scam">Check Scam</button>
            <button type="button" class="lpai-action-btn" data-action="suggest_subject">Subject Line</button>
            <button type="button" class="lpai-action-btn" data-action="thread_summarize">Thread Summary</button>
        </div>
        <div id="lpai-model-row" class="lpai-btn-group">
            <span class="lpai-group-label">Model</span>
            ' . $model_buttons . '
        </div>
        <div id="lpai-lang-row" class="lpai-btn-group" style="display:none">
            <span class="lpai-group-label">Language</span>
            <button type="button" class="lpai-opt-btn active" data-group="language" data-value="Portuguese">PT</button>
            <button type="button" class="lpai-opt-btn" data-group="language" data-value="English">EN</button>
            <button type="button" class="lpai-opt-btn" data-group="language" data-value="Spanish">ES</button>
            <button type="button" class="lpai-opt-btn" data-group="language" data-value="French">FR</button>
            <button type="button" class="lpai-opt-btn" data-group="language" data-value="German">DE</button>
            <button type="button" class="lpai-opt-btn" data-group="language" data-value="Italian">IT</button>
        </div>
        <div id="lpai-tone-row" class="lpai-btn-group" style="display:none">
            <span class="lpai-group-label">Tone</span>
            <button type="button" class="lpai-opt-btn active" data-group="tone" data-value="professional">Professional</button>
            <button type="button" class="lpai-opt-btn" data-group="tone" data-value="casual">Casual</button>
            <button type="button" class="lpai-opt-btn" data-group="tone" data-value="friendly">Friendly</button>
            <button type="button" class="lpai-opt-btn" data-group="tone" data-value="formal">Formal</button>
            <button type="button" class="lpai-opt-btn" data-group="tone" data-value="urgent">Urgent</button>
        </div>
        <div id="lpai-reasoning-row" class="lpai-btn-group">
            <span class="lpai-group-label">Reasoning</span>
            <button type="button" class="lpai-opt-btn active" data-group="reasoning" data-value="none">None</button>
            <button type="button" class="lpai-opt-btn" data-group="reasoning" data-value="low">Low</button>
            <button type="button" class="lpai-opt-btn" data-group="reasoning" data-value="medium">Med</button>
            <button type="button" class="lpai-opt-btn" data-group="reasoning" data-value="high">High</button>
        </div>
        <div id="lpai-verbosity-row" class="lpai-btn-group">
            <span class="lpai-group-label">Verbosity</span>
            <button type="button" class="lpai-opt-btn" data-group="verbosity" data-value="low">Concise</button>
            <button type="button" class="lpai-opt-btn active" data-group="verbosity" data-value="medium">Balanced</button>
            <button type="button" class="lpai-opt-btn" data-group="verbosity" data-value="high">Detailed</button>
        </div>
        <div id="lpai-templates-row" class="lpai-btn-group" style="display:none">
            <span class="lpai-group-label">Templates</span>
            <select id="lpai-template-select" class="lpai-template-select"><option value="">Select template...</option></select>
            <button type="button" id="lpai-template-save" class="lpai-opt-btn" title="Save current as template">Save</button>
            <button type="button" id="lpai-template-delete" class="lpai-opt-btn" title="Delete selected template" style="display:none">Del</button>
        </div>
        <div id="lpai-context-preview" style="display:none">
            <div id="lpai-context-toggle" class="lpai-context-toggle">Context preview <span id="lpai-context-arrow">&#9654;</span></div>
            <div id="lpai-context-body" class="lpai-context-body" style="display:none"></div>
        </div>
        <textarea id="lpai-input" placeholder="What do you want GenIA to do?" rows="3"></textarea>
        <div id="lpai-buttons">
            <button id="lpai-submit" type="button">Generate</button>
            <button id="lpai-apply" type="button" style="display:none">Apply to Email</button>
            <button id="lpai-copy" type="button" style="display:none">Copy</button>
            <button id="lpai-undo" type="button" style="display:none">Undo</button>
            <button id="lpai-draft" type="button" style="display:none">Save Draft</button>
        </div>
        <div id="lpai-preview" style="display:none">
            <div id="lpai-preview-label">Preview:</div>
            <div id="lpai-preview-text"></div>
        </div>
        <div id="lpai-loading" style="display:none">
            <div class="lpai-spinner"></div>
            <span id="lpai-loading-text">Thinking...</span>
        </div>
        <div id="lpai-footer">
            <a href="https://lifeprisma.ai" target="_blank" id="lpai-powered">
                <span id="lpai-powered-heart">&#9829;</span> Powered by <strong>LifePrisma.ai</strong>
            </a>
        </div>
    </div>
</div>';
    }

    /**
     * User preferences — add GenIA section
     */
    public function preferences_sections($args)
    {
        $args['list']['genia'] = [
            'id' => 'genia',
            'section' => 'GenIA AI Assistant',
        ];
        return $args;
    }

    public function preferences_list($args)
    {
        if ($args['section'] !== 'genia') return $args;

        $rcmail = rcmail::get_instance();
        $prefs = $rcmail->user->get_prefs();

        $languages = ['Portuguese' => 'Portuguese', 'English' => 'English', 'Spanish' => 'Spanish', 'French' => 'French', 'German' => 'German', 'Italian' => 'Italian'];
        $tones = ['professional' => 'Professional', 'casual' => 'Casual', 'friendly' => 'Friendly', 'formal' => 'Formal', 'urgent' => 'Urgent'];

        $lang_select = new html_select(['name' => '_genia_language', 'id' => 'genia_language']);
        foreach ($languages as $k => $v) $lang_select->add($v, $k);

        $tone_select = new html_select(['name' => '_genia_tone', 'id' => 'genia_tone']);
        foreach ($tones as $k => $v) $tone_select->add($v, $k);

        $draft_checkbox = new html_checkbox(['name' => '_genia_auto_draft', 'id' => 'genia_auto_draft', 'value' => 1]);

        $args['blocks']['genia_general'] = [
            'name' => 'General Settings',
            'options' => [
                'genia_language' => [
                    'title' => 'Default language',
                    'content' => $lang_select->show($prefs['genia_language'] ?? 'Portuguese'),
                ],
                'genia_tone' => [
                    'title' => 'Default tone',
                    'content' => $tone_select->show($prefs['genia_tone'] ?? 'professional'),
                ],
                'genia_auto_draft' => [
                    'title' => 'Auto-save AI content as draft',
                    'content' => $draft_checkbox->show($prefs['genia_auto_draft'] ?? 0),
                ],
            ],
        ];

        return $args;
    }

    public function preferences_save($args)
    {
        if ($args['section'] !== 'genia') return $args;

        $args['prefs']['genia_language'] = rcube_utils::get_input_string('_genia_language', rcube_utils::INPUT_POST);
        $args['prefs']['genia_tone'] = rcube_utils::get_input_string('_genia_tone', rcube_utils::INPUT_POST);
        $args['prefs']['genia_auto_draft'] = rcube_utils::get_input_string('_genia_auto_draft', rcube_utils::INPUT_POST) ? 1 : 0;

        return $args;
    }

    /**
     * Handle email templates (save/load/delete)
     */
    public function handle_templates()
    {
        $rcmail = rcmail::get_instance();
        header('Content-Type: application/json; charset=utf-8');

        $op = rcube_utils::get_input_string('op', rcube_utils::INPUT_POST) ?: rcube_utils::get_input_string('op', rcube_utils::INPUT_GET);
        $prefs = $rcmail->user->get_prefs();
        $templates = $prefs['genia_templates'] ?? [];

        if ($op === 'list') {
            echo json_encode(['status' => 'success', 'templates' => $templates]);
            exit;
        }

        if ($op === 'save') {
            $name = rcube_utils::get_input_string('name', rcube_utils::INPUT_POST);
            $action = rcube_utils::get_input_string('tpl_action', rcube_utils::INPUT_POST);
            $instruction = rcube_utils::get_input_string('instruction', rcube_utils::INPUT_POST);

            if (empty($name)) {
                echo json_encode(['status' => 'error', 'message' => 'Template name is required']);
                exit;
            }

            $templates[] = [
                'id' => uniqid('tpl_'),
                'name' => $name,
                'action' => $action,
                'instruction' => $instruction,
            ];

            $rcmail->user->save_prefs(['genia_templates' => $templates]);
            echo json_encode(['status' => 'success', 'templates' => $templates]);
            exit;
        }

        if ($op === 'delete') {
            $id = rcube_utils::get_input_string('id', rcube_utils::INPUT_POST);
            $templates = array_values(array_filter($templates, function ($t) use ($id) {
                return $t['id'] !== $id;
            }));
            $rcmail->user->save_prefs(['genia_templates' => $templates]);
            echo json_encode(['status' => 'success', 'templates' => $templates]);
            exit;
        }

        echo json_encode(['status' => 'error', 'message' => 'Invalid operation']);
        exit;
    }

    /**
     * Rate limiting — per-user cooldown
     */
    private function check_rate_limit()
    {
        $rcmail = rcmail::get_instance();
        $cooldown = (int) $rcmail->config->get('lifeprisma_ai_rate_limit', 3);
        if ($cooldown <= 0) return true;

        $session_key = 'lpai_last_request';
        $last = $_SESSION[$session_key] ?? 0;
        $now = microtime(true);

        if ($now - $last < $cooldown) {
            return false;
        }

        $_SESSION[$session_key] = $now;
        return true;
    }

    /**
     * Streaming endpoint — sends Server-Sent Events
     */
    public function handle_stream()
    {
        if (!$this->check_rate_limit()) {
            header('Content-Type: text/event-stream');
            echo "data: " . json_encode(['type' => 'error', 'message' => 'Please wait a few seconds between requests.']) . "\n\n";
            exit;
        }

        $rcmail = rcmail::get_instance();

        $action = rcube_utils::get_input_string('ai_action', rcube_utils::INPUT_POST);
        $instruction = rcube_utils::get_input_string('instruction', rcube_utils::INPUT_POST);
        $email_body = rcube_utils::get_input_string('email_body', rcube_utils::INPUT_POST);
        $reply_text = rcube_utils::get_input_string('reply_text', rcube_utils::INPUT_POST);
        $subject = rcube_utils::get_input_string('subject', rcube_utils::INPUT_POST);
        $language = rcube_utils::get_input_string('language', rcube_utils::INPUT_POST);
        $tone = rcube_utils::get_input_string('tone', rcube_utils::INPUT_POST);
        $sender_name = rcube_utils::get_input_string('sender_name', rcube_utils::INPUT_POST);
        $reasoning = rcube_utils::get_input_string('reasoning', rcube_utils::INPUT_POST) ?: 'none';
        $verbosity = rcube_utils::get_input_string('verbosity', rcube_utils::INPUT_POST) ?: 'medium';
        $history = rcube_utils::get_input_string('history', rcube_utils::INPUT_POST);
        $msg_uid = rcube_utils::get_input_string('msg_uid', rcube_utils::INPUT_POST);
        $mbox = rcube_utils::get_input_string('mbox', rcube_utils::INPUT_POST);
        $provider_id = rcube_utils::get_input_string('provider', rcube_utils::INPUT_POST);
        $model_override = rcube_utils::get_input_string('model', rcube_utils::INPUT_POST);
        $view_context = rcube_utils::get_input_string('view_context', rcube_utils::INPUT_POST);

        $provider = $this->get_provider_config($provider_id);
        $api_key = $provider['api_key'] ?? '';
        $model = $model_override ?: ($provider['model'] ?? 'gpt-4o');
        $api_url = $provider['api_url'] ?? 'https://api.openai.com/v1/responses';
        $api_type = $provider['api_type'] ?? 'responses';
        $max_tokens = (int) $rcmail->config->get('lifeprisma_ai_max_tokens', 2000);
        $temperature = (float) $rcmail->config->get('lifeprisma_ai_temperature', 0.5);

        $is_local = $api_type === 'chat_completions' && strpos($api_url, 'localhost') !== false;
        if (empty($api_key) && !$is_local) {
            header('Content-Type: text/event-stream');
            echo "data: " . json_encode(['type' => 'error', 'message' => 'API key not configured. Your server admin needs to edit plugins/lifeprisma_ai/config.inc.php — see github.com/eduardostern/roundcube-genia#configuration']) . "\n\n";
            exit;
        }

        // Get user's own identity (for "I am:" context)
        $user_identity = '';
        $identity = $rcmail->user->get_identity();
        if (!empty($identity)) {
            $user_identity = trim(($identity['name'] ?? '') . ' <' . ($identity['email'] ?? '') . '>');
        }

        // Enrich context from IMAP only in read view — fill gaps, don't overwrite JS data
        $raw_headers = '';
        $original_sender = '';
        if (!empty($msg_uid) && $view_context === 'read') {
            $ctx = $this->fetch_message_context($msg_uid, $mbox);
            if (!empty($ctx)) {
                if (empty($subject)) $subject = $ctx['subject'] ?? '';
                if (empty($reply_text)) $reply_text = $ctx['body'] ?? '';
                $original_sender = $ctx['from'] ?? '';
            }
        }
        if (!empty($msg_uid) && $action === 'scam') {
            $raw_headers = $this->fetch_raw_headers($msg_uid, $mbox);
        }

        // In read view, sender_name should be the user, not the email sender
        if ($view_context === 'read') {
            $sender_name = $user_identity;
        }

        $system_prompt = $this->build_system_prompt($action);
        $user_prompt = $this->build_user_prompt($action, $instruction, $email_body, $reply_text, $subject, $language, $tone, $sender_name, $raw_headers, $original_sender);

        // Build messages/input with conversation history
        $input = [];
        if (!empty($history)) {
            $hist = json_decode($history, true);
            if (is_array($hist)) {
                foreach ($hist as $msg) {
                    $input[] = $msg;
                }
            }
        }
        $input[] = ['role' => 'user', 'content' => $user_prompt];

        $supports_reasoning = $provider['supports_reasoning'] ?? ($api_type === 'responses');

        // Build payload based on API type
        if ($api_type === 'anthropic') {
            $payload = [
                'model' => $model,
                'system' => $system_prompt,
                'messages' => $input,
                'max_tokens' => $max_tokens,
                'stream' => true,
                'temperature' => $temperature,
            ];
        } elseif ($api_type === 'chat_completions') {
            $messages = array_merge(
                [['role' => 'system', 'content' => $system_prompt]],
                $input
            );
            $payload = [
                'model' => $model,
                'messages' => $messages,
                'max_tokens' => $max_tokens,
                'stream' => true,
                'temperature' => $temperature,
            ];
        } else {
            $payload = [
                'model' => $model,
                'instructions' => $system_prompt,
                'input' => $input,
                'max_output_tokens' => $max_tokens,
                'stream' => true,
            ];
            if ($supports_reasoning) {
                $payload['reasoning'] = ['effort' => $reasoning];
                $payload['text'] = ['verbosity' => $verbosity];
                if ($reasoning === 'none') {
                    $payload['temperature'] = $temperature;
                }
            } else {
                $payload['temperature'] = $temperature;
            }
        }

        // SSE headers
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');

        // Disable output buffering
        while (ob_get_level()) {
            ob_end_flush();
        }

        $ch = curl_init($api_url);

        $headers = ['Content-Type: application/json'];
        if ($api_type === 'anthropic') {
            $headers[] = 'x-api-key: ' . $api_key;
            $headers[] = 'anthropic-version: 2023-06-01';
        } elseif (!empty($api_key)) {
            $headers[] = 'Authorization: Bearer ' . $api_key;
        }

        $stream_api_type = $api_type;
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_SSL_VERIFYPEER => !$is_local,
            CURLOPT_WRITEFUNCTION => function ($ch, $data) use ($stream_api_type) {
                $lines = explode("\n", $data);
                foreach ($lines as $line) {
                    $line = trim($line);
                    if (empty($line)) continue;
                    if (strpos($line, 'data: ') !== 0) continue;
                    $json = substr($line, 6);
                    if ($json === '[DONE]') continue;

                    $event = json_decode($json, true);
                    if (!$event) continue;

                    if ($stream_api_type === 'anthropic') {
                        // Anthropic Messages API format
                        $type = $event['type'] ?? '';
                        if ($type === 'content_block_delta') {
                            $delta = $event['delta']['text'] ?? '';
                            if ($delta !== '') {
                                echo "data: " . json_encode(['type' => 'delta', 'text' => $delta]) . "\n\n";
                                flush();
                            }
                        } elseif ($type === 'message_stop') {
                            echo "data: " . json_encode(['type' => 'done', 'tokens' => ['input' => 0, 'output' => 0]]) . "\n\n";
                            flush();
                        } elseif ($type === 'message_delta') {
                            $usage = $event['usage'] ?? [];
                            if (!empty($usage)) {
                                echo "data: " . json_encode([
                                    'type' => 'done',
                                    'tokens' => [
                                        'input' => $usage['input_tokens'] ?? 0,
                                        'output' => $usage['output_tokens'] ?? 0,
                                    ],
                                ]) . "\n\n";
                                flush();
                            }
                        } elseif ($type === 'error') {
                            $msg = $event['error']['message'] ?? 'Unknown error';
                            echo "data: " . json_encode(['type' => 'error', 'message' => $msg]) . "\n\n";
                            flush();
                        }
                    } elseif ($stream_api_type === 'chat_completions') {
                        // OpenAI Chat Completions / Ollama format
                        $delta = $event['choices'][0]['delta']['content'] ?? '';
                        if ($delta !== '') {
                            echo "data: " . json_encode(['type' => 'delta', 'text' => $delta]) . "\n\n";
                            flush();
                        }
                        $finish = $event['choices'][0]['finish_reason'] ?? null;
                        if ($finish === 'stop') {
                            $usage = $event['usage'] ?? [];
                            echo "data: " . json_encode([
                                'type' => 'done',
                                'tokens' => [
                                    'input' => $usage['prompt_tokens'] ?? 0,
                                    'output' => $usage['completion_tokens'] ?? 0,
                                ],
                            ]) . "\n\n";
                            flush();
                        }
                    } else {
                        // OpenAI Responses API format
                        $type = $event['type'] ?? '';
                        if ($type === 'response.output_text.delta') {
                            $delta = $event['delta'] ?? '';
                            echo "data: " . json_encode(['type' => 'delta', 'text' => $delta]) . "\n\n";
                            flush();
                        } elseif ($type === 'response.completed') {
                            $usage = $event['response']['usage'] ?? [];
                            echo "data: " . json_encode([
                                'type' => 'done',
                                'tokens' => [
                                    'input' => $usage['input_tokens'] ?? 0,
                                    'output' => $usage['output_tokens'] ?? 0,
                                ],
                            ]) . "\n\n";
                            flush();
                        } elseif ($type === 'error') {
                            $msg = $event['message'] ?? 'Unknown error';
                            echo "data: " . json_encode(['type' => 'error', 'message' => $msg]) . "\n\n";
                            flush();
                        }
                    }
                }
                return strlen($data);
            },
        ]);

        curl_exec($ch);

        if (curl_error($ch)) {
            echo "data: " . json_encode(['type' => 'error', 'message' => curl_error($ch)]) . "\n\n";
            flush();
        }

        curl_close($ch);

        echo "data: [DONE]\n\n";
        flush();
        exit;
    }

    /**
     * Non-streaming fallback endpoint
     */
    public function handle_request()
    {
        if (!$this->check_rate_limit()) {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['status' => 'error', 'message' => 'Please wait a few seconds between requests.']);
            exit;
        }

        $rcmail = rcmail::get_instance();
        header('Content-Type: application/json; charset=utf-8');

        $action = rcube_utils::get_input_string('ai_action', rcube_utils::INPUT_POST);
        $instruction = rcube_utils::get_input_string('instruction', rcube_utils::INPUT_POST);
        $email_body = rcube_utils::get_input_string('email_body', rcube_utils::INPUT_POST);
        $reply_text = rcube_utils::get_input_string('reply_text', rcube_utils::INPUT_POST);
        $subject = rcube_utils::get_input_string('subject', rcube_utils::INPUT_POST);
        $language = rcube_utils::get_input_string('language', rcube_utils::INPUT_POST);
        $tone = rcube_utils::get_input_string('tone', rcube_utils::INPUT_POST);
        $sender_name = rcube_utils::get_input_string('sender_name', rcube_utils::INPUT_POST);
        $reasoning = rcube_utils::get_input_string('reasoning', rcube_utils::INPUT_POST) ?: 'none';
        $verbosity = rcube_utils::get_input_string('verbosity', rcube_utils::INPUT_POST) ?: 'medium';
        $msg_uid = rcube_utils::get_input_string('msg_uid', rcube_utils::INPUT_POST);
        $mbox = rcube_utils::get_input_string('mbox', rcube_utils::INPUT_POST);
        $provider_id = rcube_utils::get_input_string('provider', rcube_utils::INPUT_POST);
        $model_override = rcube_utils::get_input_string('model', rcube_utils::INPUT_POST);
        $view_context = rcube_utils::get_input_string('view_context', rcube_utils::INPUT_POST);

        $provider = $this->get_provider_config($provider_id);
        $api_key = $provider['api_key'] ?? '';
        $model = $model_override ?: ($provider['model'] ?? 'gpt-4o');
        $api_url = $provider['api_url'] ?? 'https://api.openai.com/v1/responses';
        $api_type = $provider['api_type'] ?? 'responses';
        $max_tokens = (int) $rcmail->config->get('lifeprisma_ai_max_tokens', 2000);
        $temperature = (float) $rcmail->config->get('lifeprisma_ai_temperature', 0.5);

        $is_local = $api_type === 'chat_completions' && strpos($api_url, 'localhost') !== false;
        if (empty($api_key) && !$is_local) {
            echo json_encode(['status' => 'error', 'message' => 'API key not configured. Your server admin needs to edit plugins/lifeprisma_ai/config.inc.php — see github.com/eduardostern/roundcube-genia#configuration']);
            exit;
        }

        $user_identity = '';
        $identity = $rcmail->user->get_identity();
        if (!empty($identity)) {
            $user_identity = trim(($identity['name'] ?? '') . ' <' . ($identity['email'] ?? '') . '>');
        }

        $raw_headers = '';
        $original_sender = '';
        if (!empty($msg_uid) && $view_context === 'read') {
            $ctx = $this->fetch_message_context($msg_uid, $mbox);
            if (!empty($ctx)) {
                if (empty($subject)) $subject = $ctx['subject'] ?? '';
                if (empty($reply_text)) $reply_text = $ctx['body'] ?? '';
                $original_sender = $ctx['from'] ?? '';
            }
        }
        if (!empty($msg_uid) && $action === 'scam') {
            $raw_headers = $this->fetch_raw_headers($msg_uid, $mbox);
        }

        if ($view_context === 'read') {
            $sender_name = $user_identity;
        }

        $system_prompt = $this->build_system_prompt($action);
        $user_prompt = $this->build_user_prompt($action, $instruction, $email_body, $reply_text, $subject, $language, $tone, $sender_name, $raw_headers, $original_sender);

        $supports_reasoning = $provider['supports_reasoning'] ?? ($api_type === 'responses');

        // Build payload based on API type
        if ($api_type === 'anthropic') {
            $payload = [
                'model' => $model,
                'system' => $system_prompt,
                'messages' => [['role' => 'user', 'content' => $user_prompt]],
                'max_tokens' => $max_tokens,
                'temperature' => $temperature,
            ];
        } elseif ($api_type === 'chat_completions') {
            $messages = [
                ['role' => 'system', 'content' => $system_prompt],
                ['role' => 'user', 'content' => $user_prompt],
            ];
            $payload = [
                'model' => $model,
                'messages' => $messages,
                'max_tokens' => $max_tokens,
                'temperature' => $temperature,
            ];
        } else {
            $payload = [
                'model' => $model,
                'instructions' => $system_prompt,
                'input' => $user_prompt,
                'max_output_tokens' => $max_tokens,
            ];
            if ($supports_reasoning) {
                $payload['reasoning'] = ['effort' => $reasoning];
                $payload['text'] = ['verbosity' => $verbosity];
                if ($reasoning === 'none') {
                    $payload['temperature'] = $temperature;
                }
            } else {
                $payload['temperature'] = $temperature;
            }
        }

        $curl_headers = ['Content-Type: application/json'];
        if ($api_type === 'anthropic') {
            $curl_headers[] = 'x-api-key: ' . $api_key;
            $curl_headers[] = 'anthropic-version: 2023-06-01';
        } elseif (!empty($api_key)) {
            $curl_headers[] = 'Authorization: Bearer ' . $api_key;
        }

        $ch = curl_init($api_url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => $curl_headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_SSL_VERIFYPEER => !$is_local,
        ]);

        $response = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($error) {
            echo json_encode(['status' => 'error', 'message' => 'Connection failed: ' . $error]);
            exit;
        }

        $data = json_decode($response, true);

        if ($http_code !== 200) {
            $msg = $data['error']['message'] ?? 'API error (HTTP ' . $http_code . ')';
            echo json_encode(['status' => 'error', 'message' => $msg]);
            exit;
        }

        $content = '';
        if ($api_type === 'anthropic') {
            foreach ($data['content'] ?? [] as $block) {
                if (($block['type'] ?? '') === 'text') {
                    $content .= $block['text'];
                }
            }
        } elseif ($api_type === 'chat_completions') {
            $content = $data['choices'][0]['message']['content'] ?? '';
        } else {
            if (!empty($data['output'])) {
                foreach ($data['output'] as $item) {
                    if (($item['type'] ?? '') === 'message' && !empty($item['content'])) {
                        foreach ($item['content'] as $block) {
                            if (($block['type'] ?? '') === 'output_text') {
                                $content .= $block['text'];
                            }
                        }
                    }
                }
            }
        }

        if (empty($content)) {
            echo json_encode(['status' => 'error', 'message' => 'Empty response from AI']);
            exit;
        }

        $usage = $data['usage'] ?? [];
        $input_tokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
        $output_tokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;
        echo json_encode([
            'status' => 'success',
            'result' => trim($content),
            'tokens' => [
                'input' => $input_tokens,
                'output' => $output_tokens,
            ],
        ]);
        exit;
    }

    /**
     * Fetch full message context from IMAP (subject, from, to, body, headers)
     */
    private function fetch_message_context($uid, $mbox = '')
    {
        try {
            $rcmail = rcmail::get_instance();
            $storage = $rcmail->get_storage();

            if (!empty($mbox)) {
                $storage->set_folder($mbox);
            }

            $uid = (int) $uid;
            $msg = new rcube_message($uid);
            if (empty($msg->headers)) {
                return [];
            }

            // Get message body as plain text
            $body = '';
            $text_body = $msg->first_text_part($part);
            if (!empty($text_body)) {
                $body = $text_body;
            } else {
                // Fallback: try HTML part and convert
                $html_body = $msg->first_html_part($part);
                if (!empty($html_body)) {
                    $h2t = new rcube_html2text($html_body);
                    $body = $h2t->get_text();
                }
            }

            return [
                'subject' => $msg->headers->subject ?? '',
                'from' => $msg->headers->from ?? '',
                'to' => $msg->headers->to ?? '',
                'date' => $msg->headers->date ?? '',
                'body' => trim($body),
            ];
        } catch (\Exception $e) {
            return [];
        }
    }

    /**
     * Fetch raw email headers from IMAP for scam analysis
     */
    private function fetch_raw_headers($uid, $mbox = '')
    {
        $rcmail = rcmail::get_instance();
        $storage = $rcmail->get_storage();

        if (!empty($mbox)) {
            $storage->set_folder($mbox);
        }

        $raw = $storage->get_raw_headers((int) $uid);
        if (empty($raw)) {
            return '';
        }

        $relevant_headers = [
            'From', 'To', 'Reply-To', 'Return-Path', 'Subject', 'Date',
            'Message-ID', 'X-Mailer', 'X-Originating-IP',
            'Received-SPF', 'Authentication-Results', 'DKIM-Signature',
            'ARC-Authentication-Results', 'X-Spam-Status', 'X-Spam-Score',
            'Content-Type', 'MIME-Version', 'Received'
        ];

        $lines = explode("\n", $raw);
        $filtered = [];
        $capturing = false;

        foreach ($lines as $line) {
            if (preg_match('/^([A-Za-z\-]+):\s*(.*)$/', $line, $m)) {
                $capturing = false;
                foreach ($relevant_headers as $h) {
                    if (strcasecmp($m[1], $h) === 0) {
                        $filtered[] = $line;
                        $capturing = true;
                        break;
                    }
                }
            } elseif ($capturing && preg_match('/^\s+/', $line)) {
                $filtered[] = $line;
            } else {
                $capturing = false;
            }
        }

        return implode("\n", $filtered);
    }

    private function build_system_prompt($action = '')
    {
        if ($action === 'suggest_subject') {
            return "You are an email subject line expert. Generate clear, concise, professional subject lines. " .
                "Return ONLY a numbered list of 5 subject lines, nothing else.";
        }

        if ($action === 'thread_summarize') {
            return "You are an expert email thread analyst. Summarize threads clearly and concisely. " .
                "Use markdown formatting (bold for key points, bullet lists for action items). " .
                "Structure: Overview, Key Points, Action Items, Current Status.";
        }

        if ($action === 'scam') {
            return "You are a cybersecurity expert specialized in email fraud detection. " .
                "Analyze the email for signs of scam, phishing, fraud, social engineering, or suspicious content.\n\n" .
                "Check for:\n" .
                "- Urgency tactics and pressure to act fast\n" .
                "- Requests for money, gift cards, wire transfers, or crypto\n" .
                "- Requests for personal information, passwords, or credentials\n" .
                "- Suspicious links or domain impersonation\n" .
                "- Impersonation of known entities (banks, government, tech companies)\n" .
                "- Grammar/spelling patterns common in scam emails\n" .
                "- Too-good-to-be-true offers\n" .
                "- Mismatched sender identity\n" .
                "- Emotional manipulation (fear, greed, curiosity)\n\n" .
                "When raw email headers are provided, also check:\n" .
                "- SPF, DKIM, and DMARC authentication results\n" .
                "- Mismatched From vs Return-Path or Reply-To addresses\n" .
                "- Suspicious Received headers or originating IPs\n" .
                "- Unusual X-Mailer or sending infrastructure\n\n" .
                "Provide a clear verdict: SAFE, SUSPICIOUS, or DANGEROUS.\n" .
                "Then explain your reasoning with specific evidence from the email.\n" .
                "Format your response with clear structure. Use bold for key findings and bullet points for evidence.";
        }

        return "You are an expert email writing assistant embedded in a webmail client. Your rules:\n\n" .
            "1. EXECUTE instructions, never write emails ABOUT instructions.\n" .
            "2. When asked to translate, translate the text. When asked to rewrite, rewrite it.\n" .
            "3. Return ONLY the email body text. No subject lines, no code blocks, no explanations.\n" .
            "4. Preserve the email structure (greeting, body, closing) unless told otherwise.\n" .
            "5. Match the requested tone and language precisely.\n" .
            "6. Be natural and human-sounding, not robotic.\n" .
            "7. When composing replies, be contextually aware of the conversation.\n" .
            "8. Use markdown formatting (bold, lists, tables). For tables use markdown pipe syntax (| col | col |), never ASCII art (+---+). Always put a line break after the greeting (e.g. 'Olá,\\n\\n' not 'Olá,Texto').\n" .
            "9. If the user gives a follow-up instruction like 'make it shorter' or 'now translate it', " .
            "apply it to the previously generated text.";
    }

    private function build_user_prompt($action, $instruction, $email_body, $reply_text, $subject, $language, $tone, $sender_name, $raw_headers = '', $original_sender = '')
    {
        switch ($action) {
            case 'compose':
                return "Compose a new {$tone} email in {$language}.\n" .
                    ($subject ? "Subject context: {$subject}\n" : '') .
                    ($sender_name ? "From: {$sender_name}\n" : '') .
                    "Instructions: {$instruction}\n\n" .
                    "Write the email body only. No subject line.";

            case 'rewrite':
                return "Here is the current email draft:\n\n{$email_body}\n\n" .
                    "Rewrite this email with a {$tone} tone in {$language}.\n" .
                    ($instruction ? "Additional instructions: {$instruction}\n" : '') .
                    "Return only the rewritten email body.";

            case 'reply':
                $prompt = "Here is the email to reply to:\n\n";
                if (!empty($original_sender)) {
                    $prompt .= "From: {$original_sender}\n";
                }
                if (!empty($subject)) {
                    $prompt .= "Subject: {$subject}\n";
                }
                $prompt .= "\n{$reply_text}\n\n";
                if (!empty($email_body)) {
                    $prompt .= "Current draft reply:\n\n{$email_body}\n\n";
                }
                if (!empty($sender_name)) {
                    $prompt .= "I am: {$sender_name}\n";
                }
                $prompt .= "Write a {$tone} reply in {$language}.\n" .
                    "Instructions: {$instruction}\n\n" .
                    "Return only the reply body.";
                return $prompt;

            case 'translate':
                return "Translate the following email to {$language}. " .
                    "Keep the same tone, structure, and meaning. Return only the translated text.\n\n{$email_body}";

            case 'summarize':
                $text = $reply_text ?: $email_body;
                return "Summarize this email thread concisely in {$language}. " .
                    "Include key points, action items, and decisions.\n\n{$text}";

            case 'fix':
                return "Fix all grammar, spelling, and punctuation errors in this email. " .
                    "Keep the same tone, style, and language. Make minimal changes. " .
                    "Return only the corrected email body.\n\n{$email_body}";

            case 'scam':
                $text = $reply_text ?: $email_body;
                $prompt = "Analyze this email for scam, phishing, or fraud indicators.\n\n";
                if (!empty($raw_headers)) {
                    $prompt .= "=== RAW EMAIL HEADERS ===\n{$raw_headers}\n\n";
                }
                if (!empty($subject)) {
                    $prompt .= "=== SUBJECT ===\n{$subject}\n\n";
                }
                $prompt .= "=== EMAIL BODY ===\n{$text}";
                return $prompt;

            case 'suggest_subject':
                return "Based on this email body, suggest 5 concise, professional subject lines in {$language}. " .
                    "Format as a numbered list. Each should be clear and specific.\n\n" .
                    "Email body:\n{$email_body}";

            case 'thread_summarize':
                $text = $reply_text ?: $email_body;
                return "Summarize this entire email thread in {$language}. Include:\n" .
                    "- Key discussion points\n" .
                    "- Decisions made\n" .
                    "- Action items and who is responsible\n" .
                    "- Current status\n\n" .
                    "Thread:\n{$text}";

            default:
                return "Help with this email in {$language} with a {$tone} tone.\n" .
                    ($email_body ? "Current text:\n{$email_body}\n\n" : '') .
                    "Instructions: {$instruction}";
        }
    }
}
