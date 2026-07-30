import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPinnedReleaseContract } from "../src/release-contract-consumer.js";

describe("checked-in release contract consumer", () => {
  it("verifies bytes against the independent digest pin", () => {
    const result = loadPinnedReleaseContract();
    expect(result.claim.schema_version).toBe("guild.release_claim.v1");
    expect(result.claim.host_support.supported).toBe(false);
    expect(result.claim.operations).toHaveLength(6);
    expect(result.claim.source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.claim.manifest.entries).toHaveLength(2314);
    expect(result.claim.contract_versions).toEqual({
      runtime: "guild.runtime_boundary_contract.v1",
      receipt: "guild.handoff.v2",
      artifact: "guild.artifact.v1",
    });
    expect(result.claim.conformance_artifacts).toHaveLength(4);
  });

  it("rejects bundle-byte and digest-pin mismatch", () => {
    expect(() => loadPinnedReleaseContract(Buffer.from("{}"), "0".repeat(64))).toThrow(/digest/i);
    expect(readFileSync(new URL("../contracts/guild-release-contract.v1.sha256", import.meta.url), "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
  });
});
