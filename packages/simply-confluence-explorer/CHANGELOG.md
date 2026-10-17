# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.1.0-beta.2](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.1...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.2) (2026-10-17)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

# [0.1.0-beta.1](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.0...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.1) (2026-10-17)

### Bug Fixes

- **simply-confluence-explorer:** refuse to push a page whose macros or images Markdown drops ([ace7b51](https://github.com/SimplySF/simply-confluence-explorer/commit/ace7b51895a9a8e5a01804f9cf33bab852d1ca31))

# 0.1.0-beta.0 (2026-10-16)

### Bug Fixes

- **deps:** convert macro titles, mentions and nested cells with simply-atlassian-core 0.7.2 ([e501c24](https://github.com/SimplySF/simply-confluence-explorer/commit/e501c2426f3454f24f269d24497b436b69663fc4))
- send the server's own copy of a page an AI is asked about ([6303e50](https://github.com/SimplySF/simply-confluence-explorer/commit/6303e501ed24a34be718d1a632178d7852c8d653))
- **simply-confluence-explorer:** make testenv env print the data directory instead of failing ([2acd40d](https://github.com/SimplySF/simply-confluence-explorer/commit/2acd40d57d296b2e319f5057d9b97f2286b3ee30))

### Features

- scaffold simply-confluence-explorer monorepo framework ([cbaedc8](https://github.com/SimplySF/simply-confluence-explorer/commit/cbaedc85c941e8781cdcac41ed676d96ca83b4d1))
- **simply-confluence-explorer:** add the API router, saved connection, data dir and doctor ([05bf86f](https://github.com/SimplySF/simply-confluence-explorer/commit/05bf86f28202679078e4bf47c0631ce3670ed031))
- **simply-confluence-explorer:** add the Svelte interface for every feature ([9e33608](https://github.com/SimplySF/simply-confluence-explorer/commit/9e3360858bc96ca705a71d6adc127d6bc746679b))
- **simply-confluence-explorer:** ask an AI about pages and spaces, through the outbound guard ([de85547](https://github.com/SimplySF/simply-confluence-explorer/commit/de85547091151bd5dc0bbf9df1c309ecce5c022c))
- **simply-confluence-explorer:** improve a page and push it back to Confluence ([c56685e](https://github.com/SimplySF/simply-confluence-explorer/commit/c56685ea48dc40b337065af90a186b90f5eed5e3))
- **simply-confluence-explorer:** read Confluence through simply-atlassian-core ([d9ce44d](https://github.com/SimplySF/simply-confluence-explorer/commit/d9ce44d30649801adbceddd7ee3043a75a8fa916))
- **simply-confluence-explorer:** refuse a stable release until its review packet is answered ([4ecf025](https://github.com/SimplySF/simply-confluence-explorer/commit/4ecf025a6f6c472496dfea8aed9943df5cf574f9))
- **simply-confluence-explorer:** review or improve a branch through a review queue ([b02bdac](https://github.com/SimplySF/simply-confluence-explorer/commit/b02bdaca51c346fa9adcc6e054405a69d366bf35))
- **simply-confluence-explorer:** sync a space to disk, with its TOC, ZIP and purge ([83a49bc](https://github.com/SimplySF/simply-confluence-explorer/commit/83a49bc33c47baf8ad43b94eec71f7d3d896ebd6))
- **simply-confluence-explorer:** write a new page after checking for pages that already cover it ([a2e65a4](https://github.com/SimplySF/simply-confluence-explorer/commit/a2e65a47273630223c62a5cd7c5f31895456cd47))
