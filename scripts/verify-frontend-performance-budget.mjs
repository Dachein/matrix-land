import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const buildDirectory = resolve("dist/_build");
const files = await readdir(buildDirectory).catch(() => []);

const budgets = [
  { label: "Portal core JavaScript", pattern: /^index-[^.]+\.js$/, maxGzipKb: 120 },
  { label: "Portal core CSS", pattern: /^index-[^.]+\.css$/, maxGzipKb: 23 },
  { label: "Deferred profile modal CSS", pattern: /^ProfileModal-[^.]+\.css$/, maxGzipKb: 3 },
  { label: "React vendor", pattern: /^vendor-react-[^.]+\.js$/, maxGzipKb: 70 },
  { label: "Icon vendor", pattern: /^vendor-icons-[^.]+\.js$/, maxGzipKb: 15 },
  { label: "Chinese locale", pattern: /^resources\.zh-CN-[^.]+\.js$/, maxGzipKb: 52 },
  { label: "English locale", pattern: /^resources\.en-[^.]+\.js$/, maxGzipKb: 50 },
  { label: "Skills route", pattern: /^PortalSkillsApps-[^.]+\.js$/, maxGzipKb: 20 },
  { label: "APPS route", pattern: /^PortalApps-[^.]+\.js$/, maxGzipKb: 40 },
  { label: "Knowledge route", pattern: /^PortalKnowledge-[^.]+\.js$/, maxGzipKb: 40 },
  { label: "Token critical route", pattern: /^PortalToken-[^.]+\.js$/, maxGzipKb: 80 },
  { label: "Deferred Token chart", pattern: /^EChart-[^.]+\.js$/, maxGzipKb: 180 },
  { label: "Forum post route", pattern: /^PortalPostDetail-[^.]+\.js$/, maxGzipKb: 12 },
  { label: "Forum reader rich blocks", pattern: /^ForumRichBlocks-[^.]+\.js$/, maxGzipKb: 12 },
  { label: "Deferred forum editor JavaScript", pattern: /^ForumBlockNoteEditor-[^.]+\.js$/, maxGzipKb: 300 },
  { label: "Deferred forum editor CSS", pattern: /^ForumBlockNoteEditor-[^.]+\.css$/, maxGzipKb: 38 },
  { label: "Deferred native resource", pattern: /^native-[^.]+\.js$/, maxGzipKb: 82 }
];

const failures = [];
const measurements = [];

for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(file));
  if (matches.length !== 1) {
    failures.push(`${budget.label}: expected one build artifact, found ${matches.length}`);
    continue;
  }

  const file = matches[0];
  const contents = await readFile(resolve(buildDirectory, file));
  const gzipKb = gzipSync(contents).byteLength / 1024;
  measurements.push({ ...budget, file, gzipKb });
  if (gzipKb > budget.maxGzipKb) {
    failures.push(
      `${budget.label}: ${gzipKb.toFixed(2)} KB gzip exceeds ${budget.maxGzipKb} KB budget`
    );
  }
}

for (const measurement of measurements) {
  console.log(
    `${measurement.label}: ${measurement.gzipKb.toFixed(2)} KB gzip / ${measurement.maxGzipKb} KB budget (${measurement.file})`
  );
}

const entryHtml = await readFile(resolve("dist/index.html"), "utf8").catch(() => "");
const initialAssets = Array.from(new Set(
  [...entryHtml.matchAll(/(?:src|href)="\/_build\/([^"]+)"/g)].map((match) => match[1])
));
if (initialAssets.length === 0) {
  failures.push("Portal initial network set: could not read _build assets from dist/index.html");
} else {
  const missingInitialAssets = initialAssets.filter((file) => !files.includes(file));
  if (missingInitialAssets.length > 0) {
    failures.push(`Portal initial network set: missing build assets ${missingInitialAssets.join(", ")}`);
  } else {
    let initialGzipKb = 0;
    for (const file of initialAssets) {
      initialGzipKb += gzipSync(await readFile(resolve(buildDirectory, file))).byteLength / 1024;
    }
    const initialBudgetKb = 215;
    console.log(`Portal initial network set: ${initialGzipKb.toFixed(2)} KB gzip / ${initialBudgetKb} KB budget (${initialAssets.length} assets)`);
    if (initialGzipKb > initialBudgetKb) {
      failures.push(`Portal initial network set: ${initialGzipKb.toFixed(2)} KB gzip exceeds ${initialBudgetKb} KB budget`);
    }

    const chineseLocale = measurements.find((measurement) => measurement.label === "Chinese locale");
    if (chineseLocale) {
      const firstVisitChineseKb = initialGzipKb + chineseLocale.gzipKb;
      const firstVisitChineseBudgetKb = 268;
      console.log(`Portal first visit (zh-CN): ${firstVisitChineseKb.toFixed(2)} KB gzip / ${firstVisitChineseBudgetKb} KB budget`);
      if (firstVisitChineseKb > firstVisitChineseBudgetKb) {
        failures.push(`Portal first visit (zh-CN): ${firstVisitChineseKb.toFixed(2)} KB gzip exceeds ${firstVisitChineseBudgetKb} KB budget`);
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Frontend performance budget failed:\n- ${failures.join("\n- ")}`);
}

console.log("Frontend performance budgets verified.");
