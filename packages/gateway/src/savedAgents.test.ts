import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSavedAgents, removeSavedAgent, saveSavedAgents, upsertSavedAgent, type SavedAgent } from './savedAgents.js';

function entry(seatId: string, model = 'm'): SavedAgent {
  const [manifestId, instanceId] = seatId.split('#');
  return { seatId, manifestId, instanceId, config: { transport: { model } }, savedAt: 1 };
}

describe('savedAgents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saved-agents-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty list when nothing has been saved', () => {
    expect(loadSavedAgents(dir)).toEqual([]);
  });

  it('round-trips through disk', () => {
    const list = [entry('claude-code'), entry('ollama#local')];
    saveSavedAgents(dir, list);
    expect(loadSavedAgents(dir)).toEqual(list);
  });

  it('treats a corrupt file as empty instead of throwing', () => {
    writeFileSync(join(dir, 'saved-agents.json'), 'not json {{{');
    expect(loadSavedAgents(dir)).toEqual([]);
  });

  it('drops malformed entries', () => {
    writeFileSync(join(dir, 'saved-agents.json'), JSON.stringify({ agents: [{ seatId: 'x' }, entry('codex')] }));
    expect(loadSavedAgents(dir).map((s) => s.seatId)).toEqual(['codex']);
  });

  it('upsert replaces in place and appends new seats', () => {
    let list = upsertSavedAgent([], entry('a'));
    list = upsertSavedAgent(list, entry('b'));
    list = upsertSavedAgent(list, entry('a', 'new'));
    expect(list.map((s) => s.seatId)).toEqual(['a', 'b']);
    expect(list[0].config.transport.model).toBe('new');
  });

  it('remove drops only the named seat', () => {
    expect(removeSavedAgent([entry('a'), entry('b')], 'a').map((s) => s.seatId)).toEqual(['b']);
  });
});
