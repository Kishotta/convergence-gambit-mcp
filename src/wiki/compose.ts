/**
 * Markdown → block tree: the write-side counterpart of render.ts, for the
 * prose Claude hands to the write tools.
 *
 * Deliberately small. It understands what an article's running text needs:
 * paragraphs (separated by a blank line), `- ` bullet lists, `> ` quote
 * blocks (which hold the same things), `**bold**`, `*italic*`, `[label](https://…)` links, and mentions written the way
 * render.ts prints them, `[Name](lk:resourceId)`. Anything else stays
 * literal text rather than being guessed at.
 */

import type { Block, Run } from "../lk/types";

type Marks = { bold?: true; italic?: true; link?: string };

export function composeBlocks(markdown: string): Block[] {
    const blocks: Block[] = [];
    let paragraph: string[] = [];
    let items: string[] = [];
    let quoted: string[] = [];

    const flush = () => {
        if (quoted.length) blocks.push({ kind: "quote", children: composeBlocks(quoted.join("\n")) });
        quoted = [];
        if (paragraph.length) blocks.push({ kind: "paragraph", content: composeRuns(paragraph.join(" ")) });
        if (items.length) {
            blocks.push({
                kind: "bulletList",
                children: items.map((item) => ({
                    kind: "listItem",
                    children: [{ kind: "paragraph", content: composeRuns(item) }],
                })),
            });
        }
        paragraph = [];
        items = [];
    };

    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trim();
        const bullet = line.match(/^[-*]\s+(.*)$/);
        const quote = line.match(/^>\s?(.*)$/);
        if (!line) flush();
        else if (quote) {
            // A bare ">" keeps the quote open across its own paragraph break.
            if (paragraph.length || items.length) flush();
            quoted.push(quote[1]);
        } else if (bullet) {
            if (paragraph.length || quoted.length) flush();
            items.push(bullet[1]);
        } else {
            if (items.length || quoted.length) flush();
            paragraph.push(line);
        }
    }
    flush();
    return blocks;
}

/**
 * A link, bold, or italic span; whichever starts first in the text wins.
 * Emphasis has to hug its text, so the asterisks in "2 * 3" and "2*3" stay
 * literal.
 */
const INLINE =
    /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(?!\s)(.+?)(?<!\s)\*\*|(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)/;

export function composeRuns(text: string, marks: Marks = {}): Run[] {
    const runs: Run[] = [];
    let rest = text;
    while (rest) {
        const match = INLINE.exec(rest);
        if (!match) {
            runs.push({ text: rest, ...marks });
            break;
        }
        if (match.index) runs.push({ text: rest.slice(0, match.index), ...marks });
        const [whole, label, href, bold, italic] = match;
        if (label !== undefined && href.startsWith("lk:")) {
            // A mention carries no marks of its own.
            runs.push({ mention: { resourceId: href.slice(3), text: label } });
        } else if (label !== undefined) {
            runs.push(...composeRuns(label, { ...marks, link: href }));
        } else if (bold !== undefined) {
            runs.push(...composeRuns(bold, { ...marks, bold: true }));
        } else {
            runs.push(...composeRuns(italic, { ...marks, italic: true }));
        }
        rest = rest.slice(match.index + whole.length);
    }
    return runs;
}
