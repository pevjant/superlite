import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BOOTSTRAP_MARKER = "superlite:using-superlite bootstrap for pi";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "../..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superlite", "SKILL.md");

let cachedBootstrap: string | null = undefined;
// Cache .superlite state for at most 2s (cheap re-read on rapid tool calls)
let stateCache: { at: number; hasSuperlite: boolean; hasStable: boolean; hasPrime: boolean; hasPool: boolean } | undefined;

function getState(cwd: string) {
    if (stateCache && Date.now() - stateCache.at < 2000) return stateCache;
    const slDir = resolve(cwd, ".superlite");
    const hasSuperlite = existsSync(slDir);
    stateCache = {
        at: Date.now(),
        hasSuperlite,
        hasStable: hasSuperlite && existsSync(resolve(slDir, "stable.json")),
        hasPrime: hasSuperlite && existsSync(resolve(slDir, "prime.md")),
        hasPool: hasSuperlite && existsSync(resolve(slDir, "pool.json")),
    };
    return stateCache;
}

function hasActiveRun(cwd: string): boolean {
    const s = getState(cwd);
    return s.hasStable || s.hasPrime || s.hasPool;
}

function isProtectedFile(path: string): boolean {
    return path.includes(".superlite/orchestrator.json") || path.includes(".superlite/human-replies.jsonl");
}

function isAllowedWriteTarget(path: string): boolean {
    return (
        path.includes("docs/plans/") ||
        path.includes("docs/") && path.endsWith(".md") ||
        /SPEC.*\.md$/.test(path) ||
        path.includes(".superlite/")
    );
}

const UNSAFE_KILL_PATTERNS = [
    /\bpkill\b/,
    /\bkillall\b/,
    /\bkill\s+-9\s+-1\b/,
    /\btaskkill\s+\/(IM|FI)\b/i,
    /\bStop-Process\s+-Name\b/i,
    /\bGet-Process\b.*\|.*\bStop-Process\b/i,
];

const TEST_COMMAND_PATTERNS = [
    /\bpytest\b/,
    /\bnpm\s+test\b/,
    /\bnpx\s+(vitest|jest)\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\bdotnet\s+test\b/,
];

export default function superlitePiExtension(pi: ExtensionAPI) {
    let injectBootstrap = true;

    pi.on("resources_discover", async () => ({
        skillPaths: [skillsDir],
    }));

    pi.on("session_start", async () => {
        injectBootstrap = true;
        stateCache = undefined;
    });

    pi.on("session_compact", async () => {
        injectBootstrap = true;
        stateCache = undefined;
    });

    pi.on("agent_end", async () => {
        injectBootstrap = false;
    });

    // ─── Gate 1: block-coordinator-edits ─────────────────────────────
    // Blocks the coordinator (main session, no agent_id) from writing
    // project code during an active superlite run.
    pi.on("tool_call", async (event) => {
        // Subagent calls always pass (they carry agent context)
        if (typeof event === "object" && event !== null && "agent_id" in event ? String(event.agent_id) : undefined) return;

        const toolName = typeof event === "object" && event !== null && "tool_name" in event && typeof event.tool_name === "string" ? event.tool_name : "";
        const input = typeof event === "object" && event !== null && "input" in event && typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {};
        const cwd = typeof event === "object" && event !== null && "cwd" in event && typeof event.cwd === "string" ? event.cwd : process.cwd();

        // Only guard during an active run
        if (!hasActiveRun(cwd)) return;

        // Rule 1: Protected files — always blocked
        const targetPath = input.path || input.file_path || input.notebook_path || "";
        if (targetPath && isProtectedFile(String(targetPath))) {
            return {
                block: true,
                reason: `superlite: ${String(targetPath).split("/").pop()} is written only by sl orchestrator/hooks, never by the model.`,
            };
        }

        // Rule 2: During active run, coordinator cannot write project code
        const isWriteTool = ["edit", "write", "notebook_edit", "apply_patch"].includes(toolName.toLowerCase());
        if (isWriteTool && targetPath) {
            const p = String(targetPath);
            if (!isAllowedWriteTarget(p)) {
                return {
                    block: true,
                    reason: `superlite: the coordinator does not write project code during an active run (found ${p}). Route edits to a fixer or implementer agent; allowed: docs/plans/**, SPEC*.md, .superlite/**.`,
                };
            }
        }

        // Rule 3: Bash write detection (best-effort)
        if (toolName.toLowerCase() === "bash" && input.command) {
            const cmd = String(input.command);
            // Check for redirect/tee to project files (heuristic)
            const writeMatch = cmd.match(/>{1,2}\s*(?!\/dev\/null|\bsl\b)[\w./-]+\.(kt|java|py|ts|js|xml|json|gradle)/);
            if (writeMatch && !isAllowedWriteTarget(writeMatch[1])) {
                return {
                    block: true,
                    reason: `superlite: bash writes to project code (${writeMatch[1]}) during an active run. Use a fixer agent.`,
                };
            }
        }

        return undefined;
    });

    // ─── Gate 2: block-unsafe-kill ───────────────────────────────────
    pi.on("tool_call", async (event) => {
        const toolName = typeof event === "object" && event !== null && "tool_name" in event && typeof event.tool_name === "string" ? event.tool_name : "";
        if (toolName.toLowerCase() !== "bash") return;

        const input = typeof event === "object" && event !== null && "input" in event && typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {};
        const cmd = String(input.command || "");

        for (const pat of UNSAFE_KILL_PATTERNS) {
            if (pat.test(cmd)) {
                return {
                    block: true,
                    reason: `superlite: killing processes by name or pattern is blocked (${pat.source}). Kill by PID from the run's own process list instead.`,
                };
            }
        }
        return undefined;
    });

    // ─── Gate 3: rewrite-test-runs ──────────────────────────────────
    // Rewrites raw test commands to background sl run_tests during active runs.
    pi.on("tool_call", async (event) => {
        if (typeof event === "object" && event !== null && "agent_id" in event ? String(event.agent_id) : undefined) return;

        const toolName = typeof event === "object" && event !== null && "tool_name" in event && typeof event.tool_name === "string" ? event.tool_name : "";
        if (toolName.toLowerCase() !== "bash") return;

        const cwd = typeof event === "object" && event !== null && "cwd" in event && typeof event.cwd === "string" ? event.cwd : process.cwd();
        if (!hasActiveRun(cwd)) return;

        const input = typeof event === "object" && event !== null && "input" in event && typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {};
        const cmd = String(input.command || "");

        // Already using sl run_tests
        if (cmd.includes("run_tests")) return;

        for (const pat of TEST_COMMAND_PATTERNS) {
            if (pat.test(cmd)) {
                const slPath = `bash "${resolve(skillsDir, "subagent-driven-development", "scripts", "sl")}"`;
                return {
                    input: {
                        ...input,
                        command: `${slPath} run_tests --full &`,
                    },
                };
            }
        }
        return undefined;
    });

    // ─── Bootstrap injection ─────────────────────────────────────────
    pi.on("context", async (event) => {
        if (!injectBootstrap) return;
        if (event.messages.some(messageContainsBootstrap)) return;

        const bootstrap = getBootstrapContent();
        if (!bootstrap) return;

        const bootstrapMessage = {
            role: "user" as const,
            content: [{ type: "text" as const, text: bootstrap }],
            timestamp: Date.now(),
        };

        const insertAt = firstNonCompactionSummaryIndex(event.messages);
        return {
            messages: [
                ...event.messages.slice(0, insertAt),
                bootstrapMessage,
                ...event.messages.slice(insertAt),
            ],
        };
    });
}

function getBootstrapContent(): string | null {
    if (cachedBootstrap !== undefined) return cachedBootstrap;
    try {
        const skillContent = readFileSync(bootstrapSkillPath, "utf8");
        const body = stripFrontmatter(skillContent);
        cachedBootstrap = `${BOOTSTRAP_MARKER}

You have superlite. Its 'superlite:using-superlite' skill follows and is already loaded for this Pi session. Follow it now. Do not try to load using-superlite again.

${body}

${piToolMapping()}`;
        return cachedBootstrap;
    } catch {
        cachedBootstrap = null;
        return null;
    }
}

function stripFrontmatter(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return (match ? match[1] : content).trim();
}

function piToolMapping(): string {
    return `## Pi tool mapping

Pi has native skills. When a superlite instruction says to invoke a skill, use Pi's native skill system: load the relevant \`SKILL.md\` with \`read\` when the skill applies.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`.

This extension registers tool_call gates equivalent to superlite's Claude Code hooks:
- **block-coordinator-edits**: during an active run, the coordinator cannot write project code (edit/write/bash-redirect to .kt/.java/.py/.ts/etc). Route edits to fixer agents.
- **block-unsafe-kill**: pkill/killall/taskkill /IM are blocked. Kill by PID from the run's process list.
- **rewrite-test-runs**: raw pytest/npm test/go test/cargo test commands are rewritten to background \`sl run_tests --full --wait\`.

For subagent dispatch, if a subagent tool is available, use it for superlite's agent dispatches. If not, do the work in this session (inline mode) or explain the missing capability.`;
}

function messageContainsBootstrap(message: unknown): boolean {
    const content = typeof message === "object" && message !== null && "content" in message ? message.content : undefined;
    if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
        return (
            part &&
            typeof part === "object" &&
            typeof part === "object" && part !== null && "type" in part ? part.type : undefined === "text" &&
            typeof typeof part === "object" && part !== null && "text" in part ? part.text : undefined === "string" &&
            typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "".includes(BOOTSTRAP_MARKER)
        );
    });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
    let index = 0;
    while (typeof messages[index] === "object" && messages[index] !== null && "role" in messages[index] ? (messages[index] as Record<string, unknown>).role : undefined === "compactionSummary") {
        index += 1;
    }
    return index;
}
