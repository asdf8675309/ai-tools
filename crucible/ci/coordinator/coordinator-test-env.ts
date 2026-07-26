// call-coordinator.ts reads a dozen env vars into module-level `const`s at
// IMPORT time, and bun test shares one module registry across every test file in
// the run — so whichever file imports the module first fixes those values for
// the whole process, and file order is not guaranteed.
//
// Every coordinator test file therefore does `import "./coordinator-test-env.ts"`
// as its FIRST static import: static imports are evaluated before the importing
// module's body, so this runs before any `await import("./call-coordinator.ts")`
// no matter which file the runner reaches first. Setting the env inline in each
// file worked only while every file happened to set identical values; this makes
// that a single fact instead of a convention.
//
// All values are synthetic. INCREMENTAL_REVIEW_ENABLED stays unset on purpose:
// the module's seed path is the default, and the incremental branches take their
// flag as a parameter so both modes are reachable from one import.

process.env.REVIEW_API_TOKEN = "test-token";
process.env.PR_NUMBER = "1";
process.env.GH_REPO = "example-org/example-repo";
process.env.REVIEW_API_BASE_URL = "https://models.example.test/v1";
process.env.REVIEW_MODEL = "test-model-standard";
process.env.REVIEW_MODEL_LARGE = "test-model-large";
process.env.RUN_URL = "https://ci.example.test/run/4242";
process.env.GITHUB_RUN_ID = "4242";
process.env.DEFAULT_BRANCH = "main";

// Provide both SHAs so module init never shells out to `git rev-parse`.
export const TEST_HEAD_SHA = "c".repeat(40);
export const TEST_BASE_SHA = "b".repeat(40);
process.env.CURRENT_HEAD_SHA = TEST_HEAD_SHA;
process.env.BASE_SHA = TEST_BASE_SHA;

delete process.env.INCREMENTAL_REVIEW_ENABLED;
delete process.env.REVIEW_METADATA_HEADER;

export const TEST_REPO = "example-org/example-repo";
export const TEST_PR = 1;
export const TEST_RUN_URL = "https://ci.example.test/run/4242";
export const TEST_RUN_ID = "4242";
