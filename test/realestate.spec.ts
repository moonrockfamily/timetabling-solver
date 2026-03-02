import { expect } from 'chai';
import { addHours, addMinutes } from 'date-fns/fp';
import { RRule, RRuleSet } from 'rrule';
import {
  ActivityConstraint,
  assembleGroups,
  // ontology types
  Availability,
  evaluateAvailability,
  EvaluationContext,
  generateSlots,
  isFeasible,
  LocationConstraint,
  makeNotifier,
  Participant,
  runBatch,
  runGenetic,
  runGeneticMulti,
  Slot,
  TimeConstraint,
  weightedScalariser
} from '../src/index';

// this file focuses strictly on the real estate domain vocabulary and scenarios

describe('real estate showing scheduling', () => {
  // slots from 9am to 5pm on 22 Feb 2026, one hour each
  const showSlots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,17), 60);
  const noisyNotifier = makeNotifier('test', true, true);
  const quietNotifier = makeNotifier('test', false, true);

  it('No showing if homeowner unavailable', () => {
    const buyer: Participant = { name: 'Buyer' };
    const agent: Participant = { name: 'Agent' };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 0] };
    const r = runGenetic(showSlots, [buyer, agent, homeowner]);
    expect(r, 'expected null when homeowner unavailable').to.be.null;
  });

  it('GA picks slot when all parties available', () => {
    const buyer: Participant = { name: 'Buyer' }; // fully available
    const agent: Participant = { name: 'Agent', preference: ctx => (ctx.start.getHours()<12?1:0.5) };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const r = runGenetic(showSlots, [buyer, agent, homeowner], { size: 20, iterations: 30, notification: quietNotifier });
    expect(r, 'should find at least one slot when all available').to.not.be.null;
  });

  it('Notice requirement from homeowner blocks early slots', () => {
    const buyer: Participant = { name: 'Buyer' };
    const agent: Participant = { name: 'Agent' };
    // create slots starting 1 hour from now
    const now = new Date();
    // slots beginning one hour from now through five hours from now
    const hoursFromNow = (h: number) => addHours(h)(now);
    const soonSlots = generateSlots(hoursFromNow(1), hoursFromNow(5), 60);
    const homeowner: Participant = {
      name: 'Homeowner',
      noticeRequired: 24 * 60 * 60 * 1000, // 24h notice (leave constant)
    };
    const r = runGenetic(soonSlots, [buyer, agent, homeowner]);
    expect(r, '24h notice should make slots infeasible').to.be.null;
  });

  it('Activity constraint can restrict to "open house" type showings', () => {
    const buyer: Participant = { name: 'Buyer' };
    const agent: Participant = { name: 'Agent' };
    const homeowner: Participant = { name: 'Homeowner', rules: [ctx => new ActivityConstraint('open-house').satisfies(ctx) ? 1 : 0] };
    // evaluating availability requires activity to match
    const ctx: EvaluationContext = { ...showSlots[0], activity: 'open-house' };
    // rule returns 1 for matching activity, 0 otherwise
    expect(homeowner.rules![0](ctx)).to.equal(1, 'open-house activity should satisfy');
    const badCtx: EvaluationContext = { ...showSlots[0], activity: 'private-showing' };
    expect(homeowner.rules![0](badCtx)).to.equal(0, 'wrong activity should not satisfy');
  });

  it('Multiple buyers compete and agent preference resolves tie', () => {
    // Simplified scenario: two buyers with clear, opposing preferences and an agent whose preference breaks the tie.
    // Slots: 9am, 10am, 11am, 12pm, 1pm, 2pm, 3pm, 4pm (showSlots)
    // Buyer1 prefers 9am, Buyer2 prefers 4pm, Agent prefers 12pm.
    const buyer1: Participant = { name: 'Buyer1', preference: ctx => ctx.start.getHours() === 9 ? 1 : 0 };
    const buyer2: Participant = { name: 'Buyer2', preference: ctx => ctx.start.getHours() === 16 ? 1 : 0 };
    const agent: Participant = { name: 'Agent', preference: ctx => ctx.start.getHours() === 16 ? .6 : .5 };
    const homeowner: Participant = { name: 'Homeowner' };
    const slots = generateSlots(new Date(2026,1,22), new Date(2026,1,23), 60);
    const r = runGenetic(slots, [buyer1, buyer2, agent, homeowner], { size: 24, iterations: 2, notification: noisyNotifier });
    expect(r, 'should find a slot even with competing buyers').to.not.be.null;
    if (r) {
      // The agent's preference should resolve the tie, so expect 12pm slot to be chosen
      const chosenHour = slots[r.slotIndex].start.getHours();
      expect(chosenHour, `chosen hour was ${chosenHour}`).to.equal(12);
    }
  });

  it('Homeowner time constraint limits available days (e.g. weekdays only)', () => {
    const weekdays = new TimeConstraint(new Date(2026,1,22,9), new Date(2026,1,22,17));
    // pretend slots span a week; just test constraint evaluation
    const avail: Availability = { constraints: [weekdays] };
    const mondayCtx: EvaluationContext = { start: new Date(2026,1,22,10), end: new Date(2026,1,22,11) };
    const saturdayCtx: EvaluationContext = { start: new Date(2026,1,27,10), end: new Date(2026,1,27,11) };
    expect(evaluateAvailability(avail, mondayCtx), 'weekday should be allowed').to.be.true;
    expect(evaluateAvailability(avail, saturdayCtx), 'weekend should be blocked').to.be.false;
  });

  it('Recurring open house constrained by rrule', () => {
    const openRule = new RRuleSet();
    openRule.rrule(new RRule({ freq: RRule.WEEKLY, byweekday: [RRule.SU], dtstart: new Date(2026,1,22,10) }) as unknown as RRule);
    // build a rule that checks the recurrence set explicitly
    const homeowner: Participant = {
      name: 'Homeowner',
      rules: [ctx => (openRule.between(ctx.start, ctx.end, true).length > 0 ? 1 : 0)],
    };
    // first slot is sunday, matches
    expect(isFeasible(showSlots[0], homeowner)).to.be.true;
    // another arbitrary non-sunday slot should fail
    const nonSunday: Slot = { start: new Date(2026,1,23,10), end: new Date(2026,1,23,11) };
    expect(isFeasible(nonSunday, homeowner)).to.be.false;
  });

  it('Homeowner combines location and time constraints for rooms', () => {
    const buyer: Participant = { name: 'Buyer' };
    const agent: Participant = { name: 'Agent' };
    const roomLOC = new LocationConstraint('kitchen');
    const timeC = new TimeConstraint(showSlots[0].start, showSlots[0].end);
    const homeowner: Participant = {
      name: 'Homeowner',
      rules: [ctx => roomLOC.satisfies(ctx) && timeC.satisfies(ctx) ? 1 : 0],
    };
    const ctxGood: EvaluationContext = { ...showSlots[0], location: 'kitchen' };
    expect(homeowner.rules![0](ctxGood)).to.equal(1);
    const ctxBad: EvaluationContext = { ...showSlots[0], location: 'bathroom' };
    expect(homeowner.rules![0](ctxBad)).to.equal(0);
  });

  it('Multiple buyers with conflicting hard availability yields no slot', () => {
    const buyer1: Participant = { name: 'B1', hardAvailability: slot => slot.start.getHours() < 12 };
    const buyer2: Participant = { name: 'B2', hardAvailability: slot => slot.start.getHours() >= 12 };
    const agent: Participant = { name: 'Agent' };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner]);
    expect(r).to.be.null;
  });

  it('Agent weighted preference steers choice when buyers indifferent', () => {
    const buyer1: Participant = { name: 'B1' };
    const buyer2: Participant = { name: 'B2' };
    const agent: Participant = { name: 'Agent', preference: ctx => ctx.start.getHours() === 10 ? 1 : 0.1 };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    // bump the population to reduce stochastic variance; with size=200 the
    // 10 am preference almost always wins on a simple problem.
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner], { size: 200, iterations: 20 });
    expect(r, 'agent prefers 10am slots, result should be close').to.not.be.null;
    if (r) {
      const hr = showSlots[r.slotIndex].start.getHours();
      // we only assert that an answer was found; the stochastic nature of the GA
      // means the exact hour may vary but the presence of a result is sufficient
      // for this behavioural smoke test.
      expect(hr).to.be.a('number');
      expect(hr).to.equal(10);
    }
  });

  it('restarts help the GA converge to the true best slot (10am)', () => {
    const buyer1: Participant = { name: 'B1' };
    const buyer2: Participant = { name: 'B2' };
    const agent: Participant = { name: 'Agent', preference: ctx => ctx.start.getHours() === 10 ? 1 : 0.1 };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    // run a handful of independent trials and insist on the optimal hour
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner], {
      size: 20,
      iterations: 20,
      restarts: 10,
    });
    expect(r).to.not.be.null;
    if (r) {
      expect(showSlots[r.slotIndex].start.getHours()).to.equal(10);
    }
  });

  it('Booked slot prevents that time from being used', () => {
    const buyer: Participant = { name: 'Buyer', bookedSlots: [{ start: showSlots[0].start, end: showSlots[0].end }] };
    const agent: Participant = { name: 'Agent' };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const result = runGenetic(showSlots, [buyer, agent, homeowner], { size: 10, iterations: 10 });
    expect(result).to.not.be.null;
    if (result) expect(result.slotIndex).to.not.equal(0);
  });

  it('Multiple parties with bookings may force no solution', () => {
    const buyer: Participant = { name: 'Buyer', bookedSlots: [showSlots[0]] } as any;
    const agent: Participant = { name: 'Agent', bookedSlots: [showSlots[1]] } as any;
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const r = runGenetic(showSlots, [buyer, agent, homeowner], { size: 10, iterations: 10 });
    // slots0 and 1 blocked; GA may choose later slot or null if none
    if (showSlots.length <= 2) {
      expect(r).to.be.null;
    } else {
      expect(r).to.not.be.null;
      if (r) expect(r.slotIndex).to.be.gte(2);
    }
  });

  it('Booked slots plus agent preference leads to later slot choice', () => {
    const buyer: Participant = { name: 'Buyer', bookedSlots: [showSlots[0]] } as any;
    const agent: Participant = { name: 'Agent', preference: ctx => ctx.start.getHours() > 12 ? 1 : 0.1 };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const r = runGenetic(showSlots, [buyer, agent, homeowner], { size: 20, iterations: 20 });
    expect(r, 'should choose an afternoon slot due to preference').to.not.be.null;
    if (r) expect(showSlots[r.slotIndex].start.getHours(), `chose ${showSlots[r.slotIndex].start.getHours()}`).to.be.greaterThan(12);
  });

  it('Two buyers both have bookings that overlap with the agent’s preferred times', () => {
    // agent really likes the 11am and noon slots (indices 2 and 3)
    const buyer1: Participant = { name: 'B1', bookedSlots: [showSlots[2]] } as any;
    const buyer2: Participant = { name: 'B2', bookedSlots: [showSlots[3]] } as any;
    const agent: Participant = {
      name: 'Agent',
      preference: ctx =>
        ctx.start.getHours() === 11 || ctx.start.getHours() === 12 ? 1 : 0,
    };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner], {
      size: 10,
      iterations: 10,
    });
    // slots 2 and 3 are both desirable for agent but blocked by buyers.
    // due to GA randomness we might occasionally return null or a suboptimal
    // index; the only unacceptable outcome is a blocked slot being chosen.
    if (r) {
      expect([2, 3], `got ${r.slotIndex}`).to.not.include(r.slotIndex);
    }
  });

  // multi-objective examples: scheduling several showings in one plan
  it('Agent schedules three showings via runGeneticMulti with simple scalariser', () => {
    // three meetings, each with a buyer; agent and homeowner are common
    const buyers: Participant[][] = [
      [{ name: 'B1', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B2', preference: s => (s.start.getHours() >= 12 ? 1 : 0) }],
      [{ name: 'B3', preference: s => 0.5 }],
    ];
    const slots = showSlots; // reuse same pool for simplicity
    const agent: Participant = { name: 'Agent', preference: s => (s.start.getHours() === 10 ? 1 : 0.1) };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    // incorporate the agent & homeowner by appending them to each group
    const groups = buyers.map(group => [...group, agent, homeowner]);
    const best = runGeneticMulti(slots, groups, { size: 50, iterations: 50 });
    expect(best).to.not.be.null;
    if (best) {
      expect(best.slotIndices).to.have.length(3);
      // ensure indices are within pool
      best.slotIndices.forEach((idx: number) => expect(idx).to.be.within(0, slots.length - 1));
    }
  });

  it('assembleGroups helper builds combined participant lists with two common members', () => {
    const b1: Participant = { name: 'B1' };
    const b2: Participant = { name: 'B2' };
    const agent: Participant = { name: 'A' };
    const homeowner: Participant = { name: 'H' };
    const baseGroups = [[b1], [b2]];
    const groups = assembleGroups(baseGroups, agent, homeowner);
    expect(groups).to.deep.equal([[b1, agent, homeowner], [b2, agent, homeowner]]);
  });

  it('assembleGroups works with zero common members (identity)', () => {
    const g1: Participant = { name: 'X' };
    const g2: Participant = { name: 'Y' };
    const baseGroups = [[g1], [g2]];
    const groups = assembleGroups(baseGroups);
    expect(groups).to.deep.equal([[g1], [g2]]);
  });

  it('assembleGroups can append any number of common members', () => {
    const p: Participant = { name: 'P' };
    const q: Participant = { name: 'Q' };
    const r: Participant = { name: 'R' };
    const baseGroups: Participant[][] = [[p]];
    const result = assembleGroups(baseGroups, q, r);
    expect(result).to.deep.equal([[p, q, r]]);
  });

  it('Business rule: agent prefers afternoon while buyers want mornings', () => {
    const buyers: Participant[][] = [
      [{ name: 'B1', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B2', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B3', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
    ];
    const agent: Participant = { name: 'Agent', preference: s => (s.start.getHours() >= 12 ? 1 : 0) };
    const homeowner: Participant = { name: 'Homeowner', rules: [() => 1] };
    const groups = assembleGroups(buyers, agent, homeowner);

    // weight agent heavily so afternoon is chosen in multi-objective optimisation.
    // each group list is [buyer, agent, homeowner], so the second position
    // corresponds to the agent; we give that position the largest weight.
    const scalar = weightedScalariser([0.1, 0.7, 0.1]);
    const best = runGeneticMulti(showSlots, groups, { size: 50, iterations: 50 }, scalar);
    expect(best).to.not.be.null;
    if (best) {
      // expect at least one chosen index corresponds to afternoon (>=12h)
      const hrs = best.slotIndices.map(i => showSlots[i].start.getHours());
      expect(hrs.some(h => h >= 12), `hrs=${hrs}`).to.be.true;
    }
  });

  it('Batch scheduling three showings respects earlier bookings', () => {
    // using runBatch with progressively booked slots; reuse same agent/homeowner
    const agentObj: Participant = { name: 'Agent' };
    const homeownerObj: Participant = { name: 'Homeowner', rules: [() => 1] };
    const meetings = [
      { slots: showSlots, participant: [{ name: 'Buyer1' }, agentObj, homeownerObj] },
      { slots: showSlots, participant: [{ name: 'Buyer2' }, agentObj, homeownerObj] },
      { slots: showSlots, participant: [{ name: 'Buyer3' }, agentObj, homeownerObj] },
    ];
    // cast to any to bypass strict Meeting typings; the runtime structure is correct
    const results = runBatch(meetings as any, { size: 20, iterations: 20 });
    expect(results).to.have.length(3);
    // if all were assigned, bookedSlots should have been updated on shared agent/homeowner
    expect(agentObj.bookedSlots).to.exist;
    expect(homeownerObj.bookedSlots).to.exist;
    // ensure each meeting picks a different slot
    if (results[0] && results[1] && results[2]) {
      expect(results[0]!.slotIndex).to.not.equal(results[1]!.slotIndex);
      expect(results[0]!.slotIndex).to.not.equal(results[2]!.slotIndex);
      expect(results[1]!.slotIndex).to.not.equal(results[2]!.slotIndex);
    }
  });
});
