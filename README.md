# Timetabling Solver Demo

This small project shows how to turn an algebraic availability model into a
heuristic optimizer using `genetic-js-no-ww`.  It corresponds to the outline
from the conversation:

* availability predicates → feasibility functions
* preference weights → fitness scores
* `rrule` recurrence and conditional logic are supported
* genetic representation is just a slot index on a discretised timeline

## Installation

```bash
npm install @moonrockfamily/timetabling-solver
# or
pnpm add @moonrockfamily/timetabling-solver
```

## Getting started

```bash
# from project directory
npm install          # download dependencies
npm run build        # compile to dist/
npm start            # run compiled JS
# or during development
npm run dev          # run TypeScript directly via ts-node
```

## Quick start example

```ts
import { generateSlots, runGenetic } from '@moonrockfamily/timetabling-solver';

const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,17), 60);
const person = { name: 'Alice', preference: s => s.start.getHours() < 12 ? 1 : 0 };

const result = runGenetic(slots, [person]);
console.log(result);
```

The full API surface is exported from the package root; see `src/index.ts` for
TypeScript definitions and additional helpers (`runGeneticMulti`,
`assembleGroups`, etc.).  

### Tuning the genetic search

The GA is intentionally simple; by default `runGenetic` uses a population of 100
and runs for up to 500 generations.  For small slot pools the solver may not
always hit the global optimum on a single invocation.  You can improve
consistency by:

1. Increasing `size` and/or `iterations` (e.g. `{ size: 200, iterations: 1000 }`).
2. Using the new `restarts` option to rerun the GA several times and pick the
   best result:

```ts
const best = runGenetic(slots, people, {
  size: 50,
  iterations: 50,
  restarts: 10,      // try ten independent runs
});
```

### Heuristic defaults

If you just want a reasonable starting point without hand‑picking numbers,
call the helper `estimateOptions` with your slot list (and optionally the
array of meetings for multi-objective problems).  It will return a
`GARunOptions` object with a population size that grows with the number of
slots, a matching iterations count and a modest number of restarts based on
how many meetings you’re scheduling:

```ts
import { estimateOptions } from '@moonrockfamily/timetabling-solver';

const opts = estimateOptions(slots, meetings);
runGenetic(slots, people, opts);
```

The heuristic values are simple and capped (size is never more than 200) but
are enough to get you started; feel free to adjust them after observing the
behavior with the `notification` callback.

### Meta‑optimization & adaptive tuning

For users who want a truly data‑driven default, you can wrap the scheduler in
an outer genetic algorithm that *tunes the tunable parameters themselves*.
The idea is simple:

1. Define a small suite of representative problems – different slot sets,
   people, constraints, etc., ideally reflecting the kinds of schedules you
   expect in production.
2. Treat the GA configuration (`size`, `iterations`, `restarts`, possibly
   mutation/crossover rates or other genetic-js settings) as a chromosome.
3. For each candidate parameter chromosome, run the inner scheduler on every
   training problem and measure how well it performs (e.g. how often it
   reaches the optimal fitness, how many generations it takes).
4. Use those measurements to compute a fitness score for the candidate.
5. Evolve the population of candidates over many generations; the winner is
   a set of parameters that works well across the suite.

The repo includes a basic `runMetaGA` helper that implements the pattern
mentioned above; you can use it directly or adapt it to your own needs.  It
is intentionally minimal – the source in `src/metaOptimizer.ts` is a clean
starting point that demonstrates how to encode parameter ranges, run an inner
GA on each training problem, and evolve a population of parameter candidates.

Once trained, the outer GA gives you a principled, empirically tested default
configuration.  You can then layer lighter‑weight heuristics on top for each
individual scheduling request—for example, start with the tuned defaults and
then run a few short “trial runs” that tweak one or two parameters and pick
whatever variant converges fastest.

Because training can be expensive, this code is best run offline (e.g. as a
nightly job) or on a small representative sample.  Even without a dedicated
training pass you can reuse the helper to perform a handful of exploratory
runs and see which settings tend to perform well on your workload.

```ts
const best = runGenetic(slots, people, {
  size: 50,
  iterations: 50,
  restarts: 10,      // try ten independent runs
});
```

`runGeneticMulti` accepts the same parameters (including `restarts`) and also
an optional `scalariser` for aggregating meeting scores.  These knobs let you
trade off execution time for reliability depending on your use case.

### Observing generation statistics

For debugging or tuning you may want to peek inside the GA as it evolves.
The `GARunOptions` type includes a `notification` callback that is invoked at
each generation with the current population, generation number, statistics and
finished flag.

```ts
runGenetic(slots, people, {
  size: 50,
  iterations: 100,
  notification: (pop, gen, stats, finished) => {
    // `stats` comes from genetic-js; it may contain `maximum`/`minimum`/`mean`
    // or `max`/`min`/`average` depending on the library version.
    console.log(stats);
  }
});
```

## Development


The sample scenario in `src/index.ts` generates slots over the next two days
and defines two people (Alice & Bob) with different constraints.  The genetic
algorithm finds a slot that satisfies both and maximises the minimum
preference value.

Feel free to adapt the `people` array, slot generation, or the fitness
definition for your own requirements.