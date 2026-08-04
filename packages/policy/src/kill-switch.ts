import { DigestSchema, type Digest } from "@pactmark/core";
import { z } from "zod";

export const KillSwitchTargetKindSchema = z.enum([
  "tool_registration",
  "mcp_server",
  "model_adapter",
  "model_profile",
  "policy_registration",
  "compensation_definition",
  "compensation_strategy",
]);
export type KillSwitchTargetKind = z.infer<typeof KillSwitchTargetKindSchema>;

export const KillSwitchEntrySchema = z
  .object({
    schemaVersion: z.literal("1"),
    targetKind: KillSwitchTargetKindSchema,
    targetDigest: DigestSchema,
    reasonCode: z.string().regex(/^KAF_[A-Z0-9_]+$/u),
    activatedAt: z.iso.datetime({ offset: true }),
    activatedBy: z.string().min(1).max(256),
    registryVersion: z.number().int().positive(),
  })
  .strict();
export type KillSwitchEntry = z.infer<typeof KillSwitchEntrySchema>;

export const KillSwitchSnapshotSchema = z
  .object({
    schemaVersion: z.literal("1"),
    version: z.number().int().nonnegative(),
    entries: z.array(KillSwitchEntrySchema),
  })
  .strict();
export type KillSwitchSnapshot = z.infer<typeof KillSwitchSnapshotSchema>;

export interface KillSwitchRegistry {
  activate(
    targetKind: KillSwitchTargetKind,
    targetDigest: Digest,
    reasonCode: string,
    activatedBy: string,
    activatedAt: string,
  ): KillSwitchEntry;
  deactivate(targetKind: KillSwitchTargetKind, targetDigest: Digest): boolean;
  isKilled(targetKind: KillSwitchTargetKind, targetDigest: Digest): boolean;
  snapshot(): KillSwitchSnapshot;
}

function key(kind: KillSwitchTargetKind, digest: Digest): string {
  return `${kind}:${digest}`;
}

/**
 * A portable in-process registry. Durable hosts persist and distribute the
 * versioned snapshot, then re-check it before every model/tool/effect boundary.
 */
export function createKillSwitchRegistry(initial?: KillSwitchSnapshot): KillSwitchRegistry {
  const parsed = initial === undefined ? undefined : KillSwitchSnapshotSchema.parse(initial);
  let version = parsed?.version ?? 0;
  const active = new Map<string, KillSwitchEntry>();
  for (const entry of parsed?.entries ?? [])
    active.set(key(entry.targetKind, entry.targetDigest), entry);

  const registry: KillSwitchRegistry = {
    activate(
      targetKind: KillSwitchTargetKind,
      targetDigest: Digest,
      reasonCode: string,
      activatedBy: string,
      activatedAt: string,
    ) {
      const nextVersion = version + 1;
      const entry = KillSwitchEntrySchema.parse({
        schemaVersion: "1",
        targetKind,
        targetDigest,
        reasonCode,
        activatedAt,
        activatedBy,
        registryVersion: nextVersion,
      });
      active.set(key(entry.targetKind, entry.targetDigest), Object.freeze(entry));
      version = nextVersion;
      return entry;
    },
    deactivate(targetKind: KillSwitchTargetKind, targetDigest: Digest) {
      const removed = active.delete(key(targetKind, targetDigest));
      if (removed) version += 1;
      return removed;
    },
    isKilled(targetKind: KillSwitchTargetKind, targetDigest: Digest) {
      return active.has(key(targetKind, targetDigest));
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: "1",
        version,
        entries: [...active.values()].sort((left, right) =>
          key(left.targetKind, left.targetDigest).localeCompare(
            key(right.targetKind, right.targetDigest),
          ),
        ),
      });
    },
  };
  return Object.freeze(registry);
}
