// Restriction wording the engine can classify without parsing it (design spec 19.9).

/** Sentence ends: . ! or ? (with any closing quote or bracket) followed by whitespace. */
const SENTENCE_END = /[.!?]["'’)\]]*\s+/

/** A statement about who gets enrolment priority or preference. */
const PRIORITY = [
  // "Priority is given to …", "Priority given first to …", "Priority enrolment is given …",
  // "Enrolment priority …", "Please note that preference will be given …". "Priorty" is a
  // misspelling found in the official text.
  /^(?:please note(?: that)?,?\s+)?(?:(?:enrolment|enrollment|registration)\s+)?(?:priority|priorty|preference)\b/i,
  // "English Specialists have priority for registration, followed by English Majors."
  /\b(?:has|have|get|gets|receive|receives)\s+(?:(?:enrolment|enrollment|registration)\s+)?priority\b/i,
]

/** Wording that limits who may enrol, which a priority statement never needs. */
const RESTRICTIVE = /\b(?:restrict\w*|only|not open|not eligible|not permitted|limited|must|cannot|can not|may not|requir\w*|exclusive\w*|closed|permission|approval|audition\w*)\b/i

/**
 * True when every sentence of a restriction only says who gets enrolment priority or preference
 * ("Priority is given to students enrolled in …"). Such text is an enrolment note: it never
 * decides whether a student may take the course. Anything else, including a priority sentence
 * that also limits enrolment, is a real restriction.
 */
export function isPriorityOnly(text: string): boolean {
  const sentences = text.split(SENTENCE_END).map(sentence => sentence.trim()).filter(Boolean)
  return sentences.length > 0
    && sentences.every(sentence => PRIORITY.some(pattern => pattern.test(sentence)) && !RESTRICTIVE.test(sentence))
}
