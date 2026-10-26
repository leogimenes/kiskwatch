// The help texts, one Markdown file per panel tab (and one for the overlays),
// in src/help. The panel shows them on the tabs' "?" and the help window.

const FILES = import.meta.glob<string>("./help/*.md", { query: "?raw", import: "default", eager: true });

export interface Topic { id: string; title: string; text: string }

/** In the order of the panel's tabs. */
const ORDER = ["timers", "pets", "build", "group", "dps", "checklist", "enchant", "titles", "config", "overlays", "privacidade"];

export const TOPICS: Topic[] = ORDER.flatMap((id) => {
  const text = FILES[`./help/${id}.md`];
  if (text == null) return [];
  const title = /^#\s+(.*)$/m.exec(text)?.[1] ?? id;
  return [{ id, title, text }];
});

export const topic = (id: string) => TOPICS.find((t) => t.id === id) ?? TOPICS[0];
