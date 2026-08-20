/**
 * Safe compilation and bounded matching for the MODEL-SUPPLIED flag pattern.
 *
 * The recipe's flagPattern and the (potentially large) session transcript are
 * both attacker/model influenced. A pattern like `(a+)+$` on a big input can
 * trigger catastrophic backtracking and wedge the whole Node event loop (there
 * is no per-regex timeout in JS). We defend structurally: cap the pattern
 * length, reject the nested-quantifier shapes that cause exponential blowup,
 * and only ever run the match against a bounded tail of the transcript (a flag
 * printed by `cat` is at the end anyway).
 */
const MAX_PATTERN_LENGTH = 200;
const MAX_MATCH_WINDOW = 64 * 1024;

/** Nested quantifier over a group, e.g. (a+)+, (a*)*, (a+)*, ([ab]+)+ — the classic ReDoS shape. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*]/;
/** A quantified group followed by another quantifier via backreference-free alternation, e.g. (a|aa)+ */
const QUANTIFIED_ALTERNATION = /\([^)]*\|[^)]*\)\s*[+*]\+?/;

export function compileSafeFlagPattern(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("flag pattern must be a non-empty string");
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`flag pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  if (NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern)) {
    throw new Error("flag pattern uses a nested/ambiguous quantifier that risks catastrophic backtracking; simplify it");
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid flag pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Match against only the bounded tail of `text` so a huge transcript cannot amplify a slow pattern. */
export function matchFlagBounded(pattern: RegExp, text: string): RegExpExecArray | null {
  const window = text.length > MAX_MATCH_WINDOW ? text.slice(text.length - MAX_MATCH_WINDOW) : text;
  return pattern.exec(window);
}
