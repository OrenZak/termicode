---
name: create-pr
description: Create a GitHub pull request for the current branch. Use when the user says "create PR", "open PR", "make a PR", or similar.
allowed-tools: Bash(git *), Bash(gh *)
---

Create a GitHub pull request for the current branch. Follow these steps:

1. Run `git status`, `git log main..HEAD --oneline`, and `git diff main...HEAD --stat` to understand the changes
2. If not already on a conventional branch, rename it: `git branch -m <type>/<short-description>`
   - Types: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`
   - Example: `fix/remove-plan-auto-preview`
3. Ensure all commits follow conventional commit format: `<type>: <description>`
   - Example: `feat: add worktree session support`
   - If commits don't follow the format, note it but don't amend (don't rewrite history)
4. Pick a PR title that mirrors the conventional commit style: `<type>: <description>` (under 70 chars)
5. Build the PR body:
   - **Summary**: 2–4 bullet points of what changed and why
   - **Test plan**: reflect the actual work done — mark items as `- [x]` if they were already verified during the work (e.g., build passed, manual testing done), leave `- [ ]` for things the reviewer should check
6. Push the branch if not already pushed: `git push -u origin HEAD`
7. Create the PR with `gh pr create`
8. Open the PR in the browser with `gh pr view --web`
9. Return the PR URL

> **Merging:** always use squash merge so the merge commit follows the conventional title.
> In the GitHub UI: select "Squash and merge" and set the commit message to match the PR title (`type: description`).
> Via CLI: `gh pr merge --squash --subject "type: description"`

Use HEREDOC syntax to pass the body:
```
gh pr create --title "type: description" --body "$(cat <<'EOF'
## Summary
- ...

## Test plan
- [x] Build passes
- [x] <things already verified>
- [ ] <things for reviewer to check>
EOF
)"
```

Do not add "Co-Authored-By" lines.
