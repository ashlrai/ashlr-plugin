import asyncio, os
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

async def main():
    env = os.environ.copy()
    env["ASHLR_HOOK_TIMINGS"] = "0"
    params = StdioServerParameters(
        command="node",
        args=["scripts/bootstrap.mjs", "servers/_router.ts"],
        cwd=REPO,
        env=env,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f"connected · {len(names)} tools")
            print(", ".join(sorted(names)[:50]))

asyncio.run(main())
