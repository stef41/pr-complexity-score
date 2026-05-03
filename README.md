# 📊 PR Complexity Score

**Scores pull requests on reviewability and suggests splits for oversized PRs.**

> **Gap filled:** anti-slop detects AI-generated junk, compressed-size-action measures bundle size, but nothing measures *how hard a PR is to review* using cognitive complexity, blast radius, and cross-cutting concern analysis.

## Scoring Dimensions

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Lines changed | 15% | Raw volume of changes |
| Files changed | 15% | Number of files touched |
| Directory spread | 15% | How many modules are affected |
| Cognitive complexity | 20% | Conditionals, loops, nesting in new code |
| Test ratio | 10% | Presence of tests for code changes |
| Cross-cutting concerns | 10% | Mixing UI + API + DB + infra changes |
| File type spread | 10% | Code + config + docs + styles mixed |
| Review time estimate | 5% | Estimated minutes to review |

## Usage

```yaml
on: pull_request

jobs:
  complexity:
    runs-on: ubuntu-latest
    steps:
      - uses: your-org/pr-complexity-score@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          max-score: '70'
          post-comment: 'true'
          fail-on-high-complexity: 'false'
```

## Example Output

> ## 🟡 PR Complexity Score: **54/100** (medium)
> | Metric | Value | Score |
> |--------|-------|-------|
> | Lines changed | +342 / -89 | 86 |
> | Files changed | 12 | 60 |
> | Directory spread | 3 top-level dirs | 30 |
> | Cognitive complexity | 18 constructs | 36 |
> 
> ### 💡 Suggested Splits
> - Split API changes from UI changes — they can be reviewed independently
