import {
  Engine,
  EngineSession,
  checkSettingsValid,
  Circuit,
} from "mpc-framework-common";
import EmpWasmSession from "./EmpWasmSession.js";
import EmpCircuit from "./EmpCircuit.js";

export default class EmpWasmEngine implements Engine {
  run(
    circuit: Circuit,
    name: string,
    input: Record<string, unknown>,
    send: (to: string, msg: Uint8Array) => void,
  ): EngineSession {
    const checkResult = (
      checkSettingsValid(circuit, name, input) ??
      checkSettingsValidForEmpWasm(circuit)
    );

    if (checkResult !== undefined) {
      throw checkResult;
    }

    const empCircuit = new EmpCircuit(circuit);

    return new EmpWasmSession(
      empCircuit,
      input,
      send,
      name,
    );
  }
}

export function checkSettingsValidForEmpWasm(
  circuit: Circuit,
): Error | undefined {
  for (const participant of circuit.mpcSettings) {
    if (!checkStringSetsEqual(
      participant.outputs,
      circuit.info.outputs.map((o) => o.name),
    )) {
      return new Error(
        "Participant outputs do not match the circuit",
      );
    }

    // Note: It's also possible for the garbler to get no outputs, but this is
    // not currently supported here.
  }

  return undefined;
}

function checkStringSetsEqual(a: string[], b: string[]) {
  const setA = new Set(a);
  const setB = new Set(b);

  if (setA.size !== setB.size) {
    return false;
  }

  for (const elem of setA) {
    if (!setB.has(elem)) {
      return false;
    }
  }

  return true;
}
