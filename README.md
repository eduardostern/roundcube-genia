<p align="center">
  <img src="https://raw.githubusercontent.com/eduardostern/roundcube-genia/main/assets/banner.svg" alt="GenIA — AI Email Assistant for Roundcube" width="100%">
</p>

<h1 align="center">GenIA — AI Email Assistant for Roundcube</h1>

<p align="center">
  <strong>The missing AI for your self-hosted email.</strong><br>
  Compose, rewrite, reply, translate, summarize, scam check — works with OpenAI, Claude, Grok, Ollama, or any local LLM.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#usage">Usage</a> •
  <a href="#faq">FAQ</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/eduardostern/roundcube-genia?style=flat-square&color=7c3aed" alt="Release">
  <img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/Roundcube-1.5%2B-blue?style=flat-square" alt="Roundcube">
  <img src="https://img.shields.io/badge/PHP-8.0%2B-777BB4?style=flat-square" alt="PHP">
</p>

---

## Why?

Gmail has Gemini. Outlook has Copilot. **Your self-hosted Roundcube has... nothing. Until now.**

GenIA brings the same AI-powered email experience to your own mail server. No vendor lock-in. Point it at a local Ollama instance and **zero data leaves your network**. Or use cloud providers like OpenAI and Grok when convenience matters. Your server, your choice.

---

## Features

### Seven Powerful Actions

| Action | What it does |
|--------|-------------|
| **Compose** | Describe what you want, get a fully written email |
| **Rewrite** | Change tone, rephrase, restructure your existing draft |
| **Reply** | AI reads the conversation and drafts a contextual reply |
| **Translate** | Translate between 6 languages preserving tone and structure |
| **Summarize** | Extract key points and action items from long threads |
| **Fix Grammar** | Correct spelling, grammar, and punctuation with minimal changes |
| **Check Scam** | Analyze emails for phishing, fraud, and social engineering |

### Quick Actions Toolbar (Read View)

When reading an email, a toolbar appears above the message body with one-click actions:

- **Translate** — dropdown with 6 languages, streams translation inline, "Show Original" to revert
- **Summarize** — streams a summary in a result panel above the email
- **Scam Check** — analyzes the email with color-coded verdict (green/yellow/red)
- **Reply with AI** — opens the full GenIA panel in reply mode

### Multi-Provider Support

Switch between AI providers directly in the UI. Mix cloud and local:

| Provider | Models | Data leaves network? | API Key |
|----------|--------|---------------------|---------|
| **Ollama** | Llama 3.1, Mistral, Qwen, Gemma, etc. | **No** — fully local | Not needed |
| **LM Studio** | Any GGUF model | **No** — fully local | Not needed |
| **LocalAI / vLLM** | Any supported model | **No** — fully local | Optional |
| **OpenAI** | GPT-5.4, GPT-4.1, GPT-4o | Yes — sent to OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic (Claude)** | Sonnet 4.6, Haiku 4.5, Opus 4.6 | Yes — sent to Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **xAI (Grok)** | Grok-4.1-fast, Grok-3 | Yes — sent to xAI | [console.x.ai](https://console.x.ai) |
| **Any OpenAI-compatible API** | Custom | Depends on endpoint | Varies |

### AI Controls

- **Reasoning Effort** — None / Low / Medium / High
- **Verbosity** — Concise / Balanced / Detailed
- **Language** — Portuguese, English, Spanish, French, German, Italian
- **Tone** — Professional, Casual, Friendly, Formal, Urgent

### Smart Features

- **Streaming responses** — see the AI write in real-time
- **Conversation memory** — chain instructions: "make it shorter", "now translate it"
- **Preview before applying** — review AI output before it touches your email
- **Undo** — one-click revert after applying
- **Copy to clipboard** — copy AI results with one click
- **Persistent preferences** — provider, model, language, tone saved across sessions
- **Keyboard shortcut** — `Alt+A` to toggle the GenIA panel
- **Token counter** — see input/output token usage per request

### UI

- Floating GenIA button (bottom-right corner)
- Quick actions toolbar in read view
- Modal panel with backdrop blur
- Dark mode support
- Fully responsive on mobile

---

## Installation

### Option 1: Git Clone (Recommended)

```bash
cd /path/to/roundcube/plugins/
git clone https://github.com/eduardostern/roundcube-genia.git lifeprisma_ai
cd lifeprisma_ai
cp config.inc.php.dist config.inc.php
```

Edit `config.inc.php` and add your API keys.

Enable the plugin in Roundcube's `config/config.inc.php`:

```php
$config['plugins'] = [
    // ... your other plugins
    'lifeprisma_ai',
];
```

### Option 2: Composer

```bash
cd /path/to/roundcube/
composer require lifeprisma/roundcube-genia
```

### Option 3: Manual Download

1. Download the [latest release](https://github.com/eduardostern/roundcube-genia/releases)
2. Extract to `plugins/lifeprisma_ai/`
3. Copy `config.inc.php.dist` to `config.inc.php`
4. Add your API keys and enable the plugin

---

## Configuration

### Ollama (Local — Zero Data Leaves Your Network)

```php
<?php
$config['lifeprisma_ai_providers'] = [
    'ollama' => [
        'label'    => 'Ollama',
        'api_url'  => 'http://localhost:11434/v1/chat/completions',
        'api_type' => 'chat_completions',
        'api_key'  => '',
        'model'    => 'llama3.1',
        'models'   => ['llama3.1', 'mistral', 'qwen2.5'],
        'supports_reasoning' => false,
    ],
];
```

> Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.1`

### Cloud Providers (OpenAI + Claude + Grok)

```php
<?php
$config['lifeprisma_ai_providers'] = [
    'openai' => [
        'label'    => 'GPT',
        'api_url'  => 'https://api.openai.com/v1/responses',
        'api_type' => 'responses',
        'api_key'  => 'sk-proj-xxxxx',
        'model'    => 'gpt-5.4',
        'models'   => ['gpt-5.4', 'gpt-4.1'],
    ],
    'anthropic' => [
        'label'    => 'Claude',
        'api_url'  => 'https://api.anthropic.com/v1/messages',
        'api_type' => 'anthropic',
        'api_key'  => 'sk-ant-xxxxx',
        'model'    => 'claude-sonnet-4-6',
        'models'   => ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
        'supports_reasoning' => false,
    ],
    'xai' => [
        'label'    => 'Grok',
        'api_url'  => 'https://api.x.ai/v1/responses',
        'api_type' => 'responses',
        'api_key'  => 'xai-xxxxx',
        'model'    => 'grok-4.1-fast',
        'models'   => ['grok-4.1-fast', 'grok-3'],
    ],
];
```

### Mix Local + Cloud (Best of Both Worlds)

```php
<?php
$config['lifeprisma_ai_providers'] = [
    'ollama' => [
        'label'    => 'Local',
        'api_url'  => 'http://localhost:11434/v1/chat/completions',
        'api_type' => 'chat_completions',
        'api_key'  => '',
        'model'    => 'llama3.1',
        'models'   => ['llama3.1', 'mistral'],
        'supports_reasoning' => false,
    ],
    'openai' => [
        'label'    => 'GPT',
        'api_url'  => 'https://api.openai.com/v1/responses',
        'api_type' => 'responses',
        'api_key'  => 'sk-proj-xxxxx',
        'model'    => 'gpt-5.4',
        'models'   => ['gpt-5.4', 'gpt-4.1'],
    ],
];
```

> Users can switch between local and cloud in the UI. Use local for privacy, cloud for quality.

### API Type Reference

| `api_type` | Format | Used by |
|------------|--------|---------|
| `responses` | OpenAI Responses API (`/v1/responses`) | OpenAI, xAI |
| `anthropic` | Anthropic Messages API (`/v1/messages`) | Claude (Sonnet, Haiku, Opus) |
| `chat_completions` | Chat Completions API (`/v1/chat/completions`) | Ollama, LM Studio, LocalAI, vLLM, any OpenAI-compatible |

### Global Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lifeprisma_ai_max_tokens` | `2000` | Maximum output tokens per request |
| `lifeprisma_ai_temperature` | `0.5` | Creativity (0.0-1.0). Only when reasoning is "None" |

---

## Usage

1. Log into Roundcube webmail
2. Open a compose window or view an email
3. Click the **GenIA** button (bottom-right) or press `Alt+A`
4. Choose an action, set your preferences, and generate

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Alt+A` | Toggle GenIA panel |
| `Enter` | Submit (in the instruction field) |
| `Shift+Enter` | New line in instruction |
| `Escape` | Close the GenIA panel |

### Tips

- **Quick translate**: Use the toolbar above the email — no panel needed
- **Chain actions**: Compose in Portuguese, translate to English, change tone to Formal
- **Scam check**: Auto-analyzes SPF, DKIM, and authentication headers
- **Persistent settings**: Your provider, language, and tone are remembered

---

## Compatibility

| Roundcube | PHP | Browsers |
|-----------|-----|----------|
| 1.5.x, 1.6.x | 8.0+ | Chrome, Firefox, Safari, Edge, Mobile |

---

## Privacy & Security

GenIA is designed with privacy-conscious self-hosters in mind:

- **Local LLM = zero data leaves your network.** Point GenIA at Ollama or any local model and your emails never touch an external server
- **Cloud providers**: when using OpenAI/Grok, email content is sent to their API for processing. These providers have [data usage policies](https://openai.com/policies/api-data-usage-policies) — API data is **not** used for training by default
- **API keys stay on your server** — never sent to the browser
- **No telemetry, no tracking, no analytics** — the plugin makes zero external calls except to your configured AI endpoint
- **No phone-home, no registration** — install and use, that's it
- **Open source (MIT)** — audit every line of code yourself

### Recommended Setup for Maximum Privacy

Use Ollama with a local model. No API keys needed, no external calls, no data exposure:

```php
'ollama' => [
    'label'    => 'Local',
    'api_url'  => 'http://localhost:11434/v1/chat/completions',
    'api_type' => 'chat_completions',
    'api_key'  => '',
    'model'    => 'llama3.1',
    'models'   => ['llama3.1'],
    'supports_reasoning' => false,
],
```

---

## FAQ

**Q: Which AI providers are supported?**
A: OpenAI (GPT), Anthropic (Claude), xAI (Grok), Ollama, LM Studio, LocalAI, vLLM, and any OpenAI-compatible endpoint. Responses API, Anthropic Messages API, and Chat Completions API formats are all supported.

**Q: Does it send my emails to an external server?**
A: **Only if you configure a cloud provider** (OpenAI, Grok). If you use Ollama or another local LLM, zero data leaves your network. You choose.

**Q: Can I run it fully offline / air-gapped?**
A: Yes. Use Ollama or any local model server. No internet connection needed after initial model download.

**Q: How much does it cost?**
A: The plugin is free (MIT). If using cloud providers, you pay for API usage (~$0.001-0.01 per email). Local models are completely free.

**Q: I see "GenIA is not configured yet" — what do I do?**
A: Your server admin needs to add API keys to the config file. See [Configuration](#configuration) above.

---

## Troubleshooting

### "GenIA is not configured yet"

The plugin needs at least one AI provider with an API key. Create or edit your config file:

```bash
cp plugins/lifeprisma_ai/config.inc.php.dist plugins/lifeprisma_ai/config.inc.php
```

Then add your API keys:

```php
<?php
$config['lifeprisma_ai_providers'] = [
    'openai' => [
        'label'   => 'GPT',
        'api_url' => 'https://api.openai.com/v1/responses',
        'api_key' => 'sk-proj-xxxxx',  // Get yours at platform.openai.com/api-keys
        'model'   => 'gpt-5.4',
        'models'  => ['gpt-5.4', 'gpt-4.1'],
    ],
];
```

Make sure the file is readable by your web server:

```bash
chown root:www-data plugins/lifeprisma_ai/config.inc.php
chmod 640 plugins/lifeprisma_ai/config.inc.php
```

### "API key not configured"

This means the provider you selected doesn't have an API key set. Check your `config.inc.php` and make sure the `api_key` field is filled for each provider.

---

## Contributing

Contributions welcome! Fork, branch, PR.

---

## Support the Project

This plugin is **100% free and open source**. If it helps you:

- Try **[LifePrisma.ai](https://lifeprisma.ai)** — our AI platform
- Star this repo on GitHub
- Share feedback via [GitHub Issues](https://github.com/eduardostern/roundcube-genia/issues)

---

## License

**MIT License** — Free to use, modify, and distribute.

See [LICENSE](LICENSE) for full terms.

---

<p align="center">
  Built by <a href="https://lifeprisma.com">Eduardo Stern</a> / <a href="https://lifeprisma.ai">LifePrisma.ai</a>
</p>
