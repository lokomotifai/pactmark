import {
  VerificationExceptionSchema,
  digestCanonicalJson,
  type VerificationException,
} from "@pactmark/core";

export type CreateVerificationExceptionInput = Omit<VerificationException, "exceptionDigest">;

export function createVerificationException(
  input: CreateVerificationExceptionInput,
): VerificationException {
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) {
    throw new TypeError("KAF_VERIFICATION_EXCEPTION_WINDOW_INVALID");
  }
  return VerificationExceptionSchema.parse({
    ...input,
    exceptionDigest: digestCanonicalJson(input),
  });
}

export function verifyVerificationExceptionDigest(value: VerificationException): boolean {
  const exception = VerificationExceptionSchema.parse(value);
  const { exceptionDigest, ...material } = exception;
  return exceptionDigest === digestCanonicalJson(material);
}

export function verificationExceptionReference(exceptionValue: VerificationException): Readonly<{
  exceptionId: string;
  exceptionDigest: string;
  verifierId: string;
  verifierRegistrationDigest: string;
  artifactDigest: string;
  rubricVersion: string;
  rubricDigest: string;
}> {
  const exception = VerificationExceptionSchema.parse(exceptionValue);
  if (!verifyVerificationExceptionDigest(exception)) {
    throw new TypeError("KAF_VERIFICATION_EXCEPTION_DIGEST_INVALID");
  }
  return Object.freeze({
    exceptionId: exception.exceptionId,
    exceptionDigest: exception.exceptionDigest,
    verifierId: exception.verifierId,
    verifierRegistrationDigest: exception.verifierRegistrationDigest,
    artifactDigest: exception.artifactDigest,
    rubricVersion: exception.rubricVersion,
    rubricDigest: exception.rubricDigest,
  });
}
