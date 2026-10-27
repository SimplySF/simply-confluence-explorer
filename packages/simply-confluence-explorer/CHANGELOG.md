# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.10.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.6...%40simplysf%2Fsimply-confluence-explorer%400.10.0) (2026-10-27)

### Features

- a Space chat's pages are chosen from the space's tree, leaving out what does not belong ([#73](https://github.com/SimplySF/simply-confluence-explorer/issues/73)) ([a7532de](https://github.com/SimplySF/simply-confluence-explorer/commit/a7532deb44651cd37585e4d4c3a51f7636671e77))

## [0.9.6](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.5...%40simplysf%2Fsimply-confluence-explorer%400.9.6) (2026-10-26)

### Bug Fixes

- deleting a space shows its progress, and a slow Confluence gets more time and clearer messages ([#71](https://github.com/SimplySF/simply-confluence-explorer/issues/71)) ([c3fa677](https://github.com/SimplySF/simply-confluence-explorer/commit/c3fa6772d9e4d61f2dbe7116be6018119cfb40f9))
- **deps:** Bump openai from 7.34.0 to 7.43.0 ([#68](https://github.com/SimplySF/simply-confluence-explorer/issues/68)) ([5e12e42](https://github.com/SimplySF/simply-confluence-explorer/commit/5e12e42bac1c976ef92fe0b4262cd72225b24867))

## [0.9.5](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.4...%40simplysf%2Fsimply-confluence-explorer%400.9.5) (2026-10-26)

### Bug Fixes

- a space's copy can be deleted, so it can be downloaded afresh ([#69](https://github.com/SimplySF/simply-confluence-explorer/issues/69)) ([fa786d0](https://github.com/SimplySF/simply-confluence-explorer/commit/fa786d05efe2728de5da132b06ccc49c4f892404))
- **deps:** Bump @simplysf/simply-atlassian-core from 0.7.2 to 0.8.0 ([#67](https://github.com/SimplySF/simply-confluence-explorer/issues/67)) ([d869bc3](https://github.com/SimplySF/simply-confluence-explorer/commit/d869bc31a92a06e0d7ffb0d6de2b11f870ee8532))

## [0.9.4](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.3...%40simplysf%2Fsimply-confluence-explorer%400.9.4) (2026-10-23)

### Bug Fixes

- a catalog save never stops the app, and a review can be cleared or its chat deleted ([#62](https://github.com/SimplySF/simply-confluence-explorer/issues/62)) ([7c1ad5f](https://github.com/SimplySF/simply-confluence-explorer/commit/7c1ad5ffbf063e6e60b273679d5aa950a9aab2a2))
- an update downloads attachments a page is missing, and Download gives the local copy ([#60](https://github.com/SimplySF/simply-confluence-explorer/issues/60)) ([79b4553](https://github.com/SimplySF/simply-confluence-explorer/commit/79b45538f58629fdf7738443c4ba4b8ccc154de2))

## [0.9.3](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.2...%40simplysf%2Fsimply-confluence-explorer%400.9.3) (2026-10-23)

### Bug Fixes

- each image reaches the AI with its name, and the Gemini CLI reads no page text as files ([#58](https://github.com/SimplySF/simply-confluence-explorer/issues/58)) ([8d173b0](https://github.com/SimplySF/simply-confluence-explorer/commit/8d173b0481c3ef740874d0e540d21f8eb2654ba4))

## [0.9.2](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.1...%40simplysf%2Fsimply-confluence-explorer%400.9.2) (2026-10-23)

### Bug Fixes

- an image the AI did not read says why the AI gave no answer with it ([#56](https://github.com/SimplySF/simply-confluence-explorer/issues/56)) ([257a4aa](https://github.com/SimplySF/simply-confluence-explorer/commit/257a4aa1c7152d626c130039f30be5987fdb57e3))

## [0.9.1](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.9.0...%40simplysf%2Fsimply-confluence-explorer%400.9.1) (2026-10-23)

### Performance Improvements

- the app keeps up on a large space, shows every wait, and gives review its own place ([#54](https://github.com/SimplySF/simply-confluence-explorer/issues/54)) ([2a67683](https://github.com/SimplySF/simply-confluence-explorer/commit/2a6768334c6292b2efbc4f7a1a5926688c1fc382))

# [0.9.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.8.1...%40simplysf%2Fsimply-confluence-explorer%400.9.0) (2026-10-23)

### Features

- a clearer layout for every main screen of the web app ([#51](https://github.com/SimplySF/simply-confluence-explorer/issues/51)) ([34a089b](https://github.com/SimplySF/simply-confluence-explorer/commit/34a089b19eb52d5a731be144f2ca5abb5621b20a))

## [0.8.1](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.8.0...%40simplysf%2Fsimply-confluence-explorer%400.8.1) (2026-10-23)

### Bug Fixes

- the gemini cli answers when images stop it, files can be left out, and new ones are asked about ([#49](https://github.com/SimplySF/simply-confluence-explorer/issues/49)) ([bbcaeb8](https://github.com/SimplySF/simply-confluence-explorer/commit/bbcaeb8f659d689cf1518a84826fb445a4e5cd01))

# [0.8.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.7.2...%40simplysf%2Fsimply-confluence-explorer%400.8.0) (2026-10-22)

### Features

- every attachment of a chat's pages is read or named with why, in many more formats ([#47](https://github.com/SimplySF/simply-confluence-explorer/issues/47)) ([4e5e67d](https://github.com/SimplySF/simply-confluence-explorer/commit/4e5e67dd7ca997e53ac4498958ed1c16b95afa0e))

## [0.7.2](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.7.1...%40simplysf%2Fsimply-confluence-explorer%400.7.2) (2026-10-22)

### Bug Fixes

- the gemini cli runs in a private folder of its own, and says why when it gives no answer ([#45](https://github.com/SimplySF/simply-confluence-explorer/issues/45)) ([dd7c4a2](https://github.com/SimplySF/simply-confluence-explorer/commit/dd7c4a28f5c1007d406b2b9416a8ba5b385b2527))

## [0.7.1](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.7.0...%40simplysf%2Fsimply-confluence-explorer%400.7.1) (2026-10-22)

### Bug Fixes

- review names what only a person can do, shows a page's pictures, and leaves no edit stuck ([#43](https://github.com/SimplySF/simply-confluence-explorer/issues/43)) ([0096e17](https://github.com/SimplySF/simply-confluence-explorer/commit/0096e1715d55f5b34c7fd817da66a64cdb245fad))

# [0.7.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.6.0...%40simplysf%2Fsimply-confluence-explorer%400.7.0) (2026-10-21)

### Features

- page attachments are read with their page, text always and images by the space's choice ([#41](https://github.com/SimplySF/simply-confluence-explorer/issues/41)) ([27d42c8](https://github.com/SimplySF/simply-confluence-explorer/commit/27d42c8169fd8dbdde234c1193d1049e7d69a0ef))

# [0.6.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.5.1...%40simplysf%2Fsimply-confluence-explorer%400.6.0) (2026-10-21)

### Features

- tags and the page tree load from a page catalog kept current, with progress on its first build ([#39](https://github.com/SimplySF/simply-confluence-explorer/issues/39)) ([0fb1440](https://github.com/SimplySF/simply-confluence-explorer/commit/0fb1440ad62937110040741b477d4080291bc3c4))

## [0.5.1](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.5.0...%40simplysf%2Fsimply-confluence-explorer%400.5.1) (2026-10-21)

### Bug Fixes

- clearer queues, edits written at once with progress, real freeze alerts and a faster first load ([#37](https://github.com/SimplySF/simply-confluence-explorer/issues/37)) ([5917853](https://github.com/SimplySF/simply-confluence-explorer/commit/591785311b289d4d2e553d62c6029b8aa8712f37))

# [0.5.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.4.0...%40simplysf%2Fsimply-confluence-explorer%400.5.0) (2026-10-21)

### Features

- each chat keeps its suggestions, edits and staged pages as queues, and edits start from the live page ([#35](https://github.com/SimplySF/simply-confluence-explorer/issues/35)) ([6ce8cf5](https://github.com/SimplySF/simply-confluence-explorer/commit/6ce8cf5e4f7cf860ad3d7a93925ac9a5b1aaf472))

# [0.4.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.3.0...%40simplysf%2Fsimply-confluence-explorer%400.4.0) (2026-10-21)

### Features

- pages with macros can be changed, and each change is accepted or rejected on its own ([#33](https://github.com/SimplySF/simply-confluence-explorer/issues/33)) ([02118d3](https://github.com/SimplySF/simply-confluence-explorer/commit/02118d30511a6df9177b9a59545f121d7f5d54df))

# [0.3.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.2.0...%40simplysf%2Fsimply-confluence-explorer%400.3.0) (2026-10-20)

### Bug Fixes

- a frozen server is flagged from how late the check ran, not only from Node's delay monitor ([#31](https://github.com/SimplySF/simply-confluence-explorer/issues/31)) ([06f6a52](https://github.com/SimplySF/simply-confluence-explorer/commit/06f6a52b57f8c099979fca0252c6085f559d4dee))
- a large synced space no longer freezes the app; the status shows Connected when signing in works ([#29](https://github.com/SimplySF/simply-confluence-explorer/issues/29)) ([c95fe10](https://github.com/SimplySF/simply-confluence-explorer/commit/c95fe10284d48d749efdef4aa8c5e3e9b5b7209d))

### Features

- large spaces: packed indexing, context checks, thorough answers, and an Observability page ([#30](https://github.com/SimplySF/simply-confluence-explorer/issues/30)) ([a003bda](https://github.com/SimplySF/simply-confluence-explorer/commit/a003bda6c66bf35fa69e28c3ba3dc5b903557662))

# [0.2.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0...%40simplysf%2Fsimply-confluence-explorer%400.2.0) (2026-10-20)

### Features

- chat as the place to work: contexts, a context engine, a change queue, and new pages from GitLab ([#24](https://github.com/SimplySF/simply-confluence-explorer/issues/24)) ([fbe2940](https://github.com/SimplySF/simply-confluence-explorer/commit/fbe2940efeca7d24cf04775baad340d5f59e7186))
- link each file a release reviewer reads, and publish only approved releases ([#23](https://github.com/SimplySF/simply-confluence-explorer/issues/23)) ([984b837](https://github.com/SimplySF/simply-confluence-explorer/commit/984b8375a0967ca67ee7b7e9cecb017e8ead4dc1))

# [0.1.0](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.7...%40simplysf%2Fsimply-confluence-explorer%400.1.0) (2026-10-19)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

# [0.1.0-beta.7](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.6...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.7) (2026-10-19)

### Features

- publish a stable release when its release pull request is approved ([#21](https://github.com/SimplySF/simply-confluence-explorer/issues/21)) ([f544759](https://github.com/SimplySF/simply-confluence-explorer/commit/f544759c1505b0bab3e5d4516a88cfbbda49a662))

# [0.1.0-beta.6](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.5...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.6) (2026-10-19)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

# [0.1.0-beta.5](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.4...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.5) (2026-10-19)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

# [0.1.0-beta.4](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.3...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.4) (2026-10-17)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

# [0.1.0-beta.3](https://github.com/SimplySF/simply-confluence-explorer/compare/%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.2...%40simplysf%2Fsimply-confluence-explorer%400.1.0-beta.3) (2026-10-17)

**Note:** Version bump only for package @simplysf/simply-confluence-explorer

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
