import { tool } from "@opencode-ai/plugin";
import {
  evaluateDecision,
  parseQuestionsJson,
  publicErrorMessage,
} from "../src/core.mjs";

const description = [
  "Use TypeSafe Jev for an advisory, typed decision about the supplied Multica task state.",
  "Choose a purpose of triage, risk, review, route, prioritize, or custom and provide focused questions only when needed.",
  "For custom questions_json, each question is {type: choice|score|noul, instructions: string, criteria: ...}.",
  "Choice questions may use an options array of labels; it is normalized to safe keys automatically.",
  "The question field is accepted as an alias for instructions, and levels is accepted for score criteria.",
  "The tool never changes Multica, the repository, or an issue. Its output is not a verdict:",
  "resolving review threads, judging whether findings are real, scoping/creating cards, and deciding",
  "that an issue is decision-gated always require a human or supervising session.",
].join(" ");

export default async function MulticaJevOpenCodePlugin() {
  return {
    tool: {
      multica_jev_decide: tool({
        description,
        args: {
          state: tool.schema.string().describe("The task state Jev should evaluate."),
          purpose: tool.schema.string().optional().describe("triage, risk, review, route, prioritize, or custom."),
          provider: tool.schema.string().optional().describe(
            "typesafe or openrouter; defaults to MULTICA_JEV_PROVIDER.",
          ),
          questions_json: tool.schema.string().optional().describe(
            "Optional JSON object. Example: {\"decision\":{\"type\":\"choice\",\"question\":\"Which lane?\",\"options\":[\"investigate\",\"implement\"]}}. Required for custom purpose.",
          ),
          model: tool.schema.string().optional().describe("Optional pinned Jev model, such as jev-1.13.0."),
        },
        async execute(args) {
          try {
            const result = await evaluateDecision({
              state: args.state,
              purpose: args.purpose || "triage",
              provider: args.provider,
              questions: parseQuestionsJson(args.questions_json),
              model: args.model,
            });
            return JSON.stringify(result, null, 2);
          } catch (error) {
            return `multica_jev error: ${publicErrorMessage(error)}`;
          }
        },
      }),
    },
  };
}
