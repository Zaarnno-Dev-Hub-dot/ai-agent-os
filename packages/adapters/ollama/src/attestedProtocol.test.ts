import { describe, expect, it } from 'vitest';
import {
  buildArithmeticProbe,
  buildStringTransformProbe,
  checkProbeAnswer,
  parseNonceEcho,
} from './attestedProtocol.js';

describe('parseNonceEcho', () => {
  const nonce = 'atn-abc123-xyz789';

  it('matches a clean structured echo', () => {
    const result = parseNonceEcho(`{"nonce":"${nonce}"}`, nonce);
    expect(result.matched).toBe(true);
    expect(result.parsedNonce).toBe(nonce);
  });

  it('matches through a markdown code fence', () => {
    const result = parseNonceEcho('```json\n{"nonce":"' + nonce + '"}\n```', nonce);
    expect(result.matched).toBe(true);
  });

  it('matches via regex fallback when surrounded by noise the JSON parser rejects', () => {
    const result = parseNonceEcho(`Sure! Here you go: {"nonce": "${nonce}"} — hope that helps!`, nonce);
    expect(result.matched).toBe(true);
  });

  it('does not match a wrong nonce value', () => {
    const result = parseNonceEcho(`{"nonce":"wrong-value"}`, nonce);
    expect(result.matched).toBe(false);
    expect(result.genericResponseSuspected).toBe(false);
  });

  it('flags long unstructured prose as a suspected generic/static response', () => {
    const prose =
      'I am a helpful AI assistant and I am happy to help you with your question today, thanks for asking!';
    const result = parseNonceEcho(prose, nonce);
    expect(result.matched).toBe(false);
    expect(result.genericResponseSuspected).toBe(true);
  });

  it('does not flag short non-matching text as generic prose (below threshold)', () => {
    const result = parseNonceEcho('nope', nonce);
    expect(result.matched).toBe(false);
    expect(result.genericResponseSuspected).toBe(false);
  });
});

describe('probe generators', () => {
  it('buildArithmeticProbe expected value is the real sum embedded in the question', () => {
    for (let i = 0; i < 25; i++) {
      const probe = buildArithmeticProbe();
      const nums = probe.question.match(/\d+/g)?.map(Number) ?? [];
      expect(nums).toHaveLength(2);
      expect(probe.expected).toBe(String(nums[0] + nums[1]));
    }
  });

  it('buildStringTransformProbe expected value is the uppercasing of the quoted word', () => {
    for (let i = 0; i < 25; i++) {
      const probe = buildStringTransformProbe();
      const m = probe.question.match(/"([a-z]+)"/);
      expect(m).not.toBeNull();
      const word = m![1];
      expect(probe.expected).toBe(word.toUpperCase());
    }
  });

  it('probes are randomized across calls (not the same question every time)', () => {
    const questions = new Set(Array.from({ length: 20 }, () => buildArithmeticProbe().question));
    expect(questions.size).toBeGreaterThan(1);
  });
});

describe('checkProbeAnswer', () => {
  it('accepts a clean arithmetic answer', () => {
    expect(checkProbeAnswer('arithmetic', '115', '115')).toBe(true);
  });

  it('extracts the integer from arithmetic answers with stray filler', () => {
    expect(checkProbeAnswer('arithmetic', 'The answer is 115.', '115')).toBe(true);
  });

  it('rejects a wrong arithmetic answer', () => {
    expect(checkProbeAnswer('arithmetic', '116', '115')).toBe(false);
  });

  it('accepts a clean string-transform answer regardless of case', () => {
    expect(checkProbeAnswer('string-transform', 'lighthouse', 'LIGHTHOUSE')).toBe(true);
  });

  it('rejects a wrong string-transform answer', () => {
    expect(checkProbeAnswer('string-transform', 'turbine', 'LIGHTHOUSE')).toBe(false);
  });

  it('rejects a static/canned response that ignores the question entirely', () => {
    // Same failure mode a mock endpoint would produce: fixed text regardless
    // of the (randomized) expected answer.
    expect(checkProbeAnswer('arithmetic', 'I am a helpful assistant.', '115')).toBe(false);
    expect(checkProbeAnswer('string-transform', 'I am a helpful assistant.', 'LIGHTHOUSE')).toBe(false);
  });
});
