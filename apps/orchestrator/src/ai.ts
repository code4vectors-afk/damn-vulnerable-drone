import fs from "node:fs";
import { config, slotIps } from "./config.js";
import { db, audit } from "./db.js";

interface KnowledgeChunk {
  id: string;
  source: string;
  category: string;
  scenarioId: string | null;
  text: string;
  tokens: string[];
}

interface IndexedChunk extends KnowledgeChunk {
  tf: Map<string, number>;
  len: number;
}

let chunks: IndexedChunk[] = [];
let df = new Map<string, number>();
let avgLen = 1;

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_/.:-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

export function loadKnowledgeIndex() {
  if (!fs.existsSync(config.knowledgePath)) {
    chunks = [];
    return;
  }
  const raw = JSON.parse(fs.readFileSync(config.knowledgePath, "utf8")) as { chunks: KnowledgeChunk[] };
  df = new Map();
  let totalLen = 0;
  chunks = (raw.chunks || []).map((c) => {
    const tf = new Map<string, number>();
    for (const tok of c.tokens || tokenize(c.text)) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    for (const tok of tf.keys()) {
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
    const len = c.tokens?.length || 1;
    totalLen += len;
    return { ...c, tf, len };
  });
  avgLen = chunks.length ? totalLen / chunks.length : 1;
}

loadKnowledgeIndex();

export function searchKnowledge(query: string, activeScenarioId?: string | null, topK = 5) {
  const qTokens = tokenize(query);
  const N = Math.max(chunks.length, 1);
  const k1 = 1.5;
  const b = 0.75;

  const scored = chunks.map((c) => {
    let score = 0;
    for (const qt of qTokens) {
      const freq = c.tf.get(qt) ?? 0;
      if (!freq) continue;
      const docFreq = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * c.len) / avgLen)));
    }
    if (activeScenarioId && c.scenarioId === activeScenarioId) score += 4.0;
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

const todayKey = () => new Date().toISOString().slice(0, 10);

export function getAiQuota(userId: number) {
  const day = todayKey();
  const row = db.prepare("SELECT requests, tokens FROM ai_usage WHERE user_id=? AND day=?").get(userId, day) as
    | { requests: number; tokens: number }
    | undefined;
  const used = row?.requests ?? 0;
  return {
    configured: Boolean(config.ai.apiKey),
    baseUrl: config.ai.baseUrl,
    models: { fast: config.ai.modelFast, pro: config.ai.modelPro },
    usedToday: used,
    limitToday: config.ai.dailyReqLimit,
    remainingToday: Math.max(0, config.ai.dailyReqLimit - used),
    indexedChunks: chunks.length,
  };
}

function recordUsage(userId: number, tokens: number) {
  const day = todayKey();
  db.prepare(
    `INSERT INTO ai_usage(user_id, day, requests, tokens) VALUES(?,?,1,?)
     ON CONFLICT(user_id, day) DO UPDATE SET requests=requests+1, tokens=tokens+excluded.tokens`
  ).run(userId, day, tokens);
}

export async function askCopilot(params: {
  userId: number;
  message: string;
  scenarioId?: string | null;
  slot?: number | null;
  modelTier?: "fast" | "pro";
}) {
  const query = params.message.trim();
  if (!query || query.length > 2000) throw new Error("Message must be 1–2000 characters");

  const quota = getAiQuota(params.userId);
  if (quota.configured && quota.remainingToday <= 0) {
    throw new Error(`Daily AI quota reached (${quota.limitToday} requests/day). Local doc search remains available.`);
  }

  const hits = searchKnowledge(query, params.scenarioId, 5);
  const citations = hits.map((h, i) => ({
    index: i + 1,
    id: h.id,
    source: h.source,
    category: h.category,
    excerpt: h.text.slice(0, 260).replace(/\s+/g, " ").trim(),
  }));

  const ips = params.slot ? slotIps(params.slot) : null;

  // Fallback to local BM25 knowledge search when AI_API_KEY is not configured yet
  if (!config.ai.apiKey) {
    const lines = [
      `**Local Knowledge Search** *(DeepSeek API key not configured in \`.env\` — set \`AI_API_KEY\` to enable full LLM synthesis)*`,
      "",
    ];
    if (ips) {
      lines.push(
        `Active Slot IPs: FC \`${ips.fc}\` · Companion \`${ips.companion}\` · GCS \`${ips.gcs}\` · Sim \`${ips.sim}\` · Subnet \`${ips.subnet}\``,
        ""
      );
    }
    if (!hits.length) {
      lines.push("No matching sections found in the local DVD knowledge base. Try keywords like `mavproxy`, `camera flood`, `hydra`, `cyclonedds`, or `gps`.");
    } else {
      hits.slice(0, 3).forEach((h, i) => {
        lines.push(`**[${i + 1}] ${h.source}**\n${h.text.slice(0, 520).trim()}…\n`);
      });
    }
    return {
      mode: "local-rag" as const,
      model: "local-bm25",
      reply: lines.join("\n"),
      citations,
      quota: getAiQuota(params.userId),
    };
  }

  const model = params.modelTier === "pro" ? config.ai.modelPro : config.ai.modelFast;
  const contextBlock = hits
    .map((h, i) => `[${i + 1}] SOURCE: ${h.source}\n${h.text.slice(0, 1800)}`)
    .join("\n\n---\n\n");

  const slotContext = ips
    ? `Active User Lab Slot #${params.slot}:
- Flight Controller ($DRONE_FC_IP): ${ips.fc}
- Companion Computer ($DRONE_COMPANION_IP): ${ips.companion} (Web :3000, MAVLink TCP :5760, RTSP :554, SSH :22)
- Ground Control Station ($DRONE_GCS_IP): ${ips.gcs} (UDP :14550, QGC noVNC)
- Simulator ($DRONE_SIM_IP): ${ips.sim} (Web :8000)
- Lab Subnet ($DRONE_SUBNET): ${ips.subnet}
- Pre-baked tools: /opt/dvd-tools/ (passwords.txt, ros2_rogue_publisher.py), ROS 2 Humble + CycloneDDS pre-configured (ROS_DOMAIN_ID=42).`
    : "No active lab slot is currently running for this user.";

  const systemPrompt = `You are the DVDrone Web Range Tactical AI Copilot (Track C).
You assist authorized students inside an isolated Damn Vulnerable Drone training range.
Rules:
1. Ground your answers strictly in the retrieved DVD documentation below and the user's active lab slot IPs.
2. Always cite retrieved sources inline using [1], [2], etc.
3. Give exact, copy-pasteable commands using the user's live slot IPs (never use 10.13.0.x or sudo, since the AttackBox has no sudo and uses isolated per-slot subnets).
4. Include a brief defensive takeaway when explaining an attack.
5. Remind users only if they ask about real-world aircraft that techniques are strictly for this isolated simulator.

${slotContext}

RETRIEVED KNOWLEDGE BASE:
${contextBlock || "(No matching documents retrieved)"}`;

  const resp = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: config.ai.maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`AI provider error (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  const reply = data?.choices?.[0]?.message?.content?.trim() || "(Empty response from model)";
  const tokens = Number(data?.usage?.total_tokens ?? 0);
  recordUsage(params.userId, tokens);
  audit(params.userId, "ai_chat", `${model} tokens=${tokens}`);

  return {
    mode: "llm" as const,
    model,
    reply,
    citations,
    quota: getAiQuota(params.userId),
  };
}
