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

const getSha256Circuit = (() => {
  let compileOutput: summon.CompileResult | undefined = undefined;

  return async () => {
    if (compileOutput) {
      return compileOutput;
    }

    await summon.init();

    const libVersion = 'c24b5f32ccb8d8ffe77fb1465425a0575012b4b7';
    const ghPse = 'https://raw.githubusercontent.com/privacy-scaling-explorations';
    const libBase = `${ghPse}/summon-lib/${libVersion}`;

    async function downloadLib(path: string) {
      const resp = await fetch(`${libBase}/${path}`);
      const txt = await resp.text();

      return txt;
    }

    compileOutput = summon.compile({
      path: '/src/main.ts',
      boolifyWidth: 8,
      files: {
        '/src/main.ts': `
          import sha256 from './deps/sha256/mod.ts';

          export default (io: Summon.IO) => {
            // 6 characters * 8 bits, so we can encode 'summon'
            const input = range(6 * 8).map(
              i => io.input('alice', \`input\${i}\`, summon.bool()),
            );

            io.addParty('bob');

            // expected: 2815cb02b95b6d15383bf551f09b33e01806ad2f4221b035a592c1be146d6a99
            // (but encoded as bits)
            const output = sha256(input);

            for (const [i, b] of output.entries()) {
              io.outputPublic(\`output\${i}\`, b);
            }
          };

          export function range(limit: number) {
            let res = [];

            for (let i = 0; i < limit; i++) {
              res.push(i);
            }

            return res;
          }
        `,
        '/src/deps/sha256/mod.ts': await downloadLib('sha256/mod.ts'),
        '/src/deps/sha256/sha256Compress.ts': await downloadLib('sha256/sha256Compress.ts'),
      },
    });

    return compileOutput;
  };
})();

test('compile sha256', async () => {
  await getSha256Circuit();
});

for (let nParties = 2; nParties <= 4; nParties++) {
  test(`sha256('summon') == 28..99 (${nParties} parties)`, async () => {
    const start = Date.now();
    let { circuit } = await getSha256Circuit();
    circuit = structuredClone(circuit);

    const partyNames = ['alice', 'bob', 'charlie', 'dave'];
    expect(partyNames.length).to.be.greaterThanOrEqual(nParties);

    while (circuit.mpcSettings.length < nParties) {
      const partyIndex = circuit.mpcSettings.length;
      const name = partyNames[partyIndex];

      circuit.mpcSettings.push({
        name,
        inputs: [],
        outputs: circuit.mpcSettings[0].outputs,
      })
    }

    // We rely (perhaps improperly) on `compile sha256` to have already been run
    // so that the circuit is already cached. This way the test provides a measure
    // of MPC performance, separate from summon compiling sha256.
    expect(Date.now() - start).to.be.lessThan(50, 'Circuit should have been cached');

    const protocol = new Protocol(circuit, new EmpWasmEngine());
    const aqs = new AsyncQueueStore<Uint8Array>();

    const summonBits = [...'summon']
      .map(c => c.codePointAt(0)!.toString(2).padStart(8, '0'))
      .join('').split('')
      .map(bit => bit === '0' ? false : true);

    const aliceInputs = Object.fromEntries(summonBits.entries().map(
      ([i, boolBit]) => [`input${i}`, boolBit],
    ));

    const outputs = await Promise.all(
      range(nParties).map(partyIndex => runParty(
        protocol,
        partyNames[partyIndex],
        partyIndex === 0 ? aliceInputs : {},
        aqs,
      )),
    );

    for (const output of outputs) {
      const bits = range(256).map(i => output[`output${i}`] as boolean);
      const outputHex = bitsToHex(bits);

      expect(outputHex).to.eq('2815cb02b95b6d15383bf551f09b33e01806ad2f4221b035a592c1be146d6a99');
    }
  });
}

function range(limit: number) {
  let res: number[] = [];

  for (let i = 0; i < limit; i++) {
    res.push(i);
  }

  return res;
}

function bitsToHex(bits: boolean[]) {
  if (bits.length % 8 !== 0) {
    throw new Error('bits do not form complete bytes');
  }

  let res = '';

  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;

    for (let j = 0; j < 8; j++) {
      const bit = Number(bits[i + j]);
      byte |= bit << (7 - j);
    }

    res += byte.toString(16).padStart(2, '0');
  }

  return res;
}

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
