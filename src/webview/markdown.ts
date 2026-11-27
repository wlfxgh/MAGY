import { escapeHtml } from "./utils";

interface TagMatch {
    start: number;
    end: number;
    closing: boolean;
}

interface TableRow {
    header: boolean;
    cells: string[];
}

interface TableBlock {
    kind: "table";
    rows: TableRow[];
}

interface HeadingBlock {
    kind: "h";
    level: number;
    text: string;
}

interface HrBlock {
    kind: "hr";
}

interface QuoteBlock {
    kind: "quote";
    items: string[];
}

interface PreBlock {
    kind: "pre";
    lang: string;
    code: string;
}

interface CodeBlock {
    kind: "code";
    html: string;
}

interface ListItem {
    text: string;
    children: ListBlock[] | null;
    value: number;
}

interface ListBlock {
    kind: "ul" | "ol";
    items: ListItem[];
}

type InlineBlock = string | TableBlock | HeadingBlock | HrBlock | QuoteBlock | PreBlock | ListBlock;
type QuoteInnerBlock = string | TableBlock | HeadingBlock | HrBlock | QuoteBlock | CodeBlock | ListBlock;

let quotedFenceHtml: string[] = [];

function fenceHtml(lang: string, fence: string, spaced?: boolean): string {
    const code = `<pre><code>${escapeHtml(fence)}</code></pre>`;
    const label = lang.trim() || "代码";
    return `<div class="ref${spaced ? " spaced" : ""}"><div class="ref-head"><span class="ref-path">${escapeHtml(label)}</span><button type="button" class="ref-copy">复制</button></div>${code}</div>`;
}

export function renderMarkdown(source: string): string {
    quotedFenceHtml = [];
    const normalized = String(source ?? "").replace(/\r\n?/g, "\n").replace(/^> ?```([^\n]*)\n([\s\S]*?)\n> ?```[ \t]*$/gm, (_all, lang: string, body: string) => {
        const fence = body.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n");
        const id = quotedFenceHtml.length;
        quotedFenceHtml.push(fenceHtml(lang.trim(), fence));
        return `> \u0001${id}`;
    });
    const parts = normalized.split("```");
    let html = "";
    for (let index = 0; index < parts.length; index += 2) {
        let text = parts[index];
        const paragraphBefore = index > 0 && /^\n(?:[ \t]*\n)+/.test(text);
        if (index + 1 >= parts.length) {
            const rendered = renderInline(text);
            if (paragraphBefore && rendered.trim()) {
                html += "<br>";
            }
            html += rendered;
            break;
        }
        const lineStart = text.lastIndexOf("\n") + 1;
        const prefix = text.slice(lineStart);
        let indent = "";
        if (/^[ \t]+$/.test(prefix)) {
            indent = prefix;
            text = text.slice(0, lineStart);
        }
        const raw = parts[index + 1];
        const breakAt = raw.indexOf("\n");
        const lang = breakAt === -1 ? "" : raw.slice(0, breakAt).trim();
        const fence = breakAt === -1 ? raw : raw.slice(breakAt + 1);
        let lines = fence.split("\n");
        if (indent) {
            lines = lines.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line));
            const rest = parts[index + 2];
            if (rest !== null && rest !== undefined) {
                parts[index + 2] = rest.split("\n").map((line) => {
                    if (!line.startsWith(indent)) {
                        return line;
                    }
                    const trimmed = line.slice(indent.length);
                    if (/^(?:[-*]|\d{1,2}\.)\s+/.test(trimmed) || /^#{1,6}\s+/.test(trimmed)) {
                        return line;
                    }
                    return trimmed;
                }).join("\n");
            }
        }
        if (lines.length && !lines[lines.length - 1].trim()) {
            lines.pop();
        }
        const paragraphAfter = /\n[ \t]*\n[ \t]*$/.test(text);
        const rendered = renderInline(text);
        if (paragraphBefore && rendered.trim()) {
            html += "<br>";
        }
        html += rendered;
        html += fenceHtml(lang, lines.join("\n"), paragraphAfter && Boolean(rendered.trim()));
    }
    return html;
}

function unescapeHtml(value: string): string {
    return String(value)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
}

function findTag(source: string, from: number, tag: string): TagMatch | null {
    const lower = source.toLowerCase();
    const open = `&lt;${tag}`;
    const close = `&lt;/${tag}`;
    let index = from;
    while (index < source.length) {
        const nextOpen = lower.indexOf(open, index);
        const nextClose = lower.indexOf(close, index);
        if (nextOpen < 0 && nextClose < 0) {
            return null;
        }
        const closing = nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen);
        const at = closing ? nextClose : nextOpen;
        const nameEnd = at + (closing ? close.length : open.length);
        const boundary = lower[nameEnd];
        if (boundary && boundary !== "&" && !/\s/.test(source[nameEnd])) {
            index = nameEnd;
            continue;
        }
        const gt = lower.indexOf("&gt;", nameEnd);
        if (gt < 0) {
            return null;
        }
        return { start: at, end: gt + 4, closing };
    }
    return null;
}

function replaceBalanced(source: string, tag: string, replacer: (inner: string) => string): string {
    let result = "";
    let index = 0;
    while (index < source.length) {
        const found = findTag(source, index, tag);
        if (!found || found.closing) {
            result += source.slice(index);
            break;
        }
        let depth = 1;
        let cursor = found.end;
        let close: TagMatch | null = null;
        while (depth > 0) {
            const next = findTag(source, cursor, tag);
            if (!next) {
                break;
            }
            depth += next.closing ? -1 : 1;
            if (depth === 0) {
                close = next;
            }
            cursor = next.end;
        }
        if (!close) {
            result += source.slice(index);
            break;
        }
        result += source.slice(index, found.start);
        result += replacer(source.slice(found.end, close.start));
        index = close.end;
    }
    return result;
}

function htmlTableMarkdown(inner: string): string {
    const rows: TableRow[] = [];
    replaceBalanced(inner, "tr", (row) => {
        const cells: string[] = [];
        let header = false;
        const cellRe = /&lt;(th|td)\b[\s\S]*?&gt;([\s\S]*?)&lt;\/\1&gt;/gi;
        let match: RegExpExecArray | null;
        while ((match = cellRe.exec(row))) {
            if (match[1].toLowerCase() === "th") {
                header = true;
            }
            cells.push(match[2].replace(/\n+/g, " ").replace(/\|/g, "\\|").trim());
        }
        if (cells.length) {
            rows.push({ header, cells });
        }
        return "";
    });
    if (!rows.length) {
        return "";
    }
    const width = Math.max(...rows.map((row) => row.cells.length));
    const pad = (cells: string[]): string => {
        const next = cells.slice();
        while (next.length < width) {
            next.push("");
        }
        return `| ${next.join(" | ")} |`;
    };
    const lines: string[] = [];
    if (rows.some((row) => row.header)) {
        const head = rows.find((row) => row.header)!;
        lines.push(pad(head.cells));
        lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
        for (const row of rows.filter((item) => !item.header)) {
            lines.push(pad(row.cells));
        }
    } else {
        lines.push(pad(rows[0].cells));
        lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
        for (const row of rows.slice(1)) {
            lines.push(pad(row.cells));
        }
    }
    return lines.join("\n");
}

function htmlBlocks(source: string): string {
    source = replaceBalanced(source, "table", (inner) => {
        const markdown = htmlTableMarkdown(inner);
        return markdown ? `\n${markdown}\n` : "";
    });
    source = replaceBalanced(source, "blockquote", (inner) => {
        const converted = htmlBlocks(inner).trim();
        if (!converted) {
            return "";
        }
        return `\n${converted.split("\n").map((line) => (/^\u0003\d+\u0003$/.test(line.trim()) || /^\|/.test(line.trim()) ? line.trim() : `&gt; ${line}`)).join("\n")}\n`;
    });
    source = replaceBalanced(source, "ol", (inner) => `\n${listItems(inner, "ol")}\n`);
    source = replaceBalanced(source, "ul", (inner) => `\n${listItems(inner, "ul")}\n`);
    source = replaceBalanced(source, "p", (inner) => `\n\n${inner.trim()}\n\n`);
    source = replaceBalanced(source, "div", (inner) => `\n${htmlBlocks(inner)}\n`);
    source = source.replace(/&lt;h([1-6])\b[\s\S]*?&gt;([\s\S]*?)&lt;\/h\1&gt;/gi, (_all, level: string, text: string) => `\n${"#".repeat(Number(level))} ${text.trim()}\n`);
    source = source.replace(/&lt;hr\b[^&]*?\/?\s*&gt;/gi, "\n---\n");
    return source;
}

function listItems(inner: string, kind: "ul" | "ol"): string {
    const pieces: string[] = [];
    let n = 0;
    replaceBalanced(inner, "li", (text) => {
        const lines = htmlBlocks(text).trim().split("\n");
        let started = false;
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            if (/^\u0003\d+\u0003$/.test(line.trim())) {
                pieces.push(line.trim());
                continue;
            }
            if (!started) {
                n += 1;
                pieces.push(`${kind === "ol" ? `${n}. ` : "- "}${line}`);
                started = true;
            } else {
                pieces.push(`  ${line}`);
            }
        }
        return "";
    });
    return pieces.join("\n");
}

function renderInline(text: string): string {
    let html = escapeHtml(text);
    const codes: string[] = [];
    html = html.replace(/`([^`]+)`/g, (_all, code: string) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });
    const pres: Array<{ lang: string; code: string }> = [];
    html = replaceBalanced(html, "pre", (inner) => {
        const code = /^\s*&lt;code\b([\s\S]*?)&gt;([\s\S]*?)&lt;\/code&gt;\s*$/i.exec(inner);
        const langMatch = code ? /(?:language-|lang-)([\w-]+)/i.exec(code[1]) : null;
        const body = code ? code[2] : inner;
        pres.push({ lang: langMatch ? langMatch[1] : "", code: unescapeHtml(body).replace(/\n$/, "") });
        return `\n\u0003${pres.length - 1}\u0003\n`;
    });
    html = html.replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/gi, (_all, code: string) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });
    html = htmlBlocks(html);
    html = html.replace(/\n[ \t]*\n+(\u0003\d+\u0003)/g, "\n$1");
    html = html.replace(/&lt;br\s*\/?\s*&gt;/gi, "<br>");
    html = html.replace(/&lt;(\/?)(?:strong|b)&gt;/gi, "<$1strong>");
    html = html.replace(/&lt;(\/?)(?:em|i)&gt;/gi, "<$1em>");
    html = html.replace(/&lt;(\/?)del&gt;/gi, "<$1del>");
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    html = html.replace(/&lt;(https?:\/\/[^\s]+?)&gt;/g, '<a href="$1">$1</a>');
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+&quot;[\s\S]*?&quot;)?\)/g, (_all, alt: string, url: string) => {
        const label = String(alt).trim() || "图片";
        return `<a href="${url}">${label}</a>`;
    });
    html = html.replace(/!\[([^\]]*)\]\([^)\n]*\)/g, (_all, alt: string) => String(alt).trim() || "图片");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+&quot;[\s\S]*?&quot;)?\)/g, '<a href="$2">$1</a>');
    html = html.replace(/\[([^\]]+)\]\((file:\/\/\/[^\s)]+)(?:\s+&quot;[\s\S]*?&quot;)?\)/g, '<a class="file-link" href="$2" title="打开文件">$1</a>');
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[\s\S]*?&quot;)?\)/g, (full: string, label: string, target: string) => {
        if (/^(?:https?:|file:|mailto:|javascript:|data:|vbscript:|#)/i.test(target)) {
            return full;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[A-Za-z]:[\\/]/.test(target) && !/\.[\w-]+:\d+/.test(target)) {
            return full;
        }
        if (!/(?:[\\/]|^[A-Za-z]:|\.[\w-]+(?::\d+(?:-\d+)?(?::\d+)?|#L\d+(?:-L?\d+)?)?$)/.test(target) || /["'<>]/.test(target)) {
            return full;
        }
        return `<a class="file-link" href="${target}" title="打开文件">${label}</a>`;
    });
    html = html.replace(/&lt;a\s+href=(?:&quot;|')(https?:\/\/(?:[^&"'<>\s]|&amp;)+)(?:&quot;|')(?:\s+[\w-]+=(?:&quot;[^&]*&quot;|'[^']*'))*\s*&gt;([\s\S]*?)&lt;\/a&gt;/gi, '<a href="$1">$2</a>');
    const urls: string[] = [];
    html = html.split(/(<[^>]+>)/).map((part) => {
        if (part.startsWith("<")) {
            return part;
        }
        return part.replace(/https?:\/\/[^\s<]+/g, (url) => {
            urls.push(url);
            return `\u0002${urls.length - 1}\u0002`;
        });
    }).join("");
    html = html.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<em><strong>$1</strong></em>");
    html = html.replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    html = html.replace(/(?<![\p{L}\p{N}_])__([^\n_]+?)__(?![\p{L}\p{N}_])/gu, "<strong>$1</strong>");
    html = html.replace(/(?<![\p{L}\p{N}_])_([^\n_]+?)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");
    html = html.replace(/\u0002(\d+)\u0002/g, (_all, index: string) => urls[Number(index)]);
    html = html.replace(/\u0000(\d+)\u0000/g, (_all, index: string) => `<code>${codes[Number(index)]}</code>`);
    const lines = html.split("\n");
    const blocks: InlineBlock[] = [];
    let list: ListBlock | null = null;
    let quote: QuoteBlock | null = null;
    let table: TableBlock | null = null;
    const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    for (const line of lines) {
        const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
        const tableRow = /^\s*\|.+\|\s*$/.test(line);
        if (tableRule) {
            list = null;
            quote = null;
            if (table && table.rows.length) {
                table.rows[table.rows.length - 1].header = true;
            }
            continue;
        }
        if (tableRow) {
            list = null;
            quote = null;
            if (!table) {
                table = { kind: "table", rows: [] };
                blocks.push(table);
            }
            table.rows.push({ header: false, cells: cellsOf(line) });
            continue;
        }
        table = null;
        const preLine = /^\u0003(\d+)\u0003$/.exec(line.trim());
        if (preLine) {
            list = null;
            quote = null;
            blocks.push({ kind: "pre", ...pres[Number(preLine[1])] });
            continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            list = null;
            quote = null;
            blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
            continue;
        }
        if (/^[-*_]{3,}$/.test(line)) {
            list = null;
            quote = null;
            blocks.push({ kind: "hr" });
            continue;
        }
        const quoted = /^&gt;\s?(.*)$/.exec(line);
        if (quoted) {
            list = null;
            if (!quote) {
                quote = { kind: "quote", items: [] };
                blocks.push(quote);
            }
            quote.items.push(quoted[1]);
            continue;
        }
        const match = /^(\s*)([-*]|\d{1,2}\.)\s+(.+)$/.exec(line);
        if (match) {
            quote = null;
            const depth = Math.floor(match[1].replace(/\t/g, "  ").length / 2);
            const kind: "ul" | "ol" = /^\d/.test(match[2]) ? "ol" : "ul";
            const itemText = match[3];
            if (!list || (depth === 0 && list.kind !== kind)) {
                list = { kind, items: [] };
                blocks.push(list);
            }
            pushListItem(list, depth, kind, itemText, kind === "ol" ? Number.parseInt(match[2], 10) : 0);
            continue;
        }
        list = null;
        quote = null;
        blocks.push(line);
    }
    html = "";
    let lastText = false;
    let sawBlank = false;
    for (const block of blocks) {
        if (typeof block === "string" && !block.trim()) {
            sawBlank = true;
            continue;
        }
        const isText = typeof block === "string";
        let piece: string;
        if (typeof block === "string") {
            piece = block;
        } else if (block.kind === "h") {
            piece = `<h${block.level}>${block.text}</h${block.level}>`;
        } else if (block.kind === "hr") {
            piece = "<hr>";
        } else if (block.kind === "quote") {
            piece = renderQuote(block.items);
        } else if (block.kind === "table") {
            piece = renderTable(block);
        } else if (block.kind === "pre") {
            piece = fenceHtml(block.lang, block.code, Boolean(html && sawBlank));
        } else {
            piece = `<${block.kind}>${renderListItems(block)}</${block.kind}>`;
        }
        if (html && isText && lastText) {
            html += sawBlank ? "<br><br>" : "<br>";
        } else if (html && isText && sawBlank) {
            html += "<br>";
        } else if (html && sawBlank && piece.startsWith('<blockquote class="')) {
            piece = piece.replace('<blockquote class="', '<blockquote class="spaced ');
        } else if (html && sawBlank && piece.startsWith("<blockquote>")) {
            piece = piece.replace("<blockquote>", '<blockquote class="spaced">');
        } else if (html && sawBlank && piece.startsWith('<div class="table-wrap">')) {
            piece = piece.replace('<div class="table-wrap">', '<div class="table-wrap spaced">');
        }
        sawBlank = false;
        html += piece;
        lastText = isText;
    }
    return softenUrls(
        html
            .replace(/(?:<br>)+(<(?:ul|ol|blockquote|table|h[1-6]|hr|pre|div)\b)/g, "$1")
            .replace(/(<\/(?:h[1-6])>|<hr>)(?:<br>)+/g, "$1")
            .replace(/(?:<br>){3,}/g, "<br><br>"),
    );
}

function renderTable(block: TableBlock): string {
    const renderRow = (row: TableRow, tag: string): string => `<tr>${row.cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;
    const head = block.rows.filter((row) => row.header);
    const body = block.rows.filter((row) => !row.header);
    const thead = head.length ? `<thead>${head.map((row) => renderRow(row, "th")).join("")}</thead>` : "";
    const tbody = body.length ? `<tbody>${body.map((row) => renderRow(row, "td")).join("")}</tbody>` : "";
    return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderQuote(items: string[]): string {
    const lines = items.slice();
    let callout = "";
    let warn = false;
    const marker = /^\[!(note|tip|important|warning|caution)\](?:\s+(.*))?$/i.exec((lines[0] || "").trim());
    if (marker) {
        const kind = marker[1].toLowerCase();
        const labels: Record<string, string> = { note: "说明", tip: "提示", important: "重要", warning: "注意", caution: "警告" };
        callout = labels[kind] || "";
        warn = kind === "warning" || kind === "caution";
        lines.shift();
        if (marker[2]) {
            lines.unshift(marker[2]);
        } else if (!lines[0]) {
            lines.shift();
        }
    }
    const blocks: QuoteInnerBlock[] = [];
    let list: ListBlock | null = null;
    let paragraph: string[] = [];
    const flushParagraph = (): void => {
        if (!paragraph.length) {
            return;
        }
        blocks.push(paragraph.join("<br>"));
        paragraph = [];
    };
    let table: TableBlock | null = null;
    let nestedQuote: QuoteBlock | null = null;
    for (const line of lines) {
        const quotedFence = /^\u0001(\d+)$/.exec(line);
        if (quotedFence) {
            flushParagraph();
            list = null;
            table = null;
            nestedQuote = null;
            blocks.push({ kind: "code", html: quotedFenceHtml[Number(quotedFence[1])] || "" });
            continue;
        }
        const nested = /^&gt;\s?(.*)$/.exec(line);
        if (nested) {
            flushParagraph();
            list = null;
            table = null;
            if (!nestedQuote) {
                nestedQuote = { kind: "quote", items: [] };
                blocks.push(nestedQuote);
            }
            nestedQuote.items.push(nested[1]);
            continue;
        }
        nestedQuote = null;
        const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
        const tableRow = /^\s*\|.+\|\s*$/.test(line);
        if (tableRule) {
            flushParagraph();
            list = null;
            if (table && table.rows.length) {
                table.rows[table.rows.length - 1].header = true;
            }
            continue;
        }
        if (tableRow) {
            flushParagraph();
            list = null;
            if (!table) {
                table = { kind: "table", rows: [] };
                blocks.push(table);
            }
            table.rows.push({
                header: false,
                cells: line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()),
            });
            continue;
        }
        table = null;
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            flushParagraph();
            list = null;
            blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
            continue;
        }
        if (/^[-*_]{3,}$/.test(line)) {
            flushParagraph();
            list = null;
            blocks.push({ kind: "hr" });
            continue;
        }
        const match = /^(\s*)([-*]|\d{1,2}\.)\s+(.+)$/.exec(line);
        if (match) {
            flushParagraph();
            const depth = Math.floor(match[1].replace(/\t/g, "  ").length / 2);
            const kind: "ul" | "ol" = /^\d/.test(match[2]) ? "ol" : "ul";
            if (!list || (depth === 0 && list.kind !== kind)) {
                list = { kind, items: [] };
                blocks.push(list);
            }
            pushListItem(list, depth, kind, match[3], kind === "ol" ? Number.parseInt(match[2], 10) : 0);
            continue;
        }
        list = null;
        if (!line.trim()) {
            flushParagraph();
            continue;
        }
        paragraph.push(line);
    }
    flushParagraph();
    let html = "";
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        let piece: string;
        if (typeof block === "string") {
            piece = block;
        } else if (block.kind === "h") {
            piece = `<h${block.level}>${block.text}</h${block.level}>`;
        } else if (block.kind === "hr") {
            piece = "<hr>";
        } else if (block.kind === "table") {
            piece = renderTable(block);
        } else if (block.kind === "code") {
            piece = block.html;
        } else if (block.kind === "quote") {
            piece = renderQuote(block.items);
        } else {
            piece = `<${block.kind}>${renderListItems(block)}</${block.kind}>`;
        }
        if (index > 0 && typeof block === "string" && typeof blocks[index - 1] === "string") {
            html += "<br><br>";
        }
        html += piece;
    }
    const label = callout ? `<span class="callout-label${warn ? " warn" : ""}">${callout}</span>` : "";
    return `<blockquote${callout ? ' class="callout"' : ""}>${label}${html}</blockquote>`;
}

function pushListItem(list: ListBlock, depth: number, kind: "ul" | "ol", text: string, value: number): void {
    let current = list;
    let level = 0;
    while (level < depth) {
        const parent = current.items[current.items.length - 1];
        if (!parent) {
            break;
        }
        if (!parent.children) {
            parent.children = [];
        }
        let child = parent.children[parent.children.length - 1];
        if (!child || (level === depth - 1 && child.kind !== kind)) {
            child = { kind, items: [] };
            parent.children.push(child);
        }
        current = child;
        level += 1;
    }
    current.items.push({ text, children: null, value });
}

function renderListItems(block: ListBlock): string {
    return block.items.map((item) => {
        const task = /^\[( |x|X)\]\s+(.+)$/.exec(item.text);
        const nested = Array.isArray(item.children)
            ? item.children.map((child) => `<${child.kind}>${renderListItems(child)}</${child.kind}>`).join("")
            : "";
        const value = item.value > 0 ? ` value="${item.value}"` : "";
        if (!task) {
            return `<li${value}>${item.text}${nested}</li>`;
        }
        const done = task[1].toLowerCase() === "x";
        return `<li${value} class="task${done ? " done" : ""}"><span class="box" aria-hidden="true"></span><span>${task[2]}</span>${nested}</li>`;
    }).join("");
}

function softenUrls(html: string): string {
    let code = 0;
    let anchor = 0;
    const trimUrl = (url: string): { href: string; tail: string } => {
        let href = url;
        let tail = "";
        const opens = (value: string): number => (value.match(/[（(]/g) || []).length;
        const closes = (value: string): number => (value.match(/[）)]/g) || []).length;
        while (href) {
            const last = href.slice(-1);
            if (/[.,;:!?。，、】\]]/u.test(last)) {
                tail = last + tail;
                href = href.slice(0, -1);
                continue;
            }
            if (/[）)]/u.test(last) && opens(href) < closes(href)) {
                tail = last + tail;
                href = href.slice(0, -1);
                continue;
            }
            break;
        }
        return { href, tail };
    };
    const soften = (url: string): string => {
        const scheme = /^https?:\/\//.exec(url);
        const head = scheme ? scheme[0] : "";
        const rest = url.slice(head.length).replace(/&amp;|[/?=]/g, (token) => (token === "&amp;" ? "&amp;<wbr>" : `${token}<wbr>`));
        return head + rest;
    };
    return html.split(/(<[^>]+>)/).map((part) => {
        if (part.startsWith("<")) {
            if (/^<(?:code|pre)\b/i.test(part)) {
                code += 1;
            } else if (/^<\/(?:code|pre)>/i.test(part)) {
                code = Math.max(0, code - 1);
            } else if (/^<a\b/i.test(part)) {
                anchor += 1;
            } else if (/^<\/a>/i.test(part)) {
                anchor = Math.max(0, anchor - 1);
            }
            return part;
        }
        if (code) {
            return part;
        }
        return part.replace(/https?:\/\/[^\s<]+/g, (url) => {
            const trimmed = trimUrl(url);
            if (!/^https?:\/\/.+/i.test(trimmed.href)) {
                return url;
            }
            const label = soften(trimmed.href);
            if (anchor) {
                return label + trimmed.tail;
            }
            return `<a href="${trimmed.href}">${label}</a>${trimmed.tail}`;
        });
    }).join("");
}
