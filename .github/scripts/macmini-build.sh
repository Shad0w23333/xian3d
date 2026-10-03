#!/bin/bash
# Local-only build recipe. Deployment, login and real-world mutations are excluded.
set -euo pipefail
repo="${GITHUB_REPOSITORY##*/}"
case "$repo" in
  webreg-bot|zotgpt-relay-go)
    go test -race ./...
    go vet ./...
    if [ "$repo" = webreg-bot ]; then
      go build -o "$RUNNER_TEMP/webreg" ./cmd/webreg
    else
      go build ./...
    fi
    ;;
  sure-cloudflare)
    npm ci
    npm run check
    ;;
  xian3d)
    npm ci
    npm run build
    npm run build:standalone
    ;;
  lecture-companion)
    python3 -m unittest discover -s scripts -p 'test_*.py' -v
    python3 -m venv "$RUNNER_TEMP/evaluation-venv"
    "$RUNNER_TEMP/evaluation-venv/bin/pip" install 'mcp==2.0.0'
    "$RUNNER_TEMP/evaluation-venv/bin/python" -m unittest discover -s Tools/MCP -p 'test_*.py' -v
    if ! xcodebuild -version; then
      echo '::error::Full Xcode is required for Swift/Metal and Mac/iOS app builds. Install it under the SSD tools directory; Command Line Tools are insufficient.'
      exit 1
    fi
    swift test --scratch-path "$RUNNER_TEMP/swift-build"
    for scheme in LectureCompanionMac LectureCompanioniOS; do
      if [ "$scheme" = LectureCompanionMac ]; then destination='generic/platform=macOS'; else destination='generic/platform=iOS Simulator'; fi
      xcodebuild -project LectureCompanion.xcodeproj -scheme "$scheme" -destination "$destination" \
        -derivedDataPath "$MACMINI_CI_ROOT/cache/xcode/LectureCompanion" \
        -clonedSourcePackagesDirPath "$MACMINI_CI_ROOT/cache/swift-packages" \
        CODE_SIGNING_ALLOWED=NO build
    done
    ;;
  ios6-qemu)
    python3 -m unittest discover -s tools -p 'test_*.py' -v
    bash /Volumes/StrataData/github-ci/bin/build-qemu.sh
    ;;
  uci-parking-archive|zotcopilot-dining-art)
    python3 /Volumes/StrataData/github-ci/bin/validate-assets.py
    ;;
  *)
    if [ -f .github/scripts/ci.sh ]; then
      bash .github/scripts/ci.sh
    elif [ -f go.mod ]; then
      go test -race ./...; go vet ./...; go build ./...
    elif [ -f package.json ]; then
      if [ -f package-lock.json ]; then npm ci; else npm install; fi
      npm run typecheck --if-present
      npm run check --if-present
      npm run test --if-present
      npm run build --if-present
    elif [ -f Cargo.toml ]; then
      cargo fmt --all -- --check
      cargo clippy --all-targets --locked -- -D warnings
      cargo test --locked
      cargo build --release --locked
    elif [ -f Package.swift ]; then
      swift test --scratch-path "$RUNNER_TEMP/swift-build"
    elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
      python3 -m venv "$RUNNER_TEMP/project-venv"
      if [ -f requirements.txt ]; then "$RUNNER_TEMP/project-venv/bin/pip" install -r requirements.txt; fi
      if [ -f pyproject.toml ]; then "$RUNNER_TEMP/project-venv/bin/pip" install -e .; fi
      "$RUNNER_TEMP/project-venv/bin/pip" install pytest
      "$RUNNER_TEMP/project-venv/bin/python" -m pytest
    else
      python3 /Volumes/StrataData/github-ci/bin/validate-assets.py
    fi
    ;;
esac
