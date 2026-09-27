import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS, buildTransport, missingRequired, modelPatternFor, pickSeat, presetById, slugify } from './agentPresets';

describe('pickSeat', () => {
  it('uses the bare manifest id for the first agent of a kind', () => {
    expect(pickSeat('claude-code', 'Claude', [])).toEqual({ seatId: 'claude-code' });
  });

  it('adds a unique instance id for later ones', () => {
    const existing = [
      { id: 'ollama', status: 'VERIFIED' },
      { id: 'ollama#llama', status: 'VERIFIED' },
    ];
    expect(pickSeat('ollama', 'Llama', existing)).toEqual({ seatId: 'ollama#llama-2', instanceId: 'llama-2' });
  });

  it('reuses a FAILED seat so retrying does not pile up seats', () => {
    expect(pickSeat('codex', 'ChatGPT', [{ id: 'codex', status: 'FAILED' }])).toEqual({ seatId: 'codex' });
  });

  it('keeps instance ids within the 16-char slug rule', () => {
    const { instanceId } = pickSeat('ollama', 'A very long agent name indeed', [{ id: 'ollama', status: 'VERIFIED' }]);
    expect(instanceId).toMatch(/^[a-z0-9-]{1,16}$/);
  });
});

describe('slugify', () => {
  it('lowercases and dashes', () => {
    expect(slugify('GPT 4o (work)')).toBe('gpt-4o-work');
  });
});

describe('buildTransport', () => {
  it('omits blank fields and derives a model pattern for model APIs', () => {
    const preset = presetById('model-api')!;
    expect(buildTransport(preset, { endpoint: 'http://x/v1', model: 'gpt-4o-mini', apiKey: '  ' })).toEqual({
      endpoint: 'http://x/v1',
      model: 'gpt-4o-mini',
      modelPattern: '^gpt-4o-mini',
    });
  });

  it('flags a missing required field', () => {
    expect(missingRequired(presetById('model-api')!, { endpoint: 'http://x/v1' })?.key).toBe('model');
  });
});

describe('modelPatternFor', () => {
  it('escapes regex characters so the pattern matches literally', () => {
    const re = new RegExp(modelPatternFor('qwen3:8b.q4'), 'i');
    expect(re.test('qwen3:8b.q4')).toBe(true);
    expect(re.test('qwen3:8bxq4')).toBe(false);
  });
});

describe('AGENT_PRESETS', () => {
  it('has unique ids and the headline agents first', () => {
    const ids = AGENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 5)).toEqual(['chatgpt', 'claude', 'grok', 'cursor', 'hermes']);
  });
});
