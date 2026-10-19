export interface RubyTextPart { text: string; annotation?: string }

/** Accept only bounded plain-text Ruby pairs. Everything else remains literal text, never HTML. */
export function splitRubyText(value: string): RubyTextPart[] {
  const parts: RubyTextPart[] = []; let cursor = 0;
  for (const match of value.matchAll(/<ruby>([^<>]{1,2000})<rt>([^<>]{1,2000})<\/rt><\/ruby>/gu)) {
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index) });
    parts.push({ text: match[1]!, annotation: match[2]! }); cursor = match.index + match[0].length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts;
}

export function renderRubyText(target: HTMLElement, value: string): void {
  const document = target.ownerDocument;
  target.replaceChildren(...splitRubyText(value).map(part => {
    if (!part.annotation) return document.createTextNode(part.text);
    const ruby = document.createElement('ruby'), rt = document.createElement('rt');
    ruby.append(document.createTextNode(part.text)); rt.textContent = part.annotation; ruby.append(rt); return ruby;
  }));
}
