// Repair Co-Pilot server: local web UI + JSON API over the QVAC SDK.
// All AI runs on-device. Run: npm start, then open http://localhost:8091
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  status,
  ensureLoaded,
  ocrImage,
  diagnose,
  chatReply,
  synthesize,
  ingestDatasheets,
  libraryHasDocs,
  unloadAll,
  WORKSPACE,
} from './qvac.mjs';
import { joinBlocks, avgConfidence, flagSuspicious } from './markings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pubDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const seedMarker = path.join(dataDir, '.seeded');

const PORT = Number(process.env.PORT || 8091);
const BODY_LIMIT = 15 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPhotoBuffer(buf) {
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  )
    return 'png';
  return null;
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(
    String(dataUrl || '').slice(0, 32 + BODY_LIMIT)
  );
  if (!m) return null;
  try {
    return Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
}

/** Seed the bundled sample datasheets on first use. */
async function ensureLibrary() {
  try {
    if (fs.existsSync(seedMarker) && (await libraryHasDocs())) return { seeded: true };
  } catch {
    // fall through to seeding
  }
  const dir = path.join(root, 'datasheets');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    files = [];
  }
  if (files.length === 0) return { seeded: false, docs: 0 };
  const docs = files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return `SOURCE: ${f}\n${text}`;
  });
  const { processed } = await ingestDatasheets(docs);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(seedMarker, new Date().toISOString());
  return { seeded: true, docs: files.length, chunks: processed };
}

async function handlePhoto(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Could not parse the request.' });
    return;
  }
  const buf = dataUrlToBuffer(payload?.image);
  if (!buf) {
    json(res, 400, { error: 'That is not a photo upload. Please take or pick a photo.' });
    return;
  }
  const kind = isPhotoBuffer(buf);
  if (!kind) {
    json(res, 400, {
      error: 'That file is not a JPEG or PNG photo. Please pick a component photo.',
    });
    return;
  }
  const tmp = path.join(
    os.tmpdir(),
    `repair-copilot-${Date.now()}-${Math.random().toString(36).slice(2)}.${kind === 'png' ? 'png' : 'jpg'}`
  );
  console.log(`[server] POST /api/photo — ${(buf.length / 1024).toFixed(0)} KB photo received`);
  try {
    await fs.promises.writeFile(tmp, buf);
    const started = Date.now();
    const { blocks } = await ocrImage(tmp);
    const text = joinBlocks(blocks);
    console.log(
      `[server] OCR done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${blocks.length} blocks`
    );
    json(res, 200, {
      blocks,
      text,
      avgConfidence: avgConfidence(blocks),
      warnings: flagSuspicious(text),
      noText: text.trim().length === 0,
    });
  } catch (err) {
    console.error('[server] OCR failed:', err?.message || err);
    json(res, 500, { error: 'Could not read the photo. Try a closer, straighter shot with good light.' });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

async function handleDiagnose(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Could not parse the request.' });
    return;
  }
  const markings = String(payload?.markings || '').trim();
  if (!markings) {
    json(res, 400, { error: 'No markings to diagnose. Confirm the marking text first.' });
    return;
  }
  try {
    const lib = await ensureLibrary();
    console.log('[server] library:', JSON.stringify(lib));
    const started = Date.now();
    const { card, noDocs } = await diagnose(markings);
    console.log(`[server] diagnosis done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    json(res, 200, { card, noDocs, workspace: WORKSPACE });
  } catch (err) {
    console.error('[server] diagnose failed:', err?.message || err);
    json(res, 500, { error: 'Diagnosis failed. The models may still be loading — try again in a minute.' });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Could not parse the request.' });
    return;
  }
  const question = String(payload?.question || '').trim();
  if (!question) {
    json(res, 400, { error: 'Empty question.' });
    return;
  }
  try {
    const reply = await chatReply(
      {
        markings: String(payload?.markings || ''),
        sources: Array.isArray(payload?.sources) ? payload.sources : [],
        history: Array.isArray(payload?.history) ? payload.history : [],
      },
      question
    );
    json(res, 200, { reply });
  } catch (err) {
    console.error('[server] chat failed:', err?.message || err);
    json(res, 500, { error: 'Could not answer. Try again.' });
  }
}

async function handleSpeak(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Could not parse the request.' });
    return;
  }
  const text = String(payload?.text || '').trim();
  if (!text) {
    json(res, 400, { error: 'Nothing to speak.' });
    return;
  }
  try {
    const wav = await synthesize(text);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': wav.length,
    });
    res.end(wav);
  } catch (err) {
    console.error('[server] TTS failed:', err?.message || err);
    json(res, 500, { error: 'Speech failed. The voice model may still be loading.' });
  }
}

async function handleLibrary(req, res) {
  if (req.method === 'GET') {
    try {
      const has = await libraryHasDocs().catch(() => false);
      json(res, 200, { workspace: WORKSPACE, hasDocs: has });
    } catch (err) {
      json(res, 500, { error: String(err?.message || err) });
    }
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Could not parse the request.' });
    return;
  }
  const files = Array.isArray(payload?.files) ? payload.files : [];
  const docs = files
    .map((f) => {
      const name = String(f?.name || 'pasted').replace(/[^\w.\-]+/g, '_');
      const text = String(f?.text || '').trim();
      return text ? `SOURCE: ${name}\n${text}` : '';
    })
    .filter(Boolean);
  if (docs.length === 0) {
    json(res, 400, { error: 'No datasheet text provided.' });
    return;
  }
  try {
    await ensureLoaded('embed');
    const { processed, dropped } = await ingestDatasheets(docs);
    json(res, 200, { ok: true, docs: docs.length, chunks: processed, dropped });
  } catch (err) {
    console.error('[server] ingest failed:', err?.message || err);
    json(res, 500, { error: 'Could not ingest the datasheets.' });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (rel.includes('..') || rel.includes('\0')) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const file = path.join(pubDir, rel);
  fs.readFile(file, (err, data) => {
    if (err) {
      json(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/status') {
    json(res, 200, { ...status, workspace: WORKSPACE });
    return;
  }
  if (method === 'POST' && pathname === '/api/photo') {
    handlePhoto(req, res);
    return;
  }
  if (method === 'POST' && pathname === '/api/diagnose') {
    handleDiagnose(req, res);
    return;
  }
  if (method === 'POST' && pathname === '/api/chat') {
    handleChat(req, res);
    return;
  }
  if (method === 'POST' && pathname === '/api/speak') {
    handleSpeak(req, res);
    return;
  }
  if ((method === 'GET' || method === 'POST') && pathname === '/api/library') {
    handleLibrary(req, res);
    return;
  }
  if (method === 'POST' && pathname === '/api/unload') {
    unloadAll()
      .then(() => json(res, 200, { ok: true }))
      .catch((err) => json(res, 500, { error: String(err?.message || err) }));
    return;
  }
  if (method === 'GET') {
    serveStatic(req, res);
    return;
  }
  json(res, 404, { error: 'not found' });
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down…');
  unloadAll().finally(() => process.exit(0));
});

// Import-safe for tests: only listen when run directly (`npm start`).
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  server.listen(PORT, () => {
    console.log(`[server] Repair Co-Pilot on http://localhost:${PORT}`);
    console.log('[server] models pre-download at install time; they load into RAM on first use');
  });
}

export { server, PORT };
