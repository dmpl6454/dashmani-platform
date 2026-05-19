const DAY_MS = 86400000;

export function calcStreaks(reportDates: Date[]): { currentStreak: number; longestStreak: number } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sortedDesc = Array.from(
    new Set(
      reportDates.map((d) => {
        const dt = new Date(d);
        dt.setHours(0, 0, 0, 0);
        return dt.getTime();
      })
    )
  ).sort((a, b) => b - a);

  // Current streak: consecutive days back from today
  let currentStreak = 0;
  let cursor = today.getTime();
  for (const ts of sortedDesc) {
    if (ts === cursor || ts === cursor - DAY_MS) {
      currentStreak++;
      cursor = ts - DAY_MS;
    } else if (ts < cursor - DAY_MS) {
      break;
    }
  }

  // Longest streak: longest consecutive run
  let longestStreak = 0;
  let runLength = 0;
  let prevTs: number | null = null;
  for (const ts of [...sortedDesc].reverse()) {
    if (prevTs === null || ts === prevTs + DAY_MS) {
      runLength++;
    } else if (ts > prevTs + DAY_MS) {
      runLength = 1;
    }
    longestStreak = Math.max(longestStreak, runLength);
    prevTs = ts;
  }

  return { currentStreak, longestStreak };
}
