// Tiny fzf-flavored fuzzy scorer.
//
// Returns a score (higher = better match) or null if pattern doesn't match.
// Pattern characters must appear in order in the target. Bonuses:
// - Consecutive matches
// - Match at the start of the string or after a separator (/, -, _, space)
// - Match in the basename (after the last /)
//
// Tuned for project paths like "/Users/x/Projects/Foo/Bar".

const SEP_RX = /[\s/\-_.]/;

export function fuzzyScore(pattern: string, target: string): number | null {
  if (!pattern) return 0;
  const p = pattern.toLowerCase();
  const t = target.toLowerCase();
  if (p.length > t.length) return null;

  // Strongly prefer matches in the basename.
  const lastSlash = target.lastIndexOf("/");
  const basenameStart = lastSlash >= 0 ? lastSlash + 1 : 0;

  let score = 0;
  let pi = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < t.length && pi < p.length; i++) {
    if (t[i] === p[pi]) {
      let bonus = 1;
      if (i === prevMatchIdx + 1) bonus += 5;
      if (i === 0 || SEP_RX.test(target[i - 1])) bonus += 4;
      if (i >= basenameStart) bonus += 3;
      score += bonus;
      prevMatchIdx = i;
      pi++;
    }
  }
  return pi === p.length ? score : null;
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

export function fuzzyRank<T>(
  pattern: string,
  items: T[],
  getString: (it: T) => string,
): ScoredItem<T>[] {
  if (!pattern) return items.map((item) => ({ item, score: 0 }));
  const scored: ScoredItem<T>[] = [];
  for (const item of items) {
    const s = fuzzyScore(pattern, getString(item));
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
