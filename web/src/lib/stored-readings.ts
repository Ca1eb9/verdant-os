// The last reading per farm, kept on this device (useFarmTelemetry). Its own
// module so the login page can clear it without loading the farm's data sources.

export function readingStorageKey(farmId: string) {
  return `verdantos:v4:last-reading:${farmId}`;
}

/**
 * Forgets every farm's saved reading, older key versions included, so the next
 * person at a shared device doesn't see the last farm's reading before signing in.
 */
export function clearStoredReadings() {
  try {
    const { localStorage } = window;
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((key): key is string => key !== null && /^verdantos:(v\d+:)?last-reading:/.test(key))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // storage is blocked: nothing was saved either
  }
}
