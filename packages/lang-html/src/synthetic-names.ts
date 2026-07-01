/**
 * Single source of truth for the synthetic-fn naming convention used by
 * lang-html. The extractor produces these names; the resolvers
 * (resolveInlineHandlers, resolveAngularTemplates) recognize them via the
 * predicates below. Keep producers and predicates here so a naming change
 * happens in one file.
 *
 * Two kinds of synthetic FunctionDefinition exist:
 *
 *   Form fn               `_form_submit_L<line>`
 *     One per `<form action>`. Owns the form's MAKES_REQUEST edge. Never
 *     a CALLS_FUNCTION target.
 *
 *   Per-process fn        `_<tag>_<event>_L<line>_<attr>`
 *     One per inline event-handler attribute. Anchors the inline JS body
 *     for resolveInlineHandlers / resolveAngularTemplates.
 *
 * The predicates distinguish them via the trailing `_<attr>` segment: the
 * form fn terminates at `_L<line>`; the per-process fn must have content
 * after.
 */

export function formFnName(line: number): string {
  return `_form_submit_L${line}`;
}

export function perProcessFnName(tag: string, event: string, line: number, attr: string): string {
  return `_${tag}_${event}_L${line}_${attr}`;
}

export function isFormFn(name: string): boolean {
  return /^_form_submit_L\d+$/.test(name);
}

export function isPerProcessSynthetic(name: string): boolean {
  return /^_[a-z]+_[a-zA-Z]+_L\d+_.+$/.test(name);
}

export function isHtmlSynthetic(name: string): boolean {
  return isFormFn(name) || isPerProcessSynthetic(name);
}
