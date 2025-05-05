# Renamed: [`emp-wasm-engine`](https://www.npmjs.com/package/emp-wasm-engine)

## Previously: emp-wasm-backend

Backend for [mpc-framework](https://github.com/voltrevo/mpc-framework) powered
by [emp-ag2pc](https://github.com/emp-toolkit/emp-ag2pc) and
[emp-agmpc](https://github.com/emp-toolkit/emp-agmpc) (via
[emp-wasm](https://github.com/voltrevo/emp-wasm)).

### Usage

```sh
npm install emp-wasm-backend
```

```ts
import { EmpWasmBackend } from "emp-wasm-backend";

const backend = new EmpWasmBackend();

// Use with mpc-framework
// https://github.com/voltrevo/mpc-framework
```
