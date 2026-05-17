// Tiny markdown subset for the TranscriptModal. Renders just what claude
// actually emits in chat: paragraphs, headers, lists, blockquotes, inline
// code, bold/italic, links, and ```fenced``` code blocks. NO new deps.
//
// Security: every chunk is HTML-escaped BEFORE markdown markers are
// processed, so user/assistant text can never break out of the render.
// Code blocks keep their content escaped and are wrapped in <pre><code>;
// inline tokens are then applied to the surrounding text only.

const escape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Split on ``` fences so backticks inside a code block don't get treated as
// inline code (and vice versa). Returns alternating text/code segments —
// odd indices are code blocks (regardless of language tag).
function splitOnFences(src: string): Array<{ kind: "text" | "code"; lang?: string; body: string }> {
  const out: Array<{ kind: "text" | "code"; lang?: string; body: string }> = [];
  const parts = src.split(/```(\w*)\n?([\s\S]*?)```/g);
  // Pattern produces: [text, lang1, code1, text, lang2, code2, ..., text]
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      if (parts[i]) out.push({ kind: "text", body: parts[i] });
    } else if (i % 3 === 1) {
      // lang tag; consumed alongside the next iteration's code body
    } else {
      out.push({ kind: "code", lang: parts[i - 1], body: parts[i] });
    }
  }
  return out;
}

// URL-scheme allowlist for the link transform. Anything else (javascript:,
// data:, vbscript:, file:) gets the href stripped and renders as plain
// text — safer than rendering an active dangerous link. The threat is low
// (content originates from the user's own claude sessions), but defense
// in depth costs ~3 lines and avoids one social-engineering vector.
function isSafeUrl(url: string): boolean {
  return /^(?:https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/.test(url);
}

// Inline transforms run on already-escaped text. Order matters: process
// links BEFORE inline code so a [label](url) inside backticks stays as
// literal text; then code so * and _ inside it aren't styled; then bold
// before italic so **double** doesn't get partially consumed by single-*.
function inlineFormat(escaped: string): string {
  return escaped
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label: string, url: string) =>
        isSafeUrl(url)
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label,
    )
    .replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

// Line-level pass: groups consecutive list items into <ul>, turns headers
// into <h*>, blockquotes into <blockquote>, and the rest into <p>. A blank
// line ends the current block. Inline transforms run per line.
function renderTextBlock(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let listOpen = false;
  let quoteOpen = false;
  let paraBuf: string[] = [];

  const flushParagraph = () => {
    if (paraBuf.length === 0) return;
    const html = paraBuf.map((l) => inlineFormat(escape(l))).join("<br>");
    out.push(`<p>${html}</p>`);
    paraBuf = [];
  };
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  const closeQuote = () => {
    if (quoteOpen) {
      out.push("</blockquote>");
      quoteOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      closeQuote();
      continue;
    }
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headerMatch) {
      flushParagraph();
      closeList();
      closeQuote();
      const level = headerMatch[1].length;
      const content = inlineFormat(escape(headerMatch[2]));
      out.push(`<h${level}>${content}</h${level}>`);
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      closeQuote();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inlineFormat(escape(listMatch[1]))}</li>`);
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      closeList();
      if (!quoteOpen) {
        out.push("<blockquote>");
        quoteOpen = true;
      }
      out.push(`<p>${inlineFormat(escape(quoteMatch[1]))}</p>`);
      continue;
    }
    closeList();
    closeQuote();
    paraBuf.push(line);
  }
  flushParagraph();
  closeList();
  closeQuote();
  return out.join("");
}

export function renderMarkdownMini(input: string): string {
  if (!input) return "";
  return splitOnFences(input)
    .map((seg) => {
      if (seg.kind === "code") {
        const langClass = seg.lang ? ` class="lang-${escape(seg.lang)}"` : "";
        return `<pre><code${langClass}>${escape(seg.body)}</code></pre>`;
      }
      return renderTextBlock(seg.body);
    })
    .join("");
}
