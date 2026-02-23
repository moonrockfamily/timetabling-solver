import {
  generateSlots,
  Participant,
  Slot,
  runGenetic,
  runGeneticMulti,
  runGeneticDiagnostics,
  assembleGroups,
  TimeConstraint,
  NoticeConstraint,
  LocationConstraint,
  ActivityConstraint,
  CompositeConstraint,
  evaluateAvailability,
  isFeasible,
  preferenceScore,
  GARunOptions,
  EvaluationContext,
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
  if (p.availability) {
    console.log(`    availability status: ${p.availability.status}`);
    if (p.availability.constraints.length) {
      p.availability.constraints.forEach(c => {
        console.log(describeConstraint(c));
      });
    }
  }
  if (p.bookedSlots && p.bookedSlots.length) {
    console.log(`    booked: ${p.bookedSlots.map(fmtSlot).join('; ')}`);
  }
  if (p.noticeRequired) {
    console.log(`    notice required: ${p.noticeRequired / 3600000}h`);
  }
}

/**
 * Case 1: find the next meeting time for a small group (+ a shared resource)
 * taking into account each participant's existing bookings and working hours.
 */
// global parameters (adjusted via CLI)
let weekCount = 1; // number of weeks to span

function caseGroupMeeting() {
  console.log('=== caseGroupMeeting ===');
  console.log('Objective: schedule a single meeting for two participant plus a shared room.');
  console.log('          maximize morning preference while respecting bookings and notice requirements.');

  // discretize the upcoming work week(s) into slots
  const start = new Date();
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 5 * weekCount);
  end.setHours(18, 0, 0, 0);
  const slots = generateSlots(start, end, 30);

  // shared meeting room has some bookings
  const room: Participant = {
    name: 'Conference Room',
    bookedSlots: [
      { start: new Date(start.getTime() + 2 * 60 * 60_000), end: new Date(start.getTime() + 3 * 60 * 60_000) },
      { start: new Date(start.getTime() + 24 * 60 * 60_000), end: new Date(start.getTime() + 25 * 60 * 60_000) },
    ],
  };

  // two participants with working‑hours constraints and existing meetings
  const alice: Participant = {
    name: 'Alice',
    availability: {
      status: 'available',
      constraints: [new TimeConstraint(new Date(start), new Date(end))],
    },
    bookedSlots: [
      { start: new Date(start.getTime() + 4 * 60 * 60_000), end: new Date(start.getTime() + 5 * 60 * 60_000) },
    ],
    preference: ctx => {
      // prefers mornings
      return ctx.start.getHours() < 12 ? 1 : 0.5;
    },
  };

  const bob: Participant = {
    name: 'Bob',
    availability: {
      status: 'available',
      constraints: [new TimeConstraint(new Date(start), new Date(end))],
    },
    bookedSlots: [
      { start: new Date(start.getTime() + 6 * 60 * 60_000), end: new Date(start.getTime() + 7 * 60 * 60_000) },
    ],
    noticeRequired: 60 * 60_000, // one hour notice
  };

  const participants = [alice, bob, room];

  console.log(`slots range: ${fmtSlot(slots[0])} through ${fmtSlot(slots[slots.length-1])} (${slots.length} total)`);
  console.log('participants/resources:');
  participants.forEach(dumpParticipant);

  const opts: GARunOptions = { size: 100, iterations: 200, restarts: 3 };
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

  const opts: GARunOptions = { size: 50, iterations: 100, restarts: 2 };
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
    hardAvailability: slot => slot.start.getHours() >= 8 && slot.start.getHours() < 12,
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
    availability: { status: 'available', constraints: [composite] },
    noticeRequired: 30*60_000, // half hour
  };

  // meeting requiring two consecutive slots (duration 30 minutes)
  const participants = [carol, dave];

  console.log('participants:');
  participants.forEach(dumpParticipant);

  const opts: GARunOptions = { size: 200, iterations: 500, restarts: 2, maxDurationSlots: 2 };
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
    availability: { status: 'available', constraints: [new ActivityConstraint('zoom')] },
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

  const opts: GARunOptions = { size: 50, iterations: 100, restarts: 2 };
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
  caseBatchShowings();
  caseComplexScenario();
  caseZoomPreference();
}
