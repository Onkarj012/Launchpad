# Phase 6: create a clean immutable candidate

Status: proposed

## Parent

[Launchpad full production implementation plan](../../plans/launchpad-full-production-implementation.md), Phase 6

## What to build

Review dirty paths, separate unrelated user work, update canonical status and runbooks, run full local gates, and obtain explicit commit approval. Then use `crawler/release-manager.mjs` to create a detached content-addressed checkout outside the source repository.

Install pinned dependencies with `npm ci --ignore-scripts`, validate from the release checkout, and bind revision, lockfile, config fingerprint, manifest fingerprint, source registry, and normalized profile. Prepare schedule specs without installing them. Initial profile contains only `morning / normal / pune`.

## Main paths

- `crawler/release-manager.mjs`
- `crawler/install-schedule.mjs`
- release and schedule tests
- `docs/STATUS.md`
- operator runbooks
- dependency manifest and lockfile

## Acceptance criteria

- [ ] Source checkout is clean at exact retained revision.
- [ ] Unrelated user work is not staged, changed, or included.
- [ ] Full local gates pass before candidate creation.
- [ ] Detached release checkout is clean and content-addressed.
- [ ] `npm ci --ignore-scripts` and full validation pass inside release checkout.
- [ ] Candidate receipt binds revision, lockfile, config, manifest, source registry, and normalized profile fingerprints.
- [ ] Proposed plist points only at immutable release checkout.
- [ ] Schedule spec includes only morning Normal/Pune profile.
- [ ] No plist installation or `launchctl` mutation occurs.

## Stop point

Candidate exists. Existing schedule remains unchanged until seven-date proof and separate approval.

## Blocked by

Phase 5 real resume and manual application sync proof. Commit and release creation require explicit approval.
