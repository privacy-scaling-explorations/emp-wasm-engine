import { Circuit, CircuitIOInfo } from "mpc-framework-common";
import parseBristol, { Bristol } from "./parseBristol.js";
import assert from "./assert.js";
import never from "./never.js";

type EmpGate = (
  | { type: 'AND'; left: number; right: number; output: number }
  | { type: 'XOR'; left: number; right: number; output: number }
  | { type: 'INV'; input: number; output: number }
);

export default class EmpCircuit {
  private bristol: Bristol;
  public originalCircuit: Circuit;

  private metadata: {
    wireCount: number;
    inputBits0: number;
    inputBits1: number;
    outputBits: number;
  };
  private gates: EmpGate[] = [];

  public partyNames: string[] = [];
  private partyInputs: Record<string, string[]> = {};
  private allInputs: string[];
  private outputs: string[];

  private getOldInputAddress: (name: string) => number;
  private getOldOutputAddress: (name: string) => number;

  // old address -> new address
  private addressMap = new Map<number, number>();
  private firstOutputAddress: number;

  private nextAddress = 0;
  private nextOutputAddress = -1;

  private zeroWireAddress?: number;

  constructor(circuit: Circuit) {
    this.bristol = parseBristol(circuit.bristol);
    this.originalCircuit = circuit;

    const partyNamesSet = new Set<string>();

    for (let i = 0; i < circuit.mpcSettings.length; i++) {
      const partyName = circuit.mpcSettings[i].name ?? `party${i}`;
      this.partyNames.push(partyName);

      assert(!partyNamesSet.has(partyName), `Duplicate party name ${partyName}`);
      partyNamesSet.add(partyName);
    }

    this.allInputs = [];

    this.getOldInputAddress = (() => {
      const addressesByName = new Map<string, number>(
        circuit.info.inputs.map(input => [input.name, input.address] as const),
      );

      return (name: string) => {
        const address = addressesByName.get(name);
        assert(address !== undefined, `Address for ${name} not found`);

        return address;
      };
    })();

    this.getOldOutputAddress = (() => {
      const addressesByName = new Map<string, number>(
        circuit.info.outputs.map(output => [output.name, output.address] as const),
      );

      return (name: string) => {
        const address = addressesByName.get(name);
        assert(address !== undefined, `Address for ${name} not found`);

        return address;
      };
    })();

    for (const [i, partyName] of this.partyNames.entries()) {
      this.partyInputs[partyName] = circuit.mpcSettings[i].inputs.slice();
      this.partyInputs[partyName].sort((a, b) =>
        this.getOldInputAddress(a) - this.getOldInputAddress(b),
      );

      this.allInputs.push(...this.partyInputs[partyName]);
    }

    this.allInputs.sort(
      (a, b) => this.getOldInputAddress(a) - this.getOldInputAddress(b),
    );

    const outputNames = new Set<string>();

    for (const mpcSetting of circuit.mpcSettings) {
      for (const output of mpcSetting.outputs) {
        outputNames.add(output);
      }
    }

    this.outputs = [...outputNames];
    this.outputs.sort(
      (a, b) => this.getOldOutputAddress(a) - this.getOldOutputAddress(b),
    );

    // The emp-wasm engine requires each party's input bits to be contiguous.
    const allInputsInPartyOrder: string[] = [];

    for (const partyName of this.partyNames) {
      allInputsInPartyOrder.push(...this.partyInputs[partyName]);
    }

    for (const inputName of allInputsInPartyOrder) {
      const width = this.getInputInfo(inputName).width;
      const oldAddress = this.getOldInputAddress(inputName);
      assert(oldAddress !== undefined, `Input ${inputName} not found`);

      for (let i = 0; i < width; i++) {
        const newAddress = this.assignAddress('normal');
        this.addressMap.set(oldAddress + i, newAddress);
      }
    }

    const oldFirstOutputAddress = this.getOldOutputAddress(this.outputs[0]);

    for (const g of this.bristol.gates) {
      let outputAddress: number;
      const wireType = g.output < oldFirstOutputAddress ? 'normal' : 'output';

      // Note wireType:output means an output of the *circuit*, not just an
      // output of the gate

      switch (g.type) {
        case 'AND':
        case 'XOR': {
          outputAddress = this.assignAddress(wireType);

          this.gates.push({
            type: g.type,
            left: this.getAddress(g.left),
            right: this.getAddress(g.right),
            output: outputAddress,
          });

          if (g.type === 'XOR' && g.left === g.right) {
            // If the underlying circuit creates a zero wire we can also make
            // use of it
            this.zeroWireAddress ??= outputAddress;
          }

          break;
        }

        case 'INV': {
          outputAddress = this.assignAddress(wireType);

          this.gates.push({
            type: 'INV',
            input: this.getAddress(g.input),
            output: outputAddress,
          });

          break;
        }

        default:
          never(g);
      }

      this.addressMap.set(g.output, outputAddress);
    }

    const outputWireCount = -this.nextOutputAddress - 1;
    this.firstOutputAddress = this.nextAddress;
    this.nextAddress += outputWireCount;

    const reassignOutputAddress = (address: number) => {
      assert(address < 0);
      return this.firstOutputAddress - address - 1;
    };

    for (const g of this.gates) {
      if (g.output < 0) {
        g.output = reassignOutputAddress(g.output);
      }

      if (g.type === 'AND' || g.type === 'XOR') {
        if (g.left < 0) {
          g.left = reassignOutputAddress(g.left);
        }

        if (g.right < 0) {
          g.right = reassignOutputAddress(g.right);
        }
      } else if (g.type === 'INV') {
        if (g.input < 0) {
          g.input = reassignOutputAddress(g.input);
        }
      } else {
        never(g);
      }
    }

    for (const [oldId, newId] of this.addressMap.entries()) {
      if (newId < 0) {
        this.addressMap.set(oldId, reassignOutputAddress(newId));
      }
    }

    // For 2PC, these correspond to the number of bits from each party.
    // For 3+PC, the only thing that matters is the total number of input bits
    // is correct.
    let inputBits0: number;
    let inputBits1: number;

    if (this.partyNames.length === 2) {
      inputBits0 = sum(
        this.partyInputs[this.partyNames[0]]
          .map((n) => this.getInputInfo(n).width),
      );

      inputBits1 = sum(
        this.partyInputs[this.partyNames[1]]
          .map((n) => this.getInputInfo(n).width),
      );
    } else {
      inputBits0 = sum(this.allInputs.map((n) => this.getInputInfo(n).width));
      inputBits1 = 0;
    }

    const wireCount = this.nextAddress;

    this.metadata = {
      wireCount,
      inputBits0,
      inputBits1,
      outputBits: wireCount - this.firstOutputAddress,
    };
  }

  private getAddress(oldAddress: number): number {
    const address = this.addressMap.get(oldAddress);
    assert(address !== undefined, `Address ${oldAddress} not found`);

    return address;
  }

  private assignAddress(type: 'normal' | 'output'): number {
    if (type === 'normal') {
      return this.nextAddress++;
    }

    if (type === 'output') {
      return this.nextOutputAddress--;
    }

    never(type);
  }

  private getInputInfo(inputName: string): CircuitIOInfo {
    const inputInfo = this.originalCircuit.info.inputs.find(
      (input) => input.name === inputName,
    );

    assert(inputInfo !== undefined, `Input ${inputName} not found`);
    
    return inputInfo;
  }

  private getOutputInfo(outputName: string): CircuitIOInfo {
    const outputInfo = this.originalCircuit.info.outputs.find(
      (output) => output.name === outputName,
    );

    assert(outputInfo !== undefined, `Output ${outputName} not found`);

    return outputInfo;
  }

  hasPartyName(name: string): boolean {
    return this.partyNames.includes(name);
  }

  partyNameFromIndex(index: number): string {
    const partyName = this.partyNames[index];
    assert(partyName !== undefined, `Party index ${index} not found`);

    return partyName;
  }

  partyIndexFromName(name: string): number {
    const index = this.partyNames.indexOf(name);
    assert(index !== -1, `Party name ${name} not found`);

    return index;
  }

  getInputBitsPerParty(): number[] {
    return this.partyNames.map((partyName) =>
      sum(this.partyInputs[partyName].map((n) => this.getInputInfo(n).width)),
    );
  }

  getSimplifiedBristol(): string {
    const lines = [
      `${this.gates.length} ${this.metadata.wireCount}`,
      `${this.metadata.inputBits0} ${this.metadata.inputBits1} ${this.metadata.outputBits}`,
      '',
    ];

    for (const g of this.gates) {
      switch (g.type) {
        case 'AND':
        case 'XOR':
          lines.push(`2 1 ${g.left} ${g.right} ${g.output} ${g.type}`);
          break;

        case 'INV':
          lines.push(`1 1 ${g.input} ${g.output} INV`);
          break;

        default:
          never(g);
      }
    }

    return lines.join('\n');
  }

  encodeInput(
    party: string,
    input: Record<string, unknown>,
  ): Uint8Array {
    const inputNames = this.partyInputs[party];
    assert(inputNames !== undefined, `Party ${party} not found`);

    const bits: boolean[] = [];

    for (const inputName of inputNames) {
      const value = input[inputName];
      const { type, width } = this.getInputInfo(inputName);

      if (type === 'number') {
        assert(
          typeof value === 'number',
          `Expected input ${inputName} to be a number`,
        );

        let v = BigInt(value);
        for (let i = 0; i < width; i++) {
          bits.push(v % 2n === 1n ? true : false);
          v /= 2n;
        }
      } else if (type === 'bool') {
        assert(
          typeof value === 'boolean',
          `Expected input ${inputName} to be a bool`,
        );

        bits.push(value);
      } else {
        assert(false, `Unknown input type ${type}`);
      }
    }

    return Uint8Array.from(bits.map((bit) => (bit ? 1 : 0)));
  }

  decodeOutput(outputBits: Uint8Array): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const outputName of this.outputs) {
      const { type, width } = this.getOutputInfo(outputName);
      const oldAddress = this.getOldOutputAddress(outputName);

      let value = 0;

      for (let i = 0; i < width; i++) {
        const address = this.addressMap.get(oldAddress + i);
        assert(address !== undefined, `Address ${oldAddress + i} not found`);
        value += outputBits[address - this.firstOutputAddress] * 2 ** i;
      }

      if (type === 'number') {
        output[outputName] = value;
      } else if (type === 'bool') {
        output[outputName] = Boolean(value);
      } else {
        assert(false, `Unknown output type ${type}`);
      }
    }

    return output;
  }

  eval(
    inputs: Record<string, Record<string, unknown>>,
    //             ^ party name   ^ input name
    // eg: {
    //   alice: { a: 3 },
    //   bob: { b: 5 },
    // }
  ): Record<string, unknown> {
    const wires = new Uint8Array(this.metadata.wireCount);
    let address = 0;

    for (const party of this.partyNames) {
      assert(inputs[party] !== undefined, `Inputs for party ${party} not found`);
      for (const bit of this.encodeInput(party, inputs[party])) {
        wires[address++] = bit;
      }
    }

    for (const party of Object.keys(inputs)) {
      assert(this.partyNames.includes(party), `Unknown party ${party}`);
    }

    for (const g of this.gates) {
      switch (g.type) {
        case 'AND':
          wires[g.output] = wires[g.left] & wires[g.right];
          break;

        case 'XOR':
          wires[g.output] = wires[g.left] ^ wires[g.right];
          break;

        case 'INV':
          wires[g.output] = Number(!wires[g.input]);
          break;

        default:
          never(g);
      }
    }

    return this.decodeOutput(wires.subarray(this.firstOutputAddress));
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
