const { RRule, RRuleSet } = require('rrule');
const start = new Date();
start.setHours(8,0,0,0);
console.log('start', start);

function testRule(ruleOptions) {
  const rs = new RRuleSet();
  rs.rrule(new RRule(ruleOptions));
  console.log('options', ruleOptions);
  console.log('between start and +1h', rs.between(start, new Date(start.getTime()+3600*1000), true));
  console.log('between start and start', rs.between(start, start, true));
  console.log('all occurences first few', rs.all().slice(0,3));
}

// original with byhour
testRule({freq: RRule.DAILY, dtstart: start, byhour: 8});
// without byhour
testRule({freq: RRule.DAILY, dtstart: start});
// dtstart yesterday, no byhour
const yesterday = new Date(start.getTime() - 24*3600*1000);
testRule({freq: RRule.DAILY, dtstart: yesterday});
