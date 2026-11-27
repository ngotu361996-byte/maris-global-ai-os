import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for AI replies: headings, bold, italics, inline code, code blocks,
 * bullet and numbered lists, and links. It builds React elements only (never raw HTML),
 * so text from an AI cannot inject markup or scripts.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of a reply still streaming)
      blocks.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-md border border-line bg-bg p-2 text-xs">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const size = heading[1]!.length <= 2 ? 'text-base' : 'text-sm';
      blocks.push(
        <p key={key++} className={`mb-1 mt-2 font-semibold ${size}`}>
          {inline(heading[2]!)}
        </p>,
      );
      i++;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: { text: string; n: number | null }[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? /^\s*(\d+)[.)]\s+(.*)$/.exec(l) : /^\s*[-*+]\s+(.*)$/.exec(l);
        if (m) {
          items.push(ordered ? { n: Number(m[1]), text: m[2]! } : { n: null, text: m[1]! });
          i++;
        } else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          items[items.length - 1]!.text += `\n${l.trim()}`; // continuation line
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i + 1]!)) {
          i++; // blank line between items of the same list
        } else break;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key++} start={ordered ? (items[0]?.n ?? 1) : undefined} className={`my-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => (
            <li key={j} className="mb-0.5">
              {multiline(it.text)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push(
      <p key={key++} className="mb-2 last:mb-0">
        {multiline(para.join('\n'))}
      </p>,
    );
  }
  return <div className="break-words">{blocks}</div>;
}

function multiline(text: string): ReactNode {
  const parts = text.split('\n');
  return parts.map((p, i) => (
    <Fragment key={i}>
      {inline(p)}
      {i < parts.length - 1 && <br />}
    </Fragment>
  ));
}

// Underscore emphasis only at word edges, so names like openai.api_key stay as written.
const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w))|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    if (m[1]) {
      out.push(
        <code key={k++} className="rounded bg-bg px-1 font-mono text-[0.85em]">
          {t.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(<strong key={k++}>{inline(t.slice(2, -2))}</strong>);
    } else if (m[3]) {
      out.push(<em key={k++}>{inline(t.slice(1, -1))}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const href = link[2]!;
      // Only web links; javascript: and other schemes stay plain text.
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={k++} href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
            {link[1]}
          </a>
        ) : (
          t
        ),
      );
    }
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
