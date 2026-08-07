#!/usr/bin/env bash

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [ "$(git branch --show-current)" != "webui" ]; then
    echo "Switch to the webui branch before updating."
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "The worktree must be clean before updating."
    exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
    git remote add upstream https://github.com/ggml-org/llama.cpp.git
fi

old_base=$(git rev-parse ui-upstream)
git fetch upstream master

if git show-ref --verify --quiet refs/heads/ui-upstream-next; then
    git branch -D ui-upstream-next
fi

git subtree split --prefix=tools/ui -b ui-upstream-next upstream/master
git rebase --onto ui-upstream-next "$old_base" webui
git branch -f ui-upstream ui-upstream-next
git branch -D ui-upstream-next

echo "Updated webui from upstream tools/ui. Run the verification steps in MAINTAINING.md."
