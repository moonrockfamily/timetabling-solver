import { expect } from 'chai';
import { RRuleSet, RRule } from 'rrule';
import {
  Slot,
  Person,
  generateSlots,
  isFeasible,
  runGenetic,
  runGeneticMulti,
  runBatch,
  assembleGroups,
  weightedScalariser,
  // ontology types
  Availability,
  Constraint,
  EvaluationContext,
  TimeConstraint,
  NoticeConstraint,
  ActivityConstraint,
  LocationConstraint,
  CompositeConstraint,
  evaluateAvailability,
} from '../src/index';

// this file focuses strictly on the real estate domain vocabulary and scenarios

describe('real estate showing scheduling', () => {
  const showSlots = generateSlots(new Date(2026,1,22,9), new Date(2026,1,22,17), 60);

  it('No showing if homeowner unavailable', () => {
    const buyer: Person = { name: 'Buyer' };
    const agent: Person = { name: 'Agent' };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'unavailable', constraints: [] } };
    const r = runGenetic(showSlots, [buyer, agent, homeowner]);
    expect(r, 'expected null when homeowner unavailable').to.be.null;
  });

  it('GA picks slot when all parties available', () => {
    const buyer: Person = { name: 'Buyer' }; // fully available
    const agent: Person = { name: 'Agent', preference: slot => (slot.start.getHours()<12?1:0.5) };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const r = runGenetic(showSlots, [buyer, agent, homeowner], { size: 20, iterations: 30 });
    expect(r, 'should find at least one slot when all available').to.not.be.null;
  });

  it('Notice requirement from homeowner blocks early slots', () => {
    const buyer: Person = { name: 'Buyer' };
    const agent: Person = { name: 'Agent' };
    // create slots starting 1 hour from now
    const now = new Date();
    const soonSlots = generateSlots(new Date(now.getTime() + 60*60*1000), new Date(now.getTime() + 5*60*60*1000), 60);
    const homeowner: Person = {
      name: 'Homeowner',
      noticeRequired: 24 * 60 * 60 * 1000, // 24h notice
    };
    const r = runGenetic(soonSlots, [buyer, agent, homeowner]);
    expect(r, '24h notice should make slots infeasible').to.be.null;
  });

  it('Activity constraint can restrict to "open house" type showings', () => {
    const buyer: Person = { name: 'Buyer' };
    const agent: Person = { name: 'Agent' };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [new ActivityConstraint('open-house')] } };
    // evaluating availability requires activity to match
    const ctx: EvaluationContext = { slot: showSlots[0], activity: 'open-house' };
    expect(evaluateAvailability(homeowner.availability!, ctx), 'open-house activity should satisfy').to.be.true;
    const badCtx: EvaluationContext = { slot: showSlots[0], activity: 'private-showing' };
    expect(evaluateAvailability(homeowner.availability!, badCtx), 'wrong activity should not satisfy').to.be.false;
  });

  it('Multiple buyers compete and agent preference resolves tie', () => {
    const buyer1: Person = { name: 'Buyer1', preference: slot => slot.start.getHours() < 12 ? 0.2 : 0.8 };
    const buyer2: Person = { name: 'Buyer2', preference: slot => slot.start.getHours() < 12 ? 0.8 : 0.2 };
    const agent: Person = { name: 'Agent', preference: slot => 1 - Math.abs(slot.start.getHours() - 10) / 10 };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner], { size: 30, iterations: 50 });
    expect(r, 'should find a slot even with competing buyers').to.not.be.null;
  });

  it('Homeowner time constraint limits available days (e.g. weekdays only)', () => {
    const weekdays = new TimeConstraint(new Date(2026,1,22,9), new Date(2026,1,22,17));
    // pretend slots span a week; just test constraint evaluation
    const avail: Availability = { status: 'available', constraints: [weekdays] };
    const mondayCtx: EvaluationContext = { slot: { start: new Date(2026,1,22,10), end: new Date(2026,1,22,11) } };
    const saturdayCtx: EvaluationContext = { slot: { start: new Date(2026,1,27,10), end: new Date(2026,1,27,11) } };
    expect(evaluateAvailability(avail, mondayCtx), 'weekday should be allowed').to.be.true;
    expect(evaluateAvailability(avail, saturdayCtx), 'weekend should be blocked').to.be.false;
  });

  it('Recurring open house constrained by rrule', () => {
    const openRule = new RRuleSet();
    openRule.rrule(new RRule({ freq: RRule.WEEKLY, byweekday: [RRule.SU], dtstart: new Date(2026,1,22,10) }) as unknown as RRule);
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] }, rruleSet: openRule };
    // first slot is sunday, matches
    expect(isFeasible(showSlots[0], homeowner)).to.be.true;
    // another arbitrary non-sunday slot should fail
    const nonSunday: Slot = { start: new Date(2026,1,23,10), end: new Date(2026,1,23,11) };
    expect(isFeasible(nonSunday, homeowner)).to.be.false;
  });

  it('Homeowner combines location and time constraints for rooms', () => {
    const buyer: Person = { name: 'Buyer' };
    const agent: Person = { name: 'Agent' };
    const roomLOC = new LocationConstraint('kitchen');
    const timeC = new TimeConstraint(showSlots[0].start, showSlots[0].end);
    const homeowner: Person = {
      name: 'Homeowner',
      availability: { status: 'available', constraints: [roomLOC, timeC] },
    };
    const ctxGood: EvaluationContext = { slot: showSlots[0], location: 'kitchen' };
    expect(evaluateAvailability(homeowner.availability!, ctxGood)).to.be.true;
    const ctxBad: EvaluationContext = { slot: showSlots[0], location: 'bathroom' };
    expect(evaluateAvailability(homeowner.availability!, ctxBad)).to.be.false;
  });

  it('Multiple buyers with conflicting hard availability yields no slot', () => {
    const buyer1: Person = { name: 'B1', hardAvailability: slot => slot.start.getHours() < 12 };
    const buyer2: Person = { name: 'B2', hardAvailability: slot => slot.start.getHours() >= 12 };
    const agent: Person = { name: 'Agent' };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner]);
    expect(r).to.be.null;
  });

  it('Agent weighted preference steers choice when buyers indifferent', () => {
    const buyer1: Person = { name: 'B1' };
    const buyer2: Person = { name: 'B2' };
    const agent: Person = { name: 'Agent', preference: slot => slot.start.getHours() === 10 ? 1 : 0.1 };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
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
    const buyer1: Person = { name: 'B1' };
    const buyer2: Person = { name: 'B2' };
    const agent: Person = { name: 'Agent', preference: slot => slot.start.getHours() === 10 ? 1 : 0.1 };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
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
    const buyer: Person = { name: 'Buyer', bookedSlots: [{ start: showSlots[0].start, end: showSlots[0].end }] };
    const agent: Person = { name: 'Agent' };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const result = runGenetic(showSlots, [buyer, agent, homeowner], { size: 10, iterations: 10 });
    expect(result).to.not.be.null;
    if (result) expect(result.slotIndex).to.not.equal(0);
  });

  it('Multiple parties with bookings may force no solution', () => {
    const buyer: Person = { name: 'Buyer', bookedSlots: [showSlots[0]] } as any;
    const agent: Person = { name: 'Agent', bookedSlots: [showSlots[1]] } as any;
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
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
    const buyer: Person = { name: 'Buyer', bookedSlots: [showSlots[0]] } as any;
    const agent: Person = { name: 'Agent', preference: slot => slot.start.getHours() > 12 ? 1 : 0.1 };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const r = runGenetic(showSlots, [buyer, agent, homeowner], { size: 20, iterations: 20 });
    expect(r, 'should choose an afternoon slot due to preference').to.not.be.null;
    if (r) expect(showSlots[r.slotIndex].start.getHours(), `chose ${showSlots[r.slotIndex].start.getHours()}`).to.be.greaterThan(12);
  });

  it('Two buyers both have bookings that overlap with high-preference slots', () => {
    const buyer1: Person = { name: 'B1', bookedSlots: [showSlots[2]] } as any;
    const buyer2: Person = { name: 'B2', bookedSlots: [showSlots[3]] } as any;
    const agent: Person = { name: 'Agent', preference: slot => slot.start.getHours() === 10 ? 1 : 0 };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const r = runGenetic(showSlots, [buyer1, buyer2, agent, homeowner], { size: 20, iterations: 20 });
    // best slots 2 and 3 blocked, expect selection not 2 or 3
    expect(r, 'should avoid blocked high-preference slots').to.not.be.null;
    if (r) expect([2,3], `got ${r.slotIndex}`).to.not.include(r.slotIndex);
  });

  // multi-objective examples: scheduling several showings in one plan
  it('Agent schedules three showings via runGeneticMulti with simple scalariser', () => {
    // three meetings, each with a buyer; agent and homeowner are common
    const buyers: Person[][] = [
      [{ name: 'B1', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B2', preference: s => (s.start.getHours() >= 12 ? 1 : 0) }],
      [{ name: 'B3', preference: s => 0.5 }],
    ];
    const slots = showSlots; // reuse same pool for simplicity
    const agent: Person = { name: 'Agent', preference: s => (s.start.getHours() === 10 ? 1 : 0.1) };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
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

  // helper function tests and business-rule scenario
  it('assembleGroups helper builds combined participant lists', () => {
    const b1: Person = { name: 'B1' };
    const b2: Person = { name: 'B2' };
    const agent: Person = { name: 'A' };
    const homeowner: Person = { name: 'H' };
    const groups = assembleGroups([[b1], [b2]], agent, homeowner);
    expect(groups).to.deep.equal([[b1, agent, homeowner], [b2, agent, homeowner]]);
  });

  it('Business rule: agent prefers afternoon while buyers want mornings', () => {
    const buyers: Person[][] = [
      [{ name: 'B1', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B2', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
      [{ name: 'B3', preference: s => (s.start.getHours() < 12 ? 1 : 0) }],
    ];
    const agent: Person = { name: 'Agent', preference: s => (s.start.getHours() >= 12 ? 1 : 0) };
    const homeowner: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const groups = assembleGroups(buyers, agent, homeowner);

    // weight agent heavily so afternoon is chosen in multi-objective optimisation
    const scalar = weightedScalariser([0.1, 0.1, 0.1, 0.7]);
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
    const agentObj: Person = { name: 'Agent' };
    const homeownerObj: Person = { name: 'Homeowner', availability: { status: 'available', constraints: [] } };
    const meetings = [
      { slots: showSlots, people: [{ name: 'Buyer1' }, agentObj, homeownerObj] },
      { slots: showSlots, people: [{ name: 'Buyer2' }, agentObj, homeownerObj] },
      { slots: showSlots, people: [{ name: 'Buyer3' }, agentObj, homeownerObj] },
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
