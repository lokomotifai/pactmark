interface PortableEvent {
  readonly sequence: number;
  readonly type: string;
}
export interface PortableSuccess {
  readonly ok: true;
  readonly events: readonly PortableEvent[];
  readonly toolOutput: { readonly sku: string; readonly name: string; readonly available: boolean };
  readonly artifactContentDigest: string;
  readonly evidenceProduced: true;
  readonly summary: string;
}
interface PortableFailure {
  readonly ok: false;
  readonly errorCode:
    "KAF_EXAMPLE_INPUT_INVALID" | "KAF_EXAMPLE_SKU_NOT_FOUND" | "KAF_EXAMPLE_RUN_FAILED";
}
export type PortableResult = PortableSuccess | PortableFailure;
