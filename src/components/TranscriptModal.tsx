import {
  Component,
  createEffect,
  createResource,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { Accessor } from "solid-js";

import { readSessionTranscript } from "../lib/ipc";
import { renderMarkdownMini } from "../lib/markdown-mini";
import type { ContentBlock, TranscriptLine } from "../lib/types";

export interface TranscriptModalProps {
  open: Accessor<boolean>;
  cwd: string;
  sessionId: string;
  onClose: () => void;
  // Wakes the session and closes the modal in one motion. Wired up to the
  // existing resumeTab() in TerminalsView so it shares the suspend/resume
  // plumbing — no separate code path for "resume from modal".
  onResume: () => void;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Aggregate token counts across all assistant lines so the header can show
// total usage at a glance. Cache hits (cache_read_input_tokens) are usually
// the dominant share for long sessions — we surface them so the cost story
// makes sense ("90% of input tokens came from cache").
function aggregateUsage(lines: TranscriptLine[]) {
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  for (const l of lines) {
    if (l.type !== "assistant") continue;
    const u = l.message?.usage;
    if (!u) continue;
    inTok += u.input_tokens ?? 0;
    outTok += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
  }
  return { inTok, outTok, cacheRead };
}

function countTurns(lines: TranscriptLine[]): number {
  return lines.filter((l) => l.type === "user").length;
}

// Render one content block — text/thinking/tool_use/tool_result/image —
// inside a user or assistant message. Thinking blocks collapse by default
// (high noise, low value for review); tool_use shows tool name + a
// summary line, expanding reveals full input/output JSON. Switch on the
// discriminated `type` field so TS narrows each block to its specific
// shape — unknown types fall through to the default catch-all.
const ContentBlockRow: Component<{
  block: ContentBlock;
  role: "user" | "assistant";
}> = (props) => {
  const block = props.block;
  switch (block.type) {
    case "text": {
      const html =
        props.role === "assistant"
          ? renderMarkdownMini(block.text)
          : `<pre class="user-text">${escapeForUser(block.text)}</pre>`;
      return <div class="tm-text" innerHTML={html} />;
    }
    case "thinking": {
      const len = block.thinking.length;
      return (
        <details class="tm-thinking">
          <summary>
            <span class="tm-thinking-glyph">💭</span>
            <span>Thinking ({len.toLocaleString()} chars)</span>
          </summary>
          <pre class="tm-thinking-body">{block.thinking}</pre>
        </details>
      );
    }
    case "tool_use": {
      const summary = summariseToolInput(block.name, block.input);
      return (
        <details class="tm-tool-use">
          <summary>
            <span class="tm-tool-arrow">▶</span>
            <span class="tm-tool-name">{block.name}</span>
            <Show when={summary}>
              <span class="tm-tool-summary">{summary}</span>
            </Show>
          </summary>
          <pre class="tm-tool-body">
            {JSON.stringify(block.input ?? {}, null, 2)}
          </pre>
        </details>
      );
    }
    case "tool_result": {
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((c) => (c.type === "text" ? c.text : ""))
                .join("\n")
            : "";
      const firstLine = text.split("\n")[0]?.slice(0, 80) ?? "";
      return (
        <details class="tm-tool-result">
          <summary>
            <span class="tm-tool-arrow">▶</span>
            <span class="tm-tool-name">tool_result</span>
            <Show when={firstLine}>
              <span class="tm-tool-summary">{firstLine}</span>
            </Show>
          </summary>
          <pre class="tm-tool-body">{text || "(empty)"}</pre>
        </details>
      );
    }
    case "image": {
      if (block.source.type === "base64") {
        return (
          <img
            class="tm-image"
            src={`data:${block.source.media_type};base64,${block.source.data}`}
            alt="inline image"
            loading="lazy"
          />
        );
      }
      return null;
    }
    default:
      return null;
  }
};

// HTML-escape user-message text (we render it inside <pre> with no markdown,
// since user prompts are typed verbatim and we want to preserve indentation).
function escapeForUser(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Tool-specific one-line summary in the collapsed header. Falls back to "" so
// the header reads cleanly when we don't have a known shortcut.
function summariseToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (name === "Bash" && typeof i.command === "string") return i.command.slice(0, 100);
  if (name === "Read" && typeof i.file_path === "string") return i.file_path;
  if (name === "Edit" && typeof i.file_path === "string") return i.file_path;
  if (name === "Write" && typeof i.file_path === "string") return i.file_path;
  if (name === "Grep" && typeof i.pattern === "string") return i.pattern;
  if (name === "Glob" && typeof i.pattern === "string") return i.pattern;
  return "";
}

const LineRow: Component<{ line: TranscriptLine; idx: number }> = (props) => {
  const line = props.line;
  switch (line.type) {
    case "user": {
      const content = line.message?.content;
      const blocks: ContentBlock[] = Array.isArray(content)
        ? (content as ContentBlock[])
        : typeof content === "string"
          ? [{ type: "text", text: content }]
          : [];
      // Skip "fake" user messages that are only tool_results from the last
      // assistant turn — render those alongside the prior assistant block.
      const onlyToolResults =
        blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
      return (
        <div class={`tm-row tm-row-user ${onlyToolResults ? "is-tool-results" : ""}`}>
          <Show when={!onlyToolResults}>
            <div class="tm-role">user</div>
          </Show>
          <div class="tm-content">
            <For each={blocks}>{(b) => <ContentBlockRow block={b} role="user" />}</For>
          </div>
        </div>
      );
    }
    case "assistant": {
      const blocks = (line.message?.content ?? []) as ContentBlock[];
      const usage = line.message?.usage;
      return (
        <div class="tm-row tm-row-assistant">
          <div class="tm-role">
            assistant
            <Show when={usage}>
              <span class="tm-usage">
                {(usage?.input_tokens ?? 0).toLocaleString()} in /{" "}
                {(usage?.output_tokens ?? 0).toLocaleString()} out
              </span>
            </Show>
          </div>
          <div class="tm-content">
            <For each={blocks}>{(b) => <ContentBlockRow block={b} role="assistant" />}</For>
          </div>
        </div>
      );
    }
    case "system": {
      return (
        <div class="tm-row tm-row-system">
          <span class="tm-system-glyph">⚙</span>
          {line.level ?? "info"}: {line.subtype ?? ""}
          <Show when={line.error}>
            <span class="tm-system-error">{line.error}</span>
          </Show>
        </div>
      );
    }
    case "attachment": {
      return (
        <div class="tm-row tm-row-attachment">
          <span class="tm-attach-glyph">📎</span>
          {line.attachment?.name ?? "(attachment)"}{" "}
          <Show when={line.attachment?.size}>
            <span class="tm-attach-size">({formatBytes(line.attachment?.size)})</span>
          </Show>
        </div>
      );
    }
    case "ai-title":
      return null; // Header shows this; don't repeat inline.
    case "file-history-snapshot":
    case "permission-mode":
    case "last-prompt":
      return null; // Internal metadata; not useful to a human reader.
    default:
      return null;
  }
};

export const TranscriptModal: Component<TranscriptModalProps> = (props) => {
  // createResource keys off the open flag + identity, so the body refetches
  // when the user opens the modal for a different session without us needing
  // to manually manage a previous-state cache.
  const [data] = createResource(
    () =>
      props.open()
        ? { cwd: props.cwd, sessionId: props.sessionId }
        : null,
    async (input) => {
      if (!input) return null;
      return await readSessionTranscript(input.cwd, input.sessionId);
    },
  );

  // Esc closes; ⌘R resumes + closes. window-level keydown so it works no
  // matter where focus is inside the modal (scroll container, expanded
  // details element, etc.). Subscription lifecycle is gated on open() so we
  // don't leave a stale listener after close.
  createEffect(() => {
    if (!props.open()) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        props.onResume();
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  // Auto-scroll to the bottom on first render so the user sees the most
  // recent activity (which is usually the reason they opened the modal).
  let bodyEl: HTMLDivElement | undefined;
  createEffect(() => {
    const d = data();
    if (!d || !bodyEl) return;
    queueMicrotask(() => {
      if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
  });

  // Find the ai-title from the lines, if Claude assigned one.
  const aiTitle = () => {
    const d = data();
    if (!d) return null;
    const line = d.lines.find((l) => l.type === "ai-title") as
      | { aiTitle?: string }
      | undefined;
    return line?.aiTitle ?? null;
  };

  return (
    <Show when={props.open()}>
      <div
        class="transcript-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div class="transcript-modal" role="dialog" aria-label="Session transcript">
          <header class="transcript-header">
            <div class="transcript-header-left">
              <div class="transcript-title">
                {aiTitle() ?? "Session transcript"}
              </div>
              <div class="transcript-subtitle">
                <span class="transcript-id">{shortId(props.sessionId)}</span>
                <Show when={data()}>
                  {(d) => (
                    <>
                      <span class="transcript-sep">·</span>
                      <span>{countTurns(d().lines)} turns</span>
                      <span class="transcript-sep">·</span>
                      <span>{formatBytes(d().total_bytes)}</span>
                      {(() => {
                        const u = aggregateUsage(d().lines);
                        const total = u.inTok + u.outTok;
                        if (total === 0) return null;
                        const pctCache = u.inTok > 0
                          ? Math.round((u.cacheRead / u.inTok) * 100)
                          : 0;
                        return (
                          <>
                            <span class="transcript-sep">·</span>
                            <span>
                              {u.inTok.toLocaleString()} in / {u.outTok.toLocaleString()} out
                              {pctCache > 0 ? ` (${pctCache}% cached)` : ""}
                            </span>
                          </>
                        );
                      })()}
                    </>
                  )}
                </Show>
              </div>
            </div>
            <div class="transcript-header-right">
              <button
                type="button"
                class="transcript-resume"
                onClick={() => {
                  props.onResume();
                  props.onClose();
                }}
                title="Resume this session (⌘R)"
              >
                ▶ Resume session
              </button>
              <button
                type="button"
                class="transcript-close"
                onClick={props.onClose}
                title="Close (Esc)"
              >
                ×
              </button>
            </div>
          </header>
          <Show when={data()?.truncated}>
            {(_) => (
              <div class="transcript-truncated">
                Showing the last 5 MB of a {formatBytes(data()?.total_bytes)}{" "}
                session. Earlier turns aren't included in this view.
              </div>
            )}
          </Show>
          <div class="transcript-body" ref={bodyEl}>
            <Show
              when={!data.loading}
              fallback={<div class="transcript-loading">Loading transcript…</div>}
            >
              <Show
                when={!data.error}
                fallback={
                  <div class="transcript-error">
                    Failed to load transcript: {String(data.error)}
                  </div>
                }
              >
                <For each={data()?.lines}>
                  {(line, idx) => <LineRow line={line} idx={idx()} />}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};
