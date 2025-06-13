import { EngineSession, MpcSettings } from "mpc-framework-common";
import { BufferQueue, secureMPC } from "emp-wasm";
import { encode } from '@msgpack/msgpack';
import { keccak_256 } from '@noble/hashes/sha3';

import defer from "./defer.js";
import buffersEqual from "./buffersEqual.js";
import EmpCircuit from "./EmpCircuit.js";
import sortKeys from 'sort-keys';

export default class EmpWasmSession implements EngineSession {
  bqs = new BufferQueueStore();
  result = defer<Record<string, unknown>>();

  constructor(
    public empCircuit: EmpCircuit,
    public input: Record<string, unknown>,
    public rawSend: (to: string, msg: Uint8Array) => void,
    public thisPartyName: string,
  ) {
    this.run().catch(err => {
      this.result.reject(err);
    });
  }

  handleMessage(from: string, msg: Uint8Array): void {
    if (!this.empCircuit.hasPartyName(from)) {
      throw new Error(`Received message from unknown peer: ${from}`);
    }

    const channel = channelFromByte(msg[0]);
    this.bqs.get(from, channel).push(msg.slice(1));
  }

  send(to: string, channel: 'a' | 'b', msg: Uint8Array): void {
    const fullMsg = new Uint8Array(msg.length + 1);
    fullMsg[0] = channel.charCodeAt(0);
    fullMsg.set(msg, 1);

    this.rawSend(to, fullMsg);
  }

  async run() {
    const setupValue = sortKeys(
      this.empCircuit.originalCircuit,
      { deep: true },
    );

    const setupHash = keccak_256(encode(setupValue));

    for (const partyName of this.empCircuit.partyNames) {
      if (partyName !== this.thisPartyName) {
        this.send(partyName, 'a', setupHash);
      }
    }

    // This needs to be in a separate loop so that we send all our hashes before
    // we start waiting on the responses.
    for (const partyName of this.empCircuit.partyNames) {
      if (partyName !== this.thisPartyName) {
        const setupHashReceived = await this.bqs
          .get(partyName, 'a')
          .pop(setupHash.length, setupHash.length);

        if (!buffersEqual(setupHash, setupHashReceived)) {
          throw new Error(`Setup hash mismatch with ${partyName}`);
        }
      }
    }

    const outputBits = await secureMPC({
      party: this.empCircuit.partyIndexFromName(this.thisPartyName),
      size: this.empCircuit.partyNames.length,
      circuit: this.empCircuit.getSimplifiedBristol(),
      inputBits: this.empCircuit.encodeInput(this.thisPartyName, this.input),
      inputBitsPerParty: this.empCircuit.getInputBitsPerParty(),
      io: {
        send: (toParty, channel, data) =>
          this.send(this.empCircuit.partyNameFromIndex(toParty), channel, data),
        recv: (fromParty, channel, min_len, max_len) =>
          this.bqs.get(this.empCircuit.partyNameFromIndex(fromParty), channel).pop(min_len, max_len),
      },
    });

    this.result.resolve(this.empCircuit.decodeOutput(outputBits));
  }

  output(): Promise<Record<string, unknown>> {
    return this.result.promise;
  }
}

class BufferQueueStore {
  bqs = new Map<string, BufferQueue>();

  get(from: string, channel: 'a' | 'b') {
    const key = `${from}-${channel}`;

    if (!this.bqs.has(key)) {
      this.bqs.set(key, new BufferQueue());
    }

    return this.bqs.get(key)!;
  }
}

function channelFromByte(byte: number): 'a' | 'b' {
  switch (byte) {
    case 'a'.charCodeAt(0):
      return 'a';
    case 'b'.charCodeAt(0):
      return 'b';
    default:
      throw new Error('Invalid channel');
  }
}
