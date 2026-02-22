"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
const rrule_1 = require("rrule");
const index_1 = require("../src/index");
describe('timetabling solver (BDD)', () => {
    const start = new Date();
    start.setHours(8, 0, 0, 0);
    const end = new Date(start);
    end.setHours(12, 0, 0, 0);
    const slots = (0, index_1.generateSlots)(start, end, 60);
    // helper context array for constraint tests
    const contexts = slots.map(s => ({ slot: s }));
    describe('Availability constraint evaluations', () => {
        it('Empty availability (top of lattice) accepts all contexts', () => {
            const base = { status: 'available', constraints: [] };
            (0, chai_1.expect)(contexts.every(ctx => (0, index_1.evaluateAvailability)(base, ctx))).to.be.true;
        });
        // conditional status removed; availability determined purely by constraints
        it('Status propagation during intersection respects priority (preferred > available)', () => {
            const a = { status: 'preferred', constraints: [] };
            const b = { status: 'available', constraints: [] };
            const c = (0, index_1.intersectAvailability)(a, b);
            (0, chai_1.expect)(c.status).to.equal('preferred');
            const d = { status: 'available', constraints: [] };
            const e = (0, index_1.intersectAvailability)(c, d);
            (0, chai_1.expect)(e.status).to.equal('preferred');
        });
        it('Adding a time constraint reduces the available set', () => {
            const timeC = new index_1.TimeConstraint(slots[1].start, slots[2].end);
            const withTime = { status: 'available', constraints: [timeC] };
            const goodSlots = contexts.filter(ctx => (0, index_1.evaluateAvailability)(withTime, ctx));
            (0, chai_1.expect)(goodSlots.length).to.equal(2);
        });
        it('Context without required activity fails availability', () => {
            const timeC = new index_1.TimeConstraint(slots[1].start, slots[2].end);
            const actC = new index_1.ActivityConstraint('meeting');
            const withActivity = {
                status: 'available',
                constraints: [timeC, actC],
            };
            (0, chai_1.expect)(contexts.every(ctx => (0, index_1.evaluateAvailability)(withActivity, ctx))).to.be.false;
        });
        it('Context with matching activity satisfies availability', () => {
            const timeC = new index_1.TimeConstraint(slots[1].start, slots[2].end);
            const actC = new index_1.ActivityConstraint('meeting');
            const withActivity = {
                status: 'available',
                constraints: [timeC, actC],
            };
            const meetingCtx = {
                slot: slots[1],
                activity: 'meeting',
            };
            (0, chai_1.expect)((0, index_1.evaluateAvailability)(withActivity, meetingCtx)).to.be.true;
        });
        it('Notice constraint respects lead time', () => {
            const slot = slots[0];
            const now = new Date();
            now.setTime(slot.start.getTime() - 1000);
            const notice = new index_1.NoticeConstraint(500);
            (0, chai_1.expect)(notice.satisfies({ slot, now })).to.be.true;
            (0, chai_1.expect)(notice.satisfies({ slot, now: new Date(slot.start.getTime() - 100) })).to.be.false;
        });
        it('Location constraint matches exact location', () => {
            const slot = slots[0];
            const loc = new index_1.LocationConstraint('office');
            (0, chai_1.expect)(loc.satisfies({ slot, location: 'office' })).to.be.true;
            (0, chai_1.expect)(loc.satisfies({ slot, location: 'home' })).to.be.false;
        });
        it('Composite constraint AND works', () => {
            const slot = slots[0];
            const now = new Date();
            now.setTime(slot.start.getTime() - 1000);
            const notice = new index_1.NoticeConstraint(500);
            const loc = new index_1.LocationConstraint('office');
            const compAnd = new index_1.CompositeConstraint('and', [notice, loc]);
            (0, chai_1.expect)(compAnd.satisfies({ slot, now, location: 'office' })).to.be.true;
            (0, chai_1.expect)(compAnd.satisfies({ slot, now, location: 'home' })).to.be.false;
        });
        it('Composite constraint OR works', () => {
            const slot = slots[0];
            const loc = new index_1.LocationConstraint('office');
            const compOr = new index_1.CompositeConstraint('or', [loc, new index_1.ActivityConstraint('call')]);
            (0, chai_1.expect)(compOr.satisfies({ slot, location: 'home', activity: 'call' })).to.be.true;
        });
        it('Composite constraint NOT works', () => {
            const slot = slots[0];
            const loc = new index_1.LocationConstraint('office');
            const compNot = new index_1.CompositeConstraint('not', [loc]);
            (0, chai_1.expect)(compNot.satisfies({ slot, location: 'home' })).to.be.true;
            (0, chai_1.expect)(compNot.satisfies({ slot, location: 'office' })).to.be.false;
        });
        it('Unavailable status blocks all contexts regardless of constraints', () => {
            const av = { status: 'unavailable', constraints: [new index_1.TimeConstraint(slots[0].start, slots[3].end)] };
            (0, chai_1.expect)(contexts.every(ctx => !(0, index_1.evaluateAvailability)(av, ctx))).to.be.true;
        });
        it('Intersection returns unavailable when one side is unavailable', () => {
            const a = { status: 'available', constraints: [] };
            const b = { status: 'unavailable', constraints: [] };
            const inter = (0, index_1.intersectAvailability)(a, b);
            (0, chai_1.expect)(inter.status).to.equal('unavailable');
        });
    });
    describe('GA mechanic behaviors', () => {
        it('mutateGenome on a one‑slot genome only produces the same index', () => {
            const slotsSmall = [{ start: new Date(0), end: new Date(0) }];
            const genome = { slotIndex: 0 };
            const mutated = (0, index_1.mutateGenome)(genome, slotsSmall);
            (0, chai_1.expect)(mutated.slotIndex).to.equal(0);
        });
        it('crossoverGenome with identical parents returns a clone', () => {
            const a = { slotIndex: 1 };
            const child = (0, index_1.crossoverGenome)(a, a);
            (0, chai_1.expect)(child.slotIndex).to.equal(a.slotIndex);
        });
        it('filterFeasibleSlots respects person availability status', () => {
            const slotsSmall = [{ start: new Date(0), end: new Date(0) }, { start: new Date(1), end: new Date(1) }];
            const p1 = { name: 'A', availability: { status: 'available', constraints: [] } };
            const p2 = { name: 'B', availability: { status: 'unavailable', constraints: [] } };
            (0, chai_1.expect)((0, index_1.filterFeasibleSlots)(slotsSmall, [p1]).length).to.equal(2);
            (0, chai_1.expect)((0, index_1.filterFeasibleSlots)(slotsSmall, [p1, p2]).length).to.equal(0);
        });
        it('runGenetic chooses preferred person slot when multiple attitudes', () => {
            const slotsSmall = [{ start: new Date(0), end: new Date(0) }];
            const pA = { name: 'A', availability: { status: 'preferred', constraints: [] } };
            const pB = { name: 'B', availability: { status: 'available', constraints: [] } };
            const result = (0, index_1.runGenetic)(slotsSmall, [pA, pB], { size: 5, iterations: 5 });
            (0, chai_1.expect)(result).to.not.be.null;
        });
        it('runGenetic returns null if notice constraint makes every slot infeasible', () => {
            const slotsLong = (0, index_1.generateSlots)(new Date(0), new Date(60 * 60 * 1000), 15);
            const person = { name: 'N', noticeRequired: 24 * 60 * 60 * 1000 };
            // no slots satisfy 24h notice
            const r = (0, index_1.runGenetic)(slotsLong, [person]);
            (0, chai_1.expect)(r).to.be.null;
        });
    }); // end GA mechanic behaviors
    describe('multi-objective primitives', () => {
        it('single genome encodes multiple slot indices', () => {
            const slots = [{ start: new Date(0), end: new Date(1) }, { start: new Date(2), end: new Date(3) }, { start: new Date(4), end: new Date(5) }];
            const genome = { slotIndices: [0, 1, 2] };
            (0, chai_1.expect)(genome.slotIndices).to.have.length(3);
        });
        it('fitnessMulti returns vector of per-meeting scores', () => {
            // create two distinct slots manually to avoid minute-based generation
            const slots = [
                { start: new Date(0), end: new Date(1) },
                { start: new Date(1), end: new Date(2) },
            ];
            const groups = [
                [{ name: 'A1', preference: () => 1 }],
                [{ name: 'A2', preference: () => 0.5 }],
            ];
            const g = { slotIndices: [0, 1] };
            const vec = (0, index_1.fitnessMulti)(g, slots, groups);
            (0, chai_1.expect)(vec).to.deep.equal([1, 0.5]);
        });
        it('runGeneticMulti can optimise a simple two-meeting problem with default scalariser', () => {
            // use a handful of explicit slots for determinism
            const slots = [
                { start: new Date(0), end: new Date(1) },
                { start: new Date(1), end: new Date(2) },
                { start: new Date(2), end: new Date(3) },
                { start: new Date(3), end: new Date(4) },
            ];
            const groups = [
                [{ name: 'P1', preference: s => (s.start.getTime() < 2 ? 1 : 0) }],
                [{ name: 'P2', preference: s => (s.start.getTime() >= 2 ? 1 : 0) }],
            ];
            const best = (0, index_1.runGeneticMulti)(slots, groups, { size: 30, iterations: 30 });
            (0, chai_1.expect)(best).to.not.be.null;
            if (best) {
                // first meeting should choose index 0 or 1, second meeting 2 or 3
                (0, chai_1.expect)(best.slotIndices[0]).to.be.oneOf([0, 1]);
                (0, chai_1.expect)(best.slotIndices[1]).to.be.oneOf([2, 3]);
            }
        });
        it('scalariser allows weighted sum', () => {
            const slots = (0, index_1.generateSlots)(new Date(0), new Date(5), 1);
            const groups = [
                [{ name: 'X', preference: () => 0 }],
                [{ name: 'Y', preference: () => 1 }],
            ];
            // favour second meeting heavier
            const scalar = (scores) => scores[0] * 0.1 + scores[1] * 0.9;
            const best = (0, index_1.runGeneticMulti)(slots, groups, { size: 10, iterations: 10 }, scalar);
            (0, chai_1.expect)(best).to.not.be.null;
        });
        it('misuse: length mismatch between groups and genome triggers no crash', () => {
            const slots = (0, index_1.generateSlots)(new Date(0), new Date(3), 1);
            const groups = [[{ name: 'Z' }]];
            const g = { slotIndices: [0, 1, 2] };
            const vec = (0, index_1.fitnessMulti)(g, slots, groups);
            (0, chai_1.expect)(vec).to.have.length(3);
        });
        it('supports durationSlots per meeting when maxDurationSlots provided', () => {
            const slots = (0, index_1.generateSlots)(new Date(0), new Date(5), 1);
            const groups = [[{ name: 'D1', preference: () => 1 }]];
            const best = (0, index_1.runGeneticMulti)(slots, groups, { size: 20, iterations: 20, maxDurationSlots: 3 });
            (0, chai_1.expect)(best).to.not.be.null;
            if (best) {
                (0, chai_1.expect)(best.durationSlots).to.exist;
                if (best.durationSlots) {
                    (0, chai_1.expect)(best.durationSlots[0]).to.be.within(1, 3);
                }
            }
        });
        it('runGeneticMulti returns null if one meeting has no feasible slots', () => {
            const slots = (0, index_1.generateSlots)(new Date(0), new Date(3), 1);
            const goodGroup = [[{ name: 'Okay' }]];
            const badGroup = [[{ name: 'Never', hardAvailability: () => false }]];
            const combined = [...goodGroup, ...badGroup];
            const best = (0, index_1.runGeneticMulti)(slots, combined, { size: 10, iterations: 10 });
            (0, chai_1.expect)(best).to.be.null;
        });
    });
    // nested compound availability test
    it('Nested composite constraints combine properly', () => {
        const slot = slots[0];
        // (location == office OR activity == call) AND notice >= 1h
        const innerOr = new index_1.CompositeConstraint('or', [
            new index_1.LocationConstraint('office'),
            new index_1.ActivityConstraint('call'),
        ]);
        const notice1h = new index_1.NoticeConstraint(60 * 60 * 1000);
        const nested = new index_1.CompositeConstraint('and', [innerOr, notice1h]);
        const now = new Date(slot.start.getTime() - 2 * 60 * 60 * 1000);
        (0, chai_1.expect)(nested.satisfies({ slot, now, location: 'office' })).to.be.true;
        (0, chai_1.expect)(nested.satisfies({ slot, now, activity: 'call' })).to.be.true;
        (0, chai_1.expect)(nested.satisfies({ slot, now: new Date(slot.start.getTime() - 30 * 60 * 1000), location: 'office' })).to.be.false;
    });
    // ==== advanced real-world scenarios =====================================
    describe('advanced scheduling scenarios', () => {
        it('variable-duration requirement (multi-slot meetings)', () => {
            // schedule must span two consecutive slots
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 13), 60);
            const picky = {
                name: 'Picky',
                hardAvailability: s => true, // nothing disallows individual slots
            };
            // manually construct chromosomes of varying length
            const single = { slotIndex: 0, durationSlots: 1 };
            const double = { slotIndex: 0, durationSlots: 2 };
            // fitness should treat both as feasible but we can compare values
            const f1 = (0, index_1.fitness)(single, slots, [picky]);
            const f2 = (0, index_1.fitness)(double, slots, [picky]);
            (0, chai_1.expect)(f1).to.be.above(0);
            (0, chai_1.expect)(f2).to.be.above(0);
            // the solver retains duration information and caller can prefer longer
            (0, chai_1.expect)(f2).to.be.gte(f1);
        });
        it('multi-slot events (e.g. morning + afternoon) can be modelled via duration pattern', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 13), 60);
            const p = { name: 'Dash', hardAvailability: () => true, preference: () => 1 };
            // in production you could supply an aggregator or custom fitness that
            // rewards longer duration; here we simply exercise the API and verify
            // a chromosome with durationSlots is returned when maxDurationSlots is set.
            const r = (0, index_1.runGenetic)(slots, [p], { size: 20, iterations: 20, maxDurationSlots: 3 });
            (0, chai_1.expect)(r).to.not.be.null;
            if (r && r.durationSlots) {
                (0, chai_1.expect)(r.durationSlots).to.be.oneOf([1, 2, 3]);
            }
        });
        it('resource pools: avoid scheduling same resource for two meetings', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 12), 60);
            const resource = { name: 'Room101', bookedSlots: [slots[0]] };
            const p = { name: 'Attendee' };
            const r = (0, index_1.runGenetic)(slots, [resource, p]);
            if (r) {
                // result slot should not be the one the room is booked
                (0, chai_1.expect)(r.slotIndex).to.not.equal(0);
            }
        });
        it('cancellation/rescheduling is handled by updating bookedSlots and re-running GA', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 12), 60);
            const person = { name: 'Flexible' };
            // first run, pick some slot
            const first = (0, index_1.runGenetic)(slots, [person], { size: 10, iterations: 10 });
            (0, chai_1.expect)(first).to.not.be.null;
            if (first) {
                // simulate booking the chosen slot
                person.bookedSlots = [slots[first.slotIndex]];
                const second = (0, index_1.runGenetic)(slots, [person], { size: 10, iterations: 10 });
                // second run should select a different slot or be null if only one slot
                if (slots.length > 1) {
                    (0, chai_1.expect)(second).to.not.be.null;
                    if (second)
                        (0, chai_1.expect)(second.slotIndex).to.not.equal(first.slotIndex);
                }
                else {
                    (0, chai_1.expect)(second).to.be.null;
                }
            }
        });
        it('dynamic availability (last-minute openings) just means recompute with new constraints', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 12), 60);
            const person = { name: 'Busy', availability: { status: 'unavailable', constraints: [] } };
            const r1 = (0, index_1.runGenetic)(slots, [person]);
            (0, chai_1.expect)(r1).to.be.null;
            // later they become available
            person.availability = { status: 'available', constraints: [] };
            const r2 = (0, index_1.runGenetic)(slots, [person]);
            (0, chai_1.expect)(r2).to.not.be.null;
        });
        it('batch optimization: schedule several showings at once (multi-objective)', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 13), 60);
            const alice = { name: 'A' };
            const bob = { name: 'B' };
            const meetings = [
                { slots, people: [alice, bob] },
                { slots, people: [alice, bob] },
            ];
            const results = (0, index_1.runBatch)(meetings, { size: 10, iterations: 20 });
            (0, chai_1.expect)(results.length).to.equal(2);
            // if slots are limited, second may be null due to booking from first
            if (results[0]) {
                const idx0 = results[0];
            }
        });
        it('calendar import/export would convert ICS entries to Slot/Person records', () => {
            const slots = [
                { start: new Date(2026, 1, 22, 9), end: new Date(2026, 1, 22, 10) },
            ];
            const ics = (0, index_1.exportICS)(slots);
            const imported = (0, index_1.importICS)(ics);
            (0, chai_1.expect)(imported.length).to.equal(1);
            (0, chai_1.expect)(imported[0].start.getHours()).to.equal(9);
        });
        it('entropy/specificness score can be computed from preference distribution', () => {
            const entropy = scores => {
                // normalized entropy [0,1] where 0 = concentrated at single slot
                const total = scores.reduce((a, b) => a + b, 0);
                if (total === 0)
                    return 0;
                const probs = scores.map(s => s / total);
                const ent = -probs.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
                const maxEnt = Math.log(scores.length);
                return maxEnt > 0 ? ent / maxEnt : 0;
            };
            const slots = [{ start: new Date(0), end: new Date(0) }];
            const p = { name: 'E', preference: () => 1 };
            const val = (0, index_1.fitness)({ slotIndex: 0 }, slots, [p], entropy);
            (0, chai_1.expect)(val).to.equal(0); // single-slot entropy = 0
        });
        it('conflict explanation: provide human-readable reason when no slot found', () => {
            const buyer = { name: 'B', hardAvailability: () => false };
            const { result, diagnostics } = (0, index_1.runGeneticDiagnostics)(slots, [buyer]);
            (0, chai_1.expect)(result).to.be.null;
            (0, chai_1.expect)(diagnostics.length).to.be.greaterThan(0);
            const diag = diagnostics.find(d => d.person === 'B');
            (0, chai_1.expect)(diag).to.exist;
            (0, chai_1.expect)(diag?.reason).to.include('hard availability');
        });
        it('pairwise incompatibility is reported', () => {
            const a = { name: 'A', hardAvailability: s => s.start.getHours() < 11 };
            const b = { name: 'B', hardAvailability: s => s.start.getHours() >= 11 };
            const { result, diagnostics } = (0, index_1.runGeneticDiagnostics)(slots, [a, b]);
            (0, chai_1.expect)(result).to.be.null;
            const pair = diagnostics.find(d => d.person === 'A&B');
            (0, chai_1.expect)(pair).to.exist;
            (0, chai_1.expect)(pair?.reason).to.include('pairwise');
        });
        it('getFeasibilityDetail tolerates empty slot list and invalid slot', () => {
            const p = { name: 'Empty' };
            const empty = (0, index_1.getFeasibilityDetail)([], p);
            (0, chai_1.expect)(empty.feasible).to.be.true;
            const badSlot = { start: new Date(1), end: new Date(0) };
            const bad = (0, index_1.getFeasibilityDetail)(badSlot, p);
            (0, chai_1.expect)(bad.feasible).to.be.false;
            (0, chai_1.expect)(bad.reasons).to.include('invalid slot interval');
        });
        it('runGeneticDiagnostics handles no people or no slots gracefully', () => {
            const { result: r1, diagnostics: d1 } = (0, index_1.runGeneticDiagnostics)(slots, []);
            (0, chai_1.expect)(r1).to.be.null;
            (0, chai_1.expect)(d1.some(d => d.reason.includes('no participants'))).to.be.true;
            const { result: r2, diagnostics: d2 } = (0, index_1.runGeneticDiagnostics)([], [{ name: 'Solo' }]);
            (0, chai_1.expect)(r2).to.be.null;
            (0, chai_1.expect)(d2.some(d => d.reason.includes('no slots'))).to.be.true;
        });
        it('runBatch returns empty array when given no meetings', () => {
            (0, chai_1.expect)((0, index_1.runBatch)([], { size: 5 })).to.deep.equal([]);
        });
        it('diagnostics include specific reasons like notice or booked', () => {
            const now = new Date();
            const futureSlots = (0, index_1.generateSlots)(new Date(now.getTime() + 60 * 60 * 1000), new Date(now.getTime() + 5 * 60 * 60 * 1000), 60);
            const person = {
                name: 'N',
                noticeRequired: 24 * 60 * 60 * 1000,
                bookedSlots: [futureSlots[0]],
            };
            const { result, diagnostics } = (0, index_1.runGeneticDiagnostics)(futureSlots, [person]);
            (0, chai_1.expect)(result).to.be.null;
            const diag = diagnostics.find(d => d.person === 'N');
            (0, chai_1.expect)(diag).to.exist;
            (0, chai_1.expect)(diag?.reason).to.satisfy((r) => r.includes('notice') || r.includes('booked'));
        });
        it('travel-time constraints between back-to-back meetings are expressible', () => {
            const slots = (0, index_1.generateSlots)(new Date(2026, 1, 22, 9), new Date(2026, 1, 22, 13), 60);
            const person = { name: 'Traveller', minGapMs: 30 * 60 * 1000, bookedSlots: [slots[1]] };
            // slot[0] ends at 10, gap required 30m before next booked at 10 -> slot0 invalid
            (0, chai_1.expect)((0, index_1.isFeasible)(slots[0], person)).to.be.false;
            // slot[2] starts at 11 which is zero gap -> still invalid
            (0, chai_1.expect)((0, index_1.isFeasible)(slots[2], person)).to.be.false;
            // slot[3] starts at 12 which is 1h after booked end -> valid
            (0, chai_1.expect)((0, index_1.isFeasible)(slots[3], person)).to.be.true;
        });
        it('mixed-mode events (in-person OR virtual) can be encoded as activity/location constraints', () => {
            const slot = { start: new Date(), end: new Date() };
            const av = {
                status: 'available',
                constraints: [
                    new index_1.CompositeConstraint('or', [
                        new index_1.LocationConstraint('virtual'),
                        new index_1.CompositeConstraint('and', [
                            new index_1.LocationConstraint('office'),
                            new index_1.ActivityConstraint('in-person'),
                        ]),
                    ]),
                ],
            };
            const ctx1 = { slot, location: 'virtual' };
            const ctx2 = { slot, location: 'office', activity: 'in-person' };
            (0, chai_1.expect)((0, index_1.evaluateAvailability)(av, ctx1)).to.be.true;
            (0, chai_1.expect)((0, index_1.evaluateAvailability)(av, ctx2)).to.be.true;
        });
    });
    it('intersectAvailability combines constraints and respects status', () => {
        const a = { status: 'available', constraints: [new index_1.TimeConstraint(slots[0].start, slots[1].end)] };
        const b = { status: 'available', constraints: [new index_1.TimeConstraint(slots[2].start, slots[3].end)] };
        const intersected = (0, index_1.intersectAvailability)(a, b);
        // intersection should simply concat constraint arrays
        (0, chai_1.expect)(intersected.constraints.length).to.equal(2);
        (0, chai_1.expect)(intersected.status).to.equal('available');
    });
    it('isCompatible returns false when no contexts satisfy both avs', () => {
        const a = { status: 'available', constraints: [new index_1.TimeConstraint(slots[0].start, slots[1].end)] };
        const b = { status: 'available', constraints: [new index_1.TimeConstraint(slots[2].start, slots[3].end)] };
        (0, chai_1.expect)((0, index_1.isCompatible)(a, b, contexts)).to.be.false;
    });
    it('isCompatible returns true when an overlapping context exists', () => {
        const a = { status: 'available', constraints: [new index_1.TimeConstraint(slots[0].start, slots[1].end)] };
        const b2 = { status: 'available', constraints: [new index_1.TimeConstraint(slots[1].start, slots[2].end)] };
        (0, chai_1.expect)((0, index_1.isCompatible)(a, b2, contexts)).to.be.true;
    });
    it('Real-world compatibility: morning-only vs afternoon-only persons', () => {
        const morning = { status: 'available', constraints: [new index_1.TimeConstraint(slots[0].start, slots[1].end)] };
        const afternoon = { status: 'available', constraints: [new index_1.TimeConstraint(slots[2].start, slots[3].end)] };
        // contexts already span the full day in `contexts`
        (0, chai_1.expect)((0, index_1.isCompatible)(morning, afternoon, contexts)).to.be.false;
        // if one person relaxes to midday, they become compatible
        const flexible = { status: 'available', constraints: [new index_1.TimeConstraint(slots[1].start, slots[3].end)] };
        (0, chai_1.expect)((0, index_1.isCompatible)(morning, flexible, contexts)).to.be.true;
    });
    it('Person availability status influences feasibility and preference', () => {
        const slot = slots[0];
        const availablePerson = { name: 'A', availability: { status: 'available', constraints: [] }, preference: () => 0.5 };
        (0, chai_1.expect)((0, index_1.isFeasible)(slot, availablePerson)).to.be.true;
        const unavailablePerson = { name: 'U', availability: { status: 'unavailable', constraints: [] } };
        (0, chai_1.expect)((0, index_1.isFeasible)(slot, unavailablePerson)).to.be.false;
        const preferredPerson = { name: 'P', availability: { status: 'preferred', constraints: [] }, preference: () => 0.5 };
        // preferenceScore should bump due to preferred
        const baseScore = (0, index_1.preferenceScore)(slot, availablePerson);
        const prefScore = (0, index_1.preferenceScore)(slot, preferredPerson);
        (0, chai_1.expect)(prefScore).to.be.greaterThan(baseScore);
    });
    it('Given a person with preference, then preferenceScore returns the expected value', () => {
        const slot = slots[0];
        const person = {
            name: 'P',
            preference: s => (s.start.getHours() === 8 ? 0.5 : 1),
        };
        (0, chai_1.expect)((0, index_1.preferenceScore)(slot, person), 'pref score mismatch').to.equal(0.5);
    });
    it('Given a recurrence rule, isFeasible respects it', () => {
        const slot = slots[0];
        const p = {
            name: 'R',
            rruleSet: (() => {
                const rs = new rrule_1.RRuleSet();
                // rule that fires every day starting at the slot start time
                rs.rrule(new rrule_1.RRule({ freq: rrule_1.RRule.DAILY, dtstart: slot.start }));
                return rs;
            })(),
        };
        (0, chai_1.expect)((0, index_1.isFeasible)(slot, p), 'first slot should satisfy recurrence').to.be.true;
        (0, chai_1.expect)((0, index_1.isFeasible)(slots[1], p), 'second slot should not match daily rule').to.be.false;
    });
    it('Given a slot before notice period, isFeasible fails when notice required', () => {
        const slot = slots[0];
        const p = { name: 'N', noticeRequired: 24 * 60 * 60 * 1000 };
        (0, chai_1.expect)((0, index_1.isFeasible)(slot, p), 'notice required should block early slot').to.be.false;
    });
    it('Given impossible combination, fitness returns zero for all slots', () => {
        const alwaysFalse = { name: 'X', hardAvailability: () => false };
        const values = slots.map(s => (0, index_1.fitness)({ slotIndex: slots.indexOf(s) }, slots, [alwaysFalse]));
        (0, chai_1.expect)(values.every(v => v === 0), `expected all zeros but got ${values}`).to.be.true;
    });
    it('Given multiple preferences, default aggregator returns minimum and custom aggregators are supported', () => {
        const slot = slots[0];
        const p1 = { name: 'A', preference: () => 0.2 };
        const p2 = { name: 'B', preference: () => 0.8 };
        const minScore = (0, index_1.fitness)({ slotIndex: 0 }, slots, [p1, p2]);
        (0, chai_1.expect)(minScore, `min aggregator produced ${minScore}`).to.equal(0.2);
        // mean aggregator
        const mean = (scores) => scores.reduce((a, b) => a + b, 0) / scores.length;
        const avgScore = (0, index_1.fitness)({ slotIndex: 0 }, slots, [p1, p2], mean);
        (0, chai_1.expect)(avgScore, `mean aggregator produced ${avgScore}`).to.equal((0.2 + 0.8) / 2);
    });
    it('GA helper functions mutate and crossover correctly and filterFeasibleSlots works', () => {
        const testSlots = [{ start: new Date(0), end: new Date(0) }, { start: new Date(1), end: new Date(1) }];
        const genome = { slotIndex: 0 };
        const mutated = (0, index_1.mutateGenome)(genome, testSlots);
        (0, chai_1.expect)(mutated.slotIndex, `mutated index = ${mutated.slotIndex}`).to.be.oneOf([0, 1]);
        const other = { slotIndex: 1 };
        const child = (0, index_1.crossoverGenome)(genome, other);
        (0, chai_1.expect)(child.slotIndex, `crossover produced ${child.slotIndex}`).to.be.oneOf([0, 1]);
        const person = { name: 'F', hardAvailability: () => true };
        const feasible = (0, index_1.filterFeasibleSlots)(testSlots, [person]);
        (0, chai_1.expect)(feasible, 'all slots should be feasible').to.deep.equal(testSlots);
        const infeasible = { name: 'G', hardAvailability: () => false };
        (0, chai_1.expect)((0, index_1.filterFeasibleSlots)(testSlots, [infeasible]), 'no slots should remain').to.be.empty;
    });
    it('runGenetic returns null when there are no feasible slots', () => {
        const slots = [{ start: new Date(0), end: new Date(0) }];
        const person = { name: 'Z', hardAvailability: () => false };
        const result = (0, index_1.runGenetic)(slots, [person]);
        (0, chai_1.expect)(result, 'should be null on unsatisfiable problem').to.be.null;
    });
    it('runGenetic finds the only feasible slot with simple problem', () => {
        const slots = [
            { start: new Date(0), end: new Date(0) },
            { start: new Date(1), end: new Date(1) },
            { start: new Date(2), end: new Date(2) },
        ];
        // only third slot is allowed
        const person = { name: 'Y', hardAvailability: s => s.start.getTime() === 2 };
        const result = (0, index_1.runGenetic)(slots, [person], { size: 100, iterations: 200 });
        (0, chai_1.expect)(result, `result was ${result}`).to.not.be.null;
        if (result) {
            (0, chai_1.expect)(result.slotIndex, 'should pick index 2').to.equal(2);
        }
    });
    it('runGenetic with aggregator can prefer higher mean', () => {
        const slots = [
            { start: new Date(0), end: new Date(0) },
            { start: new Date(1), end: new Date(1) },
        ];
        const p1 = { name: 'A', hardAvailability: () => true, preference: () => 0.2 };
        const p2 = { name: 'B', hardAvailability: () => true, preference: _ => 1 }; // slot 0 & 1 same
        // aggregator that picks mean: both slots equal
        const meanAgg = scores => scores.reduce((a, b) => a + b, 0) / scores.length;
        const res = (0, index_1.runGenetic)(slots, [p1, p2], { size: 10, iterations: 20 }, meanAgg);
        (0, chai_1.expect)(res, 'should return some chromosome').to.not.be.null;
        if (res)
            (0, chai_1.expect)(res.slotIndex).to.be.oneOf([0, 1]);
    });
    it('runGenetic returns null when no feasible slot exists', () => {
        const slots = (0, index_1.generateSlots)(new Date(0), new Date(2), 60);
        const badPerson = { name: 'X', hardAvailability: () => false };
        const result = (0, index_1.runGenetic)(slots, [badPerson]);
        (0, chai_1.expect)(result, 'should be unsatisfiable').to.be.null;
    });
    it('runGenetic finds highest preference slot', () => {
        // two slots, one preferred wholeheartedly by both
        const slots = [{ start: new Date(0), end: new Date(1) }, { start: new Date(2), end: new Date(3) }];
        const p1 = { name: 'A', preference: s => (s.start.getTime() === 0 ? 0.1 : 0.9) };
        const p2 = { name: 'B', preference: s => (s.start.getTime() === 0 ? 0.2 : 0.8) };
        const best = (0, index_1.runGenetic)(slots, [p1, p2], { size: 10, iterations: 10 });
        (0, chai_1.expect)(best, 'GA should return some chromosome').to.not.be.null;
        if (best) {
            // best slot should be index 1 (higher prefs)
            (0, chai_1.expect)(best.slotIndex, `got ${best.slotIndex}`).to.equal(1);
        }
    });
    // utility and edge-case behaviors
    it('generateSlots produces correct intervals and boundaries', () => {
        const start = new Date(0);
        const end = new Date(60 * 60 * 1000); // one hour
        const slots = (0, index_1.generateSlots)(start, end, 15);
        (0, chai_1.expect)(slots.length).to.equal(4);
        (0, chai_1.expect)(slots[0].start.getTime()).to.equal(start.getTime());
        (0, chai_1.expect)(slots[3].end.getTime()).to.equal(end.getTime());
    });
    it('preferenceScore defaults to 1 and clamps values outside [0,1]', () => {
        const slot = { start: new Date(), end: new Date() };
        const n = { name: 'No' };
        (0, chai_1.expect)((0, index_1.preferenceScore)(slot, n)).to.equal(1);
        const tooHigh = { name: 'Hi', preference: () => 5 };
        (0, chai_1.expect)((0, index_1.preferenceScore)(slot, tooHigh)).to.equal(1);
        const tooLow = { name: 'Lo', preference: () => -2 };
        (0, chai_1.expect)((0, index_1.preferenceScore)(slot, tooLow)).to.equal(0);
    });
    it('fitness clamps aggregator results into [0,1]', () => {
        const slots = [{ start: new Date(0), end: new Date(0) }];
        const person = { name: 'Clamp', hardAvailability: () => true, preference: () => 0.5 };
        const overAgg = () => 2;
        (0, chai_1.expect)((0, index_1.fitness)({ slotIndex: 0 }, slots, [person], overAgg)).to.equal(1);
        const underAgg = () => -1;
        (0, chai_1.expect)((0, index_1.fitness)({ slotIndex: 0 }, slots, [person], underAgg)).to.equal(0);
    });
});
