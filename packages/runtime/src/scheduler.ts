import {
  digestCanonicalJson,
  type IdGenerator,
  type RuntimeCapabilities,
  type WakeupReceipt,
  WakeupRequestSchema,
  type WakeupRequest,
  type WakeupScheduler,
  type Clock,
} from "@pactmark/core";

export const INLINE_SCHEDULER_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: false,
  cancellation: true,
  sandbox: "none",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: [],
});

export class InlineWakeupScheduler implements WakeupScheduler {
  readonly capabilities = INLINE_SCHEDULER_CAPABILITIES;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #handler: (request: WakeupRequest) => Promise<void>;
  readonly #onHandlerError: (receipt: WakeupReceipt, error: unknown) => void;
  readonly #pending = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  constructor(options: {
    clock: Clock;
    idGenerator: IdGenerator;
    handler: (request: WakeupRequest) => Promise<void>;
    onHandlerError: (receipt: WakeupReceipt, error: unknown) => void;
  }) {
    this.#clock = options.clock;
    this.#ids = options.idGenerator;
    this.#handler = options.handler;
    this.#onHandlerError = options.onHandlerError;
  }

  schedule(input: WakeupRequest): Promise<WakeupReceipt> {
    const request = WakeupRequestSchema.parse(input);
    const receipt: WakeupReceipt = {
      schemaVersion: "1",
      receiptId: this.#ids.generate("wakeup"),
      schedulerId: "pactmark.inline@1",
      requestDigest: digestCanonicalJson(request),
      durable: false,
      atomicWithCommand: false,
      createdAt: this.#clock.now(),
    };
    const timeout = globalThis.setTimeout(() => {
      this.#pending.delete(receipt.receiptId);
      void this.#handler(request).catch((error: unknown) => {
        this.#onHandlerError(receipt, error);
      });
    }, 0);
    this.#pending.set(receipt.receiptId, timeout);
    return Promise.resolve(receipt);
  }

  cancel(receipt: WakeupReceipt): Promise<void> {
    const timeout = this.#pending.get(receipt.receiptId);
    if (timeout === undefined) return Promise.resolve();
    globalThis.clearTimeout(timeout);
    this.#pending.delete(receipt.receiptId);
    return Promise.resolve();
  }
}
