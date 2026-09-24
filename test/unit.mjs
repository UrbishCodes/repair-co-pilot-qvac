// Unit tests: pure logic only (no SDK, no network).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinBlocks,
  avgConfidence,
  flagSuspicious,
  parseSections,
  sectionLines,
  cardSpeechText,
} from '../src/markings.mjs';
import { sanitize, stripForSpeech, buildDiagnosisPrompt, buildChatHistory } from '../src/prompts.mjs';

describe('joinBlocks', () => {
  it('joins block texts with newlines, skipping empties', () => {
    const out = joinBlocks([
      { text: '2N2222', confidence: 0.9 },
      { text: '  ', confidence: 0.5 },
      { text: 'TO-92', confidence: null },
    ]);
    assert.equal(out, '2N2222\nTO-92');
  });
  it('handles non-array input', () => {
    assert.equal(joinBlocks(null), '');
  });
});

describe('avgConfidence', () => {
  it('averages non-null confidences', () => {
    assert.equal(avgConfidence([{ confidence: 0.8 }, { confidence: 0.6 }, { confidence: null }]), 0.7);
  });
  it('returns null when no confidences exist', () => {
    assert.equal(avgConfidence([{ confidence: null }]), null);
    assert.equal(avgConfidence([]), null);
  });
});

describe('flagSuspicious', () => {
  it('flags part numbers with commonly confused chars', () => {
    const w = flagSuspicious('2N2222\nLM7805');
    assert.equal(w.length, 2);
    assert.match(w[0], /2\/Z/);
    assert.match(w[1], /0\/O/);
  });
  it('ignores plain words and short codes', () => {
    assert.deepEqual(flagSuspicious('DIODE\nAB'), []);
  });
  it('ignores digits-only lines', () => {
    assert.deepEqual(flagSuspicious('220'), []);
  });
});

describe('parseSections', () => {
  const raw = `## IDENTIFICATION
2N2222 NPN transistor
## KEY SPECS
- VCEO 40 V [1]
## LIKELY FAILURE
Shorted C-E.
## REPLACEMENT
2N2222A
## REPAIR STEPS
1. Desolder.
2. Solder new part.
## SAFETY FIRST
Unplug mains.
## SOURCES
[1]`;

  it('parses all seven sections', () => {
    const c = parseSections(raw);
    assert.match(c.identification, /2N2222/);
    assert.match(c.specs, /VCEO/);
    assert.match(c.failure, /Shorted/);
    assert.match(c.replacement, /2N2222A/);
    assert.match(c.steps, /Desolder/);
    assert.match(c.safety, /Unplug/);
    assert.match(c.sources, /\[1\]/);
  });

  it('tolerates missing sections', () => {
    const c = parseSections('## IDENTIFICATION\nSomething\n## REPLACEMENT\nX');
    assert.match(c.identification, /Something/);
    assert.equal(c.specs, '');
    assert.match(c.replacement, /X/);
  });

  it('puts unparseable output in notes', () => {
    const c = parseSections('just some free text');
    assert.equal(c.identification, '');
    assert.match(c.notes, /free text/);
  });
});

describe('sectionLines', () => {
  it('strips bullets and numbering', () => {
    assert.deepEqual(sectionLines('- a\n* b\n1. c\n2) d'), ['a', 'b', 'c', 'd']);
  });
});

describe('cardSpeechText', () => {
  it('joins non-empty sections with labels', () => {
    const t = cardSpeechText({ identification: 'X', specs: '', failure: 'Y' });
    assert.match(t, /Identification\. X/);
    assert.match(t, /Likely failure\. Y/);
    assert.doesNotMatch(t, /Key specs/);
  });
});

describe('sanitize', () => {
  it('removes closed think blocks', () => {
    const out = sanitize('Hello <think>secret reasoning</think> world');
    assert.doesNotMatch(out, /secret reasoning/);
    assert.match(out, /Hello/);
    assert.match(out, /world/);
  });
  it('removes unclosed trailing think blocks', () => {
    assert.equal(sanitize('Answer <think>hmm let me think'), 'Answer');
  });
  it('collapses excess blank lines', () => {
    assert.equal(sanitize('a\n\n\n\nb'), 'a\n\nb');
  });
});

describe('stripForSpeech', () => {
  it('drops headers, bullets, and markup', () => {
    const out = stripForSpeech('## IDENTIFICATION\n- **2N2222** NPN\n1. Desolder it.');
    assert.doesNotMatch(out, /#/);
    assert.doesNotMatch(out, /\*/);
    assert.match(out, /2N2222 NPN/);
    assert.match(out, /Desolder it/);
  });
  it('reads source refs aloud', () => {
    assert.match(stripForSpeech('VCEO 40 V [1]'), /source 1/);
  });
});

describe('prompt builders', () => {
  it('diagnosis prompt carries markings, chunks, and all section headers', () => {
    const h = buildDiagnosisPrompt('2N2222', [{ text: 'chunk one' }], false);
    assert.equal(h.length, 1);
    assert.match(h[0].content, /2N2222/);
    assert.match(h[0].content, /chunk one/);
    assert.match(h[0].content, /## SAFETY FIRST/);
    assert.match(h[0].content, /\/no_think/);
  });
  it('diagnosis prompt states no-datasheet fallback plainly', () => {
    const h = buildDiagnosisPrompt('XYZ123', [], true);
    assert.match(h[0].content, /no datasheet was found/i);
  });
  it('chat history keeps system context + prior turns + question', () => {
    const h = buildChatHistory(
      { markings: '7805', sources: ['s1'], history: [{ role: 'user', content: 'q1' }] },
      'wattage?'
    );
    assert.equal(h[0].role, 'system');
    assert.match(h[0].content, /7805/);
    assert.equal(h[1].content, 'q1');
    assert.match(h[2].content, /wattage\?/);
  });
});
