import type { MessageArguments } from "../contract.js";

export class SimulatedMessageReceiver {
  readonly #receipts = new Map<string, MessageArguments>();
  dispatch(idempotencyKey: string, message: MessageArguments): void {
    if (!this.#receipts.has(idempotencyKey))
      this.#receipts.set(idempotencyKey, Object.freeze({ ...message }));
  }
  has(idempotencyKey: string): boolean {
    return this.#receipts.has(idempotencyKey);
  }
  get dispatchCount(): number {
    return this.#receipts.size;
  }
}
