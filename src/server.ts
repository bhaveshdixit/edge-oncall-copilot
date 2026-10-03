import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

const SEVERITY = ["SEV1", "SEV2", "SEV3", "SEV4"] as const;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta-llama/llama-3.2-11b-vision-instruct", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Edge Oncall Copilot — a production incident triage assistant running on Cloudflare Workers + Durable Objects.

Your job:
1. Turn noisy alerts, log snippets, and screenshots into a crisp incident brief.
2. Propose severity (SEV1–SEV4), blast radius, and the next 3 mitigation steps.
3. Use tools for structured severity scoring and runbook hints; schedule follow-up checks when asked.

Be concise. Prefer bullet lists. Call out unknowns and what data would de-risk the call.
When users paste metrics or stack traces, extract signals before recommending action.

${getSchedulePrompt({ date: new Date() })}

Use scheduleTask for "check again in N minutes" style follow-ups.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        ...mcpTools,

        scoreIncident: tool({
          description:
            "Score incident severity from structured signals (customer impact, error rate, duration).",
          inputSchema: z.object({
            customerImpact: z
              .enum(["none", "degraded", "partial_outage", "full_outage"])
              .describe("User-facing impact"),
            errorRatePercent: z
              .number()
              .min(0)
              .max(100)
              .describe("Approximate error rate"),
            durationMinutes: z
              .number()
              .min(0)
              .describe("How long the issue has been active"),
            isRevenueCritical: z.boolean().describe("Payments or billing path")
          }),
          execute: async ({
            customerImpact,
            errorRatePercent,
            durationMinutes,
            isRevenueCritical
          }) => {
            let points = 0;
            if (customerImpact === "full_outage") points += 40;
            else if (customerImpact === "partial_outage") points += 28;
            else if (customerImpact === "degraded") points += 12;
            if (errorRatePercent >= 25) points += 25;
            else if (errorRatePercent >= 5) points += 12;
            if (durationMinutes >= 60) points += 15;
            else if (durationMinutes >= 15) points += 8;
            if (isRevenueCritical) points += 20;

            const severity =
              points >= 70
                ? "SEV1"
                : points >= 50
                  ? "SEV2"
                  : points >= 30
                    ? "SEV3"
                    : "SEV4";

            return {
              severity,
              score: points,
              rationale: `Impact=${customerImpact}, errors≈${errorRatePercent}%, duration=${durationMinutes}m, revenueCritical=${isRevenueCritical}`,
              allowedSeverities: SEVERITY
            };
          }
        }),

        suggestMitigations: tool({
          description:
            "Return a short mitigation playbook for a service and symptom.",
          inputSchema: z.object({
            service: z.string().describe("Service or component name"),
            symptom: z.string().describe("What is failing"),
            severity: z.enum(SEVERITY)
          }),
          execute: async ({ service, symptom, severity }) => {
            const urgent = severity === "SEV1" || severity === "SEV2";
            return {
              service,
              symptom,
              severity,
              immediate: [
                urgent
                  ? "Page on-call owner and open a war-room channel."
                  : "Assign a single incident commander.",
                `Check recent deploys and feature flags for ${service}.`,
                "Validate upstream dependencies (DB, cache, queue) with health dashboards."
              ],
              stabilize: [
                "Enable safe rollback or traffic shed if error budget is burning.",
                "Increase observability sampling on the hot path.",
                "Document customer comms status and ETA window."
              ],
              postIncident: [
                "Capture timeline + root cause hypothesis before context decays.",
                "File follow-up tasks for guardrails and alerting gaps."
              ]
            };
          }
        }),

        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser for incident timestamps.",
          inputSchema: z.object({})
        }),

        scheduleTask: tool({
          description:
            "Schedule a follow-up (e.g. re-check error rate in 15 minutes).",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Follow-up scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List scheduled incident follow-ups",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled follow-ups.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled follow-up by ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Incident follow-up: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
