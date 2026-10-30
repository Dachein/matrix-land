import { HeatmapChart } from "echarts/charts";
import {
  AriaComponent,
  CalendarComponent,
  TooltipComponent,
  VisualMapComponent
} from "echarts/components";
import { init, use, type ECharts as EChartsInstance, type EChartsCoreOption } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

use([
  HeatmapChart,
  CalendarComponent,
  TooltipComponent,
  VisualMapComponent,
  AriaComponent,
  SVGRenderer
]);

export function EChart({
  ariaLabel,
  className,
  option
}: {
  ariaLabel: string;
  className?: string;
  option: EChartsCoreOption;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | undefined>(undefined);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    const chart = init(element, undefined, { renderer: "svg" });
    chartRef.current = chart;

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      aria-label={ariaLabel}
      className={className}
      ref={elementRef}
      role="img"
    />
  );
}
