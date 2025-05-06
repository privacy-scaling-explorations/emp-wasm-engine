import { expect } from 'chai';

import { Protocol } from 'mpc-framework';
import * as summon from 'summon-ts';

import { EmpWasmEngine } from '../src';

import { test } from './helpers/suite';
import AsyncQueueStore from './helpers/AsyncQueueStore';

test("max(3, 5) === 5", async () => {
  await summon.init();

  const { circuit } = summon.compile({
    path: '/src/main.ts',
    boolifyWidth: 16,
    files: {
      '/src/main.ts': `
        export default (io: Summon.IO) => {
          const a = io.input('alice', 'a', summon.number());
          const b = io.input('bob', 'b', summon.number());

          io.outputPublic('main', a > b ? a : b);
        };
      `,
    },
  });

  const protocol = new Protocol(circuit, new EmpWasmEngine());
  const aqs = new AsyncQueueStore<Uint8Array>();

  const outputs = await Promise.all([
    runParty(protocol, 'alice', { a: 3 }, aqs),
    runParty(protocol, 'bob', { b: 5 }, aqs),
  ]);

  expect(outputs).to.deep.equal([{ main: 5 }, { main: 5 }]);
});

test("middle(8, 17, 5) == 8", async () => {
  await summon.init();

  const { circuit } = summon.compile({
    path: '/src/main.ts',
    boolifyWidth: 8,
    files: {
      '/src/main.ts': `
        export default (io: Summon.IO) => {
          const nums = [
            io.input('alice', 'a', summon.number()),
            io.input('bob', 'b', summon.number()),
            io.input('charlie', 'c', summon.number()),
          ];

          let highest = nums[0];
          let secondHighest = 0;

          for (let i = 1; i < nums.length; i++) {
            if (nums[i] > highest) {
              secondHighest = highest;
              highest = nums[i];
            } else if (nums[i] > secondHighest) {
              secondHighest = nums[i];
            }
          }

          io.outputPublic('main', secondHighest);
        };
      `,
    },
  });

  const protocol = new Protocol(circuit, new EmpWasmEngine());
  const aqs = new AsyncQueueStore<Uint8Array>();

  const outputs = await Promise.all([
    runParty(protocol, 'alice', { a: 8 }, aqs),
    runParty(protocol, 'bob', { b: 17 }, aqs),
    runParty(protocol, 'charlie', { c: 5 }, aqs),
  ]);

  expect(outputs).to.deep.equal([
    { main: 8 },
    { main: 8 },
    { main: 8 },
  ]);
});

// FIXME: use 5 bidders and auction house (which doesn't bid but observes)
test("vickrey(8, 17, 5) == [1, 8]", async () => {
  await summon.init();

  const { circuit } = summon.compile({
    path: '/src/main.ts',
    boolifyWidth: 8,
    files: {
      '/src/main.ts': `
        export default (io: Summon.IO) => {
          const nums = [
            io.input('alice', 'a', summon.number()),
            io.input('bob', 'b', summon.number()),
            io.input('charlie', 'c', summon.number()),
          ];

          let winner = 0;
          let highest = nums[0];
          let secondHighest = 0;

          for (let i = 1; i < nums.length; i++) {
            if (nums[i] > highest) {
              secondHighest = highest;
              highest = nums[i];
              winner = i;
            } else if (nums[i] > secondHighest) {
              secondHighest = nums[i];
            }
          }

          io.outputPublic('winner', winner);
          io.outputPublic('price', secondHighest);
        }
      `,
    },
  });

  const protocol = new Protocol(circuit, new EmpWasmEngine());
  const aqs = new AsyncQueueStore<Uint8Array>();

  const outputs = await Promise.all([
    runParty(protocol, 'alice', { a: 8 }, aqs),
    runParty(protocol, 'bob', { b: 17 }, aqs),
    runParty(protocol, 'charlie', { c: 5 }, aqs),
  ]);

  expect(outputs).to.deep.equal([
    // Participant index 1 (Bob) wins the auction with the highest bid, but only
    // pays the second highest bid. His actual bid is kept secret.
    { winner: 1, price: 8 },
    { winner: 1, price: 8 },
    { winner: 1, price: 8 },
  ]);
});

test('boolean io', async () => {
  await summon.init();

  const { circuit } = summon.compile({
    path: '/src/main.ts',
    boolifyWidth: 8,
    files: {
      '/src/main.ts': `
        export default (io: Summon.IO) => {
          const a = io.input('alice', 'a', summon.bool());
          const b = io.input('bob', 'b', summon.bool());

          io.outputPublic('res', a && b);
        };
      `,
    },
  });

  const protocol = new Protocol(circuit, new EmpWasmEngine());
  const aqs = new AsyncQueueStore<Uint8Array>();

  const outputs = await Promise.all([
    runParty(protocol, 'alice', { a: true }, aqs),
    runParty(protocol, 'bob', { b: true }, aqs),
  ]);

  expect(outputs).to.deep.equal([
    { res: true },
    { res: true },
  ]);
});

async function runParty(
  protocol: Protocol,
  party: string,
  input: Record<string, unknown>,
  aqs: AsyncQueueStore<Uint8Array>,
) {
  const session = protocol.join(
    party,
    input,
    (to, msg) => {
      aqs.get(party, to).push(msg);
    },
  );

  const partyNames = protocol.circuit.mpcSettings.map(
    ({ name }, i) => name ?? `party${i}`,
  );

  for (const otherParty of partyNames) {
    if (otherParty !== party) {
      aqs.get(otherParty, party).stream(
        data => session.handleMessage(otherParty, data),
      );
    }
  }

  const output = await session.output();

  return output;
}
