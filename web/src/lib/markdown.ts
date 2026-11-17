// Markdown → sanitised HTML. LLM output is untrusted, so everything passes
// through DOMPurify; links open in a new tab and can't be javascript: URLs.
import { Marked } from "marked";
import DOMPurify from "dompurify";

const marked = new Marked({ gfm: true, breaks: false });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "b", "i", "ul", "ol", "li", "a", "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "hr", "del", "span"],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "align"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#)/i,
  });
}
