import { expect } from 'chai';

import * as summon from 'summon-ts';
import EmpCircuit from '../src/EmpCircuit';
import { test } from './helpers/suite';

test('correctly evals circuit', async () => {
  await summon.init();

  const { circuit } = summon.compile({
    path: '/src/main.ts',
    boolifyWidth: 4,
    files: {
      '/src/main.ts': `
        export default (io: Summon.IO) => {
          const a = io.input('alice', 'a', summon.number());
          const b = io.input('bob', 'b', summon.number());

          io.outputPublic('main', a * b);
        }
      `,
    },
  });

  const ec = new EmpCircuit(circuit);

  const outputs = ec.eval({
    alice: { a: 3 },
    bob: { b: 5 },
  });

  expect(outputs).to.deep.equal({ main: 15 });
});
