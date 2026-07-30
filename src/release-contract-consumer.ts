import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface PublicReleaseClaim {
  schema_version: "guild.release_claim.v1";
  source_commit: string;
  archive_sha256: string;
  manifest_sha256: string;
  manifest: { entries: Array<{ path: string; sha256: string; bytes: number }> };
  contract_versions: { runtime: string; receipt: string; artifact: string };
  conformance_artifacts: Array<{ path: string; sha256: string }>;
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
  if (!/^[a-f0-9]{40}$/.test(claim.source_commit)) throw new Error("release contract source commit mismatch");
  if (claim.manifest.entries.length <= 0) throw new Error("release contract manifest is empty");
  if (claim.contract_versions.runtime !== "guild.runtime_boundary_contract.v1") throw new Error("runtime contract version mismatch");
  if (claim.contract_versions.receipt !== "guild.handoff.v2") throw new Error("receipt contract version mismatch");
  if (claim.contract_versions.artifact !== "guild.artifact.v1") throw new Error("artifact contract version mismatch");
  if (claim.conformance_artifacts.length !== 4) throw new Error("release contract conformance artifact mismatch");
  return { claim, digest };
}
