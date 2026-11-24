/**
 * The run page's one stylesheet, inlined in every page: the Content-Security-Policy allows inline
 * styles and nothing else, so the page uses system fonts and loads nothing. The values are the
 * reviewed design's: a serif verdict sentence, 44px step rows with a chevron
 * column, the step that explains the verdict tinted and barred in the failure colour, logs that
 * open at their last line, and a full-bleed layout below 600px.
 */
export const RUN_PAGE_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif; color: #1d2430; background: #f7f8fa; }
pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
a { color: #1d4f9e; }
a:focus-visible, summary:focus-visible { outline: 3px solid #2f6fd6; outline-offset: 2px; }
.page { max-width: 72rem; margin: 0 auto; padding: 2rem clamp(1rem, 4vw, 3rem) 1.5rem; }
.context { margin: 0; color: #4d5868; overflow-wrap: anywhere; }
.context strong { color: #1d2430; }
.verdict { font-family: ui-serif, "New York", Georgia, serif; font-weight: 600; font-size: clamp(1.8rem, 4.5vw, 2.8rem); line-height: 1.15; margin: 0.35rem 0 1.2rem; max-width: 22ch; letter-spacing: -0.01em; font-variant-numeric: lining-nums; overflow-wrap: anywhere; }
.verdict.fail { color: #9e1f27; }
.verdict.pass { color: #1f6b45; }
.verdict.none { color: #1d2430; }
.lede { margin: -0.4rem 0 1.4rem; max-width: 70ch; color: #3a4554; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.6rem 2rem; margin: 0 0 1.8rem; padding: 0 0 1.4rem; border-bottom: 1px solid #d5dbe3; }
.facts dt { font-size: 0.85rem; color: #5b6676; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.facts dd code { font-size: 0.875em; }
.steps { list-style: none; margin: 0; padding: 0; }
.row { border-bottom: 1px solid #e1e5eb; }
.row > details > summary, .row.nolog { display: grid; grid-template-columns: 2.2rem 1rem 1fr auto; gap: 0.5rem; align-items: baseline; padding: 0.65rem 0.25rem; min-height: 44px; }
.row > details > summary { list-style: none; cursor: pointer; }
.row > details > summary::-webkit-details-marker { display: none; }
.row > details > summary:hover { background: #eef1f5; }
.row.nolog { color: #5b6676; }
.n { font-variant-numeric: tabular-nums; color: #5b6676; text-align: right; }
.chev { color: #5b6676; font-size: 1em; }
.chev::before { content: "\\25B8"; }
details[open] > summary .chev::before { content: "\\25BE"; }
.name { min-width: 0; overflow-wrap: anywhere; }
.row > details[open] > summary .name { font-weight: 600; }
.out { font-size: 0.9rem; color: #5b6676; text-align: right; }
.out.pass { color: #1f6b45; }
.out.fail { color: #9e1f27; font-weight: 600; }
.out.continued { color: #9e1f27; }
.row.explains { border-left: 4px solid #9e1f27; margin-left: -4px; background: #fbeeee; }
.row.explains > details > summary:hover { background: #f5e0e1; }
.log-scroll { display: flex; flex-direction: column-reverse; max-height: 28rem; overflow: auto; margin: 0 0.5rem 0.8rem 3.95rem; background: #fff; border: 1px solid #d5dbe3; border-radius: 3px; }
.log { font-size: 13px; line-height: 1.5; padding: 0.75rem 0.9rem; }
.note { margin: 0 0.5rem 0.8rem 3.95rem; color: #5b6676; font-style: italic; overflow-wrap: anywhere; }
.log-scroll + .note { margin-top: -0.4rem; font-size: 0.8rem; }
.skiplist { margin: 0 0 0.8rem 3.95rem; padding: 0; list-style: none; color: #5b6676; columns: 2 16rem; font-size: 0.9rem; }
.skiplist li { overflow-wrap: anywhere; }
.foot { margin: 1.2rem 0 0; font-size: 0.85rem; color: #5b6676; overflow-wrap: anywhere; }
.reason { margin: 0 0 1.2rem; padding: 0.75rem 0.9rem; background: #fff; border: 1px solid #d5dbe3; border-radius: 3px; font-size: 13px; line-height: 1.5; }
@media (max-width: 600px) {
  .page { padding: 1.25rem 0.75rem 1rem; }
  .row > details > summary, .row.nolog { grid-template-columns: 1.5rem 0.9rem 1fr auto; gap: 0.4rem; }
  .out { max-width: 7rem; }
  .row.explains { margin-left: -0.75rem; margin-right: -0.75rem; padding-left: calc(0.75rem - 4px); padding-right: 0.75rem; }
  .log-scroll { margin: 0 0 0.8rem 0.25rem; }
  .log { padding: 0.6rem 0.65rem; }
  .note, .skiplist { margin-left: 0.5rem; }
}
`;
