import {
  getLocale, setLocale, t,
  formatTokens, formatCompact,
  getWeekdays, formatDatePickerTitle,
  comparisonLabel,
  rangeLabel as i18nRangeLabel,
  homeStatusLabel as i18nHomeStatusLabel,
  applyStaticTranslations,
  applyDynamicTranslations,
} from "./i18n.js";

const state = {
  report: null,
  metadata: null,
  summary: null,
  remote: null,
  fingerprint: "",
  preset: "all",
  provider: "all",
  bucket: "day",
  startDate: "",
  endDate: "",
  recentValue: "1个月",
  now: null,
  autoRefreshTimer: null,
  theme: "light",
  locale: getLocale(),
  projectQuery: "",
  modelQuery: "",
  projectsExpanded: false,
  modelsExpanded: false,
  sessionsExpanded: false,
  sessionQuery: "",
  datePickerField: "",
  datePickerViews: {
    start: null,
    end: null,
  },
};

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const THEME_STORAGE_KEY = "tokenUsageTheme";
const RANKED_LIST_LIMIT = 25;
const SESSION_DEFAULT_LIMIT = 5;
const MODEL_DEFAULT_LIMIT = 5;
const tooltipRows = new WeakMap();
const timelineBars = new WeakMap();

const $ = (selector) => document.querySelector(selector);

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButtons() {
  for (const button of document.querySelectorAll("#themeToggle [data-theme-option]")) {
    button.classList.toggle("active", button.dataset.themeOption === state.theme);
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === state.theme));
  }
}

function updateLocaleButtons() {
  for (const button of document.querySelectorAll("#localeToggle [data-locale-option]")) {
    button.classList.toggle("active", button.dataset.localeOption === state.locale);
    button.setAttribute("aria-pressed", String(button.dataset.localeOption === state.locale));
  }
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  updateThemeButtons();
  render();
}

function isStaticSnapshot() {
  return Boolean(window.__TOKEN_USAGE_REPORT__);
}

function usageValue(usage, field = "total") {
  return usage?.[field] || 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character];
  });
}

// Normalize optional row labels before rendering or building accessible names.
function usageRowName(row) {
  return row?.name || row?.key || t("other_unknown");
}

// Keep keyboard/screen-reader labels aligned with the visual token value.
function usageRowAriaLabel(row) {
  return `${usageRowName(row)}: ${formatTokens(usageValue(row?.total, "total"))} tokens`;
}

function hitRateText(totals) {
  const cached = usageValue(totals, "cached");
  const input = usageValue(totals, "input");
  const totalInput = cached + input;
  if (!totalInput) {
    return "0%";
  }
  return `${Math.round((cached / totalInput) * 1000) / 10}%`;
}

export function formatUsageTooltip(row) {
  const total = row?.total || emptyUsage();
  const details = [
    [t("tip_total"), formatTokens(usageValue(total, "total"))],
    [t("tip_input"), formatTokens(usageValue(total, "input"))],
    [t("tip_cached"), formatTokens(usageValue(total, "cached"))],
    [t("tip_output"), formatTokens(usageValue(total, "output"))],
    [t("tip_cache_hit"), hitRateText(total)],
    [t("tip_events"), formatTokens(row?.count || 0)],
    [t("tip_sessions"), formatTokens(row?.sessions || 0)],
  ];
  const models = row?.models || [];
  return `
    <div class="usage-tooltip-title">${escapeHtml(row?.name || row?.key || t("other_unknown"))}</div>
    <div class="usage-tooltip-grid">
      ${details
        .map(
          ([label, value]) => `
            <span class="usage-tooltip-label">${label}</span>
            <span class="usage-tooltip-value">${value}</span>
          `,
        )
        .join("")}
    </div>
    ${
      models.length
        ? `
          <div class="usage-tooltip-subtitle">${t("tip_models")}</div>
          <div class="usage-tooltip-grid">
            ${models
              .map(
                (model) => `
                  <span class="usage-tooltip-label">${escapeHtml(model.name)}</span>
                  <span class="usage-tooltip-value">${formatTokens(usageValue(model.total, "total"))}</span>
                `,
              )
              .join("")}
          </div>
        `
        : ""
    }
  `;
}

function usageTooltip() {
  return $("#usageTooltip");
}

function hideUsageTooltip() {
  const tooltip = usageTooltip();
  if (tooltip) {
    tooltip.hidden = true;
  }
}

function positionUsageTooltip(anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const offset = 14;
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const rect = anchor?.getBoundingClientRect?.();
  const anchorX = Number.isFinite(anchor?.clientX) ? anchor.clientX : rect?.left || margin;
  const anchorY = Number.isFinite(anchor?.clientY) ? anchor.clientY : rect?.bottom || margin;
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + width + margin > window.innerWidth) {
    left = anchorX - width - offset;
  }
  if (top + height + margin > window.innerHeight) {
    top = anchorY - height - offset;
  }
  tooltip.style.left = `${Math.max(margin, left)}px`;
  tooltip.style.top = `${Math.max(margin, top)}px`;
}

function showUsageTooltip(row, anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  tooltip.innerHTML = formatUsageTooltip(row);
  tooltip.hidden = false;
  positionUsageTooltip(anchor);
}

function bindUsageRows(container, selector, rows) {
  container.querySelectorAll(selector).forEach((element, index) => {
    tooltipRows.set(element, rows[index]);
  });
}

function getModelColors(rows) {
  const styles = getComputedStyle(document.documentElement);
  const palette = [
    styles.getPropertyValue("--blue").trim() || "#2364aa",
    styles.getPropertyValue("--green").trim() || "#2f855a",
    styles.getPropertyValue("--gold").trim() || "#b7791f",
    styles.getPropertyValue("--red").trim() || "#c05621",
    styles.getPropertyValue("--muted").trim() || "#607080",
  ];
  return new Map(rows.map((row, index) => [row.name, palette[index % palette.length]]));
}

export function timelineChannelSegments(row, modelRows = []) {
  const rowModels = new Map((row?.models || []).map((model) => [model.name, model]));
  const ordered = [];
  for (const model of modelRows) {
    const match = rowModels.get(model.name);
    if (match) {
      ordered.push(match);
      rowModels.delete(model.name);
    }
  }
  ordered.push(...rowModels.values());
  return ordered;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function normalizeDateInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const date = parseLocalDate(trimmed);
  return date ? dateKey(date) : null;
}

function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function datePickerMonthModel(viewDate = new Date(), selectedValue = "") {
  const selectedDate = parseLocalDate(selectedValue);
  const visibleMonth = monthStart(viewDate instanceof Date ? viewDate : new Date(viewDate));
  const mondayOffset = (visibleMonth.getDay() + 6) % 7;
  const firstCell = addDays(visibleMonth, -mondayOffset);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(firstCell, index);
    const value = dateKey(date);
    return {
      date: value,
      day: date.getDate(),
      inCurrentMonth: date.getMonth() === visibleMonth.getMonth(),
      selected: selectedDate ? value === dateKey(selectedDate) : false,
    };
  });
  return {
    year: visibleMonth.getFullYear(),
    month: visibleMonth.getMonth() + 1,
    weekdays: getWeekdays(),
    cells,
  };
}

export function renderDatePickerHtml({ field = "start", viewDate = new Date(), selectedValue = "" } = {}) {
  const model = datePickerMonthModel(viewDate, selectedValue);
  const escapedField = escapeHtml(field);
  const title = formatDatePickerTitle(model.year, model.month);
  return `
    <div class="date-picker-heading">
      <button class="date-picker-nav" type="button" data-date-picker-action="prev" data-date-picker-field="${escapedField}" aria-label="${t("date_prev_month")}">‹</button>
      <div class="date-picker-title">${escapeHtml(title)}</div>
      <button class="date-picker-nav" type="button" data-date-picker-action="next" data-date-picker-field="${escapedField}" aria-label="${t("date_next_month")}">›</button>
    </div>
    <div class="date-picker-grid">
      ${model.weekdays.map((weekday) => `<div class="date-picker-weekday">${weekday}</div>`).join("")}
      ${model.cells
        .map((cell) => {
          const classes = ["date-picker-day"];
          if (!cell.inCurrentMonth) {
            classes.push("outside-month");
          }
          if (cell.selected) {
            classes.push("selected");
          }
          return `<button type="button" data-date="${cell.date}" data-date-picker-field="${escapedField}" class="${classes.join(" ")}">${cell.day}</button>`;
        })
        .join("")}
    </div>
  `;
}

function hourKey(date) {
  // Hour buckets use local wall-clock time to match the existing day/week/month grouping.
  const hour = String(date.getHours()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:00`;
}

function hourBoundaryKey(date) {
  // Range labels use hour boundaries, so a day ending at 23:59:59.999 displays as next-day 00:00.
  return hourKey(date);
}

function dateTimeMinuteKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:${minute}`;
}

function asDate(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfHour(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function isSingleLocalDayRange(range = {}) {
  // The hourly chart only fills 24 buckets when the selected range resolves to one local calendar day.
  const start = asDate(range.start);
  const end = asDate(range.end);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return false;
  }
  return dateKey(start) === dateKey(end);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

export function normalizeRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (/^[1-9]\d*$/.test(normalized)) {
    return `${normalized}天`;
  }
  return normalized;
}

function parseRecentValue(value) {
  const normalized = normalizeRecentValue(value);
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now) {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addDays(startOfDay(now), 1 - parsed.days)
    : startOfDay(subtractMonthsClamped(now, parsed.months));
  return {
    start,
    end: endOfDay(now),
    preset: "recent",
  };
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function bucketKey(timestamp, bucket) {
  const date = new Date(timestamp);
  if (bucket === "hour") {
    return hourKey(date);
  }
  if (bucket === "month") {
    return dateKey(date).slice(0, 7);
  }
  if (bucket === "week") {
    return dateKey(startOfWeek(date));
  }
  return dateKey(date);
}

function getRange(events) {
  const now = state.now ? new Date(state.now) : new Date();
  if (state.preset === "today") {
    return { start: startOfDay(now), end: endOfDay(now) };
  }
  if (state.preset === "week") {
    return { start: startOfWeek(now), end: endOfDay(now) };
  }
  if (state.preset === "month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: endOfDay(now) };
  }
  if (state.preset === "custom") {
    return {
      start: state.startDate ? new Date(`${state.startDate}T00:00:00`) : null,
      end: state.endDate ? new Date(`${state.endDate}T23:59:59.999`) : null,
    };
  }
  if (state.preset === "recent") {
    const range = recentDateRange(state.recentValue, now);
    if (range) {
      return range;
    }
  }
  const dates = events.map((event) => new Date(event.timestamp)).filter((date) => !Number.isNaN(date.getTime()));
  return {
    start: dates.length ? startOfDay(new Date(Math.min(...dates))) : null,
    end: dates.length ? endOfDay(new Date(Math.max(...dates))) : null,
  };
}

function addUsage(target, usage) {
  for (const field of ["total", "input", "cached", "output", "reasoning"]) {
    target[field] += usageValue(usage, field);
  }
  return target;
}

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function groupEvents(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const group = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    group.count += 1;
    group.sessions.add(event.sessionId);
    addUsage(group.total, event.total);
    if (group.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = group.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      group.channelGroups.set(channelKey, channel);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    name: group.name,
    count: group.count,
    sessions: group.sessions.size,
    total: group.total,
    ...(group.channelGroups
      ? {
          channels: [...group.channelGroups.values()]
            .map((channel) => ({
              key: channel.key,
              name: channel.name,
              count: channel.count,
              sessions: channel.sessions.size,
              total: channel.total,
            }))
            .sort((a, b) => b.total.total - a.total.total),
        }
      : {}),
  }));
}

function emptyTimelineRow(key) {
  // Empty rows let single-day hourly charts show zero-use hours without special render code.
  return {
    key,
    name: key,
    count: 0,
    sessions: 0,
    total: emptyUsage(),
    channels: [],
  };
}

function completeHourlyTimeline(rows, range, bucket) {
  // 最近范围按选定边界补齐小时；普通单日范围保留完整自然日补齐。
  if (bucket !== "hour" || (!isSingleLocalDayRange(range) && range?.preset !== "recent")) {
    return rows;
  }
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const start = range?.preset === "recent" ? startOfHour(asDate(range.start)) : startOfDay(asDate(range.start));
  const end = range?.preset === "recent" ? startOfHour(asDate(range.end)) : addHours(start, 23);
  const hourCount = Math.max(0, Math.round((end.getTime() - start.getTime()) / MS_PER_HOUR) + 1);
  return Array.from({ length: hourCount }, (_, hour) => {
    const bucketStart = addHours(start, hour);
    const key = hourKey(bucketStart);
    return rowsByKey.get(key) || emptyTimelineRow(key);
  });
}

function previousPeriodRange(range) {
  if (!range.start || !range.end || state.preset === "all") {
    return null;
  }
  if (state.preset === "today") {
    const previousDay = addDays(startOfDay(asDate(range.start)), -1);
    return {
      start: previousDay,
      end: endOfDay(previousDay),
    };
  }
  if (state.preset === "week") {
    const previousWeekStart = addDays(startOfWeek(asDate(range.start)), -7);
    return {
      start: previousWeekStart,
      end: endOfDay(addDays(previousWeekStart, 6)),
    };
  }
  if (state.preset === "month") {
    const currentMonthStart = new Date(asDate(range.start).getFullYear(), asDate(range.start).getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end) {
    return 0;
  }
  return Math.max(0, end.getTime() - start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(end.getTime(), Math.max(start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function summarizeComparison(allEvents, range, currentTotals) {
  // 静态导出没有 API 可用，因此在浏览器端复用同一套趋势口径。
  const previousRange = previousPeriodRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(state.preset),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const previousEvents = allEvents.filter((event) => {
    const time = Date.parse(event.timestamp);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const now = state.now ? new Date(state.now) : new Date();
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);
  return {
    label: comparisonLabel(state.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: new Set(previousEvents.map((event) => event.sessionId)).size,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

export function summarize(report) {
  const range = getRange(report.events);
  const provider = state.provider || "all";
  const events = report.events.filter((event) => {
    if (provider !== "all" && (event.provider || "claude") !== provider) {
      return false;
    }
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const timeline = completeHourlyTimeline(
    groupEvents(events, (event) => bucketKey(event.timestamp, state.bucket), { includeChannels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    state.bucket,
  );
  const channels = groupEvents(events, (event) => event.channel).sort((a, b) => b.total.total - a.total.total);
  const projects = groupEvents(events, (event) => event.cwd || "Unknown cwd").sort((a, b) => b.total.total - a.total.total);
  const models = groupEvents(events, (event) => event.model || "Unknown model").sort((a, b) => b.total.total - a.total.total);
  return {
    range,
    totals,
    comparison: summarizeComparison(report.events, range, totals),
    timeline,
    channels,
    projects,
    models,
    sessionCount: new Set(events.map((event) => event.sessionId)).size,
    eventCount: events.length,
  };
}

export function setSummaryFilters(filters = {}) {
  for (const key of ["preset", "bucket", "startDate", "endDate", "recentValue"]) {
    if (Object.hasOwn(filters, key)) {
      state[key] = filters[key] || "";
    }
  }
  if (Object.hasOwn(filters, "now")) {
    state.now = filters.now || null;
  }
}

export function defaultBucketForRange(preset = "all", recentValue = "") {
  // One-day views are hourly by default; broader ranges reset to daily charts.
  return preset === "today" || (preset === "recent" && normalizeRecentValue(recentValue) === "1天") ? "hour" : "day";
}

export function nextPresetState(currentState = {}, preset = "all") {
  // Preset switches intentionally reset granularity to the default for that range.
  return {
    preset,
    bucket: defaultBucketForRange(preset, currentState.recentValue),
  };
}

export function nextRecentState(currentState = {}, value = "") {
  const recentValue = normalizeRecentValue(value);
  // Recent range edits reset granularity based on whether the selected span is one day.
  return {
    preset: "recent",
    recentValue,
    bucket: defaultBucketForRange("recent", recentValue),
  };
}

function setMetric(id, value) {
  $(id).textContent = formatTokens(value);
  $(id).title = formatTokens(value);
}

function cacheHitRate(totals) {
  const totalInput = (totals.cached || 0) + (totals.input || 0);
  if (!totalInput) {
    return "";
  }
  return `${Math.round(((totals.cached || 0) / totalInput) * 1000) / 10}%`;
}

function renderMetrics(summary) {
  setMetric("#totalTokens", summary.totals.total);
  setMetric("#inputTokens", summary.totals.input);
  setMetric("#cachedTokens", summary.totals.cached);
  setMetric("#outputTokens", summary.totals.output);
  const cacheHitElement = $("#cacheHitRate");
  cacheHitElement.textContent = cacheHitRate(summary.totals);
  cacheHitElement.title = `${formatTokens(summary.totals.cached)} / ${formatTokens((summary.totals.cached || 0) + (summary.totals.input || 0))}`;
  setMetric("#sessionCount", summary.sessionCount);
}

export function rangeLabel(summary) {
  return i18nRangeLabel(summary, state.bucket);
}

export function renderBarListHtml(rows, colorMap = null) {
  // Build escaped HTML in one place so all bar-list render paths stay safe.
  if (!rows.length) {
    return `<div class="empty">${t("empty_no_usage")}</div>`;
  }
  const max = rows[0].total.total || 1;
  return rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      const color = colorMap?.get(row.name);
      const fillStyle = `width: ${width}%;${color ? ` background: ${color};` : ""}`;
      const name = escapeHtml(usageRowName(row));
      const ariaLabel = escapeHtml(usageRowAriaLabel(row));
      return `
        <div class="bar-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="bar-label">
            <span class="bar-name" title="${name}">${name}</span>
            <span class="bar-value">${formatTokens(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="${fillStyle}"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderBarList(container, rows, colorMap = null) {
  container.innerHTML = renderBarListHtml(rows, colorMap);
  bindUsageRows(container, ".bar-row", rows);
}

export function renderCompactListHtml(rows) {
  // Compact rows are focusable so keyboard users can reach the same tooltip details.
  if (!rows.length) {
    return `<div class="empty">${t("empty_no_usage")}</div>`;
  }
  return rows
    .map(
      (row) => {
        const name = escapeHtml(usageRowName(row));
        const ariaLabel = escapeHtml(usageRowAriaLabel(row));
        return `
        <div class="compact-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="compact-label">
            <span class="compact-name" title="${name}">${name}</span>
            <span class="compact-value">${formatTokens(row.total.total)}</span>
          </div>
        </div>
      `;
      },
    )
    .join("");
}

function renderCompactList(container, rows) {
  container.innerHTML = renderCompactListHtml(rows);
  bindUsageRows(container, ".compact-row", rows);
}

export function renderTimelineDetailsHtml(rows) {
  // The timeline detail list mirrors the canvas for mobile and keyboard access.
  if (!rows.length) {
    return `<div class="empty">${t("empty_no_usage")}</div>`;
  }
  return rows
    .map((row) => {
      const name = escapeHtml(usageRowName(row));
      const ariaLabel = escapeHtml(usageRowAriaLabel(row));
      return `
        <div class="timeline-detail-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <span class="timeline-detail-name">${name}</span>
          <span class="timeline-detail-value">${formatTokens(row.total.total)}</span>
        </div>
      `;
    })
    .join("");
}

function renderTimelineDetails(container, rows) {
  container.innerHTML = renderTimelineDetailsHtml(rows);
  bindUsageRows(container, ".timeline-detail-row", rows);
}

function hourlyAxisLabel(key, singleDay) {
  // Hourly labels stay compact so a 24-hour day can show every tick without long date text.
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!match) {
    return String(key || "");
  }
  return singleDay ? match[4] : `${match[2]}-${match[3]} ${match[4]}`;
}

export function timelineAxisLabels(rows, options = {}) {
  // Build label positions separately from drawing so hour sampling stays testable.
  if (!rows.length) {
    return [];
  }
  const singleHourlyDay = options.bucket === "hour" && isSingleLocalDayRange(options.range);
  if (singleHourlyDay) {
    return rows.map((row, index) => ({
      index,
      label: hourlyAxisLabel(row.key, true),
    }));
  }

  const fallbackMaxLabels = Math.max(2, Math.floor((options.chartWidth || 960) / 120));
  const maxLabels = Math.max(1, options.maxLabels || fallbackMaxLabels);
  const labelCount = Math.min(rows.length, maxLabels);
  return Array.from({ length: labelCount }, (_, position) => {
    const index = Math.round((position * (rows.length - 1)) / Math.max(1, labelCount - 1));
    const row = rows[index];
    return {
      index,
      label: options.bucket === "hour" ? hourlyAxisLabel(row.key, false) : row.key,
    };
  });
}

export function filterRankedRows(rows, { query = "", expanded = false, limit = RANKED_LIST_LIMIT, defaultLimit = RANKED_LIST_LIMIT } = {}) {
  // Search intentionally scans the full sorted list even when the default view is capped.
  const normalized = String(query || "").trim().toLowerCase();
  const filtered = normalized
    ? rows.filter((row) => usageRowName(row).toLowerCase().includes(normalized))
    : rows;
  const effectiveLimit = expanded ? undefined : (limit ?? defaultLimit);
  return normalized || expanded ? filtered : filtered.slice(0, effectiveLimit);
}

function formatDelta(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokens(value)}`;
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return t("other_no_baseline");
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}%`;
}

function comparisonClass(value) {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

export function renderComparisonHtml(comparison) {
  if (!comparison) {
    return "";
  }
  if (!comparison.previousRange) {
    return `
      <article class="comparison-item flat">
        <span>${t("cmp_trend_title")}</span>
        <strong>${t("cmp_no_comparison")}</strong>
        <small>${t("cmp_no_data_hint")}</small>
      </article>
    `;
  }
  return `
    <article class="comparison-item ${comparisonClass(comparison.totalDelta)}">
      <span>${escapeHtml(comparisonLabel(state.preset))}</span>
      <strong>${formatDelta(comparison.totalDelta)}</strong>
      <small>${formatPercent(comparison.percentChange)}</small>
    </article>
    <article class="comparison-item ${comparisonClass(comparison.averageDelta)}">
      <span>${t("cmp_avg_trend")}</span>
      <strong>${formatDelta(comparison.averageDelta)}</strong>
      <small>${formatPercent(comparison.averagePercentChange)}</small>
    </article>
    <article class="comparison-item">
      <span>${t("cmp_prev_tokens")}</span>
      <strong>${formatTokens(comparison.previousTotals.total)}</strong>
      <small>${formatTokens(comparison.previousSessionCount)} ${t("cmp_sessions")}</small>
    </article>
  `;
}

function renderComparison(summary) {
  const container = $("#comparisonSummary");
  if (!container) {
    return;
  }
  container.innerHTML = renderComparisonHtml(summary.comparison);
}

function updateRankedListControls(kind, rows) {
  const query = kind === "project" ? state.projectQuery : kind === "model" ? state.modelQuery : state.sessionQuery;
  const expanded = kind === "project" ? state.projectsExpanded : kind === "model" ? state.modelsExpanded : state.sessionsExpanded;
  const limit = kind === "session" ? SESSION_DEFAULT_LIMIT : kind === "model" ? MODEL_DEFAULT_LIMIT : RANKED_LIST_LIMIT;
  const button = $(`#${kind}Toggle`);
  if (!button) {
    return;
  }
  const hasQuery = Boolean(String(query || "").trim());
  button.hidden = hasQuery || rows.length <= limit;
  button.textContent = expanded ? t("action_collapse") : t("action_expand");
  button.setAttribute("aria-expanded", String(expanded));
}

export function drawTimeline(canvas, rows, modelRows = [], modelColors = new Map(), range = null) {
  const context = canvas.getContext("2d");
  canvas.dataset.usageTooltip = "true";
  timelineBars.set(canvas, []);
  const ratio = window.devicePixelRatio || 1;
  const styles = getComputedStyle(document.documentElement);
  const chartLine = styles.getPropertyValue("--chart-line").trim() || "#d9e0e6";
  const chartText = styles.getPropertyValue("--chart-text").trim() || "#607080";
  const blue = styles.getPropertyValue("--blue").trim() || "#2364aa";
  const green = styles.getPropertyValue("--green").trim() || "#2f855a";
  const width = canvas.clientWidth * ratio;
  const height = canvas.clientHeight * ratio;
  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.scale(ratio, ratio);

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const padding = { top: 18, right: 18, bottom: 42, left: 58 };
  const chartWidth = cssWidth - padding.left - padding.right;
  const chartHeight = cssHeight - padding.top - padding.bottom;

  context.strokeStyle = chartLine;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + chartHeight);
  context.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  context.stroke();

  if (!rows.length) {
    context.fillStyle = chartText;
    context.font = "13px system-ui";
    context.fillText(t("empty_no_usage"), padding.left + 12, padding.top + 28);
    return;
  }

  const max = Math.max(...rows.map((row) => row.total.total), 1);
  const slotWidth = chartWidth / Math.max(rows.length, 1);
  const gap = Math.min(10, slotWidth * 0.18);
  const barWidth = Math.max(0.5, slotWidth - gap);
  const bars = [];

  rows.forEach((row, index) => {
    const value = row.total.total;
    const barHeight = value ? Math.max(2, (value / max) * chartHeight) : 0;
    const slotX = padding.left + index * slotWidth;
    const x = slotX + Math.max(0, (slotWidth - barWidth) / 2);
    const segments = timelineChannelSegments(row, modelRows);
    let y = padding.top + chartHeight;
    if (value && !segments.length) {
      context.fillStyle = blue;
      context.fillRect(x, y - barHeight, barWidth, barHeight);
    }
    for (const segment of segments) {
      const segmentValue = usageValue(segment.total, "total");
      if (!segmentValue) {
        continue;
      }
      const segmentHeight = (segmentValue / value) * barHeight;
      y -= segmentHeight;
      context.fillStyle = modelColors.get(segment.name) || green;
      context.fillRect(x, y, barWidth, Math.max(0.5, segmentHeight));
    }
    bars.push({
      x: slotX,
      y: padding.top,
      width: slotWidth,
      height: chartHeight,
      row,
    });
  });
  timelineBars.set(canvas, bars);

  context.fillStyle = chartText;
  context.font = "12px system-ui";
  context.fillText(formatCompact(max), 8, padding.top + 8);
  context.fillText("0", 34, padding.top + chartHeight);

  const labels = timelineAxisLabels(rows, { bucket: state.bucket, range, chartWidth });
  for (const label of labels) {
    const index = label.index;
    const x = padding.left + index * slotWidth;
    context.save();
    context.translate(x, padding.top + chartHeight + 18);
    context.rotate(-Math.PI / 8);
    context.fillText(label.label, 0, 0);
    context.restore();
  }
}

function timelineRowAt(canvas, event) {
  const bars = timelineBars.get(canvas) || [];
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = bars.find((bar) => x >= bar.x && x <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height);
  return hit?.row || null;
}

function setupUsageTooltip() {
  const timelineChart = $("#timelineChart");
  timelineChart.addEventListener("pointermove", (event) => {
    const row = timelineRowAt(timelineChart, event);
    if (row) {
      showUsageTooltip(row, event);
      return;
    }
    hideUsageTooltip();
  });
  timelineChart.addEventListener("pointerleave", hideUsageTooltip);

  document.addEventListener("pointermove", (event) => {
    if (event.target === timelineChart) {
      return;
    }
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      hideUsageTooltip();
      return;
    }
    showUsageTooltip(tooltipRows.get(target), event);
  });
  document.addEventListener("pointerleave", hideUsageTooltip);
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      return;
    }
    showUsageTooltip(tooltipRows.get(target), target);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-usage-tooltip]")) {
      hideUsageTooltip();
    }
  });
}

function homeStatusLabel(home) {
  return i18nHomeStatusLabel(home);
}

function homeRowsFromMetadata(metadata) {
  return [...(metadata.homes || [])];
}

export function renderHomesHtml(homes, { canModify = false } = {}) {
  // Render paths and labels as escaped text because they come from local paths.
  if (!homes.length) {
    return `<div class="empty">${t("empty_no_homes")}</div>`;
  }
  return homes
    .map((home) => {
      const label = escapeHtml(home.label);
      const kind = escapeHtml(home.kind || home.type || "");
      const status = escapeHtml(homeStatusLabel(home));
      const pathText = escapeHtml(home.path);
      const reason = home.reason ? `<div class="home-reason">${escapeHtml(home.reason)}</div>` : "";
      const counts = `${formatTokens(home.eventCount || 0)} ${t("homerow_events")} · ${formatTokens(home.sessionCount || 0)} ${t("homerow_sessions")}`;
      return `
        <div class="home-row">
          <div class="home-label">
            <strong>${label}</strong>
            <span class="home-kind">${kind}</span>
          </div>
          <div class="home-meta">
            <span class="home-status">${status}</span>
            <span>${counts}</span>
          </div>
          <div class="home-path" title="${pathText}">${pathText}</div>
          ${reason}
        </div>
      `;
    })
    .join("");
}

function renderHomes(homes, options = {}) {
  const container = $("#homeList");
  container.innerHTML = renderHomesHtml(homes, options);
}

function metadataFromReport(report) {
  const homeStats = new Map();
  for (const event of report.events) {
    const current = homeStats.get(event.homeId) || {
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.sessionId);
    homeStats.set(event.homeId, current);
  }
  return {
    generatedAt: report.generatedAt,
    eventCount: report.events.length,
    sessionCount: report.sessions.length,
    homes: report.homes.map((home) => {
      const stats = homeStats.get(home.id) || { eventCount: 0, sessions: new Set() };
      return {
        ...home,
        status: stats.eventCount > 0 ? "active" : "no-events",
        eventCount: stats.eventCount,
        sessionCount: stats.sessions.size,
      };
    }),
    warnings: report.warnings || [],
  };
}

function currentSummary() {
  if (state.report) {
    return summarize(state.report);
  }
  return state.summary;
}

function currentMetadata() {
  if (state.report) {
    return metadataFromReport(state.report);
  }
  return state.metadata;
}

function render() {
  const summary = currentSummary();
  const metadata = currentMetadata();
  if (!summary || !metadata) {
    return;
  }
  hideUsageTooltip();
  renderMetrics(summary);
  renderComparison(summary);
  $("#rangeLabel").textContent = rangeLabel(summary);
  const modelColors = getModelColors(summary.models);
  const modelRows = filterRankedRows(summary.models, {
    query: state.modelQuery,
    expanded: state.modelsExpanded,
    defaultLimit: MODEL_DEFAULT_LIMIT,
  });
  const sessionRows = filterRankedRows(summary.sessions || [], {
    query: state.sessionQuery,
    expanded: state.sessionsExpanded,
    defaultLimit: SESSION_DEFAULT_LIMIT,
  });
  renderCompactList($("#sessionList"), sessionRows);
  renderCompactList($("#modelList"), modelRows);
  updateRankedListControls("model", summary.models);
  updateRankedListControls("session", summary.sessions || []);
  renderRemoteStatus(state.remote);
  drawTimeline($("#timelineChart"), summary.timeline, summary.models, modelColors, summary.range);
  renderTimelineDetails($("#timelineDetails"), [...summary.timeline].reverse());
  renderTimelineLegend($("#timelineLegend"), summary.models, modelColors);
  applyDynamicTranslations();
}

function remoteStatusLabel(status) {
  const key = `remote_${String(status || "unknown")}`;
  return t(key) === key ? t("remote_unknown") : t(key);
}

function relativeRemoteTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  return `${Math.round(seconds / 3600)}h`;
}

function renderRemoteStatus(remote) {
  const machineList = $("#remoteMachineList");
  const taskList = $("#remoteTaskList");
  const totals = $("#remoteTotals");
  const taskCount = $("#remoteTaskCount");
  if (!machineList || !taskList || !totals || !taskCount) {
    return;
  }
  if (!remote) {
    machineList.innerHTML = `<div class="empty">${t("empty_no_machines")}</div>`;
    taskList.innerHTML = `<div class="empty">${t("empty_no_tasks")}</div>`;
    totals.textContent = "";
    taskCount.textContent = "";
    return;
  }
  const machines = remote.machines || [];
  const tasks = remote.tasks || [];
  const onlineCount = machines.filter((machine) => machine.status === "online").length;
  totals.textContent = `${onlineCount}/${machines.length} · ${formatTokens(remote.totals?.total || 0)} tokens`;
  taskCount.textContent = `${tasks.filter((task) => ["active", "waiting"].includes(task.status)).length} ${t("remote_active_count")}`;
  machineList.innerHTML = machines.length
    ? machines
        .map(
          (machine) => `
            <div class="remote-row">
              <div class="remote-row-title">
                <span class="remote-dot ${escapeHtml(machine.status)}"></span>
                <strong>${escapeHtml(machine.label || machine.machineId)}</strong>
                <span class="remote-badge ${escapeHtml(machine.status)}">${remoteStatusLabel(machine.status)}</span>
              </div>
              <div class="remote-row-meta">${escapeHtml(machine.platform || "")} · ${escapeHtml(relativeRemoteTime(machine.lastSeen))} ${t("remote_ago")}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="empty">${t("empty_no_machines")}</div>`;
  taskList.innerHTML = tasks.length
    ? tasks
        .slice(0, 20)
        .map(
          (task) => `
            <div class="remote-row">
              <div class="remote-row-title">
                <strong>${escapeHtml(task.title || task.project || task.sessionId)}</strong>
                <span class="remote-badge ${escapeHtml(task.status)}">${remoteStatusLabel(task.status)}</span>
              </div>
              <div class="remote-row-meta">${escapeHtml(task.machineId)} · ${escapeHtml(task.provider)} · ${escapeHtml(task.activity || "")} · ${escapeHtml(relativeRemoteTime(task.lastSeen))} ${t("remote_ago")}</div>
            </div>
          `,
        )
        .join("")
    : `<div class="empty">${t("empty_no_tasks")}</div>`;
}

function renderTimelineLegend(container, modelRows, modelColors) {
  if (!container) {
    return;
  }
  if (!modelRows.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = modelRows
    .map((model, index) => {
      const color = modelColors.get(model.name);
      const name = escapeHtml(model.name);
      const value = formatTokens(usageValue(model?.total, "total"));
      return `
        <span class="legend-item">
          <span class="legend-swatch" style="background: ${color};"></span>
          ${name}
          <span class="legend-value">${value}</span>
        </span>
      `;
    })
    .join("");
}

function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setAutoRefreshStatus(message) {
  $("#autoRefreshStatus").textContent = message;
}

function autoRefreshReadyMessage(checkedAt = new Date()) {
  return `${t("status_refresh_interval")}${clockTime(new Date(checkedAt))}`;
}

function updatePresetButtons() {
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
}

function updateProviderButtons() {
  for (const button of document.querySelectorAll("#providerButtons [data-provider]")) {
    button.classList.toggle("active", button.dataset.provider === state.provider);
    button.setAttribute("aria-pressed", String(button.dataset.provider === state.provider));
  }
}

function updateRecentControls() {
  const recentValue = $("#recentValue");
  if (recentValue && recentValue.value !== state.recentValue) {
    recentValue.value = state.recentValue;
  }
  for (const option of document.querySelectorAll("[data-recent-option]")) {
    option.setAttribute("aria-selected", String(option.dataset.recentOption === state.recentValue));
  }
}

function updateBucketSelect() {
  // Keep the native select in sync when presets adjust bucket state programmatically.
  const bucketSelect = $("#bucketSelect");
  if (bucketSelect && bucketSelect.value !== state.bucket) {
    bucketSelect.value = state.bucket;
  }
}

function dateFieldKey(field) {
  return field === "end" ? "endDate" : "startDate";
}

function dateInputForField(field) {
  return field === "end" ? $("#endDate") : $("#startDate");
}

function datePickerForField(field) {
  return field === "end" ? $("#endDatePicker") : $("#startDatePicker");
}

function datePickerButtonForField(field) {
  return document.querySelector(`[data-date-picker-button="${field}"]`);
}

function datePickerViewDate(field) {
  const selected = parseLocalDate(state[dateFieldKey(field)]);
  if (selected) {
    return selected;
  }
  if (state.datePickerViews[field]) {
    return state.datePickerViews[field];
  }
  return new Date();
}

function renderDatePicker(field) {
  const picker = datePickerForField(field);
  if (!picker) {
    return;
  }
  picker.innerHTML = renderDatePickerHtml({
    field,
    viewDate: datePickerViewDate(field),
    selectedValue: state[dateFieldKey(field)],
  });
}

function closeDatePickers() {
  state.datePickerField = "";
  for (const field of ["start", "end"]) {
    const picker = datePickerForField(field);
    const button = datePickerButtonForField(field);
    if (picker) {
      picker.hidden = true;
    }
    if (button) {
      button.setAttribute("aria-expanded", "false");
    }
  }
}

function setDatePickerOpen(field, open) {
  if (!open) {
    closeDatePickers();
    return;
  }
  closeDatePickers();
  state.datePickerField = field;
  state.datePickerViews[field] = datePickerViewDate(field);
  renderDatePicker(field);
  const picker = datePickerForField(field);
  const button = datePickerButtonForField(field);
  if (picker) {
    picker.hidden = false;
  }
  if (button) {
    button.setAttribute("aria-expanded", "true");
  }
}

function applyDateValue(field, value) {
  const key = dateFieldKey(field);
  state[key] = value;
  const input = dateInputForField(field);
  if (input) {
    input.value = value;
  }
  state.preset = "custom";
  updatePresetButtons();
  refreshViewForFilters();
}

function applyTypedDateValue(field, value) {
  const normalized = normalizeDateInput(value);
  if (normalized === null) {
    return;
  }
  applyDateValue(field, normalized);
}

function selectDatePickerDate(field, value) {
  const date = parseLocalDate(value);
  if (!date) {
    return;
  }
  state.datePickerViews[field] = monthStart(date);
  applyDateValue(field, dateKey(date));
  closeDatePickers();
}

function shiftDatePickerMonth(field, offset) {
  const current = datePickerViewDate(field);
  state.datePickerViews[field] = new Date(current.getFullYear(), current.getMonth() + offset, 1);
  renderDatePicker(field);
}

function setRecentMenuOpen(open) {
  const menu = $("#recentRangeMenu");
  const input = $("#recentValue");
  const button = $("#recentMenuButton");
  const segment = document.querySelector(".recent-segment");
  if (!menu || !input || !button || !segment) {
    return;
  }
  menu.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-expanded", String(open));
  segment.classList.toggle("menu-open", open);
}

function activateRecentValue(value) {
  const next = nextRecentState(state, value);
  state.recentValue = next.recentValue;
  state.preset = next.preset;
  state.bucket = next.bucket;
  updateBucketSelect();
  updatePresetButtons();
  updateRecentControls();
  setRecentMenuOpen(false);
  refreshViewForFilters();
}

function usageQuery({ force = false, skipCheck = false } = {}) {
  const params = new URLSearchParams({
    preset: state.preset,
    bucket: state.bucket,
    provider: state.provider || "all",
  });
  if (state.preset === "custom") {
    if (state.startDate) {
      params.set("startDate", state.startDate);
    }
    if (state.endDate) {
      params.set("endDate", state.endDate);
    }
  }
  if (state.preset === "recent" && state.recentValue) {
    params.set("recentValue", state.recentValue);
  }
  if (force) {
    params.set("force", "1");
  }
  if (skipCheck) {
    params.set("skipCheck", "1");
  }
  return `?${params.toString()}`;
}

async function loadUsage({ force = false, skipCheck = false } = {}) {
  $("#refreshButton").disabled = true;
  const embeddedReport = window.__TOKEN_USAGE_REPORT__;
  $("#subtitle").textContent = embeddedReport ? t("status_loading_static") : t("status_scanning");
  try {
    if (embeddedReport) {
      state.report = embeddedReport;
      state.metadata = metadataFromReport(embeddedReport);
      state.summary = null;
      state.fingerprint = "static";
      setAutoRefreshStatus(t("status_static"));
    } else {
      const [response, remoteResponse] = await Promise.all([
        fetch(`/api/usage${usageQuery({ force, skipCheck })}`),
        fetch("/api/remote/status").catch(() => null),
      ]);
      if (!response.ok) {
        throw new Error(`API ${response.status}`);
      }
      const data = await response.json();
      state.report = null;
      state.metadata = data.metadata;
      state.summary = data.summary;
      state.fingerprint = data.fingerprint || "";
      state.remote = remoteResponse?.ok ? await remoteResponse.json() : null;
      setAutoRefreshStatus(autoRefreshReadyMessage(data.checkedAt));
    }
    const metadata = currentMetadata();
    const generated = new Date(metadata.generatedAt).toLocaleString();
    $("#subtitle").textContent = t("subtitle_format").replace("{events}", formatTokens(metadata.eventCount)).replace("{sessions}", formatTokens(metadata.sessionCount)).replace("{generated}", generated);
    render();
  } catch (error) {
    $("#subtitle").textContent = `${t("status_load_failed")}${error.message}`;
  } finally {
    $("#refreshButton").disabled = false;
  }
}

async function checkForUpdates() {
  if (isStaticSnapshot() || !state.fingerprint) {
    return;
  }

  try {
    setAutoRefreshStatus(t("status_checking"));
    const response = await fetch(`/api/status?since=${encodeURIComponent(state.fingerprint)}`);
    if (!response.ok) {
      throw new Error(`API ${response.status}`);
    }
    const status = await response.json();
    if (status.changed) {
      setAutoRefreshStatus(t("status_update_detected"));
      await loadUsage();
      return;
    }
    setAutoRefreshStatus(autoRefreshReadyMessage(status.checkedAt));
  } catch (error) {
    setAutoRefreshStatus(t("status_refresh_failed_prefix") + error.message + t("status_refresh_failed_suffix"));
  }
}

function startAutoRefresh() {
  if (isStaticSnapshot() || state.autoRefreshTimer) {
    return;
  }
  state.autoRefreshTimer = window.setInterval(checkForUpdates, AUTO_REFRESH_INTERVAL_MS);
}

function refreshViewForFilters() {
  if (isStaticSnapshot()) {
    render();
    return;
  }
  void loadUsage({ skipCheck: true });
}

function updateRankedQuery(kind, value) {
  // Query changes are purely local and should not trigger a server rescan.
  if (kind === "project") {
    state.projectQuery = value;
  } else if (kind === "model") {
    state.modelQuery = value;
  } else {
    state.sessionQuery = value;
  }
  render();
}

function toggleRankedExpansion(kind) {
  if (kind === "project") {
    state.projectsExpanded = !state.projectsExpanded;
  } else if (kind === "model") {
    state.modelsExpanded = !state.modelsExpanded;
  } else {
    state.sessionsExpanded = !state.sessionsExpanded;
  }
  render();
}

function bootDashboard() {
  setupUsageTooltip();

  $("#presetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) {
      return;
    }
    const next = nextPresetState(state, button.dataset.preset);
    state.preset = next.preset;
    state.bucket = next.bucket;
    updateBucketSelect();
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  });

  $("#providerButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-provider]");
    if (!button) {
      return;
    }
    state.provider = button.dataset.provider || "all";
    updateProviderButtons();
    refreshViewForFilters();
  });

  $("#bucketSelect").addEventListener("change", (event) => {
    state.bucket = event.target.value;
    refreshViewForFilters();
  });

  for (const field of ["start", "end"]) {
    const input = dateInputForField(field);
    const button = datePickerButtonForField(field);
    const picker = datePickerForField(field);
    input.addEventListener("change", (event) => {
      applyTypedDateValue(field, event.target.value);
    });
    input.addEventListener("focus", () => setDatePickerOpen(field, true));
    input.addEventListener("click", () => setDatePickerOpen(field, true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDatePickers();
      }
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setDatePickerOpen(field, state.datePickerField !== field);
      input.focus();
    });
    picker.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-date-picker-action]");
      if (nav) {
        event.stopPropagation();
        shiftDatePickerMonth(field, nav.dataset.datePickerAction === "next" ? 1 : -1);
        return;
      }
      const day = event.target.closest("[data-date]");
      if (!day) {
        return;
      }
      event.stopPropagation();
      selectDatePickerDate(field, day.dataset.date);
    });
  }

  $("#recentValue").addEventListener("change", (event) => {
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("focus", () => {
    state.preset = "recent";
    updatePresetButtons();
    setRecentMenuOpen(true);
  });

  $("#recentMenuButton").addEventListener("click", (event) => {
    event.stopPropagation();
    state.preset = "recent";
    updatePresetButtons();
    const shouldOpen = $("#recentRangeMenu").hidden;
    $("#recentValue").focus();
    setRecentMenuOpen(shouldOpen);
  });

  $("#recentRangeMenu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-recent-option]");
    if (!option) {
      return;
    }
    event.stopPropagation();
    activateRecentValue(option.dataset.recentOption);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".recent-segment")) {
      setRecentMenuOpen(false);
    }
    if (!event.target.closest(".date-input-wrap")) {
      closeDatePickers();
    }
  });

  $("#refreshButton").addEventListener("click", () => loadUsage({ force: true }));
  $("#modelSearch").addEventListener("input", (event) => updateRankedQuery("model", event.target.value));
  $("#sessionSearch").addEventListener("input", (event) => updateRankedQuery("session", event.target.value));
  $("#modelToggle").addEventListener("click", () => toggleRankedExpansion("model"));
  $("#sessionToggle").addEventListener("click", () => toggleRankedExpansion("session"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setRecentMenuOpen(false);
    }
  });
  $("#themeToggle").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-option]");
    if (!button) {
      return;
    }
    setTheme(button.dataset.themeOption);
  });
  $("#localeToggle").addEventListener("click", (event) => {
    const button = event.target.closest("[data-locale-option]");
    if (!button) {
      return;
    }
    setLocale(button.dataset.localeOption);
    state.locale = getLocale();
    updateLocaleButtons();
    applyStaticTranslations();
    render();
    applyDynamicTranslations();
  });
  window.addEventListener("resize", render);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      startAutoRefresh();
      checkForUpdates();
    }
  });

  setTheme(preferredTheme(), { persist: false });
  applyStaticTranslations();
  updateLocaleButtons();
  updateProviderButtons();
  updateRecentControls();
  updateBucketSelect();
  loadUsage().then(startAutoRefresh);
}

if (typeof document !== "undefined") {
  bootDashboard();
}
