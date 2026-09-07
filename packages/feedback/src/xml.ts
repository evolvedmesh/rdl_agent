/**
 * A minimal XML parser, just enough for RDL.
 *
 * Regexes are fine for pdftotext's machine-generated output, but not for a 4,139-line
 * RDL where the questions are structural ("which ReportItems are direct children of
 * this Body?"). Both lint and, later, layout_locate need a real tree with line numbers.
 */

export type XmlNode = {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	/** Concatenated direct text content, trimmed. */
	text: string;
	/** 1-based line of the opening tag — this is what makes findings clickable. */
	line: number;
	parent?: XmlNode;
};

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

export function decodeXmlText(s: string): string {
	return s.replace(
		/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
		(m, ent: string) => {
			if (ent.startsWith("#x") || ent.startsWith("#X")) {
				return String.fromCodePoint(parseInt(ent.slice(2), 16));
			}
			if (ent.startsWith("#"))
				return String.fromCodePoint(parseInt(ent.slice(1), 10));
			return ENTITIES[ent] ?? m;
		},
	);
}

export class XmlError extends Error {
	constructor(
		message: string,
		readonly line: number,
	) {
		super(`${message} (line ${line})`);
		this.name = "XmlError";
	}
}

export function parseXml(src: string): XmlNode {
	let i = 0;
	let line = 1;
	const stack: XmlNode[] = [];
	let root: XmlNode | undefined;
	let textBuf = "";

	const advance = (to: number) => {
		for (let k = i; k < to; k++) if (src.charCodeAt(k) === 10) line++;
		i = to;
	};

	const flushText = () => {
		if (!textBuf) return;
		const node = stack[stack.length - 1];
		if (node) {
			const t = decodeXmlText(textBuf).trim();
			if (t) node.text = node.text ? `${node.text}${t}` : t;
		}
		textBuf = "";
	};

	while (i < src.length) {
		const lt = src.indexOf("<", i);
		if (lt === -1) {
			textBuf += src.slice(i);
			break;
		}
		textBuf += src.slice(i, lt);
		advance(lt);

		if (src.startsWith("<!--", i)) {
			const end = src.indexOf("-->", i);
			advance(end === -1 ? src.length : end + 3);
			continue;
		}
		if (src.startsWith("<![CDATA[", i)) {
			const end = src.indexOf("]]>", i);
			const stop = end === -1 ? src.length : end;
			textBuf += src.slice(i + 9, stop);
			advance(end === -1 ? src.length : end + 3);
			continue;
		}
		if (src.startsWith("<?", i) || src.startsWith("<!", i)) {
			const end = src.indexOf(">", i);
			advance(end === -1 ? src.length : end + 1);
			continue;
		}

		const gt = findTagEnd(src, i);
		if (gt === -1) break;
		const raw = src.slice(i + 1, gt);
		const tagLine = line;

		if (raw.startsWith("/")) {
			flushText();
			const closing = raw.slice(1).trim();
			const open = stack.pop();
			if (!open) {
				throw new XmlError(
					`Unexpected closing tag </${closing}> with nothing open`,
					tagLine,
				);
			}
			if (open.name !== closing) {
				throw new XmlError(
					`Closing tag </${closing}> does not match <${open.name}> opened on line ${open.line}`,
					tagLine,
				);
			}
			advance(gt + 1);
			continue;
		}

		flushText();
		const selfClosing = raw.endsWith("/");
		const body = selfClosing ? raw.slice(0, -1) : raw;
		const nameMatch = /^([^\s/>]+)/.exec(body);
		const name = nameMatch?.[1] ?? "";
		const node: XmlNode = {
			name,
			attrs: parseAttrs(body.slice(name.length)),
			children: [],
			text: "",
			line: tagLine,
		};

		const parent = stack[stack.length - 1];
		if (parent) {
			node.parent = parent;
			parent.children.push(node);
		} else if (!root) {
			root = node;
		}
		if (!selfClosing) stack.push(node);
		advance(gt + 1);
	}

	if (!root) throw new XmlError("No root element found", line);
	const unclosed = stack.at(-1);
	if (unclosed) {
		throw new XmlError(
			`<${unclosed.name}> opened on line ${unclosed.line} is never closed`,
			line,
		);
	}
	return root;
}

/** `>` inside an attribute value must not end the tag. */
function findTagEnd(src: string, start: number): number {
	let quote: string | null = null;
	for (let k = start + 1; k < src.length; k++) {
		const c = src[k];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === ">") {
			return k;
		}
	}
	return -1;
}

function parseAttrs(s: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
	let m = re.exec(s);
	while (m !== null) {
		const key = m[1];
		if (key !== undefined) attrs[key] = decodeXmlText(m[3] ?? m[4] ?? "");
		m = re.exec(s);
	}
	return attrs;
}

// --- tree queries -----------------------------------------------------------

export function child(node: XmlNode, name: string): XmlNode | undefined {
	return node.children.find((c) => c.name === name);
}

export function childText(node: XmlNode, name: string): string | undefined {
	return child(node, name)?.text;
}

export function children(node: XmlNode, name: string): XmlNode[] {
	return node.children.filter((c) => c.name === name);
}

export function* descendants(node: XmlNode): Generator<XmlNode> {
	for (const c of node.children) {
		yield c;
		yield* descendants(c);
	}
}

export function findAll(node: XmlNode, name: string): XmlNode[] {
	const out: XmlNode[] = [];
	for (const d of descendants(node)) if (d.name === name) out.push(d);
	return out;
}

/** e.g. "Body / Tablix1 / TablixRow" — used to make findings readable. */
export function pathOf(node: XmlNode): string {
	const parts: string[] = [];
	let cur: XmlNode | undefined = node;
	while (cur) {
		parts.unshift(cur.attrs.Name ? `${cur.name}[${cur.attrs.Name}]` : cur.name);
		cur = cur.parent;
	}
	return parts.join(" / ");
}
