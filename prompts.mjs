// prompts.mjs — the prompt surface the board sends back into a session.
//
// One registry of framing VARIANTS plus the core prompt builders, shared by
// runSession (baseline path) and the A/B harness (/api/ab). A "variant" is a
// PURE framing transform over a core instruction string, so any surface
// (fresh task, resume, or a review-comment batch) can be A/B-tested with the
// same knob: build the core once, then frame it N ways and run each fork.
//
// Keep frames deterministic and side-effect free — they must be safe to call
// repeatedly on the same core.

// Assemble the human's review comments into the exact instruction block the
// resume prompt has always used. Extracted verbatim from the old inline
// /api/review builder so the "baseline" variant reproduces prior behaviour.
export function commentBlock(comments) {
  return "The human reviewed your transcript and left feedback. Each item cites a turn and, when they highlighted a passage, the exact quote. Address every item:\n"
    + (Array.isArray(comments) ? comments : []).map((c) => {
      const q = c.quote ? ` re: "${String(c.quote).replace(/\s+/g, " ").trim().slice(0, 160)}"` : "";
      return `- [turn ${c.turn}${c.ref ? " · " + c.ref : ""}]${q} ${String(c.text || "").trim()}`;
    }).join("\n");
}

// The default spawn prompt (fresh start vs. --continue resume). Extracted
// verbatim from runSession so the baseline spawn is byte-identical.
export function freshPrompt(task, resuming) {
  const notes = task.notes ? (resuming ? `Current notes: ${task.notes}\n` : `Notes: ${task.notes}\n`) : "";
  return resuming
    ? `Resuming your board task ${task.id} ("${task.title}").\n` + notes + `Continue from where you left off; act on anything new since your last turn. Be concise.`
    : `You are an omp agent assigned to a shared board task.\nTask id: ${task.id}\nTitle: ${task.title}\n` + notes + `Do the work needed to complete this task. Be concise. Your reasoning and output are captured to the task automatically.`;
}

// The framing registry. `baseline` MUST be identity so an A/B run always has a
// true control arm equal to the shipped behaviour. Order = display order.
export const VARIANTS = [
  {
    id: "baseline",
    label: "Baseline",
    desc: "current wording, unmodified — the control arm",
    frame: (core) => core,
  },
  {
    id: "terse",
    label: "Terse",
    desc: "strip preamble, force minimal output",
    frame: (core) =>
      "Answer with maximum brevity. No preamble, no restatement, no summary.\n\n"
      + core
      + "\n\nReply only with the change made and a one-line result.",
  },
  {
    id: "structured",
    label: "Structured",
    desc: "explicit ordered plan + /board reporting",
    frame: (core) =>
      core
      + "\n\nProceed in order:\n"
      + "1) Restate what each item asks, one line each.\n"
      + "2) Make the change.\n"
      + "3) Verify it — run the specific check that would catch a regression.\n"
      + "4) Post a /board note summarizing what changed and how you verified.",
  },
  {
    id: "senior",
    label: "Senior-eng",
    desc: "senior-engineer persona, correctness-first",
    frame: (core) =>
      "You are a meticulous senior engineer. Weigh correctness first, then maintainability six months out. Name any risk or assumption you rely on.\n\n"
      + core,
  },
];

export const VARIANT_IDS = new Set(VARIANTS.map((v) => v.id));

// Frame a core instruction with the named variant (falls back to baseline for
// an unknown id so a stale client can never produce an empty prompt).
export function frame(variantId, core) {
  const v = VARIANTS.find((x) => x.id === variantId) || VARIANTS[0];
  return v.frame(core);
}

export function variantLabel(id) {
  const v = VARIANTS.find((x) => x.id === id);
  return v ? v.label : String(id || "");
}

// Serializable metadata for the browser variant picker (no `frame` fn).
export function variantMeta() {
  return VARIANTS.map(({ id, label, desc }) => ({ id, label, desc }));
}
