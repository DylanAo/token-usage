const LOCALE_STORAGE_KEY = "tokenUsageLocale";

const zh = {
  // Metrics
  metric_total: "总 tokens",
  metric_input: "输入",
  metric_cached: "缓存输入",
  metric_output: "输出",
  metric_reasoning: "推理输出",
  metric_cache_hit: "缓存命中率",
  metric_sessions: "会话",

  // Toolbar
  toolbar_scope: "范围",
  toolbar_start: "开始",
  toolbar_end: "结束",
  toolbar_granularity: "粒度",

  // Provider filter
  provider_all: "全部",
  provider_claude: "Claude",
  provider_codex: "Codex",

  // Presets
  preset_today: "今日",
  preset_week: "本周",
  preset_month: "本月",
  preset_all: "全部",
  preset_recent: "最近",
  preset_custom: "自定义",

  // Buckets
  bucket_hour: "按小时",
  bucket_day: "按天",
  bucket_week: "按周",
  bucket_month: "按月",

  // Recent range options
  recent_1day: "1天",
  recent_1week: "1周",
  recent_1month: "1个月",
  recent_2month: "2个月",
  recent_3month: "3个月",
  recent_6month: "半年",
  recent_1year: "一年",

  // Headings
  heading_timeline: "时间分布",
  heading_sessions: "对话消耗",
  heading_projects: "项目目录",
  heading_models: "模型分布",
  heading_homes: "扫描目录",
  heading_machines: "电脑状态",
  heading_tasks: "当前任务",

  // Search
  search_session: "搜索对话",
  search_project: "搜索项目目录",
  search_model: "搜索模型",

  // Actions
  action_refresh: "强制重扫",
  action_expand: "展开",
  action_collapse: "收起",

  // Theme
  theme_light: "浅色",
  theme_dark: "深色",

  // Locale
  locale_zh: "中文",
  locale_en: "English",

  // Status messages
  status_scanning: "正在扫描本机 Claude 与 Codex 用量...",
  status_refresh_ready: "自动刷新准备中...",
  status_loading_static: "正在载入静态用量快照...",
  status_static: "静态快照 · 自动刷新关闭 · 运行 npm run export 后会生成新快照",
  status_refresh_interval: "自动刷新 开 · 每 60 秒 · 上次检查 ",
  status_checking: "自动刷新 开 · 每 60 秒 · 正在检查...",
  status_update_detected: "检测到更新，正在刷新...",
  status_refresh_failed_prefix: "自动刷新失败：",
  status_refresh_failed_suffix: " · 下次继续尝试",
  status_load_failed: "加载失败：",

  // Subtitle format
  subtitle_format: "{events} 条 token 事件 · {sessions} 个会话 · {generated}",

  // Comparison
  cmp_vs_yesterday: "较昨日",
  cmp_vs_last_week: "较上周",
  cmp_vs_last_month: "较上月",
  cmp_vs_prev_period: "较上一等长周期",
  cmp_no_comparison: "暂无对比",
  cmp_trend_title: "趋势变化",
  cmp_avg_trend: "平均趋势变化",
  cmp_prev_tokens: "上一周期 tokens",
  cmp_sessions: "个会话",
  cmp_no_data_hint: "选择今日、本周、本月或最近范围查看",

  // Empty states
  empty_no_usage: "没有匹配的用量记录",
  empty_no_homes: "没有发现 Claude Code / Codex 目录",
  empty_no_machines: "还没有采集到远程电脑",
  empty_no_tasks: "当前没有远程任务",

  // Home status
  home_unsupported: "不可用",
  home_has_usage: "有用量记录",
  home_no_usage: "无用量记录",
  home_scannable: "可扫描",
  remote_online: "在线",
  remote_offline: "离线",
  remote_active: "进行中",
  remote_waiting: "等待中",
  remote_completed: "已完成",
  remote_idle: "空闲",
  remote_unknown: "未知",
  remote_active_count: "进行中",
  remote_ago: "前",

  // Home row
  homerow_events: "条事件",
  homerow_sessions: "个会话",

  // Tooltip
  tip_total: "总 tokens",
  tip_input: "输入",
  tip_cached: "缓存输入",
  tip_output: "输出",
  tip_reasoning: "推理输出",
  tip_cache_hit: "缓存命中率",
  tip_events: "事件",
  tip_sessions: "会话",
  tip_channels: "渠道",
  tip_models: "模型",

  // Range label
  range_start: "开始",
  range_now: "现在",
  range_to: " 至 ",

  // Other
  other_unknown: "未知",
  other_no_baseline: "无基准",

  // Date picker
  date_prev_month: "上个月",
  date_next_month: "下个月",
  date_placeholder: "年/月/日",

  // Aria
  aria_theme: "主题",
  aria_language: "语言",
  aria_filter: "筛选",
  aria_overview: "总览",
  aria_trend: "趋势变化",
  aria_provider: "来源",
  aria_recent_range: "最近范围",
  aria_recent_expand: "展开最近范围选项",
  aria_date_picker_start: "打开开始日期日历",
  aria_date_picker_end: "打开结束日期日历",
  aria_timeline_details: "时间分布明细",

  // Tooltip aria
  tip_aria_format: "{name}：{tokens} tokens",
};

const en = {
  // Metrics
  metric_total: "Total tokens",
  metric_input: "Input",
  metric_cached: "Cached input",
  metric_output: "Output",
  metric_reasoning: "Reasoning",
  metric_cache_hit: "Cache hit rate",
  metric_sessions: "Sessions",

  // Toolbar
  toolbar_scope: "Range",
  toolbar_start: "Start",
  toolbar_end: "End",
  toolbar_granularity: "Granularity",

  // Provider filter
  provider_all: "All",
  provider_claude: "Claude",
  provider_codex: "Codex",

  // Presets
  preset_today: "Today",
  preset_week: "Week",
  preset_month: "Month",
  preset_all: "All",
  preset_recent: "Recent",
  preset_custom: "Custom",

  // Buckets
  bucket_hour: "Hourly",
  bucket_day: "Daily",
  bucket_week: "Weekly",
  bucket_month: "Monthly",

  // Recent range options
  recent_1day: "1 day",
  recent_1week: "1 week",
  recent_1month: "1 month",
  recent_2month: "2 months",
  recent_3month: "3 months",
  recent_6month: "6 months",
  recent_1year: "1 year",

  // Headings
  heading_timeline: "Timeline",
  heading_sessions: "Sessions",
  heading_projects: "Projects",
  heading_models: "Models",
  heading_homes: "Directories",
  heading_machines: "Computers",
  heading_tasks: "Current tasks",

  // Search
  search_session: "Search sessions",
  search_project: "Search projects",
  search_model: "Search models",

  // Actions
  action_refresh: "Force rescan",
  action_expand: "Expand",
  action_collapse: "Collapse",

  // Theme
  theme_light: "Light",
  theme_dark: "Dark",

  // Locale
  locale_zh: "中文",
  locale_en: "English",

  // Status messages
  status_scanning: "Scanning local Claude & Codex usage...",
  status_refresh_ready: "Auto-refresh initializing...",
  status_loading_static: "Loading static usage snapshot...",
  status_static: "Static snapshot · Auto-refresh off · Run npm run export to regenerate",
  status_refresh_interval: "Auto-refresh ON · Every 60s · Last check ",
  status_checking: "Auto-refresh ON · Every 60s · Checking...",
  status_update_detected: "Update detected, refreshing...",
  status_refresh_failed_prefix: "Auto-refresh failed: ",
  status_refresh_failed_suffix: " · Will retry",
  status_load_failed: "Load failed: ",

  // Subtitle format
  subtitle_format: "{events} token events · {sessions} sessions · {generated}",

  // Comparison
  cmp_vs_yesterday: "vs yesterday",
  cmp_vs_last_week: "vs last week",
  cmp_vs_last_month: "vs last month",
  cmp_vs_prev_period: "vs previous period",
  cmp_no_comparison: "No comparison",
  cmp_trend_title: "Trend change",
  cmp_avg_trend: "Average trend",
  cmp_prev_tokens: "Previous tokens",
  cmp_sessions: "sessions",
  cmp_no_data_hint: "Select today, week, month, or recent range",

  // Empty states
  empty_no_usage: "No matching usage records",
  empty_no_homes: "No Claude Code / Codex directories found",
  empty_no_machines: "No remote computers have reported yet",
  empty_no_tasks: "No remote tasks currently reported",

  // Home status
  home_unsupported: "Unavailable",
  home_has_usage: "Has records",
  home_no_usage: "No records",
  home_scannable: "Scannable",
  remote_online: "Online",
  remote_offline: "Offline",
  remote_active: "Active",
  remote_waiting: "Waiting",
  remote_completed: "Completed",
  remote_idle: "Idle",
  remote_unknown: "Unknown",
  remote_active_count: "active",
  remote_ago: "ago",

  // Home row
  homerow_events: "events",
  homerow_sessions: "sessions",

  // Tooltip
  tip_total: "Total tokens",
  tip_input: "Input",
  tip_cached: "Cached input",
  tip_output: "Output",
  tip_reasoning: "Reasoning",
  tip_cache_hit: "Cache hit rate",
  tip_events: "Events",
  tip_sessions: "Sessions",
  tip_channels: "Channels",
  tip_models: "Models",

  // Range label
  range_start: "Start",
  range_now: "Now",
  range_to: " to ",

  // Other
  other_unknown: "Unknown",
  other_no_baseline: "No baseline",

  // Date picker
  date_prev_month: "Previous month",
  date_next_month: "Next month",
  date_placeholder: "YYYY/MM/DD",

  // Aria
  aria_theme: "Theme",
  aria_language: "Language",
  aria_filter: "Filters",
  aria_overview: "Overview",
  aria_trend: "Trends",
  aria_provider: "Source",
  aria_recent_range: "Recent range",
  aria_recent_expand: "Expand recent range options",
  aria_date_picker_start: "Open start date picker",
  aria_date_picker_end: "Open end date picker",
  aria_timeline_details: "Timeline details",

  // Tooltip aria
  tip_aria_format: "{name}: {tokens} tokens",
};

const translations = { zh, en };

// -- Locale management --

export function getLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh" || saved === "en") {
      return saved;
    }
  } catch {
    // ignore
  }
  // Fall back to browser language
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("zh")) {
    return "zh";
  }
  return "en";
}

export function setLocale(locale) {
  const next = locale === "en" ? "en" : "zh";
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // ignore
  }
  document.documentElement.dataset.locale = next;
  document.documentElement.lang = next === "en" ? "en" : "zh-CN";
}

export function t(key) {
  const locale = typeof document !== "undefined" ? getLocale() : "zh";
  const dict = translations[locale] || translations.zh;
  return dict[key] || key;
}

// -- Locale-aware number formatting --

function trimTrailingZero(str) {
  return str.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const intlFormatter = new Intl.NumberFormat("en-US");

export function formatTokens(value) {
  const number = Math.round(value || 0);
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  const locale = typeof document !== "undefined" ? getLocale() : "zh";

  if (locale === "en") {
    if (abs >= 1_000_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
    if (abs >= 1_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
    if (abs >= 1_000) return `${sign}${trimTrailingZero((abs / 1_000).toFixed(1))}K`;
    return `${sign}${intlFormatter.format(abs)}`;
  }

  // Chinese
  if (abs >= 100_000_000) return `${sign}${trimTrailingZero((abs / 100_000_000).toFixed(2))}亿`;
  if (abs >= 10_000) return `${sign}${trimTrailingZero((abs / 10_000).toFixed(1))}万`;
  return `${sign}${intlFormatter.format(abs)}`;
}

export function formatCompact(value) {
  return formatTokens(value);
}

// -- Locale-aware helpers --

const ZH_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const EN_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function getWeekdays() {
  const locale = getLocale();
  return locale === "en" ? EN_WEEKDAYS : ZH_WEEKDAYS;
}

const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatDatePickerTitle(year, month) {
  const locale = getLocale();
  if (locale === "en") {
    const padded = String(month).padStart(2, "0");
    return `${EN_MONTHS[month - 1]} ${year}`;
  }
  const padded = String(month).padStart(2, "0");
  return `${year}年${padded}月`;
}

export function comparisonLabel(preset) {
  const locale = getLocale();
  if (locale === "en") {
    const map = {
      today: "vs yesterday",
      week: "vs last week",
      month: "vs last month",
      custom: "vs previous period",
      recent: "vs previous period",
    };
    return map[preset] || "No comparison";
  }
  const map = {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  };
  return map[preset] || "暂无对比";
}

export function rangeLabel(summary, bucket) {
  const locale = getLocale();
  const s = summary.range.start ? dateKey(new Date(summary.range.start)) : t("range_start");
  const e = summary.range.end ? dateKey(new Date(summary.range.end)) : t("range_now");
  const bucketMap = {
    hour: locale === "en" ? "Hourly" : "按小时",
    day: locale === "en" ? "Daily" : "按天",
    week: locale === "en" ? "Weekly" : "按周",
    month: locale === "en" ? "Monthly" : "按月",
  };
  const bucketLabel = bucketMap[bucket] || bucketMap.day;
  const sep = locale === "en" ? " to " : " 至 ";

  if (bucket === "hour" && summary.range.start && summary.range.end) {
    const startDate = new Date(summary.range.start);
    const endDate = new Date(summary.range.end);
    if (summary.range.rolling) {
      return `${dateTimeMinuteKey(startDate)}${sep}${dateTimeMinuteKey(endDate)} · ${bucketLabel}`;
    }
    const exclusiveEnd = new Date(endDate.getTime() + 1);
    return `${hourBoundaryKey(startDate)}${sep}${hourBoundaryKey(exclusiveEnd)} · ${bucketLabel}`;
  }
  return `${s}${sep}${e} · ${bucketLabel}`;
}

export function homeStatusLabel(home) {
  if (home.type === "unsupported" || home.status === "unsupported") return t("home_unsupported");
  if (home.status === "active" && home.eventCount > 0) return t("home_has_usage");
  if (home.status === "no-events") return t("home_no_usage");
  return t("home_scannable");
}

export function autoRefreshReadyMessage(checkedAt, clockTimeFn) {
  return `${t("status_refresh_interval")}${clockTimeFn(new Date(checkedAt))}`;
}

export function autoRefreshCheckingMessage() {
  return t("status_checking");
}

export function autoRefreshUpdateDetectedMessage() {
  return t("status_update_detected");
}

export function autoRefreshFailedMessage(error) {
  return `${t("status_refresh_failed_prefix")}${error}${t("status_refresh_failed_suffix")}`;
}

// -- Static DOM translations --

export function applyStaticTranslations() {
  const locale = getLocale();
  const dict = translations[locale] || translations.zh;

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (dict[key]) el.textContent = dict[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.dataset.i18nPlaceholder;
    if (dict[key]) el.placeholder = dict[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
    const key = el.dataset.i18nAriaLabel;
    if (dict[key]) el.setAttribute("aria-label", dict[key]);
  }
}

export function applyDynamicTranslations() {
  // Re-apply translations to elements that may have been re-created via innerHTML.
  const locale = getLocale();
  const dict = translations[locale] || translations.zh;

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (dict[key]) el.textContent = dict[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.dataset.i18nPlaceholder;
    if (dict[key]) el.placeholder = dict[key];
  }
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
    const key = el.dataset.i18nAriaLabel;
    if (dict[key]) el.setAttribute("aria-label", dict[key]);
  }

  // Update expand/collapse buttons
  for (const el of document.querySelectorAll("[data-i18n-expand]")) {
    const expandKey = el.dataset.i18nExpand;
    const collapseKey = el.dataset.i18nCollapse;
    if (expandKey && collapseKey && dict[expandKey] && dict[collapseKey]) {
      const expanded = el.getAttribute("aria-expanded") === "true";
      el.textContent = expanded ? dict[collapseKey] : dict[expandKey];
    }
  }
}

// -- Shared helpers used by rangeLabel --

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:00`;
}

function dateTimeMinuteKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:${minute}`;
}

function hourBoundaryKey(date) {
  return hourKey(date);
}
