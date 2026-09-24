// SDK-mocked end-to-end: the full server flow runs against a stubbed SDK
// that records call shapes. Verifies wiring, not model quality.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  OCR_LATIN,
  EMBEDDINGGEMMA_300M_Q4_0,
  QWEN3_1_7B_INST_Q4,
  TTS_EN_SUPERTONIC_Q4_0,
  MODEL_TYPES,
} from '@qvac/sdk';
import { setSdk, ocrImage, ingestDatasheets, searchDatasheets, diagnose, chatReply, synthesize, unloadAll } from '../src/qvac.mjs';
import { server } from '../src/server.mjs';

const DIAGNOSIS_TEXT = `## IDENTIFICATION
2N2222 NPN transistor in TO-92 package.
## KEY SPECS
- VCEO 40 V [1]
- IC 800 mA [1]
## LIKELY FAILURE
Collector-emitter short from overcurrent.
## REPLACEMENT
2N2222A or PN2222.
## REPAIR STEPS
1. Unplug power.
2. Desolder the failed part.
3. Solder the replacement.
## SAFETY FIRST
Unplug mains and discharge large capacitors before touching the board.
## SOURCES
[1]`;

const calls = [];
let completionQueue = [];
let emptyRag = false;

function mockSdk() {
  return {
    loadModel: async (opts) => {
      calls.push(['loadModel', opts]);
      return 'mock-model-id';
    },
    unloadModel: async ({ modelId }) => {
      calls.push(['unloadModel', { modelId }]);
    },
    ocr: ({ modelId, image, stream }) => {
      calls.push(['ocr', { modelId, image, stream }]);
      assert.ok(typeof image === 'string' && image.length > 0, 'ocr needs an image path');
      return {
        blocks: Promise.resolve([
          { text: '2N2222', confidence: 0.92 },
          { text: 'TO-92', confidence: 0.45 },
        ]),
      };
    },
    embed: async ({ modelId, text }) => {
      calls.push(['embed', { modelId, typeofText: typeof text }]);
      return { embedding: [0.1, 0.2, 0.3] };
    },
    ragIngest: async (params) => {
      calls.push(['ragIngest', { workspace: params.workspace, docs: params.documents.length, chunk: params.chunk }]);
      assert.equal(params.workspace, 'repair-datasheets');
      assert.ok(params.chunk === true, 'ingest must chunk');
      return { processed: [{ id: 'c1' }, { id: 'c2' }], droppedIndices: [] };
    },
    ragSearch: async (params) => {
      calls.push(['ragSearch', { workspace: params.workspace, query: params.query, topK: params.topK }]);
      assert.equal(params.workspace, 'repair-datasheets');
      if (emptyRag) return [];
      return [{ text: '2N2222 VCEO 40 V excerpt', score: 0.91, content: '2N2222 VCEO 40 V excerpt' }];
    },
    ragListWorkspaces: async () => {
      calls.push(['ragListWorkspaces', {}]);
      return [];
    },
    completion: ({ modelId, history, stream }) => {
      calls.push(['completion', { modelId, turns: history.length, stream, lastUser: history.at(-1)?.content }]);
      assert.ok(Array.isArray(history) && history.length > 0, 'completion needs history');
      const contentText = completionQueue.length ? completionQueue.shift() : 'mock reply';
      return { final: Promise.resolve({ contentText }) };
    },
    textToSpeech: ({ modelId, text, stream }) => {
      calls.push(['textToSpeech', { modelId, chars: String(text).length, stream }]);
      assert.ok(String(text).length > 0, 'tts needs text');
      assert.ok(!String(text).includes('#'), 'tts text must be stripped of markdown');
      return {
        buffer: Promise.resolve([0, 1000, -1000, 2000, -2000, 500]),
        done: Promise.resolve(true),
      };
    },
  };
}

before(() => {
  setSdk(mockSdk());
});

after(async () => {
  await unloadAll().catch(() => {});
});

describe('qvac wiring', () => {
  it('loads OCR via OCR_LATIN.src + ggmlOcr modelType (per SDK ocr.d.ts)', async () => {
    await ocrImage('/tmp/fake-component.png');
    const [name, opts] = calls.find(([n]) => n === 'loadModel');
    assert.equal(name, 'loadModel');
    assert.deepEqual(opts.modelSrc, OCR_LATIN.src);
    assert.equal(opts.modelType, MODEL_TYPES.ggmlOcr);
  });

  it('loads embed/llm/tts via bare registry descriptors', async () => {
    await ingestDatasheets(['doc one']);
    await diagnose('2N2222');
    const srcs = calls.filter(([n]) => n === 'loadModel').map(([, o]) => o.modelSrc);
    assert.ok(srcs.includes(EMBEDDINGGEMMA_300M_Q4_0), 'embed descriptor used');
    assert.ok(srcs.includes(QWEN3_1_7B_INST_Q4), 'llm descriptor used');
  });

  it('ocrImage returns cleaned blocks with confidence', async () => {
    const { blocks, text, avgConfidence } = await ocrImage('/tmp/x.png');
    assert.equal(blocks.length, 2);
    assert.equal(text, '2N2222\nTO-92');
    assert.ok(avgConfidence > 0.6 && avgConfidence < 0.7);
  });

  it('searchDatasheets normalizes rag results', async () => {
    const chunks = await searchDatasheets('2N2222', 4);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /VCEO/);
    assert.equal(chunks[0].score, 0.91);
  });

  it('diagnose parses the sectioned card', async () => {
    completionQueue = [DIAGNOSIS_TEXT];
    const { card, noDocs } = await diagnose('2N2222');
    assert.equal(noDocs, false);
    assert.match(card.identification, /2N2222/);
    assert.match(card.safety, /Unplug mains/);
    assert.match(card.sources, /\[1\]/);
  });

  it('diagnose flags noDocs when the library is empty', async () => {
    emptyRag = true;
    completionQueue = ['## IDENTIFICATION\nUnknown part, no datasheet found.'];
    try {
      const { card, noDocs } = await diagnose('ZZZ999');
      assert.equal(noDocs, true);
      assert.equal(card.noDocs, true);
    } finally {
      emptyRag = false;
    }
  });

  it('chatReply sanitizes model output', async () => {
    completionQueue = ['Use a 1W part. <think>hmm</think>'];
    const reply = await chatReply({ markings: '220', sources: [], history: [] }, 'wattage?');
    assert.doesNotMatch(reply, /<think>/);
    assert.match(reply, /1W/);
  });

  it('synthesize returns a valid WAV buffer at 44100 Hz', async () => {
    const wav = await synthesize('Hello bench.');
    assert.ok(Buffer.isBuffer(wav));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
  });

  it('tts model loads with the supertonic engine config', async () => {
    await synthesize('x');
    const ttsLoad = calls
      .filter(([n]) => n === 'loadModel')
      .find(([, o]) => o.modelSrc === TTS_EN_SUPERTONIC_Q4_0);
    assert.ok(ttsLoad, 'tts loadModel called');
    assert.equal(ttsLoad[1].modelConfig.ttsEngine, 'supertonic');
  });
});

describe('HTTP API', () => {
  let base;
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  before(
    () =>
      new Promise((resolve) => {
        server.listen(0, () => {
          base = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      })
  );

  after(() => new Promise((resolve) => server.close(resolve)));

  it('serves the UI', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Repair Co-Pilot/);
    assert.match(html, /photoInput/);
  });

  it('POST /api/photo rejects non-images', async () => {
    const res = await fetch(base + '/api/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/photo returns OCR blocks', async () => {
    const res = await fetch(base + '/api/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: PNG_1PX }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.text, '2N2222\nTO-92');
    assert.equal(data.blocks.length, 2);
    assert.ok(Array.isArray(data.warnings));
  });

  it('POST /api/diagnose returns the card', async () => {
    completionQueue = [DIAGNOSIS_TEXT];
    const res = await fetch(base + '/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markings: '2N2222' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.card.identification, /2N2222/);
    assert.equal(data.workspace, 'repair-datasheets');
  });

  it('POST /api/diagnose rejects empty markings', async () => {
    const res = await fetch(base + '/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markings: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/chat answers grounded in context', async () => {
    completionQueue = ['Use a 1 W metal-oxide part.'];
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markings: '220', sources: [], history: [], question: 'wattage?' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.reply, /1 W/);
    const lastCompletion = [...calls].reverse().find(([n]) => n === 'completion');
    assert.match(String(lastCompletion[1].lastUser), /wattage/);
  });

  it('POST /api/speak returns WAV audio', async () => {
    const res = await fetch(base + '/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello bench.' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /audio\/wav/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  });

  it('POST /api/library ingests pasted datasheets', async () => {
    const res = await fetch(base + '/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'test.txt', text: 'SOME PART specs here' }] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.docs, 1);
  });
});
