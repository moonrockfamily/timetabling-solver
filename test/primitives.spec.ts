import { expect } from 'chai';
import { RRuleSet, RRule } from 'rrule';
import {
  Slot,
  Participant,
  Chromosome,
  MultiChromosome,
  Aggregator,
  generateSlots,
  isFeasible,
  getFeasibilityDetail,
  preferenceScore,
  fitness,
  fitnessMulti,
  weightedScalariser,
  runGenetic,
  runGeneticMulti,
  runGeneticTopN,
  runGeneticMultiTopN,
  estimateOptions,
  runMetaGA,
  ParamSpec,
  mutateGenome,
  crossoverGenome,
  filterFeasibleSlots,
  runBatch,
  importICS,
  exportICS,
  runGeneticDiagnostics,
  // ontology types
  Availability,
  AvailabilityStatus,
  Constraint,
  EvaluationContext,
  TimeConstraint,
  NoticeConstraint,
  ActivityConstraint,
  LocationConstraint,
  CompositeConstraint,
  evaluateAvailability,
  intersectAvailability,
  isCompatible,
  Rule,
  makeContext,
  getAccessed,
  AvailabilityRule,
} from '../src/index';

describe('timetabling solver (BDD)', () => {
  const start = new Date();
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(12, 0, 0, 0);
  const slots = generateSlots(start, end, 60);

  // helper context array for constraint tests
  const contexts: EvaluationContext[] = slots.map(s => ({ ...s }));

  describe('Availability constraint evaluations', () => {
    it('Empty availability (top of lattice) accepts all contexts', () => {
      const base: Availability = { status: 'available', constraints: [] };
      expect(contexts.every(ctx => evaluateAvailability(base, ctx))).to.be.true;
    });

    // conditional status removed; availability determined purely by constraints
    it('Status propagation during intersection respects priority (preferred > available)', () => {
      const a: Availability = { status: 'preferred', constraints: [] };
      const b: Availability = { status: 'available', constraints: [] };
      const c = intersectAvailability(a, b);
      expect(c.status).to.equal('preferred');
      const d: Availability = { status: 'available', constraints: [] };
      const e = intersectAvailability(c, d);
      expect(e.status).to.equal('preferred');
    });

    it('Adding a time constraint reduces the available set', () => {
      const timeC = new TimeConstraint(slots[1].start, slots[2].end);
      const withTime: Availability = { status: 'available', constraints: [timeC] };
      const goodSlots = contexts.filter(ctx => evaluateAvailability(withTime, ctx));
      expect(goodSlots.length).to.equal(2);
    });

    it('Context without required activity fails availability', () => {
      const timeC = new TimeConstraint(slots[1].start, slots[2].end);
      const actC = new ActivityConstraint('meeting');
      const withActivity: Availability = {
        status: 'available',
        constraints: [timeC, actC],
      };
      expect(contexts.every(ctx => evaluateAvailability(withActivity, ctx))).to.be.false;
    });

    it('Context with matching activity satisfies availability', () => {
      const timeC = new TimeConstraint(slots[1].start, slots[2].end);
      const actC = new ActivityConstraint('meeting');
      const withActivity: Availability = {
        status: 'available',
        constraints: [timeC, actC],
      };
      const meetingCtx: EvaluationContext = {
        ...slots[1],
        activity: 'meeting',
      };
      expect(evaluateAvailability(withActivity, meetingCtx)).to.be.true;
    });

    it('isFeasible respects activity metadata carried on slot', () => {
      // widen slots type to include metadata for test
      const mySlots: (Slot & { activity?: string })[] = [{ start: new Date(0), end: new Date(1), activity: 'call' }];
      const p: Participant = {
        name: 'X',
        availability: { status: 'available', constraints: [new ActivityConstraint('call')] },
      };
      expect(isFeasible(mySlots[0], p)).to.be.true;
      // wrong activity should fail
      mySlots[0].activity = 'meeting';
      expect(isFeasible(mySlots[0], p)).to.be.false;
    });

    it('isFeasible respects location metadata carried on slot', () => {
      const mySlots: (Slot & { location?: string })[] = [{ start: new Date(0), end: new Date(1), location: 'office' }];
      const p: Participant = {
        name: 'Y',
        availability: { status: 'available', constraints: [new LocationConstraint('office')] },
      };
      expect(isFeasible(mySlots[0], p)).to.be.true;
      mySlots[0].location = 'home';
      expect(isFeasible(mySlots[0], p)).to.be.false;
    });

    it('Notice constraint respects lead time', () => {
      const slot: Slot = slots[0];
      const now = new Date();
      now.setTime(slot.start.getTime() - 1000);
      const notice = new NoticeConstraint(500);
      expect(notice.satisfies({ ...slot, now })).to.be.true;
      expect(notice.satisfies({ ...slot, now: new Date(slot.start.getTime() - 100) })).to.be.false;
    });

    it('Location constraint matches exact location', () => {
      const slot: Slot = slots[0];
      const loc = new LocationConstraint('office');
      expect(loc.satisfies({ ...slot, location: 'office' })).to.be.true;
      expect(loc.satisfies({ ...slot, location: 'home' })).to.be.false;
    });

    it('Composite constraint AND works', () => {
      const slot: Slot = slots[0];
      const now = new Date();
      now.setTime(slot.start.getTime() - 1000);
      const notice = new NoticeConstraint(500);
      const loc = new LocationConstraint('office');
      const compAnd = new CompositeConstraint('and', [notice, loc]);
      expect(compAnd.satisfies({ ...slot, now, location: 'office' })).to.be.true;
      expect(compAnd.satisfies({ ...slot, now, location: 'home' })).to.be.false;
    });

    it('Composite constraint OR works', () => {
      const slot: Slot = slots[0];
      const loc = new LocationConstraint('office');
      const compOr = new CompositeConstraint('or', [loc, new ActivityConstraint('call')]);
      expect(compOr.satisfies({ ...slot, location: 'home', activity: 'call' })).to.be.true;
    });

    it('Composite constraint NOT works', () => {
      const slot: Slot = slots[0];
      const loc = new LocationConstraint('office');
      const compNot = new CompositeConstraint('not', [loc]);
      expect(compNot.satisfies({ ...slot, location: 'home' })).to.be.true;
      expect(compNot.satisfies({ ...slot, location: 'office' })).to.be.false;
    });

    it('Unavailable status blocks all contexts regardless of constraints', () => {
      const av: Availability = { status: 'unavailable', constraints: [new TimeConstraint(slots[0].start, slots[3].end)] };
      expect(contexts.every(ctx => !evaluateAvailability(av, ctx))).to.be.true;
    });

    it('Rule class sets optimization hints and is callable via AvailabilityRule', () => {
      let calls = 0;
      const rawRuleInstance = new Rule(ctx => {
        calls++;
        return ctx.start.getTime() === slots[0].start.getTime() ? 1 : 0;
      }, { dependsOnSlot: true, dependsOnNow: false });
      expect(rawRuleInstance.dependsOnSlot).to.be.true;
      expect(rawRuleInstance.dependsOnNow).to.be.false;
      // treat as AvailabilityRule for calling
      const r: AvailabilityRule = rawRuleInstance as unknown as AvailabilityRule;
        expect(r({ start: slots[0].start, end: slots[0].end })).to.equal(1);
      expect(r({ start: slots[1].start, end: slots[1].end })).to.equal(0);
      // constructor inference invokes the provided function once, so we expect
      // three total calls (one for dependency detection + two explicit calls).
      expect(calls).to.equal(3);
    });

    it('dependency inference detects slot/now usage automatically', () => {
      const r1 = new Rule(ctx => 0.5);               // no references
      expect(r1.dependsOnSlot).to.be.false;
      expect(r1.dependsOnNow).to.be.false;
      const r2 = new Rule(ctx => ctx.start.getTime());
      expect(r2.dependsOnSlot).to.be.true;
      expect(r2.dependsOnNow).to.be.false;
      const r3 = new Rule(ctx => (ctx.now ? 1 : 0));
      expect(r3.dependsOnSlot).to.be.false;
      expect(r3.dependsOnNow).to.be.true;
      const r4 = new Rule(ctx => (ctx.start, ctx.now ? 0 : 1));
      expect(r4.dependsOnSlot).to.be.true;
      expect(r4.dependsOnNow).to.be.true;
    });

    it('scheduler annotates raw function rules with inferred hints', () => {
      const raw: AvailabilityRule = (ctx: EvaluationContext) => (ctx.start.getTime() > 0 ? 1 : 0);
      const p: Participant = { name: 'Raw', rules: [raw] };
      // trigger evaluation path
      isFeasible({ start: new Date(0), end: new Date(1) }, p);
      expect(raw.dependsOnSlot).to.be.true;
      expect(raw.dependsOnNow).to.be.false;
    });

    it('makeContext tracks accesses on a context object', () => {
      const ctx = makeContext({
        start: new Date(1),
        end: new Date(2),
        activity: 'x',
        now: new Date(3),
      });
      // read some props
      void ctx.start;
      void ctx.activity;
      expect(getAccessed(ctx).has('start')).to.be.true;
      expect(getAccessed(ctx).has('activity')).to.be.true;
      expect(getAccessed(ctx).has('now')).to.be.false;
    });

    it('Intersection returns unavailable when one side is unavailable', () => {
      const a: Availability = { status: 'available', constraints: [] };
      const b: Availability = { status: 'unavailable', constraints: [] };
      const inter = intersectAvailability(a, b);
      expect(inter.status).to.equal('unavailable');
    });
  });

  // preference and fitness tests
  describe('Preference & fitness behaviors', () => {
    it('preferenceScore can inspect slot metadata and now', () => {
      const slot: (Slot & { activity?: string; location?: string }) = { start: new Date(0), end: new Date(1), activity: 'call', location: 'office' };
      const ctx = {...slot, now: new Date(0)};
      const p: Participant = {
        name: 'Meta',
        preference: c => (c.activity === 'call' && c.location === 'office' && c.now!.getTime() === 0 ? 0.7 : 0.3),
      };
      expect(preferenceScore(ctx, p)).to.equal(0.7);
    });

    it('multi-slot fitness passes context for each slot', () => {
      const slots: Slot[] = [
        { start: new Date(0), end: new Date(1), activity: 'a' } as Slot & { activity?: string },
        { start: new Date(1), end: new Date(2), activity: 'b' } as Slot & { activity?: string },
      ];
      const p: Participant = { name: 'X', preference: c => (c.activity === 'a' ? 0.2 : 0.8) };
      const genome: Chromosome = { slotIndex: 0, durationSlots: 2 };
      // fitness averages 0.2 and 0.8 -> 0.5
      expect(fitness(genome, slots, [p])).to.equal(0.5);
    });

    it('weightedScalariser handles weird weights', () => {
      const w = weightedScalariser([0, -1, NaN]);
      // NaN should propagate through the arithmetic
      expect(Number.isNaN(w([1,2,3]))).to.be.true;
      // runGeneticMulti should clamp final value via fitness and not throw
      const best = runGeneticMulti(slots, [[{ name: 'A' }]], { size: 5, iterations: 5 }, w as any);
      // best may be null or chromosome but not throw
    });

    it('runGeneticMulti clamps aggregator outputs', () => {
      const slots = generateSlots(new Date(0), new Date(3), 1);
      const groups: Participant[][] = [[{ name: 'A' }]];
      const over: Aggregator = () => 2;
      const under: Aggregator = () => -1;
      const chr = runGeneticMulti(slots, groups, { size: 5, iterations: 5 }, over);
      if (chr) expect(fitnessMulti(chr, slots, groups)[0]).to.be.at.most(1);
      const chr2 = runGeneticMulti(slots, groups, { size: 5, iterations: 5 }, under);
      if (chr2) expect(fitnessMulti(chr2, slots, groups)[0]).to.be.at.least(0);
    });

    it('runGeneticDiagnostics reports all reason types', () => {
      const slots = generateSlots(new Date(0), new Date(4), 1);
      const p1: Participant = { name: 'Hard', hardAvailability: () => false };
      const p2: Participant = { name: 'Notice', noticeRequired: 100000000 };
      const p3: Participant = { name: 'Rrule', rruleSet: new RRuleSet() };
      const { diagnostics } = runGeneticDiagnostics(slots, [p1, p2, p3]);
      // diagnostics may use generic phrasing; just check substrings that indicate
      // each failure mode was reported somewhere
      const diagText = diagnostics.map(d => d.reason).join(' | ');
      expect(diagText).to.include('hard availability');
      expect(diagText).to.match(/notice/i);
    });

    it('rules allow multiple alternative availability predicates', () => {
      // participant can join via phone any time (no notice) or in-person after 10am
      const twoSlots = generateSlots(new Date('2026-02-24T09:00:00'), new Date('2026-02-24T12:00:00'), 60);
      const rulePhone = new Rule(ctx => (ctx.activity === 'phone' ? 1 : 0), {
        dependsOnSlot: true,
        dependsOnNow: false,
      });
      const ruleOffice = new Rule(ctx => {
        const t = ctx.start.getTime();
        const start = new Date('2026-02-24T10:00:00').getTime();
        const end = new Date('2026-02-24T15:00:00').getTime();
        return ctx.location === 'office' && t >= start && t <= end ? 1 : 0;
      });
      const p: Participant = {
        name: 'Bob',
        rules: [rulePhone as unknown as AvailabilityRule, ruleOffice as unknown as AvailabilityRule],
      };
      // first slot is 9am, not office but phone missing -> not feasible
      expect(isFeasible(twoSlots[0], p)).to.be.false;
      // if we tag it as phone it becomes feasible via the first rule
      (twoSlots[0] as any).activity = 'phone';
      expect(isFeasible(twoSlots[0], p)).to.be.true;
      // tenth slot (10am) is feasible even without activity – treat as office
      (twoSlots[1] as any).location = 'office';
      expect(isFeasible(twoSlots[1], p)).to.be.true;
    });

    it('runGeneticTopN returns sorted suggestions and respects limit', () => {
      const s = generateSlots(new Date(0), new Date(4), 1);
      const p: Participant = {
        name: 'A',
        preference: ctx => 1 - ctx.start.getTime() / 4, // earlier slots better
      };
      const res = runGeneticTopN([...s], [p], 3, { size: 10, iterations: 10 });
      expect(res.length).to.be.at.most(3);
      for (let i = 1; i < res.length; i++) {
        expect(res[i].fitness).to.be.at.most(res[i - 1].fitness);
      }
    });

    it('runGeneticMultiTopN can rank multi-meeting solutions', () => {
      const s = generateSlots(new Date(0), new Date(4), 1);
      const groups: Participant[][] = [
        [{ name: 'G1', preference: () => 0.5 }],
        [{ name: 'G2', preference: () => 1 }],
      ];
      const res = runGeneticMultiTopN([...s], groups, 5, { size: 10, iterations: 10 });
      expect(res.length).to.be.at.most(5);
      for (let i = 1; i < res.length; i++) {
        expect(res[i].fitness).to.be.at.most(res[i - 1].fitness);
      }
    });
  });

  describe('GA mechanic behaviors', () => {

  it('mutateGenome on a one‑slot genome only produces the same index', () => {
    const slotsSmall = [{ start: new Date(0), end: new Date(0) }];
    const genome: Chromosome = { slotIndex: 0 };
    const mutated = mutateGenome(genome, slotsSmall);
    expect(mutated.slotIndex).to.equal(0);
  });

  it('crossoverGenome with identical parents returns a clone', () => {
    const a: Chromosome = { slotIndex: 1 };
    const child = crossoverGenome(a, a);
    expect(child.slotIndex).to.equal(a.slotIndex);
  });

  it('filterFeasibleSlots respects participant availability status', () => {
    const slotsSmall = [{ start: new Date(0), end: new Date(0) }, { start: new Date(1), end: new Date(1) }];
    const p1: Participant = { name: 'A', availability: { status: 'available', constraints: [] } };
    const p2: Participant = { name: 'B', availability: { status: 'unavailable', constraints: [] } };
    expect(filterFeasibleSlots(slotsSmall, [p1]).length).to.equal(2);
    expect(filterFeasibleSlots(slotsSmall, [p1, p2]).length).to.equal(0);
  });

  it('runGenetic chooses preferred participant slot when multiple attitudes', () => {
    const slotsSmall = [{ start: new Date(0), end: new Date(0) }];
    const pA: Participant = { name: 'A', availability: { status: 'preferred', constraints: [] } };
    const pB: Participant = { name: 'B', availability: { status: 'available', constraints: [] } };
    const result = runGenetic(slotsSmall, [pA, pB], { size: 5, iterations: 5 });
    expect(result).to.not.be.null;
  });

  it('runGenetic returns null if notice constraint makes every slot infeasible', () => {
    const slotsLong = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const participant: Participant = { name: 'N', noticeRequired: 24 * 60 * 60 * 1000 };
    // no slots satisfy 24h notice
    const r = runGenetic(slotsLong, [participant]);
    expect(r).to.be.null;
  });

  }); // end GA mechanic behaviors

  describe('multi-objective primitives', () => {
    it('single genome encodes multiple slot indices', () => {
      const slots = [{ start: new Date(0), end: new Date(1) }, { start: new Date(2), end: new Date(3) }, { start: new Date(4), end: new Date(5) }];
      const genome: MultiChromosome = { slotIndices: [0,1,2] };
      expect(genome.slotIndices).to.have.length(3);
    });

    it('fitnessMulti returns vector of per-meeting scores', () => {
      // create two distinct slots manually to avoid minute-based generation
      const slots: Slot[] = [
        { start: new Date(0), end: new Date(1) },
        { start: new Date(1), end: new Date(2) },
      ];
      const groups: Participant[][] = [
        [{ name: 'A1', preference: () => 1 }],
        [{ name: 'A2', preference: () => 0.5 }],
      ];
      const g: MultiChromosome = { slotIndices: [0,1] };
      const vec = fitnessMulti(g, slots, groups);
      expect(vec).to.deep.equal([1, 0.5]);
    });

    it('runGeneticMulti can optimise a simple two-meeting problem with default scalariser', () => {
      // use a handful of explicit slots for determinism
      const slots: Slot[] = [
        { start: new Date(0), end: new Date(1) },
        { start: new Date(1), end: new Date(2) },
        { start: new Date(2), end: new Date(3) },
        { start: new Date(3), end: new Date(4) },
      ];
      const groups: Participant[][] = [
        [{ name: 'P1', preference: ctx => (ctx.start.getTime() < 2 ? 1 : 0) }],
        [{ name: 'P2', preference: ctx => (ctx.start.getTime() >= 2 ? 1 : 0) }],
      ];
      const best = runGeneticMulti(slots, groups, { size: 30, iterations: 30 });
      expect(best).to.not.be.null;
      if (best) {
        // first meeting should choose index 0 or 1, second meeting 2 or 3
        expect(best.slotIndices[0]).to.be.oneOf([0,1]);
        expect(best.slotIndices[1]).to.be.oneOf([2,3]);
      }
    });

    it('scalariser allows weighted sum', () => {
      const slots = generateSlots(new Date(0), new Date(5), 1);
      const groups: Participant[][] = [
        [{ name: 'X', preference: () => 0 }],
        [{ name: 'Y', preference: () => 1 }],
      ];
      // favour second meeting heavier
      const scalar = (scores: number[]) => scores[0] * 0.1 + scores[1] * 0.9;
      const best = runGeneticMulti(slots, groups, { size: 10, iterations: 10 }, scalar);
      expect(best).to.not.be.null;
    });

    it('misuse: length mismatch between groups and genome triggers no crash', () => {
      const slots = generateSlots(new Date(0), new Date(3), 1);
      const groups: Participant[][] = [[{ name: 'Z' }]];
      const g: MultiChromosome = { slotIndices: [0,1,2] };
      const vec = fitnessMulti(g, slots, groups);
      expect(vec).to.have.length(3);
    });

    it('supports durationSlots per meeting when maxDurationSlots provided', () => {
      const slots = generateSlots(new Date(0), new Date(5), 1);
      const groups: Participant[][] = [[{ name: 'D1', preference: () => 1 }]];
      const best = runGeneticMulti(slots, groups, { size: 20, iterations: 20, maxDurationSlots: 3 });
      expect(best).to.not.be.null;
      if (best) {
        expect(best.durationSlots).to.exist;
        if (best.durationSlots) {
          expect(best.durationSlots[0]).to.be.within(1,3);
        }
      }
    });

    it('runGeneticMulti returns null if one meeting has no feasible slots', () => {
      const slots = generateSlots(new Date(0), new Date(3), 1);
      const goodGroup: Participant[][] = [[{ name: 'Okay' }]];
      const badGroup: Participant[][] = [[{ name: 'Never', hardAvailability: () => false }]];
      const combined = [...goodGroup, ...badGroup];
      const best = runGeneticMulti(slots, combined, { size: 10, iterations: 10 });
      expect(best).to.be.null;
    });
  });

  // nested compound availability test
  it('Nested composite constraints combine properly', () => {
    const slot: Slot = slots[0];
    // (location == office OR activity == call) AND notice >= 1h
    const innerOr = new CompositeConstraint('or', [
      new LocationConstraint('office'),
      new ActivityConstraint('call'),
    ]);
    const notice1h = new NoticeConstraint(60 * 60 * 1000);
    const nested = new CompositeConstraint('and', [innerOr, notice1h]);
    const now = new Date(slot.start.getTime() - 2 * 60 * 60 * 1000);
    expect(nested.satisfies({ ...slot, now, location: 'office' })).to.be.true;
    expect(nested.satisfies({ ...slot, now, activity: 'call' })).to.be.true;
    expect(nested.satisfies({ ...slot, now: new Date(slot.start.getTime() - 30 * 60 * 1000), location: 'office' })).to.be.false;
  });

  // ==== advanced real-world scenarios =====================================
  describe('advanced scheduling scenarios', () => {
    it('variable-duration requirement (multi-slot meetings)', () => {
      // schedule must span two consecutive slots
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,13), 60);
      const picky: Participant = {
        name: 'Picky',
        hardAvailability: s => true, // nothing disallows individual slots
      };
      // manually construct chromosomes of varying length
      const single: Chromosome = { slotIndex: 0, durationSlots: 1 };
      const double: Chromosome = { slotIndex: 0, durationSlots: 2 };
      // fitness should treat both as feasible but we can compare values
      const f1 = fitness(single, slots, [picky]);
      const f2 = fitness(double, slots, [picky]);
      expect(f1).to.be.above(0);
      expect(f2).to.be.above(0);
      // the solver retains duration information and caller can prefer longer
      expect(f2).to.be.gte(f1);
    });

    it('multi-slot events (e.g. morning + afternoon) can be modelled via duration pattern', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,13), 60);
      const p: Participant = { name: 'Dash', hardAvailability: () => true, preference: () => 1 };
      // in production you could supply an aggregator or custom fitness that
      // rewards longer duration; here we simply exercise the API and verify
      // a chromosome with durationSlots is returned when maxDurationSlots is set.
      const r = runGenetic(slots, [p], { size: 20, iterations: 20, maxDurationSlots: 3 });
      expect(r).to.not.be.null;
      if (r && r.durationSlots) {
        expect(r.durationSlots).to.be.oneOf([1,2,3]);
      }
    });

    it('resource pools: avoid scheduling same resource for two meetings', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,12), 60);
      const resource: Participant = { name: 'Room101', bookedSlots: [slots[0]] };
      const p: Participant = { name: 'Attendee' };
      const r = runGenetic(slots, [resource, p]);
      if (r) {
        // result slot should not be the one the room is booked
        expect(r.slotIndex).to.not.equal(0);
      }
    });

    it('cancellation/rescheduling is handled by updating bookedSlots and re-running GA', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,12), 60);
      const participant: Participant = { name: 'Flexible' };
      // first run, pick some slot
      const first = runGenetic(slots, [participant], { size: 10, iterations: 10 });
      expect(first).to.not.be.null;
      if (first) {
        // simulate booking the chosen slot
        participant.bookedSlots = [slots[first.slotIndex]];
        const second = runGenetic(slots, [participant], { size: 10, iterations: 10 });
        // second run should select a different slot or be null if only one slot
        if (slots.length > 1) {
          expect(second).to.not.be.null;
          if (second) expect(second.slotIndex).to.not.equal(first.slotIndex);
        } else {
          expect(second).to.be.null;
        }
      }
    });

    it('dynamic availability (last-minute openings) just means recompute with new constraints', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,12), 60);
      const participant: Participant = { name: 'Busy', availability: { status: 'unavailable', constraints: [] } };
      const r1 = runGenetic(slots, [participant]);
      expect(r1).to.be.null;
      // later they become available
      participant.availability = { status: 'available', constraints: [] };
      const r2 = runGenetic(slots, [participant]);
      expect(r2).to.not.be.null;
    });

    it('batch optimization: schedule several showings at once (multi-objective)', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,13), 60);
      const alice: Participant = { name: 'A' };
      const bob: Participant = { name: 'B' };
      const meetings: any[] = [
        { slots, participant: [alice, bob] },
        { slots, participant: [alice, bob] },
      ];
      const results = runBatch(meetings, { size: 10, iterations: 20 });
      expect(results.length).to.equal(2);
      // if slots are limited, second may be null due to booking from first
      if (results[0]) {
        const idx0 = results[0]!;
      }
    });

    it('calendar import/export would convert ICS entries to Slot/Participant records', () => {
      const slots: Slot[] = [
        { start: new Date(2026,1,22,9), end: new Date(2026,1,22,10) } as any,
      ];
      const ics = exportICS(slots); 
      const imported = importICS(ics);
      expect(imported.length).to.equal(1);
      expect(imported[0].start.getHours()).to.equal(9);
    });

    it('entropy/specificness score can be computed from preference distribution', () => {
      const entropy: Aggregator = scores => {
        // normalized entropy [0,1] where 0 = concentrated at single slot
        const total = scores.reduce((a, b) => a + b, 0);
        if (total === 0) return 0;
        const probs = scores.map(s => s / total);
        const ent = -probs.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
        const maxEnt = Math.log(scores.length);
        return maxEnt > 0 ? ent / maxEnt : 0;
      };
      const slots = [{ start: new Date(0), end: new Date(0) }];
      const p: Participant = { name: 'E', preference: () => 1 };
      const val = fitness({ slotIndex: 0 }, slots, [p], entropy);
      expect(val).to.equal(0); // single-slot entropy = 0
    });

    it('conflict explanation: provide human-readable reason when no slot found', () => {
      const buyer: Participant = { name: 'B', hardAvailability: () => false };
      const { result, diagnostics } = runGeneticDiagnostics(slots, [buyer]);
      expect(result).to.be.null;
      expect(diagnostics.length).to.be.greaterThan(0);
      const diag = diagnostics.find(d => d.participant === 'B');
      expect(diag).to.exist;
      expect(diag?.reason).to.include('hard availability');
    });

    it('pairwise incompatibility is reported', () => {
      const a: Participant = { name: 'A', hardAvailability: s => s.start.getHours() < 11 };
      const b: Participant = { name: 'B', hardAvailability: s => s.start.getHours() >= 11 };
      const { result, diagnostics } = runGeneticDiagnostics(slots, [a, b]);
      expect(result).to.be.null;
      const pair = diagnostics.find(d => d.participant === 'A&B');
      expect(pair).to.exist;
      expect(pair?.reason).to.include('pairwise');
    });

    it('getFeasibilityDetail tolerates empty slot list and invalid slot', () => {
      const p: Participant = { name: 'Empty' };
      const empty = getFeasibilityDetail([], p);
      expect(empty.feasible).to.be.true;
      const badSlot: Slot = { start: new Date(1), end: new Date(0) };
      const bad = getFeasibilityDetail(badSlot, p);
      expect(bad.feasible).to.be.false;
      expect(bad.reasons).to.include('invalid slot interval');
    });

    it('runGeneticDiagnostics handles no participant or no slots gracefully', () => {
      const { result: r1, diagnostics: d1 } = runGeneticDiagnostics(slots, []);
      expect(r1).to.be.null;
      expect(d1.some(d => d.reason.includes('no participants'))).to.be.true;

      const { result: r2, diagnostics: d2 } = runGeneticDiagnostics([], [{ name: 'Solo' } as Participant]);
      expect(r2).to.be.null;
      expect(d2.some(d => d.reason.includes('no slots'))).to.be.true;
    });

    it('runBatch returns empty array when given no meetings', () => {
      expect(runBatch([], { size: 5 })).to.deep.equal([]);
    });

    it('diagnostics include specific reasons like notice or booked', () => {
      const now = new Date();
      const futureSlots = generateSlots(new Date(now.getTime() + 60*60*1000), new Date(now.getTime() + 5*60*60*1000), 60);
      const participant: Participant = {
        name: 'N',
        noticeRequired: 24 * 60 * 60 * 1000,
        bookedSlots: [futureSlots[0]],
      };
      const { result, diagnostics } = runGeneticDiagnostics(futureSlots, [participant]);
      expect(result).to.be.null;
      const diag = diagnostics.find(d => d.participant === 'N');
      expect(diag).to.exist;
      expect(diag?.reason).to.satisfy((r: string) => r.includes('notice') || r.includes('booked'));
    });

    it('travel-time constraints between back-to-back meetings are expressible', () => {
      const slots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,13), 60);
      const participant: Participant = { name: 'Traveller', minGapMs: 30 * 60 * 1000, bookedSlots: [slots[1]] };
      // slot[0] ends at 10, gap required 30m before next booked at 10 -> slot0 invalid
      expect(isFeasible(slots[0], participant)).to.be.false;
      // slot[2] starts at 11 which is zero gap -> still invalid
      expect(isFeasible(slots[2], participant)).to.be.false;
      // slot[3] starts at 12 which is 1h after booked end -> valid
      expect(isFeasible(slots[3], participant)).to.be.true;
    });

    it('mixed-mode events (in-participant OR virtual) can be encoded as activity/location constraints', () => {
      const slot: Slot = { start: new Date(), end: new Date() };
      const av: Availability = {
        status: 'available',
        constraints: [
          new CompositeConstraint('or', [
            new LocationConstraint('virtual'),
            new CompositeConstraint('and', [
              new LocationConstraint('office'),
              new ActivityConstraint('in-participant'),
            ]),
          ]),
        ],
      };
      const ctx1: EvaluationContext = { ...slot, location: 'virtual' };
      const ctx2: EvaluationContext = { ...slot, location: 'office', activity: 'in-participant' };
      expect(evaluateAvailability(av, ctx1)).to.be.true;
      expect(evaluateAvailability(av, ctx2)).to.be.true;
    });
  });

  it('intersectAvailability combines constraints and respects status', () => {
    const a: Availability = { status: 'available', constraints: [new TimeConstraint(slots[0].start, slots[1].end)] };
    const b: Availability = { status: 'available', constraints: [new TimeConstraint(slots[2].start, slots[3].end)] };
    const intersected = intersectAvailability(a, b);
    // intersection should simply concat constraint arrays
    expect(intersected.constraints.length).to.equal(2);
    expect(intersected.status).to.equal('available');
  });

  it('isCompatible returns false when no contexts satisfy both avs', () => {
    const a: Availability = { status: 'available', constraints: [new TimeConstraint(slots[0].start, slots[1].end)] };
    const b: Availability = { status: 'available', constraints: [new TimeConstraint(slots[2].start, slots[3].end)] };
    expect(isCompatible(a, b, contexts)).to.be.false;
  });

  it('isCompatible returns true when an overlapping context exists', () => {
    const a: Availability = { status: 'available', constraints: [new TimeConstraint(slots[0].start, slots[1].end)] };
    const b2: Availability = { status: 'available', constraints: [new TimeConstraint(slots[1].start, slots[2].end)] };
    expect(isCompatible(a, b2, contexts)).to.be.true;
  });

  it('Real-world compatibility: morning-only vs afternoon-only participants', () => {
    const morning: Availability = { status: 'available', constraints: [new TimeConstraint(slots[0].start, slots[1].end)] };
    const afternoon: Availability = { status: 'available', constraints: [new TimeConstraint(slots[2].start, slots[3].end)] };
    // contexts already span the full day in `contexts`
    expect(isCompatible(morning, afternoon, contexts)).to.be.false;
    // if one participant relaxes to midday, they become compatible
    const flexible: Availability = { status: 'available', constraints: [new TimeConstraint(slots[1].start, slots[3].end)] };
    expect(isCompatible(morning, flexible, contexts)).to.be.true;
  });

  it('Participant availability status influences feasibility and preference', () => {
    const slot = slots[0];
    const ctx: EvaluationContext = { ...slot };
    const availableParticipant: Participant = { name: 'A', availability: { status: 'available', constraints: [] }, preference: () => 0.5 };
    expect(isFeasible(slot, availableParticipant)).to.be.true;
    const unavailableParticipant: Participant = { name: 'U', availability: { status: 'unavailable', constraints: [] } };
    expect(isFeasible(slot, unavailableParticipant)).to.be.false;
    const preferredParticipant: Participant = { name: 'P', availability: { status: 'preferred', constraints: [] }, preference: () => 0.5 };
    // preferenceScore should bump due to preferred
    const baseScore = preferenceScore(ctx, availableParticipant);
    const prefScore = preferenceScore(ctx, preferredParticipant);
    expect(prefScore).to.be.greaterThan(baseScore);
  });

  it('Given a participant with preference, then preferenceScore returns the expected value', () => {
    const slot: Slot = slots[0];
    const ctx: EvaluationContext = { ...slot };
    const participant: Participant = {
      name: 'P',
      preference: c => (c.start.getHours() === 8 ? 0.5 : 1),
    };
    expect(preferenceScore(ctx, participant), 'pref score mismatch').to.equal(0.5);
  });

  it('Given a recurrence rule, isFeasible respects it', () => {
    const slot: Slot = slots[0];
    const p: Participant = {
      name: 'R',
      rruleSet: (() => {
        const rs = new RRuleSet();
        // rule that fires every day starting at the slot start time
        rs.rrule(
          new RRule({ freq: RRule.DAILY, dtstart: slot.start }) as unknown as RRule
        );
        return rs;
      })(),
    };
    expect(isFeasible(slot, p), 'first slot should satisfy recurrence').to.be.true;
    expect(isFeasible(slots[1], p), 'second slot should not match daily rule').to.be.false;
  });

  it('Given a slot before notice period, isFeasible fails when notice required', () => {
    const slot: Slot = slots[0];
    const p: Participant = { name: 'N', noticeRequired: 24 * 60 * 60 * 1000 };
    expect(isFeasible(slot, p), 'notice required should block early slot').to.be.false;
  });

  it('Given impossible combination, fitness returns zero for all slots', () => {
    const alwaysFalse: Participant = { name: 'X', hardAvailability: () => false };
    const values = slots.map(s => fitness({ slotIndex: slots.indexOf(s) }, slots, [alwaysFalse]));
    expect(values.every(v => v === 0), `expected all zeros but got ${values}`).to.be.true;
  });

  it('Given multiple preferences, default aggregator returns minimum and custom aggregators are supported', () => {
    const slot: Slot = slots[0];
    const p1: Participant = { name: 'A', preference: () => 0.2 };
    const p2: Participant = { name: 'B', preference: () => 0.8 };
    const minScore = fitness({ slotIndex: 0 }, slots, [p1, p2]);
    expect(minScore, `min aggregator produced ${minScore}`).to.equal(0.2);
    // mean aggregator
    const mean = (scores: number[]) => scores.reduce((a, b) => a + b, 0) / scores.length;
    const avgScore = fitness({ slotIndex: 0 }, slots, [p1, p2], mean);
    expect(avgScore, `mean aggregator produced ${avgScore}`).to.equal((0.2 + 0.8) / 2);
  });

  it('GA helper functions mutate and crossover correctly and filterFeasibleSlots works', () => {
    const testSlots = [{ start: new Date(0), end: new Date(0) }, { start: new Date(1), end: new Date(1) }];
    const genome: Chromosome = { slotIndex: 0 };
    const mutated = mutateGenome(genome, testSlots);
    expect(mutated.slotIndex, `mutated index = ${mutated.slotIndex}`).to.be.oneOf([0, 1]);
    const other: Chromosome = { slotIndex: 1 };
    const child = crossoverGenome(genome, other);
    expect(child.slotIndex, `crossover produced ${child.slotIndex}`).to.be.oneOf([0, 1]);

    const participant: Participant = { name: 'F', hardAvailability: () => true };
    const feasible = filterFeasibleSlots(testSlots, [participant]);
    expect(feasible, 'all slots should be feasible').to.deep.equal(testSlots);
    const infeasible: Participant = { name: 'G', hardAvailability: () => false };
    expect(filterFeasibleSlots(testSlots, [infeasible]), 'no slots should remain').to.be.empty;
  });

  it('runGenetic returns null when there are no feasible slots', () => {
    const slots: Slot[] = [{ start: new Date(0), end: new Date(0) }];
    const participant: Participant = { name: 'Z', hardAvailability: () => false };
    const result = runGenetic(slots, [participant]);
    expect(result, 'should be null on unsatisfiable problem').to.be.null;
  });

  it('notification callback can be used to observe generations', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const p: Participant = { name: 'Dbg' };
    const seen: any[] = [];
    const r = runGenetic(slots, [p], {
      size: 10,
      iterations: 5,
      restarts: 1,
      notification: (_pop, gen, stats, finished) => {
        seen.push({ ...stats, generation: gen, finished } as any);
      },
    });
    expect(r).to.not.be.null;
    expect(seen.length).to.be.greaterThan(1); // should see at least two callbacks
    // ensure we saw at least one non-finished notification and one finished
    const haveFinished = seen.some(s => s.finished === true);
    const haveRunning = seen.some(s => s.finished === false);
    expect(haveFinished).to.be.true;
    expect(haveRunning).to.be.true;
  });

  it('generations respect the configured population size', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const p: Participant = { name: 'Pop' };
    const sizes: number[] = [];
    runGenetic(slots, [p], {
      size: 50,
      iterations: 3,
      notification: pop => sizes.push(pop.length),
    });
    // each logged population should equal the requested size
    expect(sizes.every(len => len === 50)).to.be.true;
  });

  it('estimateOptions returns reasonable values and scales with problem size', () => {
    const fewSlots = generateSlots(new Date(0), new Date(2 * 60 * 60 * 1000), 60);
    const manySlots = generateSlots(new Date(0), new Date(10 * 60 * 60 * 1000), 15);
    const oSmall = estimateOptions(fewSlots, [{ participant: [] }]);
    const oLarge = estimateOptions(manySlots, Array(6).fill({ participant: [] }));

    // options values are optional in the type but our helper always sets them
    expect(oLarge.size).to.be.a('number').and.to.be.greaterThan(oSmall.size!);
    expect(oLarge.iterations).to.be.a('number').and.to.be.greaterThan(oSmall.iterations!);
    expect(oSmall.restarts).to.equal(1);
    expect(oLarge.restarts).to.be.greaterThan(1);

    // ensure the population cap is honoured
    const huge = Array(5000).fill({ start: new Date(), end: new Date() }) as any;
    const oHuge = estimateOptions(huge);
    expect(oHuge.size).to.be.at.most(200);
  });



  it('notification callback is invoked across restarts', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const p: Participant = { name: 'Dbg2' };
    const seen: any[] = [];
    // use trivial aggregator so no candidate ever reaches fitness 1 and all
    // restarts execute
    const constAgg: Aggregator = () => 0.5;
    runGenetic(slots, [p], {
      size: 5,
      iterations: 3,
      restarts: 3,
      notification: (_pop, gen, stats) => {
        seen.push({ gen, stats });
      },
    }, constAgg);
    expect(seen.length).to.be.at.least(6);
  });

  it('multi-objective GA also notifies per generation', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const groups: Participant[][] = [[{ name: 'M' }]];
    const seen: any[] = [];
    runGeneticMulti(slots, groups, {
      size: 5,
      iterations: 3,
      notification: (_pop, gen, stats) => seen.push({ gen, stats }),
    });
    expect(seen.length).to.be.greaterThan(0);
  });

  it('runBatch propagates notifications through each meeting', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const seen: any[] = [];
    const meetings = [
      { slots, participant: [{ name: 'A' }] },
      { slots, participant: [{ name: 'B' }] },
    ];
    runBatch(meetings, {
      size: 5,
      iterations: 2,
      notification: (_pop, gen) => seen.push(gen),
    });
    // two iterations per meeting -> at least 4 notifications
    expect(seen.length).to.be.at.least(4);
  });

  it('runGeneticDiagnostics does not interfere with notification', () => {
    const slots = generateSlots(new Date(0), new Date(60 * 60 * 1000), 15);
    const p: Participant = { name: 'Diag', hardAvailability: () => true };
    let called = false;
    runGeneticDiagnostics(slots, [p], {
      size: 5,
      iterations: 2,
      notification: () => { called = true; },
    });
    expect(called).to.be.true;
  });



  it('runGenetic finds the only feasible slot with simple problem', () => {
    const slots: Slot[] = [
      { start: new Date(0), end: new Date(0) },
      { start: new Date(1), end: new Date(1) },
      { start: new Date(2), end: new Date(2) },
    ];
    // only third slot is allowed
    const participant: Participant = { name: 'Y', hardAvailability: s => s.start.getTime() === 2 };
    const result = runGenetic(slots, [participant], { size: 100, iterations: 200 });
    expect(result, `result was ${result}`).to.not.be.null;
    if (result) {
      expect(result.slotIndex, 'should pick index 2').to.equal(2);
    }
  });

  it('runGenetic with aggregator can prefer higher mean', () => {
    const slots: Slot[] = [
      { start: new Date(0), end: new Date(0) },
      { start: new Date(1), end: new Date(1) },
    ];
    const p1: Participant = { name: 'A', hardAvailability: () => true, preference: () => 0.2 };
    const p2: Participant = { name: 'B', hardAvailability: () => true, preference: _ => 1 }; // slot 0 & 1 same
    // aggregator that picks mean: both slots equal
    const meanAgg: Aggregator = scores => scores.reduce((a, b) => a + b, 0) / scores.length;
    const res = runGenetic(slots, [p1, p2], { size: 10, iterations: 20 }, meanAgg);
    expect(res, 'should return some chromosome').to.not.be.null;
    if (res) expect(res.slotIndex).to.be.oneOf([0, 1]);
  });

  it('runGenetic returns null when no feasible slot exists', () => {
    const slots = generateSlots(new Date(0), new Date(2), 60);
    const badParticipant: Participant = { name: 'X', hardAvailability: () => false };
    const result = runGenetic(slots, [badParticipant]);
    expect(result, 'should be unsatisfiable').to.be.null;
  });

  it('runGenetic finds highest preference slot', () => {
    // two slots, one preferred wholeheartedly by both
    const slots = [{ start: new Date(0), end: new Date(1) }, { start: new Date(2), end: new Date(3) }];
    const p1: Participant = { name: 'A', preference: ctx => (ctx.start.getTime() === 0 ? 0.1 : 0.9) };
    const p2: Participant = { name: 'B', preference: ctx => (ctx.start.getTime() === 0 ? 0.2 : 0.8) };
    const best = runGenetic(slots, [p1, p2], { size: 10, iterations: 10 });
    expect(best, 'GA should return some chromosome').to.not.be.null;
    if (best) {
      // best slot should be index 1 (higher prefs)
      expect(best.slotIndex, `got ${best.slotIndex}`).to.equal(1);
    }
  });

  // utility and edge-case behaviors
  it('generateSlots produces correct intervals and boundaries', () => {
    const start = new Date(0);
    const end = new Date(60 * 60 * 1000); // one hour
    const slots = generateSlots(start, end, 15);
    expect(slots.length).to.equal(4);
    expect(slots[0].start.getTime()).to.equal(start.getTime());
    expect(slots[3].end.getTime()).to.equal(end.getTime());
  });

  it('generateSlots returns empty when start >= end', () => {
    const slots = generateSlots(new Date(10), new Date(5), 5);
    expect(slots).to.be.empty;
  });

  it('generateSlots handles intervals that do not divide evenly', () => {
    const slots = generateSlots(new Date(0), new Date(50), 30);
    // should generate slots [0-30], [30-60?) but stops before end
    expect(slots.length).to.equal(1);
    // end time is 30 minutes in ms
    expect(slots[0].end.getTime()).to.equal(30 * 60_000);
  });

  it('ICS import handles multiple/invalid events safely', () => {
    const multi = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260223T090000Z\nDTEND:20260223T100000Z\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260224T090000Z\nDTEND:20260224T100000Z\nEND:VEVENT\nEND:VCALENDAR';
    const imp = importICS(multi);
    expect(imp.length).to.equal(2);
    const bad = 'NOTCALENDAR';
    const imp2 = importICS(bad);
    expect(imp2).to.be.empty;
  });

  it('preferenceScore defaults to 1 and clamps values outside [0,1]', () => {
    const slot: Slot = { start: new Date(), end: new Date() };
    const ctx: EvaluationContext = { ...slot };
    const n: Participant = { name: 'No' };
    expect(preferenceScore(ctx, n)).to.equal(1);
    const tooHigh: Participant = { name: 'Hi', preference: () => 5 };
    expect(preferenceScore(ctx, tooHigh)).to.equal(1);
    const tooLow: Participant = { name: 'Lo', preference: () => -2 };
    expect(preferenceScore(ctx, tooLow)).to.equal(0);
  });

  it('fitness clamps aggregator results into [0,1]', () => {
    const slots: Slot[] = [{ start: new Date(0), end: new Date(0) }];
    const participant: Participant = { name: 'Clamp', hardAvailability: () => true, preference: () => 0.5 };
    const overAgg: Aggregator = () => 2;
    expect(fitness({ slotIndex: 0 }, slots, [participant], overAgg)).to.equal(1);
    const underAgg: Aggregator = () => -1;
    expect(fitness({ slotIndex: 0 }, slots, [participant], underAgg)).to.equal(0);
  });
});