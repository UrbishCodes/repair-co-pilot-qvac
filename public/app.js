// Repair Co-Pilot frontend: photo -> confirm markings -> diagnosis -> chat,
// with hands-free TTS read-aloud (tap-to-stop) throughout.
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  photoDataUrl: null,
  markings: '',
  sources: [],
  chatHistory: [],
  speaking: null, // current Audio element, if any
};

// ---------- step navigation ----------
function goStep(name) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $('step-' + name).classList.add('active');
  const order = ['photo', 'confirm', 'diagnose', 'chat'];
  const idx = order.indexOf(name);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setStatus(id, text, mode) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'status' + (mode ? ' ' + mode : '');
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- TTS ----------
function stopSpeaking() {
  if (state.speaking) {
    try { state.speaking.pause(); } catch {}
    const url = state.speaking.dataset.url;
    if (url) URL.revokeObjectURL(url);
    state.speaking = null;
  }
  $('stopSpeakBtn').hidden = true;
  document.querySelectorAll('.mini.stop').forEach((b) => {
    b.textContent = '🔊 Read';
    b.classList.remove('stop');
  });
}

async function speak(text, btn) {
  stopSpeaking();
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('speak failed');
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.dataset.url = url;
    state.speaking = audio;
    $('stopSpeakBtn').hidden = false;
    audio.onended = () => stopSpeaking();
    audio.onerror = () => stopSpeaking();
    await audio.play();
  } catch (err) {
    console.error(err);
    alert('Speech failed — the voice model may still be loading.');
    stopSpeaking();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ---------- STEP 1: photo ----------
$('photoInput').addEventListener('change', () => {
  const file = $('photoInput').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.photoDataUrl = reader.result;
    $('photoImg').src = state.photoDataUrl;
    $('photoPreview').hidden = false;
    $('readBtn').hidden = false;
    setStatus('photoStatus', '');
  };
  reader.readAsDataURL(file);
  // Reset so picking the same file twice still fires change.
  $('photoInput').value = '';
});

$('readBtn').addEventListener('click', async () => {
  if (!state.photoDataUrl) return;
  setStatus('photoStatus', 'Reading the markings…', 'busy');
  $('readBtn').disabled = true;
  try {
    const res = await fetch('/api/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: state.photoDataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'OCR failed');
    if (data.noText) {
      setStatus('photoStatus', 'No text found — try a closer, brighter shot.', 'error');
      return;
    }
    renderBlocks(data.blocks || []);
    $('markingsEdit').value = data.text || '';
    const warnBox = $('ocrWarnings');
    if (data.warnings && data.warnings.length) {
      warnBox.innerHTML = data.warnings.map((w) => `<div>⚠️ ${esc(w)}</div>`).join('');
      warnBox.hidden = false;
    } else {
      warnBox.hidden = true;
    }
    state.markings = data.text || '';
    goStep('confirm');
  } catch (err) {
    setStatus('photoStatus', err.message, 'error');
  } finally {
    $('readBtn').disabled = false;
  }
});

function renderBlocks(blocks) {
  const box = $('blockList');
  box.innerHTML = '';
  for (const b of blocks) {
    const conf = typeof b.confidence === 'number' ? b.confidence : null;
    const low = conf !== null && conf < 0.6;
    const div = document.createElement('div');
    div.className = 'block' + (low ? ' low' : '');
    div.innerHTML =
      `<span class="t">${esc(b.text)}</span>` +
      `<span class="c">${conf !== null ? Math.round(conf * 100) + '%' : 'n/a'}</span>`;
    box.appendChild(div);
  }
}

// ---------- STEP 2: confirm ----------
$('backToPhoto').addEventListener('click', () => goStep('photo'));

$('diagnoseBtn').addEventListener('click', async () => {
  const markings = $('markingsEdit').value.trim();
  if (!markings) {
    setStatus('confirmStatus', 'Type or confirm the marking text first.', 'error');
    return;
  }
  state.markings = markings;
  state.chatHistory = [];
  state.sources = [];
  setStatus('confirmStatus', 'Diagnosing — loading models on first run…', 'busy');
  $('diagnoseBtn').disabled = true;
  try {
    const res = await fetch('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markings }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Diagnosis failed');
    $('noDocsNote').hidden = !data.noDocs;
    renderCard(data.card || {});
    goStep('diagnose');
    setStatus('confirmStatus', '');
  } catch (err) {
    setStatus('confirmStatus', err.message, 'error');
  } finally {
    $('diagnoseBtn').disabled = false;
  }
});

function sectionHtml(title, body, cls) {
  if (!body || !String(body).trim()) return '';
  const lines = String(body).split('\n').filter((l) => l.trim());
  const items = lines.map((l) => `<li>${esc(l.replace(/^[-*•\d+.)\s]+/, ''))}</li>`).join('');
  return `<div class="card-section ${cls || ''}"><h3>${esc(title)}</h3><ul>${items}</ul></div>`;
}

function renderCard(card) {
  const el = $('card');
  el.innerHTML =
    sectionHtml('Identification', card.identification) +
    sectionHtml('Key specs', card.specs) +
    sectionHtml('Likely failure', card.failure) +
    sectionHtml('Replacement', card.replacement) +
    sectionHtml('Repair steps', card.steps) +
    sectionHtml('Safety first', card.safety, 'safety') +
    (card.sources ? `<div class="card-section"><h3>Sources</h3><p class="src">${esc(card.sources)}</p></div>` : '') +
    (card.notes ? `<div class="card-section"><h3>Notes</h3><p>${esc(card.notes)}</p></div>` : '');
  // Stash a plain-text version for the chat context + read-aloud.
  el.dataset.speech = [
    card.identification, card.specs, card.failure,
    card.replacement, card.steps, card.safety,
  ].filter(Boolean).join('\n');
}

// ---------- STEP 3: diagnosis ----------
$('speakCardBtn').addEventListener('click', (e) => {
  speak($('card').dataset.speech || 'No diagnosis to read.', e.target);
});
$('stopSpeakBtn').addEventListener('click', stopSpeaking);
$('toChatBtn').addEventListener('click', () => goStep('chat'));

// ---------- STEP 4: chat ----------
function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(body);
  if (role === 'ai') {
    const row = document.createElement('div');
    row.className = 'speak-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini';
    btn.textContent = '🔊 Read';
    btn.addEventListener('click', () => speak(text, btn));
    row.appendChild(btn);
    div.appendChild(row);
  }
  $('thread').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  addMsg('user', question);
  setStatus('chatStatus', 'Thinking…', 'busy');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markings: state.markings,
        sources: state.sources,
        history: state.chatHistory,
        question,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Chat failed');
    addMsg('ai', data.reply);
    state.chatHistory.push({ role: 'user', content: question });
    state.chatHistory.push({ role: 'assistant', content: data.reply });
    setStatus('chatStatus', '');
  } catch (err) {
    setStatus('chatStatus', err.message, 'error');
  }
});

// ---------- library drawer ----------
$('libraryBtn').addEventListener('click', async () => {
  $('drawer').hidden = false;
  setStatus('libStatus', 'Checking library…', 'busy');
  try {
    const res = await fetch('/api/library');
    const data = await res.json();
    setStatus('libStatus', data.hasDocs
      ? 'Library has datasheets. Add more any time — they stay on this device.'
      : 'Library is empty except the bundled samples (added on first diagnosis).');
  } catch {
    setStatus('libStatus', 'Could not reach the server.');
  }
});
$('libCloseBtn').addEventListener('click', () => { $('drawer').hidden = true; });

$('libAddBtn').addEventListener('click', async () => {
  const files = [];
  const pasted = $('libPaste').value.trim();
  if (pasted) {
    files.push({ name: $('libName').value.trim() || 'pasted-datasheet', text: pasted });
  }
  const picked = $('libFiles').files;
  for (const f of picked) {
    files.push({ name: f.name, text: await f.text() });
  }
  if (!files.length) {
    setStatus('libStatus', 'Pick .txt files or paste datasheet text first.', 'error');
    return;
  }
  setStatus('libStatus', `Ingesting ${files.length} datasheet(s)…`, 'busy');
  try {
    const res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ingest failed');
    setStatus('libStatus', `Done — ${data.docs} doc(s), ${data.chunks} chunks indexed.`);
    $('libPaste').value = '';
    $('libName').value = '';
    $('libFiles').value = '';
  } catch (err) {
    setStatus('libStatus', err.message, 'error');
  }
});
