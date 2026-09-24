// Prompt builders + output hygiene for the diagnosis LLM.
//
// The 1.7B model is asked for labeled plain-text sections (not JSON — small
// LLMs return {} under the json_object grammar). Every prompt carries the
// /no_think prefix so chain-of-thought never leaks into the chat.

const NO_THINK = '/no_think ';

const GROUND_RULES = [
  'Every spec you state MUST come from the printed markings or the datasheet excerpts.',
  'If the datasheets do not cover it, say "not in the local datasheets" instead of guessing.',
  'If you are unsure about a value, tell the technician to verify with a multimeter.',
  'Never invent a part number, voltage rating, or pinout.',
].join('\n');

const SAFETY_RULES = [
  'Before any step involving a powered circuit, warn: unplug mains power and discharge large capacitors.',
  'Never give instructions that bypass fuses, safety interlocks, or isolation barriers.',
  'If the repair involves mains voltage and the user seems inexperienced, say so plainly and suggest a professional.',
].join('\n');

const SECTIONS = [
  'IDENTIFICATION',
  'KEY SPECS',
  'LIKELY FAILURE',
  'REPLACEMENT',
  'REPAIR STEPS',
  'SAFETY FIRST',
  'SOURCES',
];

function datasheetBlock(chunks, noDocs) {
  if (noDocs || chunks.length === 0) {
    return 'DATASHEET EXCERPTS: none — the local library has no matching datasheets. Give general guidance from the markings only, and say clearly that no datasheet was found.';
  }
  return (
    'DATASHEET EXCERPTS (quote these as your SOURCES):\n' +
    chunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n')
  );
}

/**
 * Build the diagnosis conversation history.
 * @param {string} markings - confirmed marking text from the photo
 * @param {Array<{text: string}>} chunks - retrieved datasheet chunks
 * @param {boolean} noDocs - true when the library had nothing relevant
 */
export function buildDiagnosisPrompt(markings, chunks, noDocs) {
  const user =
    NO_THINK +
    'You are an electronics repair assistant running fully on-device. ' +
    'A technician photographed a faulty component.\n\n' +
    'PRINTED MARKINGS (confirmed by the technician):\n' +
    markings +
    '\n\n' +
    datasheetBlock(chunks, noDocs) +
    '\n\nGround rules:\n' +
    GROUND_RULES +
    '\n\nSafety rules:\n' +
    SAFETY_RULES +
    '\n\nReply with EXACTLY these sections, in this order, each starting with the header on its own line:\n' +
    SECTIONS.map((s) => `## ${s}`).join('\n') +
    '\n\nSection guidance:\n' +
    '- IDENTIFICATION: what the component most likely is, in one line.\n' +
    '- KEY SPECS: the specs that matter for replacement, as short lines. Mark each with the excerpt number it came from.\n' +
    '- LIKELY FAILURE: what the visible damage + markings suggest, one short paragraph.\n' +
    '- REPLACEMENT: the exact replacement part to buy, or the closest safe substitute.\n' +
    '- REPAIR STEPS: numbered steps, short, in order. Assume the technician has a soldering iron and a multimeter.\n' +
    '- SAFETY FIRST: the warnings that apply to THIS repair.\n' +
    '- SOURCES: the excerpt numbers you used, e.g. "[1], [3]". If none, write "markings only".';
  return [{ role: 'user', content: user }];
}

/**
 * Build chat history for a follow-up question, grounded in the same context.
 */
export function buildChatHistory(session, question) {
  const { markings, sources } = session;
  const system =
    NO_THINK +
    'You are an electronics repair assistant. Keep answers short — the technician is mid-repair.\n\n' +
    'PRINTED MARKINGS:\n' +
    markings +
    '\n\nDATASHEET CONTEXT:\n' +
    (sources && sources.length
      ? sources.map((s, i) => `[${i + 1}] ${s}`).join('\n')
      : 'none — answer from the markings and general electronics knowledge, and say so.') +
    '\n\nGround rules:\n' +
    GROUND_RULES +
    '\n\nSafety rules:\n' +
    SAFETY_RULES;
  const history = [{ role: 'system', content: system }];
  for (const m of session.history || []) {
    history.push({ role: m.role, content: m.content });
  }
  history.push({ role: 'user', content: NO_THINK + question });
  return history;
}

/**
 * Strip chain-of-thought leakage and reasoning meta-phrases from model output.
 * Handles <think> blocks even when unclosed.
 */
export function sanitize(text) {
  let out = String(text ?? '');
  // Remove <think>...</think>, including unclosed trailing blocks.
  out = out.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  // Remove common reasoning lead-ins that leak as plain text.
  out = out.replace(
    /^(okay|ok|alright|well|so|hmm+)[,.]?\s+(the user is|let me|i (need|should|will)|here's what i)/gim,
    ''
  );
  // Collapse 3+ blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Make model output speakable: drop headers, bullets, and markup so the
 * voice reads words, not formatting.
 */
export function stripForSpeech(text) {
  let out = String(text ?? '');
  out = out.replace(/^#{1,6}\s+/gm, ''); // markdown headers
  out = out.replace(/^[-*•]\s+/gm, ''); // bullets
  out = out.replace(/^\d+[.)]\s+/gm, ''); // numbered steps -> plain sentences
  out = out.replace(/[*_`~]/g, ''); // inline markup
  out = out.replace(/\[(\d+)\]/g, 'source $1'); // [1] -> "source 1"
  out = out.replace(/\n{2,}/g, '. ');
  out = out.replace(/\n/g, ' ');
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
}

export { SECTIONS };
