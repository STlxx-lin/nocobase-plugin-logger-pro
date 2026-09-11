# NocoBase Plugin: Logger & Audit Management Pro (`@nocobase/plugin-logger-pro`)

<p align="left">
  <b>English</b> | <a href="./README.md">简体中文</a>
</p>

[![Views](https://komarev.com/ghpvc/?username=nocobase-plugin-logger-pro&color=007ec6&style=flat-square&label=Views)](https://github.com/STlxx-lin/nocobase-plugin-logger-pro)
[![Version](https://img.shields.io/badge/version-v0.1.15-blue.svg)](https://github.com/STlxx-lin/nocobase-plugin-logger-pro/releases)
[![NocoBase Version](https://img.shields.io/badge/NocoBase-2.x-brightgreen.svg)](https://www.nocobase.com)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An enterprise-grade logging console, end-to-end request tracing, AI error diagnostics, and comprehensive operation audit management plugin built for NocoBase.

As an advanced replacement for official basic logging, it offers 100% backward compatibility with built-in log diagnostic endpoints while adding a modern operations dashboard, real-time streaming terminal console, full-lifecycle request waterfall tracing, AI-driven root cause error analysis, user operation diff audits, dynamic runtime log-level reloading, slow SQL monitoring, automated log lifecycle archiving, and multi-channel instant alert notifications.

---

## 🌟 Key Features

### 1. 📊 Operations & Performance Dashboard
- **Real-Time KPI Cards**: Daily audit count, exception error count, alert trigger count, log disk usage, and file count.
- **Trend Charts**: 7-day comparative analysis of operation volume vs. system error spikes.
- **Storage Breakdown**: Visual proportion of System, SQL, Request, and Error log files.
- **Slow SQL Ranking**: Live detection of slowest SQL statements, execution duration, and occurrences.
- **Activity Leaderboards**: Top 5 most active users and top 5 frequently modified collections over the last 7 days.

### 2. 💻 Immersive Streaming Log Console
- **Multi-Source Switching**: Seamless toggle between `system`, `sql`, `request`, `system_error`, and custom log streams.
- **Live Streaming (`tail -f`)**: Real-time incremental auto-scroll with pause controls.
- **Log Level & Syntax Highlighting**: One-click filter for `ERROR` / `WARN` / `INFO` / `DEBUG` with line-level colorization.
- **Keyword & Regex Search**: In-place keyword highlighting and instant regex filtering.
- **Ops Convenience**: One-click log truncation, direct file downloads, and tail buffer size adjustment (100–2,000 lines).

### 3. 🌐 End-to-End Request Lifecycle Tracing
- **Dual-Source Correlation**: Real-time cross-referencing between `request_*.log` and `logger_audit_logs` records.
- **Chronological Waterfall**: Visual sequence of HTTP Inbound -> Middleware Auth -> Database SQL -> Audit Interception -> HTTP Outbound.
- **SQL & Parameter Insight**: Detailed breakdown of all underlying queries, parameter snapshots, and execution durations per request.

### 4. 🤖 AI-Powered Error Diagnostics
- **Built-in Expert Personas**: Tailored prompts for Node.js runtime crashes, unhandled rejections, null pointers, database constraint violations, and permission issues.
- **Direct LLM Connectivity**: Native integration with NocoBase LLM providers including `Dashscope`, `OpenAI`, `DeepSeek`, and `Local Ollama`.
- **Context-Bound Prompting**: Automatically bundles `ReqId`, endpoint URL, request payload, SQL query sequence, and stack traces into the AI prompt.
- **📜 Diagnosis History**: All analysis reports are persistently saved for review, re-evaluation, or team sharing.

### 5. 🛡️ User Operation Audit Trail & Visual Diff
- **Action Interception**: Automatically tracks `create`, `update`, `destroy`, and sensitive system operations.
- **Full Context Capture**: User identity, client IP, User-Agent, collection name, action type, endpoint, execution time, and HTTP status code.
- **Visual Diff Modal**: Clear side-by-side comparison table highlighting `Old Value` vs. `New Value` modifications.
- **Audit Whitelist**: Easily configure which collections should be included or excluded from auditing.

### 6. ⚡ Runtime Log Configuration & Storage Optimization
- **Dynamic Log Level Reloading**: Hot-switch Winston log levels (`Debug`/`Info`/`Warn`/`Error`) without service restarts.
- **Slow SQL Threshold**: Independently toggle SQL logging and define slow SQL latency thresholds in milliseconds.
- **📊 Storage Footprint Analysis**: Inspect log file sizes and database table storage metrics per plugin.
- **Automated Lifecycle Archiving**:
  - Configurable retention periods (default 15 days) and disk quota ceilings (default 2048 MB).
  - Built-in Cron scheduler for automated pruning and cleanup.
  - Manual one-click cleanup and full history export (`.tar.gz`).

### 7. 🔔 Multi-Channel Anomaly Alerting
- **Flexible Triggers**: Fire alerts based on `ERROR` log entries, `HTTP 5xx` statuses, `Slow SQL` thresholds, or custom regex patterns.
- **Anti-Storm Throttling**: Configurable silent period (default 5 mins) to prevent notification flooding during major outages.
- **Supported Channels**:
  - 💬 **WeCom Robot Webhook** (Markdown cards)
  - 🔔 **DingTalk Robot Webhook** (Secret signing supported)
  - 🚀 **Feishu Robot Webhook** (Interactive card messages)
  - 🌐 **Custom Webhook** (Raw JSON POST)
- **Connectivity Testing**: One-click test button for instant alert verification.

---

## 📦 Installation & Activation

1. Place this plugin under `packages/plugins/@nocobase/plugin-logger-pro`.
2. Enable **Logger Pro (`@nocobase/plugin-logger-pro`)** in Plugin Manager.
3. Open NocoBase **Settings Center** to access the full Logger Pro management suite.

---

## 📬 Feedback & Support

For issues, feature requests, or custom consulting:
- **Feedback QQ**: `1414794992`
- **GitHub Issues**: [Open an issue](https://github.com/STlxx-lin/nocobase-plugin-logger-pro/issues)

---

## 📄 License

MIT / AGPL-3.0 License