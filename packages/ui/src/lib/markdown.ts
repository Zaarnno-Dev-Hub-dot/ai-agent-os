import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import { shortcodesToEmoji } from './emoji';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);

const marked = new Marked({
  gfm: true,
  breaks: true,
});

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      const langLabel = language ?? 'text';
      return `<pre class="md-code"><div class="md-code-lang">${langLabel}</div><code class="hljs">${highlighted}</code></pre>`;
    },
  },
});

/** marked.parse + emoji-shortcode expansion, shared by both render modes below — everything after this is DOMPurify config, which is where the two modes diverge. */
function toRawHtml(content: string): string {
  const rawHtml = marked.parse(content, { async: false }) as string;
  return expandShortcodesOutsideCode(rawHtml);
}

/**
 * Render CommonMark (+ GFM tables, fenced code, syntax highlighting) to sanitized HTML.
 * Emoji shortcodes (:fire:) are expanded before markdown parsing so they survive
 * inside paragraphs/lists but not inside fenced code blocks (marked tokenizes code first,
 * so we run shortcode expansion only on the final HTML text nodes via a safe substitution
 * pass restricted to outside <code> — simplest safe approach: expand pre-parse, but skip
 * fenced code content by relying on marked's fence extraction already having happened
 * via a lexer pre-pass is overkill for Phase 2; instead we expand shortcodes only inside
 * the rendered HTML's text, guarded by not touching <pre>/<code> blocks.
 */
export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(toRawHtml(content), {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'img', 'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'src', 'alt', 'target', 'rel'],
  });
}

/**
 * Dossier-mode render hardening.
 * A dossier is a peer-authored markdown file with no image-hosting mechanism
 * of its own — any `img` inside one is necessarily an EXTERNAL url, and
 * `img src` is a classic render-time read-receipt beacon (an agent could
 * learn exactly when — and via Referer/UA, from where — its own dossier
 * entry gets opened). Unlike chat's renderMarkdown, `img` is dropped
 * entirely from the allowed-tag list here — not sanitized down to a safe
 * attribute set, REMOVED — and every surviving `<a>` gets
 * rel="noopener noreferrer" FORCED via a DOMPurify hook, regardless of what
 * the source markdown/embedded raw HTML wrote (or omitted), closing the
 * reverse-tabnabbing gap a bare target="_blank" would otherwise leave.
 *
 * The hook is added immediately before sanitize() and removed in a finally
 * block right after — DOMPurify hooks are process-global/static on the
 * module, so leaving it registered would silently make every FUTURE
 * renderMarkdown() call (chat rendering) force rel too. Safe under this
 * app's single-threaded synchronous call pattern (no other sanitize() call
 * can interleave between add and remove).
 */
export function renderDossierMarkdown(content: string): string {
  const forceRel = (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  };
  DOMPurify.addHook('afterSanitizeAttributes', forceRel);
  try {
    return DOMPurify.sanitize(toRawHtml(content), {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div',
        // NOTE: no 'img' — see doc comment above.
      ],
      ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** Expand :shortcode: tokens in HTML text nodes, skipping inside <pre>...</pre> blocks. */
function expandShortcodesOutsideCode(html: string): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/g);
  return parts
    .map((part, i) => (i % 2 === 0 ? shortcodesToEmoji(part) : part))
    .join('');
}
