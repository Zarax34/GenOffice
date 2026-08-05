---
title: "PDF Content-Editing Engine for GenOffice AI"
status: draft
owners: ["pdf-engine", "ai-pdf"]
created: "2026-08-05"
---

# PDF Content-Editing Engine Implementation Plan

> **For executors:** This plan is the single source of truth. It is split into **independent workstreams (WS-0 … WS-9)** so multiple agents can work in parallel **without touching the same files**. Read §5 (Ownership Matrix) and §8 (Coordination Protocol) before starting any task.

**Goal:** Make GenOffice's PDF app capable of editing **any** content inside a PDF file — original text, fonts/styles, embedded images, tables, and existing watermarks — driven by the AI agent, with a byte-stable round trip for untouched content.

**Architecture:** Add a new pure-TypeScript package `packages/pdf-content-engine` (no Electron dependency, unit-tested) modeled on the existing `packages/docx-engine` and `packages/pptx-engine` precedents. It parses a PDF into a semantic page model (text runs / lines / blocks, images, vector paths, annotations, form fields), applies typed edit operations, and rewrites **only the changed content streams** — everything the editor didn't touch survives byte-for-byte (the same philosophy as docx paragraph-patching). The main process (`apps/pdf/src/main`) hosts the engine (pdf.js + pdf-lib run in Node); the renderer AI agent gains new tools that call the engine through typed IPC. The current overlay/annotation path is preserved untouched.

**Tech Stack:** TypeScript, `pdfjs-dist` (legacy build, pure JS — already a dependency, used by `packages/file-parse/src/pdf.ts`), `pdf-lib` (already a dependency), Vitest, bundled Noto CJK subsets (already in `apps/*/out/renderer/assets`) for font embedding.

---

## 1. Scope — what "edit ANY PDF content" means, concretely

### 1.1 In scope (must support)

| # | Capability | Concrete meaning |
|---|-------------|------------------|
| C1 | **Edit original text** | Replace, insert, or delete a text fragment **in place** on a page (fix a word, change a number), preserving surrounding layout where feasible. |
| C2 | **Change text style** | Modify font family, size, color, weight for a text run on a page. |
| C3 | **Replace/insert images** | Swap an embedded raster (XObject Image) with a new image, or add a new image at a rect. |
| C4 | **Edit existing watermarks** | Detect and remove or restyle a watermark already present in the file (text or image). |
| C5 | **Add watermarks/headers/footers/page numbers** | Already partially supported via the `StampInput` overlay layer; extend to true content-stream embedding (selectable text, not raster). |
| C6 | **Tables** | Edit tabular content. Two tiers: (a) **reconstruct** a visually detected table into a semantic model and re-emit; (b) if reconstruction fails, treat as vector primitives (lines + text) and edit in place. |
| C7 | **Redact** | Remove a text fragment and optionally overlay a black box, stripping the underlying text from the content stream (not just an annotation). |
| C8 | **Metadata** | Edit title/author/subject/keywords (already supported via `MetadataInput`; keep). |

### 1.2 Explicit non-goals (out of scope for this plan)

- **Reflowing full paragraphs across pages** (PDF has no flow model; we edit in place and avoid layout collapse). Documented limitation, not a blocker.
- **OCR of scanned PDFs** (no text layer). Marked read-only-with-OCR-hint; a future plan can add `ocr_page` via an external engine.
- **Re-encryption / breaking owner passwords.** Encrypted PDFs stay read-only (current `readOnly()` behavior preserved).
- **Editing interactive form field definitions** (only filling values, already supported).
- **Editing embedded 3D, video, or JavaScript annotations.**

### 1.3 Honesty guardrail
Every content edit returns a **fidelity report** (what changed, what was preserved, any reflow risk). The agent must surface reflow risk to the user before applying irreversible structural changes. No silent layout breakage.

---

## 2. Current state (gap analysis)

### 2.1 What exists and is reused
- `apps/pdf/src/main/save-pdf.ts` — writes markups/drawings/stamps/form values/rotations/deletions/reorder/metadata into the PDF via `pdf-lib`. **Overlay-only**; does not touch page content streams.
- `apps/pdf/src/shared/ipc.ts` — `SavePdfRequest`, `MarkupInput`, `DrawingInput`, `StampInput`, `FormValueInput`, `MetadataInput`, `ExtractPagesRequest`, `InsertPdfRequest`, `ExportImagesRequest`.
- `apps/pdf/src/renderer/ai/tools.ts` — `AGENT_TOOLS` = `read_pages`, `search_text`, `goto_page`, `markup_text`, `list_form_fields`, `fill_form_field`, `rotate_page`, `delete_page`, `get_outline`. `PdfAiDeps` capability surface. `executePdfTool` dispatcher.
- `apps/pdf/src/renderer/ai/pdf-skill.ts` — `SYSTEM_PROMPT` (currently "read, annotate, organize" only) + `createPdfSkill`.
- `packages/file-parse/src/pdf.ts` — `pdfToText()` using `pdfjs-dist/legacy/build/pdf.mjs` (precedent for running pdf.js in Node).
- `packages/agent-core` — `AgentLoop`, `AgentSkill`, `AgentToolDef`, `AgentToolCall`, `ToolExecution`, `createIpcTransport`.
- Precedent engines: `packages/docx-engine` (parse → block tree + `docxIndex` anchors + byte-level patch), `packages/pptx-engine`. **The docx engine's byte-stable patch philosophy is the template for `pdf-content-engine`.**

### 2.2 The gaps this plan fills
| Gap | Where |
|-----|-------|
| No semantic PDF model (text runs/lines/blocks with font refs + positions) | new `packages/pdf-content-engine/src/parse.ts` |
| No content-stream patcher (rewrite only changed operators) | new `.../src/patch.ts` |
| No font embed/subset pipeline incl. CJK | new `.../src/fonts.ts` |
| No image XObject replace/insert | new `.../src/images.ts` |
| No text-edit operations (replace/style/redact) | new `.../src/text-ops.ts` |
| No watermark detection/removal | new `.../src/watermark.ts` |
| No table reconstruction | new `.../src/tables.ts` |
| No IPC bridge renderer AI → main-process engine | new `apps/pdf/src/main/pdf-content-ipc.ts` |
| AI tools stop at markup/form/rotate/delete | extend `apps/pdf/src/renderer/ai/tools.ts` |
| AI prompt says "annotate only" | extend `apps/pdf/src/renderer/ai/pdf-skill.ts` + new `prompts/guides/pdf-editing.md` |

---

## 3. Architecture

### 3.1 New package: `packages/pdf-content-engine`
- Pure TypeScript, **no Electron dependency** (unit-tests like docx-engine/pptx-engine).
- `exports: "." → ./src/index.ts` (consistent with sibling packages).
- Depends on `pdfjs-dist` and `pdf-lib` (already at root).
- Runs in the **Electron main process** (Node) where pdf.js + pdf-lib are available; the renderer never imports it directly (avoids bundling ~MBs into the renderer and avoids CORS).

### 3.2 Round-trip philosophy (copy from docx-engine)
```
open pdf ─► archive original bytes (never mutated)
         ─► pdf-content-engine parse → ParsedPdf (pages, each with anchored
            text runs / images / paths / annots / form fields)
edit      ─► typed operations build an edit journal (per-page, per-object)
save      ─► only changed content streams are re-serialized and spliced into
            the original page objects; all other objects copied byte-for-byte
         ─► repack; untouched pages/objects survive untouched
```
Invariant: opening a PDF and saving with **no edits** produces a byte-identical file (the docx-engine invariant, applied to PDF). This is the acceptance gate for the patcher.

### 3.3 Where each piece runs
| Layer | Process | Responsibility |
|-------|---------|-----------------|
| `packages/pdf-content-engine` | Node (main) | parse, edit ops, serialize/patch |
| `apps/pdf/src/main/pdf-content-ipc.ts` | Node (main) | IPC handlers: `pdf:parse`, `pdf:read-model`, `pdf:apply-edits`, `pdf:preview-edit` |
| `apps/pdf/src/main/save-pdf.ts` | Node (main) | merges content edits + existing overlay edits into one save |
| `apps/pdf/src/renderer/ai/tools.ts` | renderer | new agent tools call IPC; existing overlay tools unchanged |
| `apps/pdf/src/renderer/ai/pdf-skill.ts` | renderer | extended prompt + `load_guide` for the editing catalog |

### 3.4 Edit journal (single source of truth for changes)
All content edits accumulate in an **`EditJournal`** (per file session) before save — mirroring the sheets `editJournal` pattern. This lets `⌘Z` undo content edits (not just overlays), and lets the save path merge content + overlay edits transactionally.

#### 3.4.1 EditJournal structure
```ts
interface EditJournal { version: string; pages: Record<number, PageEdit[]> }
type PageEdit = ReplaceTextRun | ReplaceImage | EditTable | AddContent | RemoveObject
type ContentRef = { page: number; id: string } // id = Tj index in content stream or XObject /Name
type ReplaceTextRun = { op: 'replaceText'; ref: ContentRef; newText: string; style?: Partial<TextStyle> }
type ReplaceImage   = { op: 'replaceImage'; ref: ContentRef; newImageBytes: Uint8Array; rect?: Rect }
type EditTable      = { op: 'editTable'; tableId: string; cellEdits: Record<string, string> }
type AddContent     = { op: 'addContent'; page: number; content: AddableContent }
type RemoveObject   = { op: 'remove'; ref: ContentRef }
```

#### 3.4.2 Patching algorithm (byte-stable)
For each page in `pages`:
1. Load original page object (from pdf-lib copy of the doc).
2. Re-parse only that page's content stream (pdf.js `getOperatorArray` gives glyphs with font + matrix).
3. Apply journal entries for this page -> build new content stream string.
4. `page.node.set(PDFName.of('Contents'), newStream)` with the **same filters + DecodeParms** as the original stream -> no bloat, preserves compression.
5. Untouched pages: copy object reference unchanged -> **byte-stable for untouched pages**.
6. Post-condition (enforced by a test): empty journal => `sha256(out) == sha256(in)`.

---

## 4. Phase breakdown / roadmap

| Phase | Goal | Core capabilities | Exit criteria |
|-------|------|-------------------|---------------|
| **P0** | Foundations | `replace_text_content` (simple run) + `replace_image_xobject` + IPC + AI tool calls | typecheck + 3 sample PDFs (text/rich/image) parsed; round-trip identity test passes |
| **P1** | Font/style aware | C2 font/style change; Noto CJK subset embed; reflow risk report | font substitution works on 1 CJK paragraph; fidelity report surfaced |
| **P2** | Tables & watermarks | C4 detect+edit watermark; C6 table recon -> re-emit grid | `edit_table` on 1 grid + 1 borderless; watermark removal selectable text |
| **P3** | Agent autonomy | AI chains multi-edit; merged save (content + overlay) | 3 agent scenarios in `examples/pdf-scenarios.md` pass end-to-end |

### 4.1 Acceptance tests (run every phase)
- `roundtrip_identity`: open -> empty journal -> save -> `sha256` equals original.
- `touched_only`: edit page 3 only; pages 1,2,4,5 byte-identical.
- `preserve_encryption_state`, `preserve_links`, `preserve_form_fields`.

---

## 5. Task breakdown & ownership matrix

Independent work-packages (WP) — each owned by one agent; file ranges never overlap. Claim via `.agents/<WP>.claimed`.

| WP ID | Name | Files owned | Agent role |
|-------|------|-------------|-----------|
| WP-A | engine core (parse/edit/serialize) | `packages/pdf-content-engine/src/{index,parse,patch}.ts` | @pdf-engineer |
| WP-B | Font/Subset embedder | `packages/pdf-content-engine/src/fonts.ts` | @pdf-engineer |
| WP-C | Layout/Table/Watermark recon | `packages/pdf-content-engine/src/{layout,tables,watermark}.ts` | @layout-specialist |
| WP-D | Image ops | `packages/pdf-content-engine/src/images.ts` | @pdf-engineer |
| WP-E | IPC bridge (main) | `apps/pdf/src/main/pdf-content-ipc.ts` | @electron-backend |
| WP-F | AI agent tools (renderer) | `apps/pdf/src/renderer/ai/tools.ts` | @ai-agent-coder |
| WP-G | AI guide + prompt | `prompts/guides/pdf-editing.md` | @ai-agent-coder |

Atomic tasks (in `PLAN_tasks.csv`):
csv
ID,WP,Task,Owner,Priority,DependsOn,EstHours,Status
T01,WP-A,Design ParsedPdf model,@pdf-engineer,P0,,32,TODO
T02,WP-A,Build content stream parser,@pdf-engineer,P0,T01,48,TODO
T03,WP-A,Write roundtrip-identity test,@pdf-engineer,P0,,12,TODO
T04,WP-A,Implement patcher splice,@pdf-engineer,P0,T02,36,TODO
T05,WP-B,Font subsetting analysis,@pdf-engineer,P1,,24,TODO
T06,WP-B,Font substitution+embed,@pdf-engineer,P1,T05,40,TODO
T07,WP-C,Table detection,@layout-specialist,P1,T02,40,TODO
T08,WP-C,Table serialization,@layout-specialist,P1,T07,32,TODO
T09,WP-D,Image XObject replace/insert,@pdf-engineer,P0,T04,20,TODO
T10,WP-C,Watermark detect+remove,@layout-specialist,P1,T07,28,TODO
T11,WP-E,IPC handlers,@electron-backend,P0,T04,T09,TODO
T12,WP-E,Merge into save-pdf.ts,@electron-backend,P0,T11,16,TODO
T13,WP-F,New AI tools,@ai-agent-coder,P0,T11,24,TODO
T14,WP-F,Wire tools->IPC,@ai-agent-coder,P0,T13,20,TODO
T15,WP-G,Write pdf-editing.md guide,@ai-agent-coder,P0,,16,IN_PROGRESS
T16,P0,Phase 0 deliverable,@lead,P0,T01-T15,TODO
csv-end

---
## 6. Key interfaces

### 6.1 Engine -> AI agent (renderer) `apps/pdf/src/renderer/ai/tools.ts`
```ts
tool replace_text_content(content: ContentRef, newText: string, style?: Partial<TextStyle>): Promise<FidelityReport>
tool replace_image(content: ContentRef, newImageBytes: Uint8Array, rect?: Rect): Promise<FidelityReport>
tool edit_table(tableId: string, cellEdits: Record<string,string>): Promise<FidelityReport>
tool remove_watermark(wmarkId: string): Promise<FidelityReport>
type FidelityReport = { changedRefs: ContentRef[]; reflowRisk: 'low'|'medium'|'high'; notes: string[] }
```

### 6.2 AI -> main process (IPC)
```ts
type ContentRef = { page: number; id: string }
ipc.invoke('pdf:preview-edit', { journal: EditJournal }): Promise<Diff>  // dry-run
ipc.send('pdf:apply-edits', { journal: EditJournal }): void            // apply
ipc.send('pdf:save-merged', { filename }): void                          // save content+overlay
```

### 6.3 Engine internals `@genoffice/pdf-content-engine`
```ts
ParsedPage { pageNumber, text: TextRun[], images, paths, annotations, tables, fonts, opList }
EditJournal { version, pages: Record<number, PageEdit[]> }
export class PdfContentEngine { parse(bytes): ParsedPdf; patch(bytes, journal): Uint8Array }
```

---
## 7. Coordination protocol

1. Claim via `claim --wp WP-X` (writes `.agents/<WP>.claimed`); if locked, pick another WP.
2. Types in `types.ts` are the **shared contract** — never change exported types without `#breaking-change:` + notice in `#pdf-edits`.
3. Tests touch the engine, not the renderer (mock `electron` in renderer tests).
4. CI gate per phase: `npm run test -w pdf-content-engine` + `node tools/roundtrip-sample.js samples/*.pdf`.
5. Overlapping file-claim => auto-notify `#pdf-edits`; lead arbitrates.

---
## 8. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Stream splicing corrupts downstream objects | High | byte-stable post-condition test (4.1) |
| CJK font embedding bloat | High | subset embedding; cap 5MB/page |
| AI hallucinates nonexistent ContentRef | Medium | `preview-edit` validates refs; re-ask on NotFound |
| Reflow breaks layout | High | `reflowRisk` + confirm-before-apply |
| pdfjs-dist version drift | Medium | pin `pdfjs-dist@^5.4.54` (matches file-parse) |

---
## 9. Definition of done

- P0 text/image edit works on 3 sample PDFs.
- `npm run test -w pdf-content-engine` >= 85% coverage.
- Round-trip identity (empty journal) => byte-identical output.
- Edited text is **selectable/searchable** (not raster overlay).
- `npm run typecheck` clean for pdf-content-engine + `@genoffice/pdf`.
- `prompts/guides/pdf-editing.md` loaded by AI agent and referenced in `pdf-skill.ts`.

---
## 10. References / precedents
- `./packages/docx-engine` (paragraph-patch + byte-stable invariant).
- `./packages/pptx-engine` (slide XML patching).
- `./packages/file-parse/src/pdf.ts` (pdfjs-dist legacy import pattern).
- `./apps/sheets/src/renderer/ai/AiChatPanel.tsx` (edit journal UI pattern).
