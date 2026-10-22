// Just enough Markdown for the help texts: headings, paragraphs, lists,
// quotes, bold, italics, code and links. Everything else is plain text.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function inline(text: string) {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

/** The Markdown as HTML; the text is escaped, so only these tags come out. */
export function markdown(source: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: "ul" | "ol" | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^(?:([-*])|\d+\.)\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if (line.startsWith(">")) {
      flush();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else if (item) {
      const kind = item[1] ? "ul" : "ol";
      if (para.length || list !== kind) flush();
      if (!list) out.push(`<${(list = kind)}>`);
      out.push(`<li>${inline(item[2])}</li>`);
    } else if (list) {
      // A line under an item carries on that item.
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line)}</li>`);
    } else para.push(line);
  }
  flush();
  return out.join("\n");
}
