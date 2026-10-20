import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BOOTSTRAP_MARKER = "superlite:using-superlite bootstrap for pi";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "../..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superlite", "SKILL.md");
const hooksDir = resolve(packageRoot, "hooks");

// ─── Thin adapter: OMP tool_call → 원본 bash hook 재사용 ───
// OMP event를 Claude Code hook이 기대하는 stdin JSON으로 변환해
// 원본 hooks 스크립트를 그대로 실행. 전체 정책(승인 게이트 포함) 보존.

// 도구명 매핑: omp lowercase → Claude Code PascalCase
const TOOL_NAME_MAP: Record<string, string> = {
    edit: "Edit", write: "Write", apply_patch: "MultiEdit",
    bash: "Bash", shell: "Bash", task: "Task",
};

function buildHookInput(event: ToolCallEvent, ctx: ExtensionContext): string {
    const ompTool = event.toolName?.toLowerCase() ?? "";
    const ccTool = TOOL_NAME_MAP[ompTool] ?? event.toolName ?? "";
    const input = event.input ?? {};

    // OMP input → Claude Code tool_input 키 매핑
    const toolInput: Record<string, unknown> = {};
    if (typeof input.command === "string") toolInput.command = input.command;
    if (typeof input.path === "string") toolInput.file_path = input.path;
    if (typeof input.file_path === "string") toolInput.file_path = input.file_path;
    if (typeof input.notebook_path === "string") toolInput.notebook_path = input.notebook_path;
    // omp tool-event-input.ts:73-82 — 다중 파일 edit는 paths 배열로 제공
    // 다중 파일(paths 배열)은 각 경로마다 hook을 별도 실행해야 함

    // 서브에이전트면 agent_id 필드 존재 (원본 hooks가 이걸 확인)
    const isSub = ctx.agent?.kind === "sub";

    return JSON.stringify({
        tool_name: ccTool,
        tool_input: toolInput,
        cwd: ctx.cwd,
        ...(isSub ? { agent_id: ctx.agent?.id ?? "sub" } : {}),
        ...(ctx.agent?.name ? { subagent_type: ctx.agent.name } : {}),
    });
}

interface HookResult {
    blocked: boolean;
    reason?: string;
    modifiedCommand?: string;
    runInBackground?: boolean;
}

function runHook(hookName: string, event: ToolCallEvent, ctx: ExtensionContext): HookResult | null {
    const hookPath = resolve(hooksDir, hookName);
    if (!existsSync(hookPath)) return null;

    // 다중 파일: 각 경로마다 hook 실행, 하나라도 차단하면 전체 차단
    const input = event.input ?? {};
    if (Array.isArray(input.paths) && input.paths.every((p) => typeof p === "string")) {
        for (const p of input.paths) {
            const singleEvent = { ...event, input: { ...input, path: p } } as ToolCallEvent;
            const single = execHook(hookPath, singleEvent, ctx);
            if (single?.blocked) return single;
        }
        return { blocked: false };
    }

    const stdin = buildHookInput(event, ctx);
    return execHook(hookPath, event, ctx);
}

function execHook(hookPath: string, event: ToolCallEvent, ctx: ExtensionContext): HookResult {
    const stdin = buildHookInput(event, ctx);
    try {
        const stdout = execFileSync("/opt/homebrew/bin/bash", [hookPath], {
            input: stdin,
            encoding: "utf8",
            timeout: 5000,
            cwd: ctx.cwd,
        }).trim();

        if (stdout.startsWith("{")) {
            try {
                const parsed = JSON.parse(stdout) as {
                    hookSpecificOutput?: {
                        updatedInput?: { command?: string; run_in_background?: boolean };
                    };
                };
                const updated = parsed.hookSpecificOutput?.updatedInput;
                if (updated?.command) {
                    return { blocked: false, modifiedCommand: updated.command, runInBackground: updated.run_in_background === true };
                }
            } catch { /* not JSON */ }
        }
        return { blocked: false };
    } catch (err) {
        if (err && typeof err === "object" && "status" in err) {
            if ((err as { status: number }).status === 2) {
                const stderr = (err as { stderr?: string }).stderr?.trim();
                return { blocked: true, reason: stderr ?? "superlite gate" };
            }
        }
        return { blocked: false };
    }
}

// ─── Extension ───

let cachedBootstrap: string | null = undefined;

export default function superlitePiExtension(pi: ExtensionAPI) {
    let injectBootstrap = true;

    pi.on("resources_discover", async () => ({ skillPaths: [skillsDir] }));
    pi.on("session_start", async () => { injectBootstrap = true; });
    pi.on("session_compact", async () => { injectBootstrap = true; });
    pi.on("agent_end", async () => { injectBootstrap = false; });

    // ─── Gates: 원본 bash hooks를 어댑터로 재사용 ───
    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
        // 순서는 원본 hooks.json과 동일
        // 1. block-unsafe-kill (전 에이전트, 항상)
        const kill = runHook("block-unsafe-kill", event, ctx);
        if (kill?.blocked) return { block: true, reason: kill.reason };

        // 2. block-coordinator-edits (coordinator만, 승인 게이트 포함)
        const edit = runHook("block-coordinator-edits", event, ctx);
        if (edit?.blocked) return { block: true, reason: edit.reason };

        // 3. rewrite-test-runs (coordinator만, 활성 런 중)
        const rewrite = runHook("rewrite-test-runs", event, ctx);
        if (rewrite?.modifiedCommand) {
            const input = event.input ?? {};
            const revised: Record<string, unknown> = { ...input, command: rewrite.modifiedCommand };
            if (rewrite.runInBackground) revised.async = true; // omp bash async
            return { input: revised };
        }

        // 차단도 재작성도 아니면 통과
    });

    // ─── Bootstrap injection ───
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

// ─── Helpers ───

function getBootstrapContent(): string | null {
    if (cachedBootstrap !== undefined) return cachedBootstrap;
    try {
        const raw = readFileSync(bootstrapSkillPath, "utf8");
        const body = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)?.[1]?.trim() ?? raw.trim();
        cachedBootstrap = `${BOOTSTRAP_MARKER}\n\nYou have superlite. Follow the using-superlite skill now.\n\n${body}\n\nGates are enforced by the original bash hooks via a thin adapter.`;
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
