import {
  DigestSchema,
  EvidenceRecordSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type EvidenceRecord,
} from "@pactmark/core";
import { z } from "zod";
import { verifyEvidenceDigest } from "./records.js";

const HexSchema = z
  .string()
  .regex(/^[0-9a-f]+$/u)
  .refine((value) => value.length % 2 === 0);

export const EvidenceAttestationSchema = z
  .object({
    schemaVersion: z.literal("1"),
    format: z.literal("pactmark.evidence-attestation@1"),
    evidenceDigest: DigestSchema,
    keyId: z.string().trim().min(1).max(256),
    algorithm: z.enum(["Ed25519", "ECDSA-P256-SHA256"]),
    signatureHex: HexSchema,
    issuedAt: z.iso.datetime({ offset: true }),
    attestationDigest: DigestSchema,
  })
  .strict();
export type EvidenceAttestation = z.infer<typeof EvidenceAttestationSchema>;

export interface EvidenceSigner {
  readonly keyId: string;
  readonly algorithm: EvidenceAttestation["algorithm"];
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export interface EvidenceSignatureVerifier {
  verify(
    input: Readonly<{
      keyId: string;
      algorithm: EvidenceAttestation["algorithm"];
      payload: Uint8Array;
      signature: Uint8Array;
    }>,
  ): Promise<boolean>;
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const parsed = HexSchema.parse(value);
  return Uint8Array.from(parsed.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function signingPayload(
  record: EvidenceRecord,
  keyId: string,
  algorithm: EvidenceAttestation["algorithm"],
  issuedAt: string,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalJsonStringify({
      format: "pactmark.evidence-attestation-signing-input@1",
      evidenceDigest: record.evidenceDigest,
      keyId,
      algorithm,
      issuedAt,
    }),
  );
}

export async function createEvidenceAttestation(
  recordInput: EvidenceRecord,
  signer: EvidenceSigner,
  issuedAt: string,
): Promise<EvidenceAttestation> {
  const record = EvidenceRecordSchema.parse(recordInput);
  const normalizedIssuedAt = z.iso.datetime({ offset: true }).parse(issuedAt);
  if (!verifyEvidenceDigest(record)) throw new TypeError("KAF_EVIDENCE_DIGEST_INVALID");
  const signatureHex = bytesToHex(
    await signer.sign(signingPayload(record, signer.keyId, signer.algorithm, normalizedIssuedAt)),
  );
  const material = {
    schemaVersion: "1" as const,
    format: "pactmark.evidence-attestation@1" as const,
    evidenceDigest: record.evidenceDigest,
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    signatureHex,
    issuedAt: normalizedIssuedAt,
  };
  return Object.freeze(
    EvidenceAttestationSchema.parse({
      ...material,
      attestationDigest: digestCanonicalJson(material),
    }),
  );
}

export async function verifyEvidenceAttestation(
  recordInput: EvidenceRecord,
  attestationInput: EvidenceAttestation,
  verifier: EvidenceSignatureVerifier,
): Promise<boolean> {
  const record = EvidenceRecordSchema.parse(recordInput);
  const attestation = EvidenceAttestationSchema.parse(attestationInput);
  const { attestationDigest, ...material } = attestation;
  if (
    !verifyEvidenceDigest(record) ||
    attestation.evidenceDigest !== record.evidenceDigest ||
    digestCanonicalJson(material) !== attestationDigest
  ) {
    return false;
  }
  return verifier.verify({
    keyId: attestation.keyId,
    algorithm: attestation.algorithm,
    payload: signingPayload(record, attestation.keyId, attestation.algorithm, attestation.issuedAt),
    signature: hexToBytes(attestation.signatureHex),
  });
}
