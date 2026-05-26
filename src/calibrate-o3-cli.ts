// benchmark/src/calibrate-o3-cli.ts
//
// Usage: tsx src/calibrate-o3-cli.ts [--runs-dir <path>] [<runDir>...]
//
// O-3 calibration CLI — wraps the analyzeRuns() function and prints the
// proposed `models.shortOutputThreshold` fragment to STDOUT as JSON.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PRINT-ONLY — this CLI NEVER writes to settings.json.                  ║
// ║  Guild discipline: nothing auto-promotes (D-OBS-3 §"activate after      ║
// ║  ≥30 samples"; §10.5.1 write path). The operator reviews the printed   ║
// ║  proposal and lands it manually.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Discovery modes (mutually exclusive; --runs-dir wins over positionals):
//   --runs-dir <path>   Enumerate all immediate subdirectories of <path> as
//                       individual run dirs.  Default: <cwd>/.guild/runs/
//   <runDir>...         Positional args — each is treated as a run dir
//                       already resolved.  Skipped when --runs-dir is set.
//
// Output (stdout, JSON):
//   {
//     "proposal": {
//       "models": {
//         "shortOutputThreshold": { "<task_type>": { "<tier>": <p10> } }
//       }
//     },
//     "skippedBuckets": [
//       { "taskType": "...", "tier": "...", "samples": <n> }
//     ]
//   }
//
// Exit codes: 0 success, 1 error.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRuns } from "./o3-threshold-analyzer.js";

// ── Argument parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  runsDirFlag: string | undefined;
  positionalDirs: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  let runsDirFlag: string | undefined;
  const positionalDirs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs-dir") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        process.stderr.write("calibrate-o3: --runs-dir requires a path argument\n");
        process.exit(1);
      }
      runsDirFlag = next;
      i += 1;
    } else if (a?.startsWith("--runs-dir=")) {
      runsDirFlag = a.slice("--runs-dir=".length);
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (a !== undefined && !a.startsWith("--")) {
      positionalDirs.push(a);
    }
  }

  return { runsDirFlag, positionalDirs };
}

// ── Subdirectory discovery ─────────────────────────────────────────────────

/**
 * Enumerate immediate subdirectories of `runsDir` as run dirs.
 * Silently skips non-directory entries — a stray file in the runs dir
 * should not fail the whole analysis.
 */
function discoverRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) {
    process.stderr.write(
      `calibrate-o3: runs dir not found: ${runsDir}\n` +
        `  (pass --runs-dir <path> or provide run dirs as positional args)\n`,
    );
    process.exit(1);
  }
  return readdirSync(runsDir)
    .map((entry) => resolve(runsDir, entry))
    .filter((full) => {
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
}

// ── Help text ──────────────────────────────────────────────────────────────

function printUsage(): void {
  process.stdout.write(
    [
      "calibrate-o3 — O-3 short-output threshold calibration (PRINT-ONLY)",
      "",
      "Usage:",
      "  tsx src/calibrate-o3-cli.ts [--runs-dir <path>] [<runDir>...]",
      "",
      "Options:",
      "  --runs-dir <path>  Parent directory whose subdirs are the run dirs.",
      "                     Default: <cwd>/.guild/runs/",
      "  <runDir>...        Explicit run dirs (ignored when --runs-dir is set).",
      "  -h, --help         Print this help.",
      "",
      "Output: JSON printed to stdout — proposed models.shortOutputThreshold",
      "fragment plus skippedBuckets (< 30 samples).  NEVER writes settings.json.",
      "",
    ].join("\n"),
  );
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const { runsDirFlag, positionalDirs } = parseArgs(argv);

  // Resolve the list of run dirs.
  let runDirs: string[];
  if (runsDirFlag !== undefined || positionalDirs.length === 0) {
    // --runs-dir mode (or no args → default to .guild/runs/).
    const runsDir = resolve(runsDirFlag ?? resolve(process.cwd(), ".guild", "runs"));
    runDirs = discoverRunDirs(runsDir);
    if (runDirs.length === 0) {
      process.stderr.write(
        `calibrate-o3: no run directories found under ${runsDir}\n`,
      );
      // Still produce empty output — valid analysis over an empty corpus.
    }
  } else {
    // Positional-arg mode: treat each arg as an already-resolved run dir.
    runDirs = positionalDirs.map((d) => resolve(d));
  }

  const proposal = await analyzeRuns({ runDirs });

  // Structured output — easy for the operator (or a follow-up script) to
  // diff against the current settings.json block.
  const output = {
    proposal: {
      models: {
        shortOutputThreshold: proposal.thresholds,
      },
    },
    skippedBuckets: proposal.skippedBuckets,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(
    `calibrate-o3: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
