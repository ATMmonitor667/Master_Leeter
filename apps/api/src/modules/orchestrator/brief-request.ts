/** Requests for the authored prompt, distinct from debugging or asking for a solution. */
export function isBriefRequest(transcript: string): boolean {
  const text = transcript.toLowerCase()
    .replace(/\bwha\s+t\b/g, "what")
    .replace(/\b(problem|question|task|challenge)\s+s\b/g, "$1s")
    .replace(/\s+/g, " ").trim();
  if (/\b(?:with|in) (?:my|the|this|that|our|your) (?:code|solution|approach|algorithm|implementation)\b/.test(text)) return false;
  return /\b(say that again|repeat (that|the (question|problem))|hear that again|didn'?t (quite )?catch|missed that)\b/.test(text)
    || /\bwhat(?:'s| (?:is|are)) (?:the |our |my |this |these )?(?:coding )?(?:problems?|questions?|tasks?|challenges?)(?=\s*(?:[?.!]|$|that\b|we\b|today\b|for (?:today|this interview)\b))/i.test(text)
    || /\b(?:tell|read|repeat|restate|explain|describe) (?:me |to me )?(?:what (?:the |our )?)?(?:the |our )?(?:coding )?(?:problem|question|task|challenge)(?:s| statement)?(?=\s*(?:[?.!]|$|is\b|are\b|again\b|please\b))/i.test(text);
}
