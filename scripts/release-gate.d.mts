// Types for the parts of release-gate.mjs the package's tests import.

interface Pull {
  number: number;
  merged_at?: string | null;
  user: { login: string };
  head: { ref: string; sha: string };
  base?: { ref: string };
  merged_by?: { login: string } | null;
}

interface Review {
  state: string;
  user: { login: string };
  commit_id: string;
}

/** The rows of the load-bearing surfaces table in AGENTS.md. */
export function surfacesOf(agents: string): { surface: string; where: string }[];

/** What the reviewer of a release reads, one entry per load-bearing surface. */
export const REVIEW_GUIDE: {
  surface: string;
  about: string;
  items: { file: string; symbol?: string; check: string }[];
}[];

/** The 1-based line a declaration starts on, or undefined when it is not declared in `text`. */
export function lineOf(text: string, symbol: string): number | undefined;

/** The description of the pull request that releases a version. */
export function pullRequestBody(
  version: string,
  source: { repoUrl: string; commit: string; read: (file: string) => string },
): string;

/** What stops a merged release pull request from publishing its version; empty when nothing does. */
export function approvalProblems(version: string, pull: Pull, reviews: Review[], maintainers?: string[]): string[];

/** The GitHub logins in the RELEASE_MAINTAINERS repository variable, who may release alone before 1.0 (ADR-053). */
export function maintainersFrom(value: string | undefined): string[];

/** Finds the release pull request merged as `commit` and checks its approval. */
export function releaseProblems(
  version: string,
  commit: string,
  github: {
    repo: string;
    token: string;
    fetch: (url: string, init?: object) => Promise<Response>;
    maintainers?: string[];
  },
): Promise<string[]>;
