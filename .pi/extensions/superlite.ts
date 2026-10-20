import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BOOTSTRAP_MARKER = "superlite:using-superlite bootstrap for pi";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "../..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superlite", "SKILL.md");
const slScript = resolve(skillsDir, "subagent-driven-development", "scripts", "sl");

// State cache (2s TTL)
let stateCache: { at: number; hasRun: boolean } | undefined;

function hasActiveRun(cwd: string): boolean {
    if (stateCache && Date.now() - stateCache.at < 2000) return stateCache.hasRun;
    const slDir = resolve(cwd, ".superlite");
    const hasRun = existsSync(resolve(slDir, "stable.json")) || existsSync(resolve(slDir, "prime.md")) || existsSync(resolve(slDir, "pool.json"));
    stateCache = { at: Date.now(), hasRun };
    return hasRun;
}

const PROTECTED_FILES = [".superlite/orchestrator.json", ".superlite/human-replies.jsonl"];
const UNSAFE_KILL: RegExp[] = [/\bpkill\b/, /\bkillall\b/, /\bkill\s+-9\s+-1\b/, /\btaskkill\s+\/(IM|FI)\b/i, /\bStop-Process\s+-Name\b/i];
const TEST_CMDS: RegExp[] = [/\bpytest\b/, /\bnpm\s+test\b/, /\bnpx\s+(vitest|jest)\b/, /\bgo\s+test\b/, /\bcargo\s+test\b/, /\bdotnet\s+test\b/];

function isAllowedWrite(path: string): boolean {
    return path.includes("docs/plans/") || (path.includes("docs/") && path.endsWith(".md")) || /SPEC.*\.md$/.test(path) || path.includes(".superlite/");
}

function replaceTestSegment(cmd: string): string | null {
    const parts = cmd.split(/(\s*(?:&&|\|\||;)\s*)/);
    let changed = false;
    for (let i = 0; i < parts.length; i += 2) {
        const seg = parts[i].trim();
        if (seg && TEST_CMDS.some((p) => p.test(seg))) {
            parts[i] = seg.replace(TEST_CMDS.find((p) => p.test(seg))!, `bash "${slScript}" run_tests --full`);
            changed = true;
        }
    }
    return changed ? parts.join("") : null;
}

let cachedBootstrap: string | null = undefined;

export default function superlitePiExtension(pi: ExtensionAPI) {
    let injectBootstrap = true;

    pi.on("resources_discover", async () => ({ skillPaths: [skillsDir] }));
    pi.on("session_start", async () => { injectBootstrap = true; stateCache = undefined; });
    pi.on("session_compact", async () => { injectBootstrap = true; stateCache = undefined; });
    pi.on("agent_end", async () => { injectBootstrap = false; });

    // ─── Gates: tool_call 차단·재작성 ────────────────────────────
    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
        const tool = event.toolName?.toLowerCase() ?? "";
        const input = event.input ?? {};

        // Gate: unsafe kill — applies to ALL agents (workers included, 원본 hooks 계약)
        if (tool === "bash") {
            const cmd = typeof input.command === "string" ? input.command : "";
            for (const pat of UNSAFE_KILL) {
                if (pat.test(cmd)) {
                    return { block: true, reason: `superlite: killing by name/pattern blocked (${pat.source}). Use PID from the run's process list.` };
                }
            }
        }

        // Remaining gates are coordinator-only — workers pass through
        if (ctx.agent?.kind === "sub") return;

        // Protected files: ALWAYS blocked (원본 hooks Rule 1 — 활성 런 무관)
        const targetPath = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
        if (PROTECTED_FILES.some((pf) => targetPath.endsWith(pf))) {
            return { block: true, reason: `superlite: ${targetPath.split("/").pop()} is hook-managed, not written by the model.` };
        }

        const active = hasActiveRun(ctx.cwd);
        if (!active) return;

        // Active run: coordinator cannot write project code
        if (["edit", "write", "apply_patch"].includes(tool) && targetPath && !isAllowedWrite(targetPath)) {
            return { block: true, reason: `superlite: coordinator cannot write project code (${targetPath}). Use fixer agent. Allowed: docs/plans/**, SPEC*.md, .superlite/**.` };
        }

        // Gate: test-run rewrite (segment-preserving, single execution, immediate return)
        if (tool === "bash") {
            const cmd = typeof input.command === "string" ? input.command : "";
            if (cmd.includes("run_tests")) return;
            const rewritten = replaceTestSegment(cmd);
            if (rewritten !== null) {
                return { input: { ...input, command: `${rewritten} &` } };
            }
        }
    });

    // ─── Bootstrap injection ─────────────────────────────────────
    pi.on("context", async (event) => {
        if (!injectBootstrap) return;
        if (event.messages.some(messageContainsBootstrap)) return;
        const bootstrap = getBootstrapContent();
        if (!bootstrap) return;
        const insertAt = firstNonCompactionSummaryIndex(event.messages);
        const msg = { role: "user" as const, content: [{ type: "text" as const, text: bootstrap }], timestamp: Date.now() };
        return { messages: [...event.messages.slice(0, insertAt), msg, ...event.messages.slice(insertAt)] };
    });
}

function getBootstrapContent(): string | null {
    if (cachedBootstrap !== undefined) return cachedBootstrap;
    try {
        const raw = readFileSync(bootstrapSkillPath, "utf8");
        const body = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)?.[1]?.trim() ?? raw.trim();
        cachedBootstrap = `${BOOTSTRAP_MARKER}\n\nYou have superlite. Follow the using-superlite skill now.\n\n${body}\n\nThis extension registers tool_call gates: block-coordinator-edits, block-unsafe-kill, rewrite-test-runs.`;
        return cachedBootstrap;
    } catch { cachedBootstrap = null; return null; }
}

function messageContainsBootstrap(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
        if (typeof part !== "object" || part === null) return false;
        if (!("type" in part) || part.type !== "text") return false;
        if (!("text" in part) || typeof part.text !== "string") return false;
        return part.text.includes(BOOTSTRAP_MARKER);
    });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (typeof m === "object" && m !== null && "role" in m && m.role === "compactionSummary") i++;
        else break;
    }
    return i;
}
