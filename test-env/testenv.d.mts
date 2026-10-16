// Types for the parts of testenv.mjs the package's tests import.

/** The lines `node test-env/testenv.mjs env` prints, one `NAME=value` each. */
export function envLines(creds: { baseUrl: string; token: string }): string[];
