export function formatMetric(value: number, unit: string, precision = 1) {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value)}${unit ? ` ${unit}` : ""}`;
}

export function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatTimestamp(value: string | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatChartTick(value: string, compact = false) {
  return new Intl.DateTimeFormat(
    "en-US",
    compact
      ? {
          hour: "numeric",
        }
      : {
          month: "short",
          day: "numeric",
          hour: "numeric",
        },
  ).format(new Date(value));
}

export function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function maximum(values: number[]) {
  return Math.max(...values);
}

export function minimum(values: number[]) {
  return Math.min(...values);
}
