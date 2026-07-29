# Changelog

## [0.1.2](https://github.com/postalsys/email-content/compare/v0.1.1...v0.1.2) (2026-07-29)


### Features

* give the HTML segmenter the structural detectors the text path had ([7608d0a](https://github.com/postalsys/email-content/commit/7608d0a7d7187d09c52946aa49548591f86c9d72))
* settle the annotation conventions as prompt v4 and re-label ([255c9a9](https://github.com/postalsys/email-content/commit/255c9a947abd022096c7450260976c936fee6eaa))


### Bug Fixes

* remove pattern false positives from case folding and dead alternatives ([01be58f](https://github.com/postalsys/email-content/commit/01be58f2cc0b3c178680e177e4d4cd90cde2ce12))

## [0.1.1](https://github.com/postalsys/email-content/compare/v0.1.0...v0.1.1) (2026-07-27)


### Features

* identify unmarked history by matching the thread ([de7eb00](https://github.com/postalsys/email-content/commit/de7eb00a24d7b67fa476f01da4b3987307465e64))


### Bug Fixes

* make the shipped example runnable ([3791b45](https://github.com/postalsys/email-content/commit/3791b456f1d9790e7502a088f01b0fa99bda3883))

## [0.1.0](https://github.com/postalsys/email-content/compare/v0.0.5...v0.1.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* `SourceRef` is now a discriminated union on `kind`. A segment traced to a MIME part carries `kind: 'mime-part'` with the existing fields; one produced when MIME parsing failed carries `kind: 'raw-message'` with only a byte range. Reading `source.mimePart` unconditionally no longer type checks. Use the exported `mimePartOf()` and `blockIndexOf()` helpers, which return null for the raw-message case. Deliberate pre-1.0: the previous shape reported a MIME part that never held the text.

### Bug Fixes

* fail loudly when no detector pattern can be loaded ([15f3c96](https://github.com/postalsys/email-content/commit/15f3c961b2c01e28781b097604359c6db8a91b22))
* stop losing content and bound hostile-input processing ([4f0aadf](https://github.com/postalsys/email-content/commit/4f0aadf45f441722570813812a5c3ec9d8a8684b))

## [0.0.5](https://github.com/postalsys/email-content/compare/v0.0.4...v0.0.5) (2026-07-26)


### Features

* support Node 20 so EmailEngine can consume the library ([5a41627](https://github.com/postalsys/email-content/commit/5a41627df30964f4653cac9b21380ea40f8bd64d))


### Bug Fixes

* run the test suite on every supported Node version ([eb7b3f9](https://github.com/postalsys/email-content/commit/eb7b3f95e21b6ef96c84dd96b9b5d33882f15a8f))

## [0.0.4](https://github.com/postalsys/email-content/compare/v0.0.3...v0.0.4) (2026-07-26)


### Bug Fixes

* do not request provenance from a private repository ([6fbcee2](https://github.com/postalsys/email-content/commit/6fbcee28f294ccf130a2edae4a6a2296de8f682a))

## [0.0.3](https://github.com/postalsys/email-content/compare/v0.0.2...v0.0.3) (2026-07-26)


### Bug Fixes

* request provenance when publishing ([11dd08c](https://github.com/postalsys/email-content/commit/11dd08cbcff7cc551a1a7cd2c9d83cc56de6afd1))

## [0.0.2](https://github.com/postalsys/email-content/compare/v0.0.1...v0.0.2) (2026-07-26)


### Features

* email content extraction library ([655573c](https://github.com/postalsys/email-content/commit/655573c2864b5c5f6d8b551dff9140a49dc719cd))


### Bug Fixes

* keep the extractor version in step with the release ([118d660](https://github.com/postalsys/email-content/commit/118d6605e963861129cf52e00252d2f139516187))

## Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versions and entries below the
Unreleased heading are managed by release-please; do not edit them by hand.

## Unreleased

Initial development. The public API is `analyze()` and `extract()`, and it is not yet stable.
