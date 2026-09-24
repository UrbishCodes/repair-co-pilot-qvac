// QVAC wiring: loadModel / ocr / embed / ragIngest / ragSearch /
// completion / textToSpeech / unloadModel. All inference runs on-device.
//
// Call shapes verified against @qvac/sdk 0.19.1's own .d.ts:
//   loadModel({ modelSrc })                  -> Promise<modelId string>
//   loadModel({ modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr })
//   ocr({ modelId, image, stream })          -> { blocks: Promise<OCRTextBlock[]> }
//   embed({ modelId, text })                 -> { embedding: number[] }
//   ragIngest({ workspace, modelId, documents, chunk, chunkOpts })
//   ragSearch({ workspace, modelId, query, topK }) -> RagSearchResult[]
//   completion({ modelId, history })         -> CompletionRun; (await run.final).contentText
//   textToSpeech({ modelId, text, stream })  -> { buffer, done }
//   unloadModel({ modelId })
import {
  loadModel,
  unloadModel,
  ocr,
  embed,
  ragIngest,
  ragSearch,
  ragListWorkspaces,
  completion,
  textToSpeech,
  MODEL_TYPES,
  OCR_LATIN,
  EMBEDDINGGEMMA_300M_Q4_0,
  QWEN3_1_7B_INST_Q4,
  TTS_EN_SUPERTONIC_Q4_0,
} from '@qvac/sdk';
import { buildDiagnosisPrompt, buildChatHistory, sanitize, stripForSpeech } from './prompts.mjs';
import { parseSections } from './markings.mjs';

// Dependency injection for tests: production uses the real SDK, the
// SDK-mocked end-to-end test swaps in a stub that records call shapes.
let sdk = {
  loadModel,
  unloadModel,
  ocr,
  embed,
  ragIngest,
  ragSearch,
  ragListWorkspaces,
  completion,
  textToSpeech,
};
export function setSdk(impl) {
  sdk = impl;
}

// Pinned registry constants (verified present in @qvac/sdk 0.19.1).
export const MODELS = {
  ocr: 'OCR_LATIN', // EasyOCR mode: CRAFT detector auto-derived. Printed part numbers.
  embed: 'EMBEDDINGGEMMA_300M_Q4_0', // datasheet RAG vectors, ~300 MB
  llm: 'QWEN3_1_7B_INST_Q4', // diagnosis + chat, ~1.1 GB
  tts: 'TTS_EN_SUPERTONIC_Q4_0', // hands-free read-aloud, ~150 MB
};

export const WORKSPACE = 'repair-datasheets';

// Supertonic's native output rate: 44100 Hz int16 PCM.
export const TTS_SAMPLE_RATE = 44100;

export const status = { ready: false, stage: 'idle', pct: 0 };

const ids = { ocr: null, embed: null, llm: null, tts: null };

function setStatus(stage, pct) {
  status.stage = stage;
  status.pct = Math.max(0, Math.min(100, Math.round(pct)));
}

function track(stage, base, span) {
  return (p) => {
    const v = typeof p === 'number' ? p : (p?.progress ?? p?.fraction ?? p?.pct ?? 0);
    const pct = v <= 1 ? v * 100 : v;
    setStatus(stage, base + (pct / 100) * span);
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Load one model into RAM on first use (lazy — keeps RAM pressure low).
 * Weights are pre-downloaded at `npm install` time (scripts/download-models.mjs);
 * this step only maps them into memory.
 */
export async function ensureLoaded(kind) {
  if (ids[kind]) return ids[kind];
  if (kind === 'ocr') {
    setStatus('loading text reader', 5);
    console.log('[qvac] loading text reader (EasyOCR)…');
    // The SDK's own ocr.d.ts example loads OCR_LATIN via .src + explicit
    // modelType — the descriptor alone does not carry the OCR engine.
    ids.ocr = await sdk.loadModel({
      modelSrc: OCR_LATIN.src,
      modelType: MODEL_TYPES.ggmlOcr,
      onProgress: track('loading text reader', 5, 20),
    });
    console.log('[qvac] text reader ready');
  } else if (kind === 'embed') {
    setStatus('loading embedder', 25);
    console.log('[qvac] loading embedder…');
    ids.embed = await sdk.loadModel({
      modelSrc: EMBEDDINGGEMMA_300M_Q4_0,
      onProgress: track('loading embedder', 25, 20),
    });
    console.log('[qvac] embedder ready');
  } else if (kind === 'llm') {
    setStatus('loading diagnostician', 45);
    console.log('[qvac] loading diagnostician…');
    ids.llm = await sdk.loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      onProgress: track('loading diagnostician', 45, 25),
    });
    console.log('[qvac] diagnostician ready');
  } else if (kind === 'tts') {
    setStatus('loading voice', 70);
    console.log('[qvac] loading voice…');
    ids.tts = await sdk.loadModel({
      modelSrc: TTS_EN_SUPERTONIC_Q4_0,
      modelConfig: { ttsEngine: 'supertonic', language: 'en' },
      onProgress: track('loading voice', 70, 25),
    });
    console.log('[qvac] voice ready');
  } else {
    throw new Error(`unknown model kind: ${kind}`);
  }
  setStatus('ready', 100);
  status.ready = true;
  return ids[kind];
}

export function isReady(kind) {
  if (kind) return Boolean(ids[kind]);
  return Boolean(ids.ocr && ids.embed && ids.llm && ids.tts);
}

/**
 * Read printed markings off a component photo.
 * @param {string} imagePath - local file path of the component photo
 * @returns {{ blocks: Array<{text: string, confidence: number|null}>, text: string, avgConfidence: number|null }}
 */
export async function ocrImage(imagePath) {
  const modelId = await ensureLoaded('ocr');
  console.log('[qvac] reading markings…');
  const started = Date.now();
  const { blocks } = sdk.ocr({ modelId, image: imagePath, stream: false });
  const list = await withTimeout(blocks, 120000, 'marking OCR timed out after 120s');
  const cleaned = (Array.isArray(list) ? list : [])
    .map((b) => ({
      text: String(b?.text ?? '').trim(),
      confidence:
        typeof b?.confidence === 'number' && !Number.isNaN(b.confidence)
          ? b.confidence
          : null,
    }))
    .filter((b) => b.text.length > 0);
  const text = cleaned.map((b) => b.text).join('\n');
  const confs = cleaned.map((b) => b.confidence).filter((c) => c !== null);
  const avgConfidence = confs.length
    ? confs.reduce((a, c) => a + c, 0) / confs.length
    : null;
  console.log(
    `[qvac] OCR done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${cleaned.length} blocks`
  );
  return { blocks: cleaned, text, avgConfidence };
}

/**
 * Ingest datasheet documents into the local RAG workspace.
 * @param {string[]} documents - datasheet texts
 * @returns {{ processed: number, dropped: number }}
 */
export async function ingestDatasheets(documents) {
  const modelId = await ensureLoaded('embed');
  console.log(`[qvac] ingesting ${documents.length} datasheet(s)…`);
  const result = await sdk.ragIngest({
    workspace: WORKSPACE,
    modelId,
    documents,
    chunk: true,
    chunkOpts: { chunkSize: 800, chunkOverlap: 100, splitStrategy: 'sentence' },
  });
  const processed = Array.isArray(result?.processed) ? result.processed.length : 0;
  const dropped = Array.isArray(result?.droppedIndices) ? result.droppedIndices.length : 0;
  console.log(`[qvac] ingest done — ${processed} chunks, ${dropped} dropped`);
  return { processed, dropped };
}

/**
 * Retrieve the most relevant datasheet chunks for a marking query.
 * @returns {Promise<Array<{ text: string, score: number }>>}
 */
export async function searchDatasheets(query, topK = 4) {
  const modelId = await ensureLoaded('embed');
  const results = await sdk.ragSearch({
    workspace: WORKSPACE,
    modelId,
    query,
    topK,
  });
  return (Array.isArray(results) ? results : []).map((r) => ({
    text: String(r?.text ?? r?.content ?? ''),
    score: typeof r?.score === 'number' ? r.score : 0,
  })).filter((r) => r.text.length > 0);
}

/** True when the datasheet workspace already has documents. */
export async function libraryHasDocs() {
  try {
    const list = await sdk.ragListWorkspaces();
    const ws = (Array.isArray(list) ? list : []).find((w) => w?.name === WORKSPACE || w === WORKSPACE);
    if (!ws) return false;
    return Number(ws?.docCount ?? ws?.documents ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Run the full diagnosis: retrieve datasheet chunks, then have the LLM
 * produce the structured analysis card.
 * @param {string} markings - confirmed marking text
 * @returns {Promise<{ card: object, chunks: Array, noDocs: boolean }>}
 */
export async function diagnose(markings, { timeoutMs = 300000 } = {}) {
  const modelId = await ensureLoaded('llm');
  const chunks = await searchDatasheets(markings, 4);
  const noDocs = chunks.length === 0;
  const history = buildDiagnosisPrompt(markings, chunks, noDocs);
  console.log('[qvac] diagnosing…');
  const started = Date.now();
  const run = sdk.completion({ modelId, history, stream: false });
  const final = await withTimeout(
    run.final,
    timeoutMs,
    'diagnosis timed out after ' + Math.round(timeoutMs / 1000) + 's'
  );
  const raw = sanitize(final?.contentText ?? '');
  console.log(`[qvac] diagnosis done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const card = parseSections(raw);
  card.raw = raw;
  card.noDocs = noDocs;
  return { card, chunks, noDocs };
}

/**
 * Answer a follow-up question grounded in the same markings + datasheet context.
 */
export async function chatReply(session, question, { timeoutMs = 180000 } = {}) {
  const modelId = await ensureLoaded('llm');
  const history = buildChatHistory(session, question);
  console.log('[qvac] chat reply…');
  const started = Date.now();
  const run = sdk.completion({ modelId, history, stream: false });
  const final = await withTimeout(
    run.final,
    timeoutMs,
    'chat reply timed out after ' + Math.round(timeoutMs / 1000) + 's'
  );
  const reply = sanitize(final?.contentText ?? '');
  console.log(`[qvac] chat reply done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return reply || 'I could not come up with an answer — try rephrasing the question.';
}

/** Synthesize speech and return a WAV buffer (16-bit PCM, 44100 Hz). */
export async function synthesize(text, { timeoutMs = 180000 } = {}) {
  const modelId = await ensureLoaded('tts');
  // Never speak markdown or section headers — the voice reads the words,
  // the screen keeps the structure.
  const spoken = stripForSpeech(text);
  console.log('[qvac] synthesize start:', JSON.stringify(spoken.slice(0, 80)));
  const result = sdk.textToSpeech({ modelId, text: spoken, stream: false });
  const pcm = await withTimeout(
    result.buffer,
    timeoutMs,
    'speech synthesis timed out after ' + Math.round(timeoutMs / 1000) + 's'
  );
  try {
    await result.done;
  } catch {
    // done is advisory; the buffer is what matters.
  }
  console.log('[qvac] synthesize done, samples:', Array.isArray(pcm) ? pcm.length : typeof pcm);
  return pcmToWav(pcm, TTS_SAMPLE_RATE);
}

// One global peak-based int16/float decision (per-sample guessing = radio
// noise; wrong rate = slow playback).
function pcmToWav(pcm, sampleRate) {
  const nums = (Array.isArray(pcm) ? pcm : []).filter(
    (v) => typeof v === 'number' && !Number.isNaN(v)
  );
  const peak = nums.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const toFloat = peak > 1 ? (v) => v / 32768 : (v) => v;
  const floats = nums.map((v) => Math.max(-1, Math.min(1, toFloat(v))));
  const dataBytes = floats.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < floats.length; i++) {
    buf.writeInt16LE(Math.round(floats[i] * 32767), 44 + i * 2);
  }
  return buf;
}

export async function unloadAll() {
  for (const key of ['tts', 'llm', 'embed', 'ocr']) {
    if (ids[key]) {
      try {
        await sdk.unloadModel({ modelId: ids[key] });
      } catch (err) {
        console.warn(`[qvac] unload ${key} failed:`, err?.message || err);
      }
      ids[key] = null;
    }
  }
  status.ready = false;
  setStatus('idle', 0);
}
