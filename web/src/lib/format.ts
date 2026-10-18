export function formatMetric(value: number, unit: string, precision = 1) {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value)}${unit ? ` ${unit}` : ""}`;
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

/** How long ago, coarsely: "just now", "12s ago", "4m ago", "3h ago", "2d ago" */
export function formatAgo(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
