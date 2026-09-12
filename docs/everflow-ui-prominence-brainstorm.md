# Everflow in the UI — prominence & beginner-accessibility brainstorm

**Date:** 2026-09-12
**Scope:** everything a user sees that is Everflow — landing, intake, hub chrome, the Everflow
tab, the drawers. Diagnosis + idea list, prioritized. No implementation yet.

---

## 1. Where Everflow surfaces today (audit)

| # | Surface | Location | What it shows | Prominence verdict |
| --- | --- | --- | --- | --- |
| 1 | Landing eyebrow | `src/app/page.tsx` | `BRIEF / DOUBTS / GRAPH / BUILD / EVERFLOW` + subtitle line "keeps iterating on the project graph until every goal is met" | Buried in marketing copy. No "what is this" |
| 2 | Doubt session | `IntakeSession.tsx` (full-page takeover when status `intake`) | Growing graph skeleton, doubt cards with decider chips, expanded brief, build button | **Best moment in the product.** Full takeover, plain framing. The pattern everything else should borrow |
| 3 | Topbar buttons | `ProjectHub.tsx` | `needs you (n)` (attention state when > 0) + `mid-thought` → the two drawers | The only *ambient* Everflow surface. Good instinct, agent-flavoured names, no context ("why" is only in a tooltip) |
| 4 | Hub nav tab | `ProjectHub.tsx` TABS | "Everflow" — plain text, 2nd of 9 tabs, no badge, no icon, no state | Invisible. Reads like a settings page. This is the main home of the feature and it has zero live state on the tab |
| 5 | Overview tab | `OverviewPanel.tsx` | "What you got", copilot, atlas, "Dig in" links (parts/wiring/diagram/firmware/guide/quality), brief card | **The hook page never mentions goals, completion, or open asks.** Everflow is absent from the landing experience of every project |
| 6 | Everflow tab | `EverflowPanel.tsx` | Completion ribbon → loop-moves ledger (collapsed) → graph canvas (12 node kinds, 8 edge kinds, zoom/pan) + node inspector + per-node research → two channel columns | The actual content is rich, but it's a dense two-pane workbench. Everything a beginner needs (a sentence or five) is behind node-clicking |
| 7 | Drawers | `HumanDrawers.tsx` | Left: same asks as the tab's "AI needs you" column. Right: composer (note/idea/correction/resource/**steer**) | Duplicates surface #6 with *different* wording and a *different* type set (steer only here). Two places to answer the same question |

### Two findings that change the cost of the fixes

1. **`ProjectState.everflow.evaluation` is already in the hub's live stream on every page**
   (`src/types/project.ts` — the stream refetches the full project on every
   revision/status change). Completion %, open-ask counts, pass number, `done`,
   `blockedOnHuman` are all computable in `ProjectHub` today — **a live
   "goal status" chip in the topbar needs no API change.**
2. **`evaluation.brief` is computed, served (`brief: evaluation.brief` in
   `GET …/everflow`) and never rendered anywhere in the UI.** The architecture
   doc calls it "the context bundle the UI's Everflow tab leads with" — it
   doesn't. This is the most beginner-readable artifact the system already
   produces (goal, graph summary, dangling work, open asks in prose) and it's
   dead weight. One component, zero backend work.

Housekeeping: `src/app/wireup-styles.css` is not imported by anything —
`src/app/globals.css` is the live stylesheet. Don't edit the dead file.

---

## 2. Diagnosis — why it's not prominent, why it feels complex

**P1. The product's soul lives in tab 2 of 9.** The differentiator is "the
agent keeps working on your project and you can see exactly where every goal
stands and what it needs from you." That truth is only visible behind the
"Everflow" tab. After the build completes, the persistent chrome (topbar
badge + 6-step bar) goes quiet — the page *visually freezes* exactly when the
interesting part (the goal loop) starts.

**P2. "Everflow" is a codename, not a benefit.** A newbie sees a tab named
after an internal concept and assumes it's an expert/internals page. Compare:
"Check & fix" says what it does. The tab name carries the load of the whole
positioning and it fails it.

**P3. The graph canvas is the centerpiece, but it's a map without a legend for
the destination.** 12 node kinds (INTENT/CLAIM/ASSUMPTION/DECISION/GOAL/DOUBT/
EVIDENCE/TASK/ARTIFACT/SUBSYSTEM/TEST/REVIEW) × 8 colored edge relations, and
the legend only explains the 4 goal-state dots. A beginner stares at a
flowchart and can't answer the two questions that matter: *what's broken* and
*what do I do about it*. The plain-language answer exists (`brief`, node
`verdict` strings, the ribbon's `statusLine`) but each lives in a different
spot or not at all.

**P4. Jargon density.** Within two screens a newbie meets: pass, dangling,
fingerprint, revision v2, steer, mid-thought, default-on-expiry, decider,
choose/verify/context/review asks, "gates the build". The drawer does this
right once — "You don't have to answer: if you skip it, the agent defers and
keeps working" — but that pattern (print the consequence in plain words) is
the exception, not the rule.

**P5. Two homes for the same action.** Asks render in both the left drawer
and the tab's channel column with different wording; the human→AI composer
exists twice with different type sets (steer missing from the tab). For a
power user that's "ambient + detailed"; for a beginner it's "where do I
actually do this?"

**P6. No first-contact onboarding.** The doubt session onboards by *being* the
session. After the build, the Everflow tab appears fully dressed with no
explanation of what a node is, what a pass is, or that the agent is still
working. The "run another pass" button is the only action verb on the page.

---

## 3. Brainstorm

Cost: S = one component/tweaks · M = one focused PR with new state · L = multi-day.
Impact: how much it moves "newbie opens the app → understands what the agent
is doing and what it needs from them."

### A. Prominence — pull Everflow into the persistent chrome (the biggest lever)

**A1. Live "goal status" chip in the topbar** — S, high.
Next to the status badge: a small ring/segment bar with completion %, plus
state — green "all goals met", amber "2 need you" (click opens the existing
needs-you drawer), blue pulse "agent working" (running pass). Data already in
`stream.project.everflow.evaluation`. Click → `/everflow`. This alone makes
the loop visible on *every* tab, including Overview and Firmware, and keeps
moving after the build bar is done.

**A2. Renumber the ribbon of life** — S, medium.
The 6-step build bar dies at `completed`. Add a living 7th element below it
that keeps updating post-build: `loop · pass 4 · 84% of goals met · nothing
needs you` (→ "agent is waiting on you — 1 ask" in amber). Reuses
`evaluation`; no new surface.

**A3. Rename + badge the tab** — S, medium.
`Everflow` → **"Project map"** (or "Agent & you"), keeping "Everflow" as the
eyebrow inside the tab. Badge on the tab itself using the same `btn--attention`
pattern the topbar already uses: `· 2` when asks are open, ✓ when done. A
newbie should be able to tell, from the tab row alone, that something alive
lives there.

**A4. "Where your project stands" card on Overview** — S–M, high.
The hook page gets one card (above "Dig in", never below): completion ring +
`evaluation.brief` (render it for the first time), the 3–5 most important
unmet goals in plain language (from `evaluation.results`, filtered to
goal/behaviour nodes), `N things the agent needs from you` with a
**Answer now →** button, and "Open the project map →" as the CTA. This is the
funnel: Overview sells the loop, the tab serves it. Add Everflow to the "Dig
in" link list too.

### B. Clarity — make the Everflow tab beginner-first

**B1. Two-tier view: Plain (default) / Graph (toggle)** — M, highest impact
on the tab itself.
Plain mode is a single-column narrative, top to bottom:
1. **The brief** — `evaluation.brief` rendered in prose (finding §1.2).
2. **Promises** — behaviour goals as checklist chips: ✓ proven by the
   emulator · ✓ you confirmed · ⏳ being checked · ✋ needs you.
3. **Needs you** — the existing ask cards (they're already the most
   human-shaped UI in the app).
4. **Add to the agent** — the existing composer.
5. **Since you last looked** — loop moves in plain templates ("after your
   wiring edit, it re-checked the design — found 2 pin conflicts, fixed
   them — version 3"). The ledger data already exists; this is copywork.
Graph mode = the current canvas, untouched — full power preserved behind one
toggle, and it becomes the "I'm curious / this is my thing" view, which is
exactly who it serves today.

**B2. Group the 12 node kinds into 4 buckets** — S–M, medium.
Promises (intent/goal) · Choices (decision) · Guesses (assumption/doubt) ·
Proof (evidence/artifact/task/test/review/subsystem). Color by bucket, label
with the bucket name; the exact kind stays in the inspector. Legend gets
"how to read this: every box is a goal — the dot says where it stands".
Edge legend moves into the details toggle.

**B3. Node inspector: verdict first** — S, medium.
First line = the plain verdict, not the criterion: "Done — the emulator
proved it." / "Waiting on you to confirm (it's a guess)." / "No one is
working on this — that's the gap." Technical `goal.criterion` + source
provenance fold into a `<details>` ("technical detail", aligned with the
existing `details` toggle concept).

**B4. Jargon pass (copy-only)** — S, medium.
- "run another pass" → "keep working" (pass N stays in details mode)
- "dangling" → "unowned — no task on it"
- "Loop moves — what the agent did itself before asking you" — **keep**, it's good
- "AI NEEDS YOU / YOU ADD TO AI" — **keep**, punchy and correct
- "skip → assume '…'" — keep, already self-explaining
- everywhere: copy the drawer's "You don't have to answer: …" pattern
  (consequence printed in plain words, never the term *default-on-expiry*)

**B5. First-visit 3-panel explainer** — S, low–medium.
One-time overlay on the tab (localStorage flag): ① "Every box in this map is
a goal your project must hit. The dot says where it stands." ② "The agent
keeps working on the map by itself — it only asks you what it can't close
alone, and it never blocks on you." ③ "Anything you know that it can't, goes
in the right column. A design change always comes back to you as a question."
Three dismissible cards; the doubt session's tone, reused.

### C. Structure — one home per action

**C1. Unify the human channel** — M, medium.
Keep the drawer as the *ambient* surface (it's the good idea — asks reachable
from any tab), but make the tab's channel column the *canonical* one: same
wording, same type set (add `steer` or explicitly hide it with the same
"honest about what's available" behaviour the drawer has), and when an ask
is answered in one, the other updates from the same stream (already the
mechanism — the drawers and panel just render different subsets today).
Optionally, in the drawer footer: "Full history on the Project map →".

**C2. Kill the dead stylesheet** — S, housekeeping.
Delete `src/app/wireup-styles.css` (not imported anywhere) so the next edit
doesn't land in the wrong file.

### D. Direction — medium term

**D1. Agent ticker** — M.
A compact plain-language activity feed (Overview card or under the status
ribbon) generated from the existing `everflow_move` + `everflow_pass` events
with fixed templates: "re-checked the design after your edit", "proved:
stops before obstacles ✓", "asked you: does the car actually turn?". The
loop becomes *watchable*, not just inspectable.

**D2. "Every goal met" moment** — S–M.
When `evaluation.done`, the ribbon flips to a celebratory-but-honest
"Every goal met" state and Overview gains a *proof summary*: which promises
were proven by the emulator, which by you, which by the check engine — the
beginner-readable version of the validation report. This is the "why should
I trust it" moment, currently absent.

**D3. Node → file deep links** — M (the documented "remaining half").
Artifact/decision nodes link into the right tab (parts/firmware/wiring) with
the file highlighted. Makes the graph feel like a *map of your project*, not
a diagram beside it.

---

## 4. Suggested sequence

| Wave | Items | Why this order |
| --- | --- | --- |
| **P0 (prominence, all S)** ✅ built 2026-09-12 | A1 topbar chip · A4 Overview card (renders `brief`) · A3 tab rename+badge | Pure presentation over data that already flows. After this, Everflow is visible on every screen a beginner actually lives in — before touching the tab's interior |
| **P1 (clarity)** | B1 plain/graph tier · B3 verdict-first inspector · B4 jargon pass · A2 ribbon | The tab becomes approachable while keeping the full graph for power users |
| **P2 (structure)** | C1 channel unification · B2 node buckets · B5 explainer | Consistency + onboarding once the shape is settled |
| **P3 (direction)** | D1 ticker · D2 done-moment · D3 deep links · C2 cleanup | The "watchable agent" and trust layer |

**Biggest single wins:** A4 (the `brief` that's computed but never shown, on
the one page every project visits) and A1 (live loop state in the topbar,
free data). Together they fix "not prominent" without a redesign.

### What P0 actually shipped

- **A1** — `GoalChip` in `ProjectHub.tsx`: a ring + state line in the topbar
  crumb (`building` · `63% · pass N` · `63% · 2 need you` · `all goals met`).
  Tone: olive pulse (working) / amber (waiting on you) / green (done). Click
  opens the needs-you drawer when asks are open, else the project map.
  Hidden during intake. Pure stream data — no API change.
- **A3** — tab renamed `Everflow` → **Project map** (URL stays `/everflow`),
  with a live badge: amber ask-count while asks are open, green ✓ when done.
  The "everflow · the goal map" name + one-line plain-language explanation
  now lives as a header inside the tab (`EverflowPanel` `evf-headline`).
- **A4** — `GoalStandCard` on the Overview ("Where your project stands"):
  completion ring, one-sentence status, the promises as a plain checklist
  (met / needs you / in flight), visible guesses ("it is guessing on: …"),
  unowned goals, and **`evaluation.brief` rendered for the first time** in a
  collapsed "the agent's working document" section. Footer CTA adapts:
  "Answer the agent →" when asks are open, "Open the project map →" otherwise.
  During the first build it says the goal map is coming online. "Project map"
  also joined the "Dig in" link list.
- **Liveness fix found while building** — `useProjectStream` only refetched
  the full project on revision moves / terminal, so asks filed by a
  background pass would leave the chip and card stale. Everflow-state events
  (`everflow_pass`, `everflow_move`, `human_task_*`, `injection_registered`,
  `intake_*`, `rebuild_started`, `research_completed`, `idea_graph_*`) now
  also trigger a full refetch. Rare, pass-paced events — cheap.
- **Not touched** — `GraphCanvas` and everything inside the graph view
  (it works; the request was prominence + simplicity, not a graph change).
  All new CSS in `src/app/globals.css` (the live stylesheet), classes
  `goal-chip`, `goal-ring`, `hub__tab-badge`, `evf-headline`, `mapcard*`.
- **Proof** — typecheck clean, `next build` clean, `verify:everflow` +
  `verify:graph` green; live-verified in dev: intake (chip hidden), running
  (chip "building", card "coming online" → in-flight), completed (chip
  "63% · 1 needs you", badge "1", card "Parked on you …" + CTA
  "Answer the agent →"), answered ask → pass 7 → chip/badge follow the new
  state.

## 5. Open questions

1. Tab name: "Project map" vs "Agent & you" vs keeping "Everflow" with a
   subtitle? (The name *is* the positioning for newbies.)
2. Does the plain/graph default belong to everyone, or first-visit-plain-then-remember?
3. Overview card: always visible, or only once a pass has run (avoid a 0% ring
   during the first build)?
4. Is `steer` meant to stay gated (env + model) — should the tab column hide
   it the way the drawer does, or show it disabled with the honest reason?
