#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { evaluateDecision, parseQuestionsJson, publicErrorMessage } from "../src/core.mjs";

function usage() {
  console.error(
    "Usage: multica-jev --state <text> [--purpose triage|risk|review|route|prioritize|custom] [--provider typesafe|openrouter] [--questions <json-or-file>] [--model <model>",
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main(argv) {
  // Everything that can fail belongs inside the try. Argument parsing and the
  // @file read both throw on ordinary user mistakes, and outside it the process
  // died with a raw Node stack trace instead of the CLI error message.
  try {
    const args = parseArgs(argv);
    if (!args.state) {
      usage();
      process.exitCode = 2;
      return;
    }
    let questionsJson = args.questions;
    if (questionsJson && questionsJson.startsWith("@")) {
      questionsJson = await readFile(questionsJson.slice(1), "utf8");
    }
    const result = await evaluateDecision({
      state: args.state,
      purpose: args.purpose || "triage",
      provider: args.provider,
      questions: parseQuestionsJson(questionsJson),
      model: args.model,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`multica-jev error: ${publicErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
