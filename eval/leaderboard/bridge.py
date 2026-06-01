"""
bridge.py — drive a LOCAL open model (Ollama) through ashlr's MCP tools, for $0.

Foundation for getting ashlr onto an agent leaderboard (HAL/GAIA): proves a
local open-weight model can call ashlr's compressed Read/Grep/etc. MCP tools and
answer a repo question. Uses the official `mcp` Python SDK (stdio) + Ollama's
native tool-calling (/api/chat) — no paid APIs, minimal dependencies.
"""
import asyncio, json, os, sys
import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("ASHLR_EVAL_MODEL", "qwen2.5-coder:7b")
# Read-only subset exposed to the agent (safe, sufficient for code Q&A).
EXPOSE = {"ashlr__grep", "ashlr__read", "ashlr__ls", "ashlr__glob"}
TASK = ("Which source file defines the function findFuzzyMatch, and what are its two "
        "confidence thresholds — the minimum score and the uniqueness margin? "
        "Use the tools to find out; cite the file path.")

def to_ollama_tool(t):
    return {"type": "function", "function": {
        "name": t.name, "description": (t.description or "")[:1000],
        "parameters": t.inputSchema or {"type": "object", "properties": {}}}}

async def main():
    env = os.environ.copy(); env["ASHLR_HOOK_TIMINGS"] = "0"
    params = StdioServerParameters(command="node",
        args=["scripts/bootstrap.mjs", "servers/_router.ts"], cwd=REPO, env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            all_tools = (await session.list_tools()).tools
            tools = [t for t in all_tools if t.name in EXPOSE]
            ollama_tools = [to_ollama_tool(t) for t in tools]
            print(f"[bridge] {MODEL} · exposing {len(tools)} ashlr tools: {sorted(t.name for t in tools)}")

            messages = [
                {"role": "system", "content": "You are a code-exploration agent. Use the provided ashlr__ tools to inspect the repository. Call tools to gather evidence, then answer concisely with the file path and the two threshold values."},
                {"role": "user", "content": TASK},
            ]
            tool_calls_made, prompt_toks, eval_toks = [], 0, 0
            async with httpx.AsyncClient(timeout=600) as client:
                for step in range(8):
                    r = await client.post(f"{OLLAMA}/api/chat", json={
                        "model": MODEL, "messages": messages, "tools": ollama_tools, "stream": False})
                    r.raise_for_status(); data = r.json()
                    prompt_toks += data.get("prompt_eval_count", 0); eval_toks += data.get("eval_count", 0)
                    msg = data["message"]; messages.append(msg)
                    calls = msg.get("tool_calls") or []
                    if not calls:
                        print("\n[bridge] FINAL ANSWER:\n" + (msg.get("content") or "").strip())
                        break
                    for c in calls:
                        fn = c["function"]; name = fn["name"]
                        args = fn["arguments"] if isinstance(fn["arguments"], dict) else json.loads(fn["arguments"])
                        tool_calls_made.append((name, args))
                        print(f"[bridge] → {name}({json.dumps(args)[:120]})")
                        try:
                            res = await session.call_tool(name, args)
                            out = "".join(getattr(b, "text", "") for b in res.content)[:6000]
                        except Exception as e:
                            out = f"tool error: {e}"
                        messages.append({"role": "tool", "content": out})
                else:
                    print("[bridge] hit step cap without final answer")
            print(f"\n[bridge] tool calls: {len(tool_calls_made)} · tokens: prompt={prompt_toks} eval={eval_toks} total={prompt_toks+eval_toks}")

asyncio.run(main())
