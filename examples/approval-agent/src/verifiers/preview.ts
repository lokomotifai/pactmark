import { digestCanonicalJson } from "@pactmark/core";
import type { ApprovalPreview, MessageArguments } from "../contract.js";
export function previewMatches(preview: ApprovalPreview, args: MessageArguments): boolean {
  return (
    preview.argumentsDigest ===
    digestCanonicalJson({ target: args.target.trim().toLowerCase(), content: args.content })
  );
}
