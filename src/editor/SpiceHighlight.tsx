import { useRef, type CSSProperties } from "react";

/**
 * Lightweight SPICE syntax highlighter. Renders a colourised `<pre>` layer
 * directly behind a transparent `<textarea>`, keeping their geometry identical
 * so the highlight tracks the caret. Used by the LTSpice text-import dialog.
 */

const FONT: CSSProperties = {
  fontFamily: "'Cascadia Code', 'Fira Code', 'Courier New', monospace",
  fontSize: 13,
  lineHeight: 1.6,
  letterSpacing: "normal",
  tabSize: 4,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const COLORS = {
  comment: "#64748b",
  directive: "#c084fc",
  type: "#67e8f9",
  param: "#fbbf24",
  number: "#86efac",
  paren: "#94a3b8",
  text: "#e2e8f0",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MODEL_TYPES = /^(D|NPN|PNP|NMOS|PMOS|VDMOS|NJF|PJF|RES|CAP|IND|SW|CSW)$/i;

/** Tokenises one line into coloured HTML spans. */
function highlightLine(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*")) {
    return `<span style="color:${COLORS.comment}">${escapeHtml(line)}</span>`;
  }

  let html = "";
  // Split off a trailing `;` comment first.
  let code = line;
  let comment = "";
  const semi = line.indexOf(";");
  if (semi >= 0) {
    code = line.slice(0, semi);
    comment = line.slice(semi);
  }

  // Token regex: words, key=value, parens, numbers, whitespace.
  const tokenRe = /(\s+)|([()])|([A-Za-z_][\w]*=)|(-?\d+\.?\d*(?:e-?\d+)?[a-zA-Z]*)|([.A-Za-z_][\w.]*)|(.)/g;
  let m: RegExpExecArray | null;
  let isFirstWord = true;
  while ((m = tokenRe.exec(code)) !== null) {
    const [tok, ws, paren, kv, num, word] = m;
    if (ws) {
      html += escapeHtml(ws);
    } else if (paren) {
      html += `<span style="color:${COLORS.paren}">${paren}</span>`;
    } else if (kv) {
      html += `<span style="color:${COLORS.param}">${escapeHtml(kv)}</span>`;
    } else if (num) {
      html += `<span style="color:${COLORS.number}">${escapeHtml(num)}</span>`;
    } else if (word) {
      if (word.startsWith(".")) {
        html += `<span style="color:${COLORS.directive};font-weight:600">${escapeHtml(word)}</span>`;
      } else if (!isFirstWord && MODEL_TYPES.test(word)) {
        html += `<span style="color:${COLORS.type}">${escapeHtml(word)}</span>`;
      } else {
        html += `<span style="color:${COLORS.text}">${escapeHtml(word)}</span>`;
      }
      isFirstWord = false;
    } else {
      html += escapeHtml(tok);
    }
  }
  if (comment) html += `<span style="color:${COLORS.comment}">${escapeHtml(comment)}</span>`;
  return html || "&nbsp;";
}

function highlight(text: string): string {
  return text.split("\n").map(highlightLine).join("\n");
}

interface SpiceHighlightProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function SpiceHighlight({ value, onChange, placeholder, minHeight = 220, onKeyDown }: SpiceHighlightProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const syncScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const boxStyle: CSSProperties = {
    ...FONT,
    margin: 0,
    padding: "10px 12px",
    border: "1px solid #334155",
    borderRadius: 6,
    boxSizing: "border-box",
    width: "100%",
    minHeight,
    overflow: "auto",
  };

  return (
    <div style={{ position: "relative", minHeight }}>
      <pre
        ref={preRef}
        aria-hidden
        style={{
          ...boxStyle,
          position: "absolute",
          inset: 0,
          background: "#0f172a",
          color: COLORS.text,
          pointerEvents: "none",
        }}
        dangerouslySetInnerHTML={{ __html: highlight(value) + "\n" }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          ...boxStyle,
          position: "relative",
          background: "transparent",
          color: "transparent",
          caretColor: "#67e8f9",
          resize: "vertical",
          outline: "none",
        }}
      />
    </div>
  );
}
