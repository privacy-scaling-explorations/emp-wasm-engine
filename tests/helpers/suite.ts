type TestDefinition = {
  name: string,
  options: {
    skip?: boolean,
    only?: boolean,
  },
  fn: () => unknown,
};

let suite: TestDefinition[] = [];
let failures = 0;
let autorun = true;

export async function test(
  ...args:
    | [name: string, fn: () => unknown]
    | [name: string, options: TestDefinition['options'], fn: () => unknown]
) {
  let name, options, fn;

  if (args.length === 2) {
    [name, fn] = args;
    options = {};
  } else {
    [name, options, fn] = args;
  }

  suite.push({ name, options, fn });

  if (autorun) {
    queueMicrotask(runSuite);
  }
}

export function setSuiteAutorun(value: boolean) {
  autorun = value;
}

export async function runSuite() {
  if (suite.length === 0) {
    return;
  }

  const capturedSuite = suite;
  suite = [];

  const hasOnly = capturedSuite.some(({ options }) => options.only);

  console.log(`Running ${capturedSuite.length} tests...`);

  const puppeteerDetected = (globalThis as any).reportToPuppeteer !== undefined;

  for (const { name, options, fn } of capturedSuite) {
    if (options.skip || (hasOnly && !options.only)) {
      console.log(`🟡 SKIPPED: ${name}`);
      continue;
    }

    const start = Date.now();

    try {
      await fn();
      const end = Date.now();
      console.log(`✅ ${name} (${end - start}ms)`);
    } catch (e) {
      const end = Date.now();
      failures++;
      console.error(`❌ ${name} (${end - start}ms)`);

      if (!puppeteerDetected) {
        console.error(e);
      } else {
        try {
          console.error((e as Error).stack);
        } catch {
          console.error(`${e}`);
        }
      }
    }
  }

  console.log(`Done running tests. ${failures} failure(s).`);

  return { pass: suite.length - failures, fail: failures };
}
