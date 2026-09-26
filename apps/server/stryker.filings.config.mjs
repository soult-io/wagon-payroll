// Mutation testing for apps/server/src/filings (PAY-93, PAY-108). Run with
// `pnpm mutation:server-filings` from the repo root; see CONTRIBUTING.md.
// Targets, test globs and thresholds: stryker.targets.mjs. The HTML report
// holds only source code and mutant diffs — no env, no data.
//
// Needs the workspace packages built first — the server imports @payroll/*
// from their dist/. The root script builds them.
import { strykerConfig } from "./stryker.targets.mjs";

export default strykerConfig("filings");
