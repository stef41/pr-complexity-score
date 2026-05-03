const core = require("@actions/core");
const github = require("@actions/github");

const WEIGHTS = {
  linesChanged: 0.15,
  filesChanged: 0.15,
  directorySpread: 0.15,
  cognitiveComplexity: 0.20,
  testRatio: 0.10,
  crossCutting: 0.10,
  fileTypeSpread: 0.10,
  reviewEstimate: 0.05,
};

function analyzeDirectorySpread(files) {
  const dirs = new Set();
  const topLevelDirs = new Set();
  for (const file of files) {
    const parts = file.filename.split("/");
    if (parts.length > 1) {
      dirs.add(parts.slice(0, -1).join("/"));
      topLevelDirs.add(parts[0]);
    }
  }
  return {
    uniqueDirs: dirs.size,
    topLevelDirs: topLevelDirs.size,
    score: Math.min(100, (topLevelDirs.size - 1) * 15 + (dirs.size - 1) * 5),
  };
}

function analyzeFileTypes(files) {
  const extensions = new Set();
  const categories = new Set();
  for (const file of files) {
    const ext = (file.filename.match(/\.(\w+)$/) || [])[1] || "none";
    extensions.add(ext);

    if (["ts", "js", "tsx", "jsx", "py", "rb", "go", "rs", "java"].includes(ext)) {
      categories.add("code");
    } else if (["css", "scss", "less", "styled"].includes(ext)) {
      categories.add("styles");
    } else if (["yml", "yaml", "json", "toml", "xml", "ini"].includes(ext)) {
      categories.add("config");
    } else if (["md", "rst", "txt", "adoc"].includes(ext)) {
      categories.add("docs");
    } else if (["sql"].includes(ext)) {
      categories.add("database");
    } else if (["Dockerfile", "docker-compose"].some((d) => file.filename.includes(d))) {
      categories.add("infrastructure");
    }
  }
  return {
    extensions: extensions.size,
    categories: categories.size,
    score: Math.min(100, (categories.size - 1) * 20),
  };
}

function analyzeCrossConceerns(files) {
  const concerns = new Set();
  for (const file of files) {
    const name = file.filename.toLowerCase();
    if (name.includes("test") || name.includes("spec")) concerns.add("tests");
    if (name.includes("migration") || name.includes(".sql")) concerns.add("database");
    if (name.includes("api") || name.includes("route") || name.includes("endpoint")) concerns.add("api");
    if (name.includes("component") || name.includes("view") || name.includes("page")) concerns.add("ui");
    if (name.includes("config") || name.includes("setting")) concerns.add("config");
    if (name.includes("deploy") || name.includes("ci") || name.includes("workflow")) concerns.add("infra");
    if (name.includes("model") || name.includes("schema") || name.includes("entity")) concerns.add("data-model");
    if (name.includes("auth") || name.includes("permission") || name.includes("security")) concerns.add("auth");
  }
  return {
    concerns: [...concerns],
    count: concerns.size,
    score: Math.min(100, (concerns.size - 1) * 20),
  };
}

function analyzeTestRatio(files) {
  let testFiles = 0;
  let codeFiles = 0;
  for (const file of files) {
    const name = file.filename.toLowerCase();
    const isCode = /\.(ts|js|tsx|jsx|py|rb|go|rs|java|kt|swift|cs)$/.test(name);
    if (!isCode) continue;
    if (name.includes("test") || name.includes("spec") || name.includes("_test.")) {
      testFiles++;
    } else {
      codeFiles++;
    }
  }
  if (codeFiles === 0) return { testFiles, codeFiles, ratio: 1, score: 0 };
  const ratio = testFiles / codeFiles;
  // Penalize PRs with code changes but no tests
  const score = ratio >= 0.5 ? 0 : Math.min(100, (1 - ratio) * 50);
  return { testFiles, codeFiles, ratio: Math.round(ratio * 100) / 100, score };
}

function calculateComplexityFromPatch(patch) {
  if (!patch) return 0;
  let complexity = 0;
  const lines = patch.split("\n");
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    // Count complexity-adding constructs
    if (/\b(if|else|elif|switch|case|catch|except|for|while|do)\b/.test(line)) complexity++;
    if (/&&|\|\|/.test(line)) complexity++;
    if (/\?.*:/.test(line)) complexity++; // ternary
    if (/\b(try|throw|raise)\b/.test(line)) complexity++;
    if (/=>\s*\{/.test(line)) complexity++; // arrow function with body
  }
  return complexity;
}

function suggestSplits(analysis) {
  const suggestions = [];
  const { crossCutting, directorySpread, fileTypes } = analysis;

  if (crossCutting.concerns.includes("tests") && crossCutting.concerns.includes("database")) {
    suggestions.push("Split database migrations into a separate PR from test changes");
  }
  if (crossCutting.concerns.includes("ui") && crossCutting.concerns.includes("api")) {
    suggestions.push("Split API changes from UI changes — they can be reviewed independently");
  }
  if (crossCutting.concerns.includes("infra") && crossCutting.count > 2) {
    suggestions.push("Extract infrastructure/CI changes into their own PR");
  }
  if (directorySpread.topLevelDirs > 3) {
    suggestions.push(`PR touches ${directorySpread.topLevelDirs} top-level directories — consider splitting by module`);
  }
  if (fileTypes.categories > 3) {
    suggestions.push("PR spans multiple concerns (code, config, docs, etc.) — split for focused review");
  }
  return suggestions;
}

async function run() {
  const token = core.getInput("github-token");
  const maxScore = parseInt(core.getInput("max-score"));
  const warnScore = parseInt(core.getInput("warn-score"));
  const postComment = core.getInput("post-comment") === "true";
  const failOnHigh = core.getInput("fail-on-high-complexity") === "true";

  const octokit = github.getOctokit(token);
  const context = github.context;

  if (!context.payload.pull_request) {
    core.info("Not a pull request event, skipping");
    return;
  }

  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;

  // Get PR files
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // Calculate metrics
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const totalChanges = totalAdditions + totalDeletions;

  const linesScore = Math.min(100, (totalChanges / 500) * 100);
  const filesScore = Math.min(100, (files.length / 20) * 100);

  const dirSpread = analyzeDirectorySpread(files);
  const fileTypes = analyzeFileTypes(files);
  const crossCutting = analyzeCrossConceerns(files);
  const testRatio = analyzeTestRatio(files);

  let totalCognitiveComplexity = 0;
  for (const file of files) {
    totalCognitiveComplexity += calculateComplexityFromPatch(file.patch);
  }
  const cognitiveScore = Math.min(100, (totalCognitiveComplexity / 50) * 100);

  const reviewMinutes = Math.ceil(totalChanges / 25 + files.length * 2);
  const reviewScore = Math.min(100, (reviewMinutes / 60) * 100);

  // Weighted total
  const finalScore = Math.round(
    linesScore * WEIGHTS.linesChanged +
    filesScore * WEIGHTS.filesChanged +
    dirSpread.score * WEIGHTS.directorySpread +
    cognitiveScore * WEIGHTS.cognitiveComplexity +
    testRatio.score * WEIGHTS.testRatio +
    crossCutting.score * WEIGHTS.crossCutting +
    fileTypes.score * WEIGHTS.fileTypeSpread +
    reviewScore * WEIGHTS.reviewEstimate,
  );

  const verdict =
    finalScore < warnScore ? "low" :
    finalScore < maxScore ? "medium" :
    finalScore < 90 ? "high" : "extreme";

  const analysis = { crossCutting, directorySpread: dirSpread, fileTypes };
  const splits = suggestSplits(analysis);

  core.setOutput("complexity-score", finalScore.toString());
  core.setOutput("verdict", verdict);
  core.setOutput("suggested-splits", splits.length.toString());

  // Build report
  const emoji = { low: "🟢", medium: "🟡", high: "🟠", extreme: "🔴" }[verdict];
  const report =
    `## ${emoji} PR Complexity Score: **${finalScore}/100** (${verdict})\n\n` +
    `| Metric | Value | Score |\n|--------|-------|-------|\n` +
    `| Lines changed | +${totalAdditions} / -${totalDeletions} | ${Math.round(linesScore)} |\n` +
    `| Files changed | ${files.length} | ${Math.round(filesScore)} |\n` +
    `| Directory spread | ${dirSpread.topLevelDirs} top-level dirs | ${Math.round(dirSpread.score)} |\n` +
    `| Cognitive complexity | ${totalCognitiveComplexity} constructs | ${Math.round(cognitiveScore)} |\n` +
    `| Test ratio | ${testRatio.testFiles}/${testRatio.codeFiles} (${testRatio.ratio}) | ${Math.round(testRatio.score)} |\n` +
    `| Cross-cutting concerns | ${crossCutting.concerns.join(", ") || "single"} | ${Math.round(crossCutting.score)} |\n` +
    `| Est. review time | ~${reviewMinutes} min | ${Math.round(reviewScore)} |\n\n` +
    (splits.length > 0
      ? `### 💡 Suggested Splits\n${splits.map((s) => `- ${s}`).join("\n")}\n`
      : "");

  core.summary.addRaw(report);
  await core.summary.write();

  if (postComment) {
    // Upsert comment
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: prNumber,
    });
    const existing = comments.find((c) =>
      c.body && c.body.includes("PR Complexity Score"),
    );
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body: report,
      });
    } else {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: report,
      });
    }
  }

  if (failOnHigh && finalScore >= maxScore) {
    core.setFailed(
      `PR complexity score ${finalScore} exceeds maximum ${maxScore}`,
    );
  }
}

run().catch((error) => core.setFailed(error.message));
