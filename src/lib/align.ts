/**
 * Tolerant word-level alignment between the expected (reference) recitation and
 * what the ASR heard. The verdict on correctness lives HERE, in deterministic
 * code -- never in an LLM.
 *
 * We compute matching blocks via LCS, derive positioned edit operations
 * (match / substitution / omission / insertion), and add one piece of judgement:
 * a single-word "substitution" whose character similarity is high is treated as
 * the ASR fumbling a CORRECT word, not the reciter's mistake. Tune the threshold
 * (SIMILARITY_THRESHOLD) on your own voice.
 */

export const OpKind = {
  MATCH: "match",
  SUBSTITUTION: "substitution",
  OMISSION: "omission",
  INSERTION: "insertion",
} as const;
export type OpKind = (typeof OpKind)[keyof typeof OpKind];

export interface Op {
  kind: OpKind;
  refIndex: number | null; // index into expected token list (null for insertions)
  expected: string | null;
  heard: string | null;
}

export const SIMILARITY_THRESHOLD = 0.8;

/** Matched index pairs between two sequences, via classic LCS DP + backtrack. */
function lcsPairs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** difflib-style ratio: 2 * matched / total, computed at character level. */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  const matched = lcsPairs(Array.from(a), Array.from(b)).length;
  return (2 * matched) / total;
}

/** Coalesce matched pairs into (ai, bi, size) blocks of consecutive matches. */
function matchingBlocks(pairs: Array<[number, number]>): Array<[number, number, number]> {
  const blocks: Array<[number, number, number]> = [];
  let bi = -1;
  let bj = -1;
  let size = 0;
  for (const [i, j] of pairs) {
    if (bi >= 0 && i === bi + size && j === bj + size) {
      size++;
    } else {
      if (size > 0) blocks.push([bi, bj, size]);
      bi = i;
      bj = j;
      size = 1;
    }
  }
  if (size > 0) blocks.push([bi, bj, size]);
  return blocks;
}

export function align(
  expected: string[],
  heard: string[],
  similarityThreshold: number = SIMILARITY_THRESHOLD,
): Op[] {
  const ops: Op[] = [];
  const blocks = matchingBlocks(lcsPairs(expected, heard));
  blocks.push([expected.length, heard.length, 0]); // sentinel terminator

  let i = 0;
  let j = 0;
  for (const [bi, bj, size] of blocks) {
    const gapA = bi - i; // expected words in the gap before this block
    const gapB = bj - j; // heard words in the gap before this block

    if (gapA > 0 && gapB > 0) {
      // overlapping region -> pair positionally, tail is pure omit/insert
      const span = Math.min(gapA, gapB);
      for (let k = 0; k < span; k++) {
        const exp = expected[i + k];
        const hrd = heard[j + k];
        if (ratio(exp, hrd) >= similarityThreshold) {
          ops.push({ kind: OpKind.MATCH, refIndex: i + k, expected: exp, heard: hrd });
        } else {
          ops.push({ kind: OpKind.SUBSTITUTION, refIndex: i + k, expected: exp, heard: hrd });
        }
      }
      for (let k = span; k < gapA; k++)
        ops.push({ kind: OpKind.OMISSION, refIndex: i + k, expected: expected[i + k], heard: null });
      for (let k = span; k < gapB; k++)
        ops.push({ kind: OpKind.INSERTION, refIndex: null, expected: null, heard: heard[j + k] });
    } else if (gapA > 0) {
      for (let k = 0; k < gapA; k++)
        ops.push({ kind: OpKind.OMISSION, refIndex: i + k, expected: expected[i + k], heard: null });
    } else if (gapB > 0) {
      for (let k = 0; k < gapB; k++)
        ops.push({ kind: OpKind.INSERTION, refIndex: null, expected: null, heard: heard[j + k] });
    }

    for (let k = 0; k < size; k++)
      ops.push({ kind: OpKind.MATCH, refIndex: bi + k, expected: expected[bi + k], heard: heard[bj + k] });

    i = bi + size;
    j = bj + size;
  }
  return ops;
}

export function hasMistake(ops: Op[]): boolean {
  return ops.some((op) => op.kind !== OpKind.MATCH);
}
