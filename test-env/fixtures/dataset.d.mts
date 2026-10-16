// Types for dataset.mjs, so the package's TypeScript tests can read the same dataset the test
// environment seeds.

export type DatasetAttachment = { filename: string; content: Buffer; type: string };

export type DatasetPage = {
  title: string;
  body?: string | ((ctx: { userKey: string }) => string);
  labels?: string[];
  attachments?: DatasetAttachment[];
  children?: DatasetPage[];
};

export type DatasetSpace = {
  key: string;
  name: string;
  description: string;
  home: string;
  pages: DatasetPage[];
};

export type SpaceExpectations = {
  excluded: string[];
  visible: string[];
  knownIssueVisible?: string[];
  guard?: { blocked: Record<string, string>; redacted: Record<string, string[]> };
};

export declare const spaces: DatasetSpace[];
export declare const ignoreFiles: Record<string, string[]>;
export declare const expectations: Record<string, SpaceExpectations>;
