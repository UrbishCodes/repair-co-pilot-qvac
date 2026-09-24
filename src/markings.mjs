// Pure logic for markings and diagnosis output: OCR joining, confidence,
// suspicious-character flags, and section parsing. No SDK calls — fully
// unit-testable.

/** Join OCR blocks into clean marking text. */
export function joinBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => String(b?.text ?? '').trim())
    .filter((t) => t.length > 0)
    .join('\n');
}

/** Mean of the non-null block confidences, or null when none exist. */
export function avgConfidence(blocks) {
  const confs = (Array.isArray(blocks) ? blocks : [])
    .map((b) => b?.confidence)
    .filter((c) => typeof c === 'number' && !Number.isNaN(c));
  if (confs.length === 0) return null;
  return confs.reduce((a, c) => a + c, 0) / confs.length;
}

// Character pairs the OCR commonly confuses on printed part numbers.
const SUSPICIOUS_PAIRS = [
  ['0', 'O'],
  ['5', 'S'],
  ['1', 'I'],
  ['8', 'B'],
  ['2', 'Z'],
  ['6', 'G'],
];

/**
 * Flag markings that contain commonly-confused characters so the confirm
 * screen can nudge the technician to double-check them.
 * @returns {string[]} human-readable warnings
 */
export function flagSuspicious(text) {
  const warnings = [];
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Only flag plausible part numbers: 3+ chars mixing letters and digits.
    if (trimmed.length < 3) continue;
    if (!/[A-Za-z]/.test(trimmed) || !/[0-9]/.test(trimmed)) continue;
    const hits = SUSPICIOUS_PAIRS.filter(([a, b]) => trimmed.includes(a) || trimmed.includes(b));
    if (hits.length > 0) {
      warnings.push(
        `"${trimmed}" contains ${hits.map(([a, b]) => `${a}/${b}`).join(', ')} — OCR confuses these on printed parts, please verify against the photo.`
      );
    }
  }
  return warnings;
}

/**
 * Parse the LLM's labeled sections into a card object.
 * Missing sections become empty strings; unparseable output lands in `notes`.
 */
export function parseSections(raw) {
  const card = {
    identification: '',
    specs: '',
    failure: '',
    replacement: '',
    steps: '',
    safety: '',
    sources: '',
    notes: '',
  };
  const text = String(raw ?? '');
  const headerRe = /^##\s*(IDENTIFICATION|KEY SPECS|LIKELY FAILURE|REPLACEMENT|REPAIR STEPS|SAFETY FIRST|SOURCES)\s*$/gim;
  const matches = [...text.matchAll(headerRe)];
  if (matches.length === 0) {
    card.notes = text.trim();
    return card;
  }
  const keyOf = (header) =>
    ({
      IDENTIFICATION: 'identification',
      'KEY SPECS': 'specs',
      'LIKELY FAILURE': 'failure',
      REPLACEMENT: 'replacement',
      'REPAIR STEPS': 'steps',
      'SAFETY FIRST': 'safety',
      SOURCES: 'sources',
    }[header.toUpperCase()]);
  for (let i = 0; i < matches.length; i++) {
    const key = keyOf(matches[i][1]);
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    if (key) card[key] = text.slice(start, end).trim();
  }
  // Anything before the first header is preamble — keep it as notes.
  const preamble = text.slice(0, matches[0].index).trim();
  if (preamble) card.notes = preamble;
  return card;
}

/** Split a section's lines into a clean array (for steps, specs). */
export function sectionLines(sectionText) {
  return String(sectionText ?? '')
    .split('\n')
    .map((l) => l.replace(/^[-*•\d+.)\s]+/, '').trim())
    .filter((l) => l.length > 0);
}

/** Build the full speakable text of a diagnosis card. */
export function cardSpeechText(card) {
  const parts = [];
  if (card.identification) parts.push('Identification. ' + card.identification);
  if (card.specs) parts.push('Key specs. ' + card.specs);
  if (card.failure) parts.push('Likely failure. ' + card.failure);
  if (card.replacement) parts.push('Replacement. ' + card.replacement);
  if (card.steps) parts.push('Repair steps. ' + card.steps);
  if (card.safety) parts.push('Safety first. ' + card.safety);
  return parts.join(' ');
}
