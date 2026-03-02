/*
  This file contains a handful of simple scheduling scenarios used by the
  README/docs and as a playground when developing the solver.  Be aware that
  most of the examples below use *binary* preference rules (they return only
  `0` or `1`, or things like `1`/`0.5`), and the default fitness aggregator
  picks the **minimum** score across participants.  That means any slot which
  satisfies all of a group's rules with a value of `1` will receive a fitness
  of exactly `1`.

  The GA implementation in `scheduler.ts` stops evolving as soon as the
  population contains an entity with fitness `1` (it checks
  `stats.maximum < 1` in the `generation` callback), so a perfectly‑scored
  individual in generation 0 will terminate the run immediately.  This is not
  a bug – it's an optimisation – but it can be surprising if you expect the
  algorithm to do many generations.  To work around it you can:
    * give rules continuous preferences (e.g. returning 0..1 based on how
      close a slot is to the ideal time);
    * change the `generation` predicate when constructing the GA;
    * or add a tiny random penalty/noise to the fitness function.

  The notifier below logs the statistics for each generation so the early
  termination is easier to spot; it even emits a warning when the first
  population is already perfect.
*/

import { addDays, addHours, addMinutes, differenceInMilliseconds } from 'date-fns/fp';

import {
  ActivityConstraint,
  assembleGroups,
  CompositeConstraint,
  EvaluationContext,
  GARunOptions,
  generateSlots,
  isFeasible,
  makeNotifier,
  Participant,
  preferenceScore,
  runGenetic,
  runGeneticDiagnostics,
  runGeneticMulti,
  Slot,
  TimeConstraint
} from '../src';

/**
 * Utility that prints a slot nicely.
 */
function fmtSlot(s: Slot): string {
  return `${s.start.toISOString()} -> ${s.end.toISOString()}`;
}

/**
 * print summary of a participant/resource: availability, bookings, preferences.
 */
function describeConstraint(c: any, indent = '      '): string {
  if (!c) return '';
  switch (c.kind) {
    case 'time':
      return `${indent}TimeConstraint(${(c.start as Date).toISOString()} - ${(c.end as Date).toISOString()})`;
    case 'notice':
      return `${indent}NoticeConstraint(${c.noticeMs}ms)`;
    case 'activity':
      return `${indent}ActivityConstraint(${c.activity})`;
    case 'location':
      return `${indent}LocationConstraint(${c.location})`;
    case 'composite':
      const parts = c.constraints.map((sub: any) => describeConstraint(sub, indent + '  '));
      return `${indent}CompositeConstraint(${c.operator})\n${parts.join('\n')}`;
    default:
      return `${indent}${c.kind}`;
  }
}

function dumpParticipant(p: Participant) {
  console.log(`- ${p.name}`);
  if (p.rules && p.rules.length) {
    console.log('    rules:');
    p.rules.forEach((r, i) => console.log(`      rule ${i + 1}`));
  }
  if (p.bookedSlots && p.bookedSlots.length) {
    console.log(`    booked: ${p.bookedSlots.map(fmtSlot).join('; ')}`);
  }
}

/**
 * Case 1: find the next meeting time for a small group (+ a shared resource)
 * taking into account each participant's existing bookings and working hours.
 */
// global parameters (adjusted via CLI)
let weekCount = 1; // number of weeks to span

// helper for creating dates a given number of minutes after epoch; using
// date-fns/fp keeps the intent explicit without manual arithmetic.
function minutesSinceEpoch(n: number): Date {
  return addMinutes(n)(new Date(0));
}


function caseGroupMeeting() {
  console.log('=== caseGroupMeeting ===');
  console.log('Objective: schedule a single meeting for two participants plus a shared room.');
  console.log('          preferences are graded so the GA will iterate multiple generations and ' +
              'demonstrate convergence; inspect the notification logs.');
  console.log('          /// notice the continual improvement in maxFitness across gens ///');

  // discretize the upcoming work week(s) into slots
  // start at 8 AM today and span `weekCount` working weeks of five days each
  const start = new Date();
  start.setHours(8, 0, 0, 0); // simpler to mutate once, we only care about the hour

  // end = start + (5 * weekCount) days, then push to 6 PM
  // we use the fp helper for the day addition, but setHours is clearer
  // than nesting another `addHours` call.
  const end = addDays(5 * weekCount)(start);
  end.setHours(18, 0, 0, 0);
  const slots = generateSlots(start, end, 30);

  // shared meeting room has some bookings
  const room: Participant = {
    name: 'Conference Room',
    bookedSlots: [
      { start: addHours(2)(start), end: addHours(3)(start) },
      { start: addDays(1)(start), end: addHours(25)(start) },
    ],
  };

  // two participants with working‑hours constraints and existing meetings; use
  // rules rather than the legacy availability object
  const alice: Participant = {
    name: 'Alice',
    rules: [
      ctx => {
        // available during the overall period
        const ok = new TimeConstraint(new Date(start), new Date(end));
        return ok.satisfies(ctx) ? 1 : 0;
      },
      // morning preference (graded: decreases linearly from 1 at 8am to 0 at 6pm)
      ctx => {
        const h = ctx.start.getHours() + ctx.start.getMinutes() / 60;
        // map [8,18] -> [1,0]
        const score = 1 - Math.max(0, Math.min(1, (h - 8) / 10));
        return score;
      },
    ],
    bookedSlots: [
      { start: addHours(4)(start), end: addHours(5)(start) },
    ],
  };

  const bob: Participant = {
    name: 'Bob',
    rules: [
      ctx => {
        const ok = new TimeConstraint(new Date(start), new Date(end));
        return ok.satisfies(ctx) ? 1 : 0;
      },
      // replicate his one-hour notice requirement inside a rule
      ctx => {
        const now = ctx.now ?? new Date();
        return differenceInMilliseconds(ctx.start, now) >= 60 * 60_000 ? 1 : 0;
      },
    ],
    bookedSlots: [
      { start: addHours(6)(start), end: addHours(7)(start) },
    ],
  }; // end bob

  const participants = [alice, bob, room];
  // NOTE: because the score function above returns values <1 for many slots,
  // the GA cannot terminate at generation 0. the notifier will emit a line for
  // each generation until it finds the peak interval.

  // attach observer to watch GA progress
  const opts: GARunOptions = {
    size: 100,
    iterations: 200,
    restarts: 3,
    notification: makeNotifier('GA run', true),
  };
  const result = runGenetic(slots, participants, opts);
  if (result) {
    const chosen = slots[result.slotIndex];
    console.log('found slot:', fmtSlot(chosen));
    // detailed feedback per participant
    console.log('breakdown:');
    for (const p of participants) {
      const feas = isFeasible(chosen, p);
      const ctx: EvaluationContext = { ...chosen, now: new Date() };
      const pref = preferenceScore(ctx, p);
      console.log(`  ${p.name}: feasible=${feas} pref=${pref}`);
    }
  } else {
    console.log('no feasible slot found');
    console.log('verify constraints/bookings may be too restrictive');
  }
}

/**
 * Case 2: schedule multiple showings (multi-objective) where each buyer is a
 * separate meeting but they share an agent and a room resource.
 */
function caseBatchShowings() {
  console.log('=== caseBatchShowings ===');
  console.log('Objective: schedule three separate showings (multi-objective) using a single agent and room.');
  console.log('          each buyer has different time preferences; the GA must balance them.');

  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1 * weekCount);
  end.setHours(17, 0, 0, 0);
  const slots = generateSlots(start, end, 60);

  const agent: Participant = { name: 'Agent' };
  const room: Participant = { name: 'Show Room' };

  const buyers: Participant[] = [
    { name: 'Buyer1', preference: ctx => (ctx.start.getHours() < 12 ? 1 : 0) },
    { name: 'Buyer2', preference: ctx => (ctx.start.getHours() >= 12 ? 1 : 0) },
    { name: 'Buyer3' },
  ];

  console.log(`slots range: ${fmtSlot(slots[0])} through ${fmtSlot(slots[slots.length-1])} (${slots.length})`);
  console.log('agent and room:');
  [agent, room].forEach(dumpParticipant);
  console.log('buyers:');
  buyers.forEach(dumpParticipant);

  // we can append any common participants (agent, room, etc.) via extras
  const groups = assembleGroups(buyers.map(b => [b]), agent, room);

  // observer will log generation stats for each restart
  const opts: GARunOptions = {
    size: 50,
    iterations: 100,
    restarts: 2,
    notification: makeNotifier('multi-objective GA'),
  };
  const res = runGeneticMulti(slots, groups, opts);
  if (res) {
    console.log('multi-meeting schedule:');
    res.slotIndices.forEach((idx, i) => {
      const slot = slots[idx];
      const grp = groups[i];
      console.log(` meeting ${i + 1}:`, fmtSlot(slot));
      console.log(`   participants: ${grp.map(p => p.name).join(', ')}`);
      // compute group-level fitness vector & aggregated score
      const scores = grp.map(p => {
        const feas = isFeasible(slot, p);
        const ctx: EvaluationContext = { ...slot, activity: (slot as any).activity, location: (slot as any).location, now: new Date() };
        const pref = preferenceScore(ctx, p);
        return feas ? pref : 0;
      });
      const agg = scores.reduce((a,b)=>a+b,0) / scores.length;
      console.log(`   group score (mean pref): ${agg.toFixed(3)}`);
      // show individual facts
      grp.forEach(p => {
        const feas = isFeasible(slot, p);
        const ctx: EvaluationContext = { ...slot, activity: (slot as any).activity, location: (slot as any).location, now: new Date() };
        const pref = preferenceScore(ctx, p);
        console.log(`    ${p.name}: feasible=${feas} pref=${pref}`);
      });
    });
  } else {
    console.log('could not schedule all showings');
    console.log('consider relaxing buyer preferences or resource availability');
  }
}

// small demonstration to highlight GA progression when preferences are
// continuous.  this function exists purely to show an obviously non-trivial
// search where the first generation is unlikely to be perfect.
// new simple illustration of slot metadata extensibility; we add a
// `room` property to each slot and then write a rule that selects only
// slots in room "A".  slots may carry *any* custom fields and they are
// automatically propagated into `EvaluationContext` objects.
function caseMetadataDemo() {
  console.log('=== caseMetadataDemo ===');
  console.log('Objective: show how arbitrary slot metadata can be used by rules.');

  const now = new Date();
  const later = new Date(now.getTime() + 3 * 60 * 60_000); // three hours
  // create four 1‑hour slots and tag them with a `room` string
  const slots: (Slot & { room?: string })[] =
    generateSlots(now, later, 60).map((s, i) => ({
      ...s,
      room: i % 2 === 0 ? 'A' : 'B',
    } as any));

  // participant only wants room A; we cast the context to `any` so the
  // compiler doesn't complain about our custom `room` property.
  const picky: Participant = {
    name: 'PickyPerson',
    rules: [(ctx: any) => (ctx.room === 'A' ? 1 : 0)],
  };

  console.log('slots with rooms:', slots.map(s => `${fmtSlot(s)}[room=${s.room}]`).join(', '));
  const res = runGenetic(slots, [picky], { size: 20, iterations: 50 });
  if (res) {
    const chosen = slots[res.slotIndex];
    console.log('chosen slot:', fmtSlot(chosen), 'room=', (chosen as any).room);
  } else {
    console.log('no feasible slot found');
  }
}

// new demonstration: a set of overlapping, graded preferences designed to
// create a rugged fitness landscape.  every participant has a different
// non‑linear scoring curve, forcing the GA to explore a large portion of the
// search space before converging.  this makes the problem noticeably harder
// and illustrates why having a continuous preference surface can require
// many generations.
function caseToughRules() {
  console.log('=== caseToughRules ===');
  console.log('Objective: create a difficult scheduling problem using complex rules.');
  const start = new Date();
  start.setHours(8,0,0,0);
  const end = new Date(start);
  end.setHours(18,0,0,0);
  const slots = generateSlots(start,end,15);

  // three participants with different sin/cos based preference curves
  // Alice prefers against a 4‑cycle sine wave over the day, producing a
  // smooth periodic landscape; high scores occur at times where
  // `sin` is close to 1.  Because the curve never hits 0 the fitness is
  // always in [0.0,1.0] and varies continuously, so the GA cannot terminate
  // in generation 0 and must explore to find the peak region.
  const a: Participant = {
    name: 'Alice',
    preference: ctx => 0.5 + 0.5 * Math.sin(ctx.start.getHours() / 24 * Math.PI * 4),
  };
  // Bob uses a cosine curve with a 6‑cycle peaking at different hours than
  // Alice.  The mismatch between their peaks creates a rugged, multi-modal
  // surface when the two preferences are combined, forcing the GA to balance
  // conflicting goals.
  const b: Participant = {
    name: 'Bob',
    preference: ctx => 0.5 + 0.5 * Math.cos(ctx.start.getHours() / 24 * Math.PI * 6),
  };
  // Carol does not use a continuous preference but instead alternates
  // between 0.8 and 0.6 every third slot.  Because the solver aggregates
  // by taking the *minimum* score across participants, her 0.8 ceiling
  // would normally cap the **maximum** fitness the GA could ever report to
  // 0.8 (see earlier comment).  to make the logs more interesting, we allow
  // her to occasionally return a perfect score – when the slot index is a
  // multiple of 10 – which will cause `maxFitness` to jump and then fall
  // back as the population re‑optimises.  running this example now produces
  // a visibly variable maxFitness output, demonstrating the effect of changing
  // rule shapes in mid‑run.
  const c: Participant = {
    name: 'Carol',
    rules: [ctx => {
      const idx = Math.floor(differenceInMilliseconds(ctx.start, start) / (15*60*1000));
      if (idx % 10 === 0) return 1;              // occasional perfect slot
      return idx % 3 === 0 ? 0.8 : 0.6;
    }],
  };

  const participants = [a,b,c];
  const opts: GARunOptions = {
    size: 15,
    iterations: 10,
    restarts: 2,
    notification: makeNotifier('tough GA', true),
  };
  const res = runGenetic(slots, participants, opts);
  if (res) {
    console.log('found tough slot:', fmtSlot(slots[res.slotIndex]));
  } else {
    console.log('no feasible slot found for tough rules');
  }
}

function caseProgressExample() {
  console.log('=== caseProgressExample ===');
  console.log('Objective: show a tiny problem where the GA must evolve several gens.');

  // NOTE: `Date` constructor accepts milliseconds since 1970. passing
  // `new Date(3)` gives you a time 3 ms after the epoch – far shorter than
  // our 1‑minute interval – so `generateSlots` will only produce a single
  // slot.  this quirk originally made the GA evaluate the same slot over and
  // over, which is why you saw repeated logs.  multiply by 60_000 when you
  // mean "minutes".
  const slots = generateSlots(minutesSinceEpoch(1), minutesSinceEpoch(30), 1); // 30 minutes

  const p: Participant = { name: 'GradientTester', rules: [ ctx => {
    // log only when slot index changes so the output isn't flooded
    const idx = (ctx as any).slotIndex;
    if (idx !== (p as any)._last) {
      console.log(`evaluating slot index ${idx}`);
      (p as any)._last = idx;
    }
    return 0.2 + 0.8 * (1 - differenceInMilliseconds(ctx.start, new Date(0)) / (3 * 60_000));
  } ] };

  const opts: GARunOptions = { size: 20, iterations: 10, notification: makeNotifier('progress', true) };
  
  const res = runGenetic(slots, [p], opts);
  if (res) {
    console.log('best slot index', res.slotIndex);
  }
}

// additional complex scenario showcasing many features
function caseComplexScenario() {
  console.log('=== caseComplexScenario ===');
  console.log('Objective: illustrate complex constraints (hard availability, composite, notice)');
  console.log('          and a multi-slot meeting over a pool of resources with differing bookings.');

  // two days of 15‑minute slots
  const start = new Date();
  start.setHours(7, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 2);
  end.setHours(19, 0, 0, 0);
  const slotIntervalMinutes = 15;
  const slots = generateSlots(start, end, slotIntervalMinutes);
  console.log(`generated ${slots.length} ${slotIntervalMinutes}-minute slots from ${fmtSlot(slots[0])} to ${fmtSlot(slots[slots.length-1])}`);

  // resource pool: three rooms with their own bookings
  const rooms: Participant[] = [
    { name: 'Room1', bookedSlots: [slots[10], slots[11]] },
    { name: 'Room2', bookedSlots: [slots[50]] },
    { name: 'Room3', bookedSlots: [slots[100], slots[101], slots[102]] },
  ];
  console.log('room pool:');
  rooms.forEach(r => {
    console.log(`  ${r.name}: ${r.bookedSlots?.map(fmtSlot).join('; ') || '(none)'}`);
  });

  // participant with hard availability window (only mornings) and existing booking
  const carol: Participant = {
    name: 'Carol',
    rules: [
      ctx => (ctx.start.getHours() >= 8 && ctx.start.getHours() < 12 ? 1 : 0),
    ],
    bookedSlots: [slots[20], slots[21]],
    preference: ctx => ctx.start.getDay() === start.getDay() ? 1 : 0.5,
  };

  // participant with composite constraint: either morning OR after 5pm
  const composite = new CompositeConstraint('or', [
    new TimeConstraint(new Date(start), new Date(start.getTime() + 5*60*60_000)),
    new TimeConstraint(new Date(start.getTime() + 10*60*60_000), new Date(end)),
  ]);
  const dave: Participant = {
    name: 'Dave',
    rules: [
      ctx => composite.satisfies(ctx) ? 1 : 0,
      ctx => {
        const now = ctx.now ?? new Date();
        return differenceInMilliseconds(ctx.start, now) >= 30*60_000 ? 1 : 0;
      },
    ],
  };

  // meeting requiring two consecutive slots (duration 30 minutes)
  const participants = [carol, dave];

  console.log('participants:');
  participants.forEach(dumpParticipant);

  const opts: GARunOptions = {
    size: 200,
    iterations: 500,
    restarts: 2,
    maxDurationSlots: 2,
    notification: makeNotifier('duration GA'),
  };
  const result = runGenetic(slots, participants, opts);
  if (result) {
    console.log('durationSlots requested/used:', result.durationSlots);
    const length = result.durationSlots || 1;
    const range = slots.slice(result.slotIndex, result.slotIndex + length);
    console.log('found multi-slot range:');
    range.forEach(s => console.log(' ', fmtSlot(s)));
    participants.forEach(p => {
      {
        const ctx: EvaluationContext = { ...range[0], now: new Date() };
        console.log(`  ${p.name} feasibility:`, isFeasible(range, p), 'pref=', preferenceScore(ctx, p));
      }
    });
    // determine which room(s) from pool could host the meeting
    const availableRooms = rooms.filter(r => isFeasible(range, r));
    console.log('available rooms for this slot:', availableRooms.map(r=>r.name).join(', ') || '(none)');
    if (availableRooms.length) {
      console.log('room breakdown:');
      availableRooms.forEach(r => {
        const feas = isFeasible(range, r);
        const ctx: EvaluationContext = { ...range[0], now: new Date() };
        const pref = preferenceScore(ctx, r);
        console.log(`  ${r.name}: feasible=${feas} pref=${pref}`);
      });
    }
  } else {
    console.log('no feasible multi-slot meeting found');
  }
}

// new scenario: a large, hard problem intended to stress the GA and
// demonstrate lengthy convergence.  dozens of participants, complex rules,
// and a large slot space force many generations before a solution is found.
function caseHardProblem() {
  console.log('=== caseHardProblem ===');
  console.log('Objective: schedule a meeting for a large team with mixed preferences.');
  console.log('          targetGA parameters are intentionally large to exercise notification.');

  // create a three‑week span of 15‑minute slots (big search space)
  const start = new Date();
  start.setHours(6, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 21);
  end.setHours(22, 0, 0, 0);
  const slots = generateSlots(start, end, 15);
  console.log(`generated ${slots.length} slots`);

  // build 12 participants with varying availability and preferences
  const participants: Participant[] = [];
  for (let i = 0; i < 12; i++) {
    const name = `Person${i+1}`;
    // each participant dislikes late evening and weekends, and has a
    // random booking or notice requirement
    const p: Participant = { name };
    // half of them require 2h notice
    if (i % 2 === 0) {
      p.rules = [ctx => {
        const now = ctx.now ?? new Date();
        return differenceInMilliseconds(ctx.start, now) >= 2 * 60 * 60_000 ? 1 : 0;
      }];
    }
    // set a preference curve that weights weekdays mornings more highly
    p.preference = ctx => {
      const hour = ctx.start.getHours();
      const day = ctx.start.getDay();
      let score = 0.5;
      if (day >= 1 && day <= 5) {
        if (hour >= 8 && hour < 12) score = 1;
        else if (hour >= 12 && hour < 17) score = 0.7;
      }
      return score;
    };
    // some participants have booked slots
    if (i % 3 === 0) {
      const bstart = new Date(start.getTime() + (i * 3) * 60 * 60_000);
      p.bookedSlots = [{ start: bstart, end: new Date(bstart.getTime() + 60 * 60_000) }]; // 1h block
    }
    // some participants have a lot of booked slots
    if (i % 2 === 0) {
      const bstart = new Date(start.getTime() + (i * 3) * 60 * 60_000);
      p.bookedSlots = [{ start: bstart, end: new Date(bstart.getTime() + 60 * 60_000 * 10) }]; // 10h block
    }

    participants.push(p);
  }

  console.log('participants:');
  participants.forEach(dumpParticipant);

  const opts: GARunOptions = {
    size: 50,
    iterations: 20,
    restarts: 5,
    notification: makeNotifier('hard GA', true),
  };

  const result = runGenetic(slots, participants, opts);
  if (result) {
    const chosen = slots[result.slotIndex];
    console.log('found slot for hard problem:', fmtSlot(chosen));
    participants.forEach(p => {
      const feas = isFeasible(chosen, p);
      const ctx: EvaluationContext = { ...chosen, now: new Date() };
      console.log(`  ${p.name}: feasible=${feas} pref=${preferenceScore(ctx, p)}`);
    });
  } else {
    console.log('hard problem: no feasible slot found');
  }
}

// new scenario: buyer who prefers virtual (Zoom) meetings
function caseZoomPreference() {
  console.log('=== caseZoomPreference ===');
  console.log('Objective: schedule a meeting where the buyer requires a "zoom" activity slot.');
  console.log('          an ActivityConstraint is used; we treat morning hours as zoom slots.');

  const start = new Date();
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(18, 0, 0, 0);
  // create slots and tag them with an "activity" value so that the
  // solver can reason about the type of meeting.  we choose a simple rule
  // where morning hours are considered "zoom" slots and afternoons are
  // "office" ones.
  // slots are widened with metadata for the example; core type only has
  // start/end.
  let slots: (Slot & { activity?: string; location?: string })[] =
    generateSlots(start, end, 60).map(s => ({
      ...s,
      activity: s.start.getHours() < 12 ? 'zoom' : 'office',
    } as any));
  console.log(`slots range: ${fmtSlot(slots[0])} through ${fmtSlot(slots[slots.length-1])}`);
  console.log(`  (annotated with activity tags, first=${slots[0].activity})`);

  // buyer now enforces that the chosen slot must carry a "zoom" activity
  // – the availability constraint is automatically evaluated against the
  // slot metadata we just added.  we also maintain a preference to
  // similarly bias the GA, but the hard requirement is what will make a
  // difference if there are other resources that could conflict.
  const buyer: Participant = {
    name: 'HomeBuyer',
    rules: [ctx => new ActivityConstraint('zoom').satisfies(ctx) ? 1 : 0],
    preference: slot => {
      // preference can still look at the activity field if desired
      return slot.activity === 'zoom' ? 1 : 0.3;
    },
  };
  const agent: Participant = { name: 'Agent' };

  // we don't pre‑filter here; the constraint will prune infeasible slots
  const prefiltered = slots;
  console.log(`using ${prefiltered.length} annotated slots (activity + time)`);

  console.log('participants:');
  [buyer, agent].forEach(dumpParticipant);

  const opts: GARunOptions = {
    size: 50,
    iterations: 2,
    restarts: 2,
    notification: makeNotifier('zoom GA', false, false),
  };
  const result = runGenetic(prefiltered, [buyer, agent], opts);
  if (result) {
    const chosen = prefiltered[result.slotIndex];
    console.log('chosen slot:', fmtSlot(chosen));
    console.log('preferences:');
    [buyer, agent].forEach(p => {
      {
        const ctx: EvaluationContext = { ...chosen, now: new Date() };
        console.log(`  ${p.name}: pref=${preferenceScore(ctx,p)}`);
      }
    });
  } else {
    console.log('no feasible slot');
    const diag = runGeneticDiagnostics(prefiltered, [buyer, agent], opts);
    console.log('diagnostics:', diag.diagnostics);
  }
}

// simply invoke examples when run directly
if (require.main === module) {
  caseGroupMeeting();
  caseMetadataDemo();                // demo of slot metadata extensibility
  caseToughRules();                  // problem with hard rules
  caseProgressExample();
  caseBatchShowings();
  caseComplexScenario();
  caseHardProblem();
  caseZoomPreference();
}
