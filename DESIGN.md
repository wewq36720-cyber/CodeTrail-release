# CodeTrail UI Contract

## Direction

CodeTrail is a local code-learning workbench, not a marketing page. The surface uses warm paper panels, one deep-green action color, monospaced file metadata, and a VS Code-like three-region learning workspace. Dense project data stays scannable through bounded panes, labels, and progressive disclosure.

## Tokens and surfaces

- Existing semantic tokens in `client/src/styles/themes.css` are the only color source.
- `--bg` is the application canvas, `--panel` is a persistent pane, and `--card` is a framed item.
- `--accent` is reserved for the current action, selected route, and active progress.
- Use the existing spacing (`--sp-*`), radius (`--r-*`), and shadow (`--sh-*`) tokens before adding a token.

## Workspace layout

- Header is fixed. The main shell is bounded by the viewport and has `min-height: 0` on scroll children.
- The AI view owns three regions: file tree on the left, conversation in the center, and step/editor workspace on the right.
- File tree opens by default and can be collapsed. Notes live at the bottom of the left region. The editor remains visible when the tree is collapsed.
- The two AI dividers are pointer-resizable and persist widths in local storage. Widths are clamped so the chat and editor remain usable.
- On narrow screens the regions become one vertical scroll sequence; no horizontal page overflow is allowed.

## Route and project semantics

- A route is created from a named template. Templates define stages and required evidence; code indexes and imported Markdown fill those slots.
- An imported course is a course with at least one saved route. The dashboard focuses on imported courses; unimported scanned projects are reported separately and never mixed into task cards.
- Dashboard task labels include course, route, stage, and step identity. Repeated route names are disambiguated without changing the stored route name.
- Large projects use a shallow, role-aware tree plus an index-ranked core file section. Full depth is available through lazy expansion and search.

## AI identities and translation

- The four assistant identities are: senior teacher (scaffolding), professional assistant (direct execution), analysis expert (evidence and trade-offs), and test/question specialist (test-first verification).
- Identity, model, and thinking intensity are explicit request context. Provider presets only fill fields; users can edit the compatible endpoint.
- Translation is a transient render layer. It never writes source files, route definitions, or notes. Markdown structure and code blocks remain intact. A whole-document action and per-paragraph actions share the same in-memory result cache.

## Required states

Every persistent pane has loading, empty, error, selected, and collapsed states. Every destructive route action confirms. Buttons use visible text plus an accessible label; icon-only controls have a tooltip.
