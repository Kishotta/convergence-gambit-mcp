/**
 * Markdown → block tree: the write-side counterpart of render.ts, for the
 * prose Claude hands to the write tools.
 *
 * Deliberately small. It understands what an article's running text needs,
 * written the way render.ts prints it, so text read from a page can be
 * edited and written back:
 *
 * - paragraphs, separated by a blank line
 * - headings, where `###` is a page's top level (a tab renders as `##`)
 * - `- ` bullet lists and `1. ` numbered lists, one paragraph per item
 * - `> ` quote blocks, which hold the same things; a quote whose first line
 *   is `**Info:**`, `**Note:**`, `**Success:**`, `**Warning:**` or
 *   `**Error:**` is a callout of that tone
 * - `---` rules
 * - pipe tables, one `| a | b |` line per row. A `| --- |` line under the
 *   first row makes that row the header; `<br>` breaks a cell into
 *   paragraphs, and `\|` is a literal pipe, as render.ts writes them
 * - `**bold**`, `*italic*` or `_italic_`, `~~strike~~`, `` `code` ``,
 *   `[label](https://…)` links, and mentions as `[Name](lk:resourceId)`
 *
 * Anything else stays literal text rather than being guessed at. Secrecy is
 * not markdown: a write tool wraps blocks in a secret block itself.
 */

import type { Block, Run } from "../lk/types";

type Marks = { bold?: true; italic?: true; strike?: true; link?: string };
type Tone = Extract<Block, { kind: "callout" }>["tone"];

/** The line render.ts opens a callout with, for every tone but `custom`. */
const CALLOUT = /^\*\*(Info|Note|Success|Warning|Error):\*\*$/;

export function composeBlocks(markdown: string): Block[] {
    const blocks: Block[] = [];
    let paragraph: string[] = [];
    let items: string[] = [];
    /** While `items` holds a numbered list, the number it starts at. */
    let ordered: number | undefined;
    let quoted: string[] = [];
    let rows: string[] = [];

    const flush = () => {
        if (rows.length) blocks.push(composeTable(rows));
        rows = [];
        if (quoted.length) blocks.push(composeQuote(quoted));
        quoted = [];
        if (paragraph.length) blocks.push({ kind: "paragraph", content: composeRuns(paragraph.join(" ")) });
        if (items.length) {
            const children = items.map((item): Block => ({
                kind: "listItem",
                children: [{ kind: "paragraph", content: composeRuns(item) }],
            }));
            if (ordered === undefined) blocks.push({ kind: "bulletList", children });
            else blocks.push({ kind: "orderedList", children, ...(ordered === 1 ? {} : { start: ordered }) });
        }
        paragraph = [];
        items = [];
        ordered = undefined;
    };

    for (const raw of markdown.split(/\r?\n/)) {
        const line = raw.trim();
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        const bullet = line.match(/^[-*]\s+(.*)$/);
        const numbered = line.match(/^(\d+)[.)]\s+(.*)$/);
        const quote = line.match(/^>\s?(.*)$/);
        const row = line.startsWith("|");
        if (rows.length && !row) flush();
        if (!line) flush();
        else if (row) {
            if (paragraph.length || items.length || quoted.length) flush();
            rows.push(line);
        } else if (/^(-{3,}|\*{3,})$/.test(line)) {
            flush();
            blocks.push({ kind: "rule" });
        } else if (heading) {
            flush();
            // The inverse of render.ts, which prints level 1 as "###".
            blocks.push({
                kind: "heading",
                level: Math.max(1, heading[1].length - 2),
                content: composeRuns(heading[2]),
            });
        } else if (quote) {
            // A bare ">" keeps the quote open across its own paragraph break.
            if (paragraph.length || items.length) flush();
            quoted.push(quote[1]);
        } else if (bullet || numbered) {
            const start = numbered ? Number(numbered[1]) : undefined;
            // A bullet after numbered items, or the reverse, starts a new list.
            const otherList = items.length > 0 && (ordered === undefined) !== (start === undefined);
            if (paragraph.length || quoted.length || otherList) flush();
            if (!items.length) ordered = start;
            items.push(bullet ? bullet[1] : numbered![2]);
        } else {
            if (items.length || quoted.length) flush();
            paragraph.push(line);
        }
    }
    flush();
    return blocks;
}

/** A row of only dashes, colons and pipes: the line under a table's header. */
const TABLE_RULE = /^\|?(\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?$/;

function composeTable(lines: string[]): Block {
    const headed = lines.length > 1 && TABLE_RULE.test(lines[1]);
    const rows = lines.filter((line, i) => !(headed && i === 1)).map(tableCells);
    const width = Math.max(...rows.map((cells) => cells.length));
    return {
        kind: "table",
        children: rows.map((cells, r): Block => ({
            kind: "tableRow",
            children: [...cells, ...Array<string>(width - cells.length).fill("")].map(
                (cell): Block => ({
                    kind: "tableCell",
                    ...(headed && r === 0 ? { header: true } : {}),
                    children: cell
                        .split(/\s*<br\s*\/?>\s*/i)
                        .map((part): Block => ({ kind: "paragraph", content: part ? composeRuns(part) : [] })),
                }),
            ),
        })),
    };
}

/** A row's cells: split on pipes that aren't escaped, without the outer ones. */
function tableCells(line: string): string[] {
    return line
        .replace(/^\|/, "")
        .replace(/(?<!\\)\|$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function composeQuote(lines: string[]): Block {
    const tone = lines[0].match(CALLOUT)?.[1].toLowerCase() as Tone | undefined;
    return tone
        ? { kind: "callout", tone, children: composeBlocks(lines.slice(1).join("\n")) }
        : { kind: "quote", children: composeBlocks(lines.join("\n")) };
}

/**
 * A link, bold, italic, strike or code span; whichever starts first in the
 * text wins. Emphasis has to hug its text, so the asterisks in "2 * 3" and
 * "2*3" and the underscores in "snake_case_name" stay literal.
 */
const INLINE = new RegExp(
    [
        /\[([^\]]+)\]\(([^)\s]+)\)/,
        /\*\*(?!\s)(.+?)(?<!\s)\*\*/,
        /(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)/,
        /(?<![\w_])_(?![\s_])(.+?)(?<!\s)_(?!\w)/,
        /~~(?!\s)(.+?)(?<!\s)~~/,
        /`([^`]+)`/,
    ]
        .map((part) => part.source)
        .join("|"),
);

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
        const [whole, label, href, bold, star, underscore, strike, code] = match;
        if (label !== undefined && href.startsWith("lk:")) {
            // A mention carries no marks of its own.
            runs.push({ mention: { resourceId: href.slice(3), text: label } });
        } else if (label !== undefined) {
            runs.push(...composeRuns(label, { ...marks, link: href }));
        } else if (bold !== undefined) {
            runs.push(...composeRuns(bold, { ...marks, bold: true }));
        } else if (strike !== undefined) {
            runs.push(...composeRuns(strike, { ...marks, strike: true }));
        } else if (code !== undefined) {
            // A code run carries no other mark.
            runs.push({ text: code, code: true });
        } else {
            runs.push(...composeRuns(star ?? underscore, { ...marks, italic: true }));
        }
        rest = rest.slice(match.index + whole.length);
    }
    return runs;
}
