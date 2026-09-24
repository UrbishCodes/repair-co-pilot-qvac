// Pre-download all model weights at `npm install` time so first use only
// maps them into RAM instead of downloading. Never fails the install:
// if the registry is unreachable, models fetch lazily on first use.
import { loadModel, unloadModel, MODEL_TYPES, OCR_LATIN, EMBEDDINGGEMMA_300M_Q4_0, QWEN3_1_7B_INST_Q4, TTS_EN_SUPERTONIC_Q4_0 } from '@qvac/sdk';

const MODELS = [
  ['text reader (EasyOCR)', { modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr }],
  ['embedder', { modelSrc: EMBEDDINGGEMMA_300M_Q4_0 }],
  ['diagnostician', { modelSrc: QWEN3_1_7B_INST_Q4 }],
  ['voice', { modelSrc: TTS_EN_SUPERTONIC_Q4_0, modelConfig: { ttsEngine: 'supertonic', language: 'en' } }],
];

const loaded = [];
try {
  for (const [name, opts] of MODELS) {
    console.log(`[download-models] fetching ${name}…`);
    const id = await loadModel({
      ...opts,
      onProgress: (p) => {
        const v = typeof p === 'number' ? p : (p?.progress ?? p?.fraction ?? 0);
        if (v > 0) process.stdout.write(`\r[download-models] ${name}: ${Math.round(v * 100)}%   `);
      },
    });
    loaded.push(id);
    console.log(`\r[download-models] ${name}: cached ✓`);
  }
} catch (err) {
  console.warn('[download-models] skipped (registry unreachable — models will fetch on first use):', err?.message || err);
} finally {
  for (const id of loaded) {
    try {
      await unloadModel({ modelId: id });
    } catch {}
  }
  console.log('[download-models] done — models unloaded from RAM, weights stay cached.');
}
