/**
 * Детерминированная позиция в плейлисте для синхронного показа:
 * (serverNow - epoch) mod totalDuration.
 */
export interface SyncPosition {
  index: number;
  /** Сколько мс текущий элемент уже идёт. */
  offsetMs: number;
  /** Через сколько мс начнётся следующий элемент. */
  remainingMs: number;
}

export function syncPosition(durationsSec: readonly number[], epochMs: number, nowMs: number): SyncPosition | null {
  if (durationsSec.length === 0) return null;
  const durationsMs = durationsSec.map((d) => Math.max(1, Math.round(d * 1000)));
  const total = durationsMs.reduce((a, b) => a + b, 0);
  let pos = (nowMs - epochMs) % total;
  if (pos < 0) pos += total;
  for (let i = 0; i < durationsMs.length; i++) {
    const d = durationsMs[i]!;
    if (pos < d) return { index: i, offsetMs: pos, remainingMs: d - pos };
    pos -= d;
  }
  // Недостижимо, но на всякий случай.
  return { index: 0, offsetMs: 0, remainingMs: durationsMs[0]! };
}
