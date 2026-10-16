// Types for the parts of release-gate.mjs the package's tests import.

/** The surface names in the load-bearing surfaces table of AGENTS.md. */
export function surfacesOf(agents: string): string[];

/** What is missing from a review packet; empty when the packet allows the release. */
export function packetProblems(packet: string, surfaces: string[]): string[];

/** The problems with the packet for one version, read from the repository at `root`. */
export function releaseProblems(version: string, root: string): string[];
