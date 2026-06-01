import json, sys, httpx
OLLAMA="http://localhost:11434"
tool=[{"type":"function","function":{"name":"get_weather","description":"Get weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]
for model in ["qwen2.5:72b-instruct-q4_K_M","qwen2.5-coder:7b","qwen3:32b"]:
    body={"model":model,"messages":[{"role":"user","content":"What's the weather in Paris? Use the tool."}],"tools":tool,"stream":False}
    try:
        r=httpx.post(f"{OLLAMA}/api/chat",json=body,timeout=300); m=r.json().get("message",{})
        print(f"{model}: keys={list(m.keys())} tool_calls={m.get('tool_calls')} content={(m.get('content') or '')[:80]!r}")
    except Exception as e:
        print(f"{model}: ERROR {e}")
