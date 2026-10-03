# Mac mini CI

Builds and checks use `[self-hosted, macOS, ARM64, macmini]` on the owner's Mac mini.
The SSD-backed controller provides one shared execution slot across repositories.
GitHub remains the trigger/log/check UI; cloud-hosted build runners are not the default.
Only owner-triggered jobs and current branch/PR heads are eligible. Superseded runs cancel.
Runner directories, checkout, tool/cache/temp data reside under `/Volumes/StrataData/github-ci`.
New workflow jobs must use these labels, an owner guard, the host freshness check before
checkout, and `concurrency` with `cancel-in-progress: true` for branch CI.
Do not silently remove tests when moving a Linux workflow to macOS. Linux container
actions, Windows GUI builds and missing Apple SDKs need explicit platform adaptation.
Keep the project's build recipe in its workflow or `.github/scripts/macmini-build.sh`.
Do not deploy, publish or invoke real account actions as part of ordinary build CI.
