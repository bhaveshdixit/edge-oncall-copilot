# Edge Oncall Copilot

Stateful incident triage agent built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) — Workers, Durable Objects, and Workers AI (no OpenAI key required on the free tier).

Forked from [`cloudflare/agents-starter`](https://github.com/cloudflare/agents-starter) and customized for **on-call triage**: severity scoring, mitigation playbooks, scheduled follow-ups, and vision on alert screenshots.

**Author:** [Bhavesh Dixit](https://www.linkedin.com/in/bhavesh-dixit-89577320b/) — backend engineer (Rippling); built production LangGraph on-call copilots. This demo shows the same workflow on Cloudflare's edge runtime.

## Try it locally

```bash
npm install
npx wrangler login   # one-time Cloudflare auth
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Example prompts

- _"API 5xx spiked to 18% for 25 minutes on checkout-service. Partial outage. Revenue path."_
- _"Score severity and give me the next 3 mitigations."_
- _"Remind me in 10 minutes to re-check error rate."_
- Paste a Grafana screenshot and ask what to investigate first.

## Deploy (low cost)

Workers + Workers AI free tiers are enough for a portfolio demo. No always-on server.

```bash
npm run deploy
```

## Architecture

| Piece                                                       | Role                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `ChatAgent` (Durable Object)                                | Persistent session + scheduling                       |
| Workers AI (`@cf/meta-llama/llama-3.2-11b-vision-instruct`) | Streaming triage reasoning + vision                   |
| Tools                                                       | `scoreIncident`, `suggestMitigations`, `scheduleTask` |
| React UI                                                    | Kumo chat from agents-starter                         |

## License

MIT (same as agents-starter).
