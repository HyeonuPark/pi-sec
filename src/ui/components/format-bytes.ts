/** Bytes the way a chip says them: 1200 is "1.2 KB", not "1172 B". */
export function formatBytes(bytes: number | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1000;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}
