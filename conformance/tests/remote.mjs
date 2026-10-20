// Remote level (§9.2): a server reached from another machine. Runs with --url, and --actor
// set to the client name the token was issued for.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export default [
  {
    id: 'remote.tls', level: 'remote', ref: '§9.2', title: 'A remote server is reached over TLS',
    async run(t) {
      const url = new URL(t.url);
      if (LOOPBACK.has(url.hostname)) t.skip('a loopback address; TLS applies to a server reached from another machine');
      t.equal(url.protocol, 'https:', 'the protocol of the endpoint');
    },
  },
  {
    id: 'remote.actor', level: 'remote', ref: '§9.2', title: 'A write under any actor but the authenticated client fails with ACTOR_MISMATCH',
    async run(t) {
      const event = await t.newEvent('Remote actor');
      const parent = await t.newEvent('Remote actor parent');
      for (const actor of [{ kind: 'agent', id: `${t.actor.id}-someone-else` }, { kind: 'user', id: t.actor.id }]) {
        const as = JSON.stringify(actor);
        await t.fails('ACTOR_MISMATCH', () => t.call('event_note', { actor, accountSource: 'user', eventId: event.id, text: t.unique('Not my words') }), `event_note as ${as}`);
        await t.fails('ACTOR_MISMATCH', () => t.call('event_note', { actor, accountSource: 'user', text: t.unique('A new matter') }), `a new Event as ${as}`);
        await t.fails('ACTOR_MISMATCH', () => t.call('event_record_expression', {
          eventId: event.id, actor, accountSource: 'user', text: t.unique('Not my words'), expectedVersion: event.version, set: { title: 'x' },
        }), `event_record_expression as ${as}`);
        await t.fails('ACTOR_MISMATCH', () => t.call('event_add_parent', {
          childEventId: event.id, parentEventId: parent.id, actor, sourceAccountIds: [event.accountId], expectedVersion: event.version,
        }), `event_add_parent as ${as}`);
        if (t.levels.has('entities')) {
          await t.fails('ACTOR_MISMATCH', () => t.call('entity_create', {
            actor, kind: 'thing', name: t.unique('Not mine'), accountText: t.unique('Not my words'), accountSource: 'user',
          }), `entity_create as ${as}`);
        }
      }
      const after = await t.read(event.id, { accounts: 'all' });
      t.equal([after.accounts.length, after.event.version, after.event.parents], [1, event.version, []], 'nothing was written');
    },
  },
  {
    id: 'remote.version', level: 'remote', ref: '§9.2', title: 'Writes that change fields or parents fail with VERSION_REQUIRED without expectedVersion',
    async run(t) {
      const child = await t.newEvent('Remote version');
      const parent = await t.newEvent('Remote version parent');
      const linkArgs = { childEventId: child.id, parentEventId: parent.id, actor: t.actor, sourceAccountIds: [child.accountId] };
      await t.fails('VERSION_REQUIRED', () => t.call('event_record_expression', {
        eventId: child.id, actor: t.actor, accountSource: 'user', text: t.unique('No version'), set: { title: 'x' },
      }), 'event_record_expression');
      await t.fails('VERSION_REQUIRED', () => t.call('event_add_parent', linkArgs), 'event_add_parent');
      const linked = await t.call('event_add_parent', { ...linkArgs, expectedVersion: child.version });
      await t.fails('VERSION_REQUIRED', () => t.call('event_remove_parent', linkArgs), 'event_remove_parent');
      if (t.levels.has('entities')) {
        const created = await t.call('entity_create', {
          actor: t.actor, kind: 'thing', name: t.unique('Remote thing'), accountText: t.unique('A thing'), accountSource: 'user',
        });
        await t.fails('VERSION_REQUIRED', () => t.call('entity_record', {
          entityId: created.entityId, actor: t.actor, text: t.unique('No version'), accountSource: 'user', name: t.unique('Renamed'),
        }), 'entity_record');
      }
      const after = await t.read(child.id, { accounts: 'all' });
      t.equal([after.accounts.length, after.event.version, after.event.parents], [1, linked.version, [parent.id]], 'only the write with a version changed it');
    },
  },
];
