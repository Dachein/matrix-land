import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { useI18n } from "../../../../../src/portal/i18n";
import { RelativeTime, timestampMs } from "../../../../../src/portal/components/shared/time";
import {
  budgetUsagePercent,
  formatCompactTokens,
  formatNumber,
  formatUsd,
  peakDailyTokens,
  usageIntensityLevel
} from "../../../../../src/portal/token/models";
import type {
  DailyUsagePoint,
  GatewayAnalyticsStatus,
  UsageBreakdownScope
} from "../../../../../src/portal/token/types";

const EChart = lazy(() => import("../charts/EChart").then((module) => ({ default: module.EChart })));

const CALENDAR_LEFT = 46;
const CALENDAR_RIGHT = 12;
const CALENDAR_TOP = 40;
const CALENDAR_CELL_HEIGHT = 15;
const CALENDAR_MIN_CELL_WIDTH = 10;
const HEAT_COLORS = ["#ebe9e3", "#dce9f7", "#a9c9eb", "#659bd4", "#245cab"];

export function PortalTokenEarlyTotal({
  cumulativeTokens,
  updatedAt
}: {
  cumulativeTokens: number;
  updatedAt?: string;
}) {
  const { locale, t } = useI18n();

  return (
    <section aria-label={t("my.overviewAria")} className="portal-token-overview">
      <div className="portal-token-metrics is-summary-only">
        <TokenMetric
          dataMetric="totalTokens"
          detail={updatedAt ? <RelativeTime value={updatedAt} /> : null}
          label={t("my.totalTokens")}
          title={formatNumber(cumulativeTokens)}
          value={formatCompactTokens(cumulativeTokens, locale)}
        />
      </div>
    </section>
  );
}

export function PortalTokenOverview({
  cumulativeTokens,
  budgetSpendUsd,
  currentMonthSpendUsd,
  dailyUsage,
  monthlyBudgetUsd,
  onOpenBreakdown,
  peakDailyTokenCount,
  activityLead,
  snapshotDataThroughDate,
  snapshotStatus,
  snapshotTimezone,
  snapshotDataThroughAt,
  snapshotUpdatedAt
}: {
  cumulativeTokens: number;
  budgetSpendUsd: number;
  currentMonthSpendUsd: number;
  dailyUsage: DailyUsagePoint[];
  monthlyBudgetUsd: number;
  onOpenBreakdown?: (scope: UsageBreakdownScope, date?: string) => void;
  peakDailyTokenCount: number;
  activityLead?: ReactNode;
  snapshotDataThroughAt?: string;
  snapshotDataThroughDate?: string;
  snapshotStatus: GatewayAnalyticsStatus;
  snapshotTimezone: string;
  snapshotUpdatedAt?: string;
}) {
  const { locale, t } = useI18n();
  const budgetPercent = budgetUsagePercent(budgetSpendUsd, monthlyBudgetUsd);
  const hasPublishedSnapshot = snapshotStatus === "ready" || Boolean(snapshotDataThroughDate);
  const unavailableDetail = snapshotStatus === "error"
    ? t("my.snapshotUnavailableShort")
    : t("my.snapshotAwaitingShort");

  return (
    <section className="portal-token-overview" aria-label={t("my.overviewAria")}>
      <div className="portal-token-metrics">
        <TokenMetric
          dataMetric="totalTokens"
          detail={hasPublishedSnapshot
            ? onOpenBreakdown
              ? (
                <button
                  className="portal-token-metric-detail-link"
                  onClick={() => onOpenBreakdown("all")}
                  type="button"
                >
                  {t("my.viewDetail")}
                </button>
              )
              : null
            : unavailableDetail}
          label={t("my.totalTokens")}
          title={hasPublishedSnapshot ? formatNumber(cumulativeTokens) : undefined}
          value={hasPublishedSnapshot ? formatCompactTokens(cumulativeTokens, locale) : "—"}
        />
        <TokenMetric
          dataMetric="peakDailyTokens"
          detail={hasPublishedSnapshot ? t("my.peakDailyTokensDetail") : unavailableDetail}
          label={t("my.peakDailyTokens")}
          title={hasPublishedSnapshot ? formatNumber(peakDailyTokenCount) : undefined}
          value={hasPublishedSnapshot ? formatCompactTokens(peakDailyTokenCount, locale) : "—"}
        />
        <TokenMetric
          dataMetric="monthlyCost"
          detail={hasPublishedSnapshot
            ? onOpenBreakdown
              ? (
                <button
                  className="portal-token-metric-detail-link"
                  onClick={() => onOpenBreakdown("month")}
                  type="button"
                >
                  {t("my.viewDetail")}
                </button>
              )
              : null
            : unavailableDetail}
          label={t("my.currentMonthSpend")}
          value={hasPublishedSnapshot ? formatUsd(currentMonthSpendUsd) : "—"}
        />
        <TokenMetric
          dataMetric="monthlyBudget"
          detail={monthlyBudgetUsd > 0
            ? hasPublishedSnapshot
              ? t("my.budgetUsed", { percent: budgetPercent })
              : t("my.liveBudgetDetail")
            : t("my.inheritedOrNoUsdCap")}
          label={t("my.monthlyBudget")}
          value={monthlyBudgetUsd > 0 ? formatUsd(monthlyBudgetUsd) : t("my.noCap")}
        />
      </div>

      {activityLead}

      <article className="portal-token-usage-band">
        <header>
          <div>
            <p className="portal-kicker">{t("portal.token.usageKicker")}</p>
            <h2>{t("my.tokenActivityTitle")}</h2>
          </div>
          <SnapshotTime
            dataThroughAt={snapshotDataThroughAt}
            dataThroughDate={snapshotDataThroughDate}
            status={snapshotStatus}
            timezone={snapshotTimezone}
            updatedAt={snapshotUpdatedAt}
          />
        </header>
        <DailyUsageHeatmap onOpenDate={onOpenBreakdown ? (date) => onOpenBreakdown("date", date) : undefined} points={dailyUsage} />
      </article>
    </section>
  );
}

function TokenMetric({
  dataMetric,
  detail,
  label,
  title,
  value
}: {
  dataMetric: "totalTokens" | "peakDailyTokens" | "monthlyCost" | "monthlyBudget";
  detail: ReactNode;
  label: string;
  title?: string;
  value: string;
}) {
  return (
    <article className="portal-token-metric" data-metric={dataMetric}>
      <strong title={title}>{value}</strong>
      <small>{label}</small>
      {detail && <em>{detail}</em>}
    </article>
  );
}

function SnapshotTime({
  dataThroughAt,
  dataThroughDate,
  status,
  timezone,
  updatedAt
}: {
  dataThroughAt?: string;
  dataThroughDate?: string;
  status: GatewayAnalyticsStatus;
  timezone: string;
  updatedAt?: string;
}) {
  const { locale, t } = useI18n();
  const relativeTimestamp = timestampMs(updatedAt) ? updatedAt : dataThroughAt;
  const throughDate = formatDateKey(dataThroughDate, locale);

  if (!relativeTimestamp && !throughDate) {
    return null;
  }

  return (
    <span className="portal-token-snapshot-time" data-status={status}>
      <span className="portal-token-snapshot-copy">
        {relativeTimestamp ? (
          <>
            {t("my.snapshotDataThroughPrefix")}
            <RelativeTime timeZone={timezone} value={relativeTimestamp} />
          </>
        ) : t("my.snapshotDataThroughDate", { date: throughDate })}
      </span>
    </span>
  );
}

function DailyUsageHeatmap({
  onOpenDate,
  points
}: {
  onOpenDate?: (date: string) => void;
  points: DailyUsagePoint[];
}) {
  const { locale, t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [chartEnabled, setChartEnabled] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const maxVisibleWeekColumns = viewportWidth > 0
    ? Math.max(1, Math.floor((viewportWidth - CALENDAR_LEFT - CALENDAR_RIGHT) / CALENDAR_MIN_CELL_WIDTH))
    : Number.POSITIVE_INFINITY;
  const visiblePoints = useMemo(
    () => latestPointsForWeekColumns(points, maxVisibleWeekColumns),
    [maxVisibleWeekColumns, points]
  );
  const firstDate = visiblePoints[0]?.date ?? "";
  const lastDate = visiblePoints.at(-1)?.date ?? "";
  const calculatedPeak = peakDailyTokens(points);
  const cells = useMemo(() => visiblePoints.map((point, index) => {
    const position = calendarCellPosition(point.date, firstDate);
    const tooltip = t("my.heatmapTooltip", {
      date: formatDateKey(point.date, locale),
      tokens: formatCompactTokens(point.summary.billableUnits, locale)
    });

    return {
      ...point,
      column: position.column,
      index,
      level: usageIntensityLevel(point.summary.billableUnits, calculatedPeak),
      openAria: t("my.heatmapOpenBreakdown", {
        date: formatDateKey(point.date, locale)
      }),
      row: position.row,
      tooltip
    };
  }), [calculatedPeak, firstDate, locale, t, visiblePoints]);
  const weekColumns = Math.max(1, ...cells.map((cell) => cell.column));
  const ariaLabel = t("my.heatmapAriaDescription", {
    end: formatDateKey(lastDate, locale),
    start: formatDateKey(firstDate, locale)
  });
  const option = useMemo(
    () => buildHeatmapOption(cells, firstDate, lastDate, locale, ariaLabel),
    [ariaLabel, cells, firstDate, lastDate, locale]
  );
  const overlayStyle = { "--portal-token-week-columns": weekColumns } as CSSProperties;

  useEffect(() => {
    // Keep the large chart runtime outside the data-ready paint. The semantic
    // overlay and an accessible placeholder render immediately, then ECharts
    // hydrates as a non-critical enhancement.
    const timer = window.setTimeout(() => setChartEnabled(true), 250);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateWidth = () => {
      const nextWidth = Math.max(0, Math.floor(viewport.clientWidth));
      setViewportWidth((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    };
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className="portal-token-heatmap" aria-label={ariaLabel} role="group">
      <div className="portal-token-heatmap-scroll" ref={viewportRef}>
        <div className="portal-token-heatmap-canvas">
          {chartEnabled ? (
            <Suspense fallback={<div aria-busy="true" aria-label={ariaLabel} className="portal-token-heatmap-chart" role="img" />}>
              <EChart ariaLabel={ariaLabel} className="portal-token-heatmap-chart" option={option} />
            </Suspense>
          ) : (
            <div aria-busy="true" aria-label={ariaLabel} className="portal-token-heatmap-chart" role="img" />
          )}
          <div className="portal-token-heatmap-overlay" style={overlayStyle}>
            {cells.map((cell) => {
              const tooltipId = `portal-token-heatmap-tooltip-${cell.date}`;
              const edge = cell.column <= 2 ? "start" : cell.column >= weekColumns - 1 ? "end" : "center";
              const side = cell.row <= 2 ? "below" : "above";

              return (
                <span
                  aria-describedby={tooltipId}
                  aria-label={onOpenDate ? cell.openAria : cell.tooltip}
                  className="portal-token-heatmap-cell"
                  data-interactive={onOpenDate ? "true" : undefined}
                  data-date={cell.date}
                  data-index={cell.index}
                  data-level={cell.level}
                  data-tooltip-align={edge}
                  data-tooltip-side={side}
                  key={cell.date}
                  onClick={onOpenDate ? () => onOpenDate(cell.date) : undefined}
                  onKeyDown={(event) => {
                    if (onOpenDate && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onOpenDate(cell.date);
                      return;
                    }
                    moveHeatmapFocus(event, cell.index, cells.length);
                  }}
                  role="img"
                  style={{ gridColumn: cell.column, gridRow: cell.row }}
                  tabIndex={cell.index === cells.length - 1 ? 0 : -1}
                  title={onOpenDate ? cell.openAria : undefined}
                >
                  <span className="portal-token-heatmap-tooltip" id={tooltipId} role="tooltip">
                    {cell.tooltip}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <div className="portal-token-heatmap-legend" aria-hidden="true">
        <span>{t("my.heatmapLess")}</span>
        {HEAT_COLORS.map((color, index) => <i key={color} style={{ background: color }} data-level={index} />)}
        <span>{t("my.heatmapMore")}</span>
      </div>
    </div>
  );
}

type HeatmapCell = DailyUsagePoint & {
  column: number;
  index: number;
  level: number;
  openAria: string;
  row: number;
  tooltip: string;
};

function buildHeatmapOption(
  cells: HeatmapCell[],
  firstDate: string,
  lastDate: string,
  locale: string,
  ariaDescription: string
): EChartsCoreOption {
  const monthNames = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(2026, month, 1))));
  const dayNames = Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, {
    weekday: "narrow",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(2026, 0, 4 + day))));

  return {
    animation: false,
    aria: {
      enabled: true,
      label: {
        description: ariaDescription,
        enabled: true
      }
    },
    calendar: {
      cellSize: ["auto", CALENDAR_CELL_HEIGHT],
      dayLabel: {
        color: "#817b71",
        firstDay: 1,
        fontSize: 9,
        margin: 8,
        nameMap: dayNames
      },
      itemStyle: {
        borderColor: "#ffffff",
        borderWidth: 2,
        color: HEAT_COLORS[0]
      },
      height: CALENDAR_CELL_HEIGHT * 7,
      left: CALENDAR_LEFT,
      monthLabel: {
        color: "#5e5a52",
        fontSize: 10,
        margin: 11,
        nameMap: monthNames
      },
      range: [firstDate, lastDate],
      right: CALENDAR_RIGHT,
      splitLine: { show: false },
      top: CALENDAR_TOP,
      yearLabel: { show: false }
    },
    series: [{
      coordinateSystem: "calendar",
      data: cells.map((cell) => [cell.date, cell.summary.billableUnits, cell.level]),
      emphasis: {
        itemStyle: {
          borderColor: "#11110f",
          borderWidth: 2
        }
      },
      type: "heatmap"
    }],
    tooltip: {
      appendToBody: false,
      confine: true,
      formatter: (params: unknown) => {
        const value = chartValue(params);
        return cells.find((cell) => cell.date === value[0])?.tooltip ?? "";
      },
      trigger: "item"
    },
    visualMap: {
      dimension: 2,
      pieces: HEAT_COLORS.map((color, value) => ({ color, value })),
      show: false,
      type: "piecewise"
    }
  };
}

function chartValue(params: unknown): Array<string | number> {
  if (typeof params !== "object" || params === null || !("value" in params)) {
    return [];
  }
  const value = (params as { value?: unknown }).value;
  return Array.isArray(value) ? value as Array<string | number> : [];
}

function calendarCellPosition(date: string, firstDate: string) {
  const start = dateKeyAsUtc(firstDate);
  const current = dateKeyAsUtc(date);
  const startWeekday = (start.getUTCDay() + 6) % 7;
  const dayOffset = Math.max(0, Math.round((current.getTime() - start.getTime()) / 86_400_000));
  const gridOffset = startWeekday + dayOffset;

  return {
    column: Math.floor(gridOffset / 7) + 1,
    row: (gridOffset % 7) + 1
  };
}

function latestPointsForWeekColumns(points: DailyUsagePoint[], maxColumns: number) {
  if (points.length <= 1 || !Number.isFinite(maxColumns)) {
    return points;
  }

  const lastDate = points.at(-1)?.date ?? "";
  const boundedColumns = Math.max(1, Math.floor(maxColumns));
  let firstVisibleIndex = 0;

  while (
    firstVisibleIndex < points.length - 1
    && calendarCellPosition(lastDate, points[firstVisibleIndex].date).column > boundedColumns
  ) {
    firstVisibleIndex += 1;
  }

  return firstVisibleIndex === 0 ? points : points.slice(firstVisibleIndex);
}

function moveHeatmapFocus(event: KeyboardEvent<HTMLElement>, index: number, count: number) {
  const offsets: Record<string, number> = {
    ArrowDown: 1,
    ArrowLeft: -7,
    ArrowRight: 7,
    ArrowUp: -1,
    End: count - 1 - index,
    Home: -index
  };
  const offset = offsets[event.key];
  if (offset === undefined) {
    return;
  }

  const nextIndex = Math.max(0, Math.min(count - 1, index + offset));
  const nextCell = event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-index="${nextIndex}"]`);
  if (nextCell) {
    event.preventDefault();
    nextCell.focus();
  }
}

function formatDateKey(value: string | undefined, locale: string) {
  if (!value) {
    return "";
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(timestamp)
    : value;
}

function dateKeyAsUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}
