export interface SnippedText {
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
}

export function snipText(value: string, maxChars: number): SnippedText {
  if (!Number.isInteger(maxChars) || maxChars < 64) throw new Error("maxChars must be an integer of at least 64");
  if (value.length <= maxChars) return { text: value, truncated: false, originalChars: value.length, omittedChars: 0 };
  const markerBudget = 48;
  const contentBudget = maxChars - markerBudget;
  const headChars = Math.ceil(contentBudget * 0.65);
  const tailChars = contentBudget - headChars;
  const omittedChars = value.length - headChars - tailChars;
  const marker = `\n...[${omittedChars} chars archived]...\n`;
  return {
    text: `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`,
    truncated: true,
    originalChars: value.length,
    omittedChars,
  };
}
