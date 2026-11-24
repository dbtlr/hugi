/**
 * Building HTML with every interpolated value escaped. A pull request chooses step names, causes
 * and logs, so a string only reaches a page as text; markup is only what an `html` template wrote.
 */

/** Markup that is already safe: written by an `html` template, never taken from a value. */
export class SafeHtml {
  readonly markup: string;
  constructor(markup: string) {
    this.markup = markup;
  }
  toString(): string {
    return this.markup;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/** `text` escaped for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/["&'<>]/gu, (character) => ESCAPES[character] ?? character);
}

/** What a template may interpolate: text (escaped), markup, nothing, or a list of these. */
export type HtmlValue = string | number | SafeHtml | undefined | false | readonly HtmlValue[];

function markupOf(value: HtmlValue): string {
  if (value === undefined || value === false) {
    return '';
  }
  if (value instanceof SafeHtml) {
    return value.markup;
  }
  if (Array.isArray(value)) {
    return value.map(markupOf).join('');
  }
  return escapeHtml(String(value));
}

/** An HTML template: the literal parts are markup, every interpolated value is escaped. */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  return new SafeHtml(
    strings.reduce((markup, part, index) => {
      const value = index < values.length ? markupOf(values[index]) : '';
      return `${markup}${part}${value}`;
    }, ''),
  );
}
