export const PLUGIN_NAME = 'logger-pro';
export const RESOURCE_NAME = 'loggerPro';
export const COMPAT_RESOURCE_NAME = 'logger';

export const CONFIG_KEYS = {
  LOGGER_LEVEL: 'logger_level',
  SQL_LOGGING: 'sql_logging',
  SLOW_QUERY_ENABLED: 'slow_query_enabled',
  SLOW_QUERY_THRESHOLD_MS: 'slow_query_threshold_ms',
  REQUEST_LOGGING: 'request_logging',
  REQUEST_IGNORE_PATTERNS: 'request_ignore_patterns',
  AUDIT_LOG_ENABLED: 'audit_log_enabled',
  AUDIT_RECORD_DIFF: 'audit_record_diff',
  AUDIT_COLLECTIONS: 'audit_collections',
  AUDIT_EXCLUDE_COLLECTIONS: 'audit_exclude_collections',
  AUDIT_EXCLUDE_ACTIONS: 'audit_exclude_actions',
  AUDIT_IGNORE_READONLY_POST: 'audit_ignore_readonly_post',
  AUDIT_ZERO_DIFF_SKIP: 'audit_zero_diff_skip',
  RETENTION_DAYS: 'retention_days',
  MAX_DISK_SIZE_MB: 'max_disk_size_mb',
  AUTO_CLEAN_ENABLED: 'auto_clean_enabled',
  AUTO_CLEAN_CRON: 'auto_clean_cron',
  AI_ALLOW_PRIVATE_LLM: 'ai_allow_private_llm',
  AI_DEFAULT_SANITIZE: 'ai_default_sanitize',
  AI_REQUEST_TIMEOUT_MS: 'ai_request_timeout_ms',
  AI_DEFAULT_EMPLOYEE: 'ai_default_employee',
  AI_DEFAULT_LLM_SERVICE: 'ai_default_llm_service',
  AI_DEFAULT_LLM_MODEL: 'ai_default_llm_model',
};

export const DEFAULT_CONFIGS = {
  [CONFIG_KEYS.LOGGER_LEVEL]: 'info',
  [CONFIG_KEYS.SQL_LOGGING]: 'true',
  [CONFIG_KEYS.SLOW_QUERY_ENABLED]: 'true',
  [CONFIG_KEYS.SLOW_QUERY_THRESHOLD_MS]: '500',
  [CONFIG_KEYS.REQUEST_LOGGING]: 'true',
  [CONFIG_KEYS.REQUEST_IGNORE_PATTERNS]: '["/api/loggerPro/*", "/api/logger/*", "/static/*", "/favicon.ico"]',
  [CONFIG_KEYS.AUDIT_LOG_ENABLED]: 'true',
  [CONFIG_KEYS.AUDIT_RECORD_DIFF]: 'true',
  [CONFIG_KEYS.AUDIT_COLLECTIONS]: '[]', // 空代表开启所有数据表
  [CONFIG_KEYS.AUDIT_EXCLUDE_COLLECTIONS]: '["auth", "roles", "uiSchemas", "uiSchemaTemplates", "desktopRoutes", "themeConfig", "dataSources", "environmentVariables", "systemSettings", "applicationPlugins", "migrations"]',
  [CONFIG_KEYS.AUDIT_EXCLUDE_ACTIONS]: '["syncCookies", "unreadCounts", "listByUser", "listMeta", "listAccessible", "listMine", "check"]',
  [CONFIG_KEYS.AUDIT_IGNORE_READONLY_POST]: 'true',
  [CONFIG_KEYS.AUDIT_ZERO_DIFF_SKIP]: 'true',
  [CONFIG_KEYS.RETENTION_DAYS]: '15',
  [CONFIG_KEYS.MAX_DISK_SIZE_MB]: '2048',
  [CONFIG_KEYS.AUTO_CLEAN_ENABLED]: 'true',
  [CONFIG_KEYS.AUTO_CLEAN_CRON]: '0 2 * * *', // 每天凌晨2点自动清理
  [CONFIG_KEYS.AI_ALLOW_PRIVATE_LLM]: 'true', // 默认信任管理员在 llm_services 中配置的本地/内网大模型 (Ollama 等)
  [CONFIG_KEYS.AI_DEFAULT_SANITIZE]: 'true', // 默认开启发送给大模型前的敏感信息脱敏
  [CONFIG_KEYS.AI_REQUEST_TIMEOUT_MS]: '45000', // AI 请求默认超时时间 (ms)
  [CONFIG_KEYS.AI_DEFAULT_EMPLOYEE]: 'system-error-expert', // 默认 AI 员工
  [CONFIG_KEYS.AI_DEFAULT_LLM_SERVICE]: '', // 默认 LLM 服务 (空则自动选用首个可用真实 LLM 服务)
  [CONFIG_KEYS.AI_DEFAULT_LLM_MODEL]: '', // 默认 LLM 模型
};

export const ALERT_RULE_TYPES = {
  ERROR_LOG: 'error_log',
  STATUS_5XX: 'status_5xx',
  SLOW_SQL: 'slow_sql',
  KEYWORD: 'keyword',
} as const;

export const ALERT_CHANNELS = {
  WECOM: 'wecom',
  DINGTALK: 'dingtalk',
  FEISHU: 'feishu',
  CUSTOM_WEBHOOK: 'custom_webhook',
  NOTIFICATION_MANAGER: 'notification_manager',
} as const;
