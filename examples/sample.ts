import {
  generateSlots,
  Person,
  Slot,
  runGenetic,
  runGeneticMulti,
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
} from '../src';

/**
 * Utility that prints a slot nicely.
 */
function fmtSlot(s: Slot): string {
  return `${s.start.toISOString()} -> ${s.end.toISOString()}`;
}

/**
 * print summary of a person/resource: availability, bookings, preferences.
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

function dumpPerson(p: Person) {
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

  // discretize the upcoming work week(s) into slots
  const start = new Date();
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 5 * weekCount);
  end.setHours(18, 0, 0, 0);
  const slots = generateSlots(start, end, 30);

  // shared meeting room has some bookings
  const room: Person = {
    name: 'Conference Room',
    bookedSlots: [
      { start: new Date(start.getTime() + 2 * 60 * 60_000), end: new Date(start.getTime() + 3 * 60 * 60_000) },
      { start: new Date(start.getTime() + 24 * 60 * 60_000), end: new Date(start.getTime() + 25 * 60 * 60_000) },
    ],
  };

  // two participants with working‑hours constraints and existing meetings
  const alice: Person = {
    name: 'Alice',
    availability: {
      status: 'available',
      constraints: [new TimeConstraint(new Date(start), new Date(end))],
    },
    bookedSlots: [
      { start: new Date(start.getTime() + 4 * 60 * 60_000), end: new Date(start.getTime() + 5 * 60 * 60_000) },
    ],
    preference: slot => {
      // prefers mornings
      return slot.start.getHours() < 12 ? 1 : 0.5;
    },
  };

  const bob: Person = {
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

  const people = [alice, bob, room];

  console.log(`slots range: ${fmtSlot(slots[0])} through ${fmtSlot(slots[slots.length-1])} (${slots.length} total)`);
  console.log('participants/resources:');
  people.forEach(dumpPerson);

  const opts: GARunOptions = { size: 100, iterations: 200, restarts: 3 };
  const result = runGenetic(slots, people, opts);
  if (result) {
    const chosen = slots[result.slotIndex];
    console.log('found slot:', fmtSlot(chosen));
    // detailed feedback per person
    console.log('breakdown:');
    for (const p of people) {
      const feas = isFeasible(chosen, p);
      const pref = preferenceScore(chosen, p);
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

  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1 * weekCount);
  end.setHours(17, 0, 0, 0);
  const slots = generateSlots(start, end, 60);

  const agent: Person = { name: 'Agent' };
  const room: Person = { name: 'Show Room' };

  const buyers: Person[] = [
    { name: 'Buyer1', preference: slot => (slot.start.getHours() < 12 ? 1 : 0) },
    { name: 'Buyer2', preference: slot => (slot.start.getHours() >= 12 ? 1 : 0) },
    { name: 'Buyer3' },
  ];

  console.log(`slots range: ${fmtSlot(slots[0])} through ${fmtSlot(slots[slots.length-1])} (${slots.length})`);
  console.log('agent and room:');
  [agent, room].forEach(dumpPerson);
  console.log('buyers:');
  buyers.forEach(dumpPerson);

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
        const pref = preferenceScore(slot, p);
        return feas ? pref : 0;
      });
      const agg = scores.reduce((a,b)=>a+b,0) / scores.length;
      console.log(`   group score (mean pref): ${agg.toFixed(3)}`);
      // show individual facts
      grp.forEach(p => {
        const feas = isFeasible(slot, p);
        const pref = preferenceScore(slot, p);
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
  const rooms: Person[] = [
    { name: 'Room1', bookedSlots: [slots[10], slots[11]] },
    { name: 'Room2', bookedSlots: [slots[50]] },
    { name: 'Room3', bookedSlots: [slots[100], slots[101], slots[102]] },
  ];
  console.log('room pool:');
  rooms.forEach(r => {
    console.log(`  ${r.name}: ${r.bookedSlots?.map(fmtSlot).join('; ') || '(none)'}`);
  });

  // person with hard availability window (only mornings) and existing booking
  const carol: Person = {
    name: 'Carol',
    hardAvailability: slot => slot.start.getHours() >= 8 && slot.start.getHours() < 12,
    bookedSlots: [slots[20], slots[21]],
    preference: slot => slot.start.getDay() === start.getDay() ? 1 : 0.5,
  };

  // person with composite constraint: either morning OR after 5pm
  const composite = new CompositeConstraint('or', [
    new TimeConstraint(new Date(start), new Date(start.getTime() + 5*60*60_000)),
    new TimeConstraint(new Date(start.getTime() + 10*60*60_000), new Date(end)),
  ]);
  const dave: Person = {
    name: 'Dave',
    availability: { status: 'available', constraints: [composite] },
    noticeRequired: 30*60_000, // half hour
  };

  // meeting requiring two consecutive slots (duration 30 minutes)
  const people = [carol, dave];

  console.log('participants:');
  people.forEach(dumpPerson);

  const opts: GARunOptions = { size: 200, iterations: 500, restarts: 2, maxDurationSlots: 2 };
  const result = runGenetic(slots, people, opts);
  if (result) {
    console.log('durationSlots requested/used:', result.durationSlots);
    const length = result.durationSlots || 1;
    const range = slots.slice(result.slotIndex, result.slotIndex + length);
    console.log('found multi-slot range:');
    range.forEach(s => console.log(' ', fmtSlot(s)));
    people.forEach(p => {
      console.log(`  ${p.name} feasibility:`, isFeasible(range, p), 'pref=', preferenceScore(range[0], p));
    });
  } else {
    console.log('no feasible multi-slot meeting found');
  }
}

// simply invoke examples when run directly
if (require.main === module) {
  caseGroupMeeting();
  caseBatchShowings();
  caseComplexScenario();
}
