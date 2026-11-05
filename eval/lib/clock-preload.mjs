// Loaded with `node --import` before the reference server, in evaluation runs only: fixes the
// server's clock at PROTOCOL_CHAOS_EVAL_CLOCK (an RFC 3339 timestamp), the moment the
// simulated conversation takes place. The server keeps its times strictly increasing, so
// writes within one conversation still come one after another.
import { setClockForEvaluation } from '../../server/clock.mjs';

const value = process.env.PROTOCOL_CHAOS_EVAL_CLOCK;
if (value !== undefined) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`PROTOCOL_CHAOS_EVAL_CLOCK is not a timestamp: ${value}`);
  setClockForEvaluation(() => ms);
}
