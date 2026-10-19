// Types for the parts of release-gate.mjs the package's tests import.

interface Pull {
  number: number;
  merged_at?: string | null;
  user: { login: string };
  head: { ref: string; sha: string };
  base?: { ref: string };
}

interface Review {
  state: string;
  user: { login: string };
  commit_id: string;
}

/** The surface names in the load-bearing surfaces table of AGENTS.md. */
export function surfacesOf(agents: string): string[];

/** The description of the pull request that releases a version. */
export function pullRequestBody(version: string, agents: string): string;

/** What stops a merged release pull request from publishing its version; empty when nothing does. */
export function approvalProblems(version: string, pull: Pull, reviews: Review[]): string[];

/** Finds the release pull request merged as `commit` and checks its approval. */
export function releaseProblems(
  version: string,
  commit: string,
  github: { repo: string; token: string; fetch: (url: string, init?: object) => Promise<Response> },
): Promise<string[]>;
