// The time the reference server records: always the real time, except under an evaluation
// harness that fixes it before the server starts (eval/lib/clock-preload.mjs, loaded with
// `node --import`). Nothing in MCP, HTTP or the command line can change it.

let read = () => Date.now();

/** Milliseconds since the epoch, as the server's clock reads them. */
export const currentTimeMs = () => read();

/** For evaluation harnesses only: replaces the clock with `source`, a function returning milliseconds. */
export function setClockForEvaluation(source) {
  if (typeof source !== 'function') throw new TypeError('setClockForEvaluation takes a function that returns milliseconds since the epoch.');
  read = source;
}
