import { Type } from "@sinclair/typebox";
import {
  evaluateDecision,
  parseQuestionsJson,
  publicErrorMessage,
} from "../src/core.mjs";

const description = [
  "Advisory TypeSafe Jev decision for Multica task state. Returns typed answers and probabilities.",
  "No Multica, repository, or issue mutation is performed. Protected decisions always require a human:",
  "review-thread resolution, finding-real judgments, card scoping/creation, and decision-gated status.",
].join(" ");

export default function MulticaJevPiExtension(pi) {
  pi.registerTool({
    name: "multica_jev_decide",
    label: "Multica Jev Decision",
    description,
    parameters: Type.Object({
      state: Type.String({ description: "The task state Jev should evaluate." }),
      purpose: Type.Optional(Type.String({ description: "triage, risk, review, route, prioritize, or custom." })),
      provider: Type.Optional(Type.String({
        description: "typesafe or openrouter; defaults to MULTICA_JEV_PROVIDER.",
      })),
      questions_json: Type.Optional(Type.String({ description: "Optional JSON object of focused questions." })),
      model: Type.Optional(Type.String({ description: "Optional pinned Jev model." })),
    }),
    execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
      try {
        const result = await evaluateDecision({
          state: params.state,
          purpose: params.purpose || "triage",
          provider: params.provider,
          questions: parseQuestionsJson(params.questions_json),
          model: params.model,
          signal,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `multica_jev error: ${publicErrorMessage(error)}` }],
          details: { error: publicErrorMessage(error) },
        };
      }
    },
  });
}
