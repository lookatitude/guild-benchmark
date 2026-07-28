import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface PublicReleaseClaim {
  schema_version: "guild.release_claim.v1";
  archive_sha256: string;
  manifest_sha256: string;
  operations: Array<{ kind: string; evidence_class: string; outcome: string }>;
  host_support: { supported: boolean; reason: string };
  public_api: { artifact: string; receipt: string };
}

const contractUrl = new URL("../contracts/guild-release-contract.v1.json", import.meta.url);
const pinUrl = new URL("../contracts/guild-release-contract.v1.sha256", import.meta.url);

export function loadPinnedReleaseContract(
  suppliedBytes?: Buffer,
  suppliedDigest?: string
): { claim: PublicReleaseClaim; digest: string } {
  const bytes = suppliedBytes ?? readFileSync(contractUrl);
  const expected = suppliedDigest ?? readFileSync(pinUrl, "utf8").trim();
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected) throw new Error(`release contract digest mismatch: expected ${expected}, got ${digest}`);
  const claim = JSON.parse(bytes.toString("utf8")) as PublicReleaseClaim;
  if (claim.schema_version !== "guild.release_claim.v1") throw new Error("release contract version mismatch");
  return { claim, digest };
}
