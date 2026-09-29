import { AgentSummary } from '@agent-os/shared';

/** Extract @mentions from message content that match known agent ids or 'everyone'. */
export function extractMentions(content: string, agents: AgentSummary[]): string[] {
  const ids = new Set(agents.map((a) => a.id));
  ids.add('everyone');
  ids.add('all');
  const found = new Set<string>();
  // '#' is included so multi-instance seat ids parse as a single mention token, not two.
  const pattern = /@([a-z0-9_#-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    let candidate = match[1].toLowerCase();
    if (candidate === 'all') candidate = 'everyone';
    if (ids.has(candidate)) found.add(candidate);
  }
  return Array.from(found);
}

/**
 * Highlight @mentions inside already-rendered (sanitized) HTML by wrapping matching
 * tokens in a span. Operates on the markdown output's text, so it must avoid touching
 * tag internals — the regex only matches "@word" sequences which never appear inside
 * attribute values we allow (href/src/class/alt/title), so a straightforward global
 * replace outside tags is safe enough for Phase 2's plain @name mentions.
 */
export function highlightMentionsHtml(html: string, knownIds: Set<string>): string {
  const parts = html.split(/(<[^>]+>)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // tag, leave untouched
      return part.replace(/@([a-z0-9_#-]+)/gi, (full, name: string) => {
        const lower = name.toLowerCase();
        if (!knownIds.has(lower) && lower !== 'everyone') return full;
        return `<span class="mention-tag">@${name}</span>`;
      });
    })
    .join('');
}
