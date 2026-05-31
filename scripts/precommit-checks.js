const fs = require("fs");
const { execSync } = require("child_process");

const mustExist = ["index.html", "styles.css", "app.js", "package.json"];

for (const f of mustExist) {
  if (!fs.existsSync(f)) {
    console.error(`❌ Missing file: ${f}`);
    process.exit(1);
  }
}

try {
  // Проверим staged файлы: если кто-то случайно закоммитил огромный файл > 10MB
  const out = execSync("git diff --cached --name-only", {
    encoding: "utf8",
  }).trim();
  const files = out ? out.split("\n") : [];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size > 10 * 1024 * 1024) {
      console.error(`❌ File too large in commit (>10MB): ${file}`);
      process.exit(1);
    }
  }

  console.log("✅ pre-commit checks passed");
} catch (e) {
  console.error("❌ pre-commit checks failed");
  process.exit(1);
}
