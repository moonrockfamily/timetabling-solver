# timetabling‑solver

**A lightweight scheduling engine** for finding feasible, high‑preference
meeting times in JavaScript/TypeScript.

`@moonrockfamily/timetabling-solver` delivers:

* composable availability rules and constraint objects,
* preference scoring via callbacks or rules,
* a lightweight genetic‑algorithm engine (`genetic-js-no-ww`),
* utilities for slot generation, ICS import/export, diagnostics, and tuning.

Embed it wherever you need to answer “which of these times work for everyone?”
or “what slot maximises preferences under hard constraints?” – in a service,
CLI, or any JS/TS runtime.

---

## Installation

```bash
npm install @moonrockfamily/timetabling-solver
# or
pnpm add @moonrockfamily/timetabling-solver
```

## Quick start

```ts
import {
  generateSlots,
  runGenetic,
  Participant,
} from '@moonrockfamily/timetabling-solver';

// build some hourly slots between 8am and noon
const start = new Date('2026-02-24T08:00:00');
const end   = new Date('2026-02-24T12:00:00');
const slots = generateSlots(start, end, 60);

const alice: Participant = {
  name: 'Alice',
  rules: [ctx => (ctx.start.getHours() < 10 ? 1 : 0.5)],
};

// Bob doesn’t care about time; an empty rule list is neutral.
const bob: Participant = { name: 'Bob', rules: [] };

const result = runGenetic(slots, [alice, bob]);
console.log('chosen slot index', result?.slotIndex);

// preferences are expressed exactly the same as availability: a rule that
// returns 0 marks infeasible, and any positive value in (0,1] is treated as
// a preference score. the overall slot score is the **minimum** returned by
// all rules (so a single hard constraint returning `Score.Preferred` makes
// every value ≤1 equivalent). to help readability a set of named constants
// (`Score.Infeasible`, `Score.Neutral`, `Score.Preferred`) is exported and
// recommended for rule authors.
// here Bob prefers early slots but will accept later ones; his rule never
// returns 0 so it acts purely as a soft score:
const scoringBob: Participant = {
  name: 'Bob 2',
  rules: [ctx => Score.Preferred - (ctx.start.getHours() - 8) / 4], // 1 at 8am, 0 at noon
};
const prefResult = runGenetic(slots, [alice, scoringBob]);
console.log('with Bob preference, picked', prefResult?.slotIndex);

// rules may be written directly or composed with constraint classes. here’s
// a simple time‑of‑day rule that isn’t tied to any particular date:
const morningRule = new Rule(ctx => {
  const h = ctx.start.getHours();
  return h >= 8 && h < 10 ? 1 : 0;
});

const alice2: Participant = { name: 'Alice2', rules: [morningRule] };
const res2 = runGenetic(slots, [alice2, bob]);
console.log('with rule-based alice, chosen index', res2?.slotIndex);

// you can also restrict availability using a recurrence rule. the
// `rrule` package is a dependency; create a set and turn it into a rule:
import { RRule } from 'rrule';
const weekdays = new RRule({ freq: RRule.WEEKLY, byweekday: [RRule.MO, RRule.WE, RRule.FR] });
const recurRule = new Rule(ctx => (weekdays.between(ctx.start, ctx.end, true).length > 0 ? Score.Preferred : Score.Infeasible));
const alice3: Participant = { name: 'Alice3', rules: [recurRule] };
const res3 = runGenetic(slots, [alice3, bob]);
console.log('alice3 available on M/W/F only →', res3?.slotIndex);

// rules can also block intervals, useful when marking times off-limits:
const blockLate = new Rule(ctx => {
  // return Score.Infeasible if the slot starts after 11am
  return ctx.start.getHours() >= 11 ? Score.Infeasible : Score.Preferred;
});
const bob2: Participant = { name: 'Bob2', rules: [blockLate] };
const res3 = runGenetic(slots, [alice, bob2]);
console.log('bob blocks late slots, result', res3?.slotIndex);
```

## Core concepts

* **Slot** – a simple `{ start: Date; end: Date }` interval.  Additional
  metadata such as `activity` or `location` may be appended for filtering.
* **Participant** – anyone attending. Feasibility and preference are
  governed by rules: functions returning `0` for infeasible or a positive
  score. A small set of named score constants (`Score.Infeasible`,
  `Score.Neutral`, `Score.Preferred`) is provided for readability. Constraint
  classes (`TimeConstraint`, `LocationConstraint`, `NoticeConstraint`,
  `CompositeConstraint`, …) are provided to build rules, but arbitrary logic
  works too.
* **Rule** – wrapper around a rule function that records whether it depends on
  the slot or on `now`, enabling optimisations.
* **Solver functions** – such as `runGenetic`, `runGeneticMulti`,
  `runGeneticTopN`, `runGeneticMultiTopN`, `isFeasible`, `fitness`, etc.
* **Helpers** – `generateSlots`, `estimateOptions`, `runMetaGA`,
  `filterFeasibleSlots`, `importICS`/`exportICS`, and more.

All of these symbols are exported from the package root; see `src/index.ts`
for the complete TypeScript definitions.

## Examples

Scenarios illustrating typical usage live in `examples/sample.ts`.  Run them
with:

```bash
npm run dev   # executes the example via ts-node
```

The file covers simple group meetings, multi‑objective batches (e.g. multiple
showings), and advanced cases such as composite availability, notice periods,
partial metadata, duration patterns, and diagnostics. Use it as a starting
point or copy relevant snippets into your own project.

---

## Tuning & advanced usage

### Heuristic defaults

`estimateOptions(slots, meetings?)` returns a sensible default GA configuration:
population size scales with the slot count and is capped at 200, iterations
and restarts are chosen based on problem size.

### Restarts and notifications

Pass `{ size, iterations, restarts, notification }` to `runGenetic` or
`runGeneticMulti` to trade off runtime against reliability and observe
per‑generation statistics.

### Meta‑optimization

`runMetaGA` searches for good GA settings over a collection of training
problems.  The supplied `defaultFeatureExtractor` encodes each problem as a
vector of slot/participant counts, rule counts, dependency hints, bookings and
other simple metrics; you can replace it with your own extractor if desired.

---

## Development

```bash
npm install
npm run dev   # rebuild & execute examples
npm run test  # run the full spec suite
```

The source in `src/` is intentionally readable; feel free to tweak constraints,
rules, or the solver itself.  Tests under `test/` double as usage examples and
regression checks.

---

Feel free to copy content from this README into your own documentation or
tailor the examples to your domain.