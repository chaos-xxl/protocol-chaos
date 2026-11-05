// The server's clock (clock.mjs): the real time unless an evaluation harness fixes it before
// the server starts. Times stay strictly increasing either way, so "most recently updated
// first" stays exact.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setClockForEvaluation } from '../clock.mjs';
import { Repository } from '../repository.mjs';

const actor = { kind: 'agent', id: 'clock-test' };

test('the clock is the real time by default', () => {
  const repo = new Repository();
  const before = Date.now();
  const { eventId } = repo.eventNote({ actor, text: 'I want to learn the guitar this year.', title: 'Learning the guitar in 2026' });
  const after = Date.now();
  const { event, accounts } = repo.getProtocol({ eventId });
  for (const time of [event.createdAt, accounts[0].createdAt]) {
    const ms = Date.parse(time);
    assert.ok(ms >= before && ms <= after, `${time} lies between the calls`);
  }
});

test('an evaluation can fix the clock, and commits stay strictly increasing', () => {
  const fixed = Date.parse('2026-10-03T12:00:00.000Z');
  setClockForEvaluation(() => fixed);
  const repo = new Repository();
  const first = repo.eventNote({ actor, text: 'The moving budget is 20,000 yuan.', title: 'Moving house in autumn 2026' });
  const second = repo.eventNote({ actor, eventId: first.eventId, text: 'Make it 25,000.' });
  const { event, accounts } = repo.getProtocol({ eventId: first.eventId });
  assert.equal(event.createdAt, '2026-10-03T12:00:00.000Z');
  assert.deepEqual(accounts.map((account) => account.createdAt), ['2026-10-03T12:00:00.000Z', '2026-10-03T12:00:00.001Z']);
  assert.equal(event.updatedAt, '2026-10-03T12:00:00.001Z');
  assert.equal(second.accountId, accounts[1].id);
});

test('setClockForEvaluation takes only a function', () => {
  assert.throws(() => setClockForEvaluation('2026-10-03T12:00:00Z'), TypeError);
});
