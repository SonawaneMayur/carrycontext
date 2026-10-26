#!/usr/bin/python3 -I
# Stand-in for the Swift helper, used by test/apple.test.js. It speaks the same protocol, and
# its MODE:… prompts probe the sandbox CarryContext runs it in (writes, network, home reads).
import json, os, pwd, socket, sys, time

def reply(obj):
    print(json.dumps(obj))
    sys.exit(0)

if "--status" in sys.argv:
    reply({"ok": True, "available": True, "contextSize": 4096})

request = json.loads(sys.stdin.read() or "{}")
prompt = request.get("prompt", "")

def attempt(fn):
    try:
        fn()
        return "allowed"
    except Exception as e:
        return "blocked:" + type(e).__name__

if "MODE:context" in prompt:
    reply({"ok": False, "error": "context", "tokens": 9000, "limit": 4096})
if "MODE:fit" in prompt:  # too long above 6000 characters, like a small model
    if len(prompt) > 6000:
        reply({"ok": False, "error": "context", "tokens": 9000, "limit": 4096})
    reply({"ok": True, "text": "## Goal\n\nprompt length %d" % len(prompt)})
if "MODE:unavailable" in prompt:
    reply({"ok": False, "error": "unavailable", "reason": "appleIntelligenceNotEnabled"})
if "MODE:garbage" in prompt:
    print("not json")
    sys.exit(0)
if "MODE:sleep" in prompt:
    time.sleep(60)
if "MODE:env" in prompt:
    reply({"ok": True, "text": json.dumps(sorted(os.environ.keys()))})
if "MODE:argv" in prompt:
    reply({"ok": True, "text": json.dumps(sys.argv[1:])})
if "MODE:write:" in prompt:
    target = prompt.split("MODE:write:")[1].strip()
    reply({"ok": True, "text": attempt(lambda: open(target, "w").write("x"))})
if "MODE:net:" in prompt:
    port = int(prompt.split("MODE:net:")[1].strip())
    reply({"ok": True, "text": attempt(lambda: socket.create_connection(("127.0.0.1", port), timeout=2))})
if "MODE:readhome" in prompt:
    home = pwd.getpwuid(os.getuid()).pw_dir
    reply({"ok": True, "text": attempt(lambda: os.listdir(home))})
if request.get("schema"):
    reply({"ok": True, "json": json.dumps({"schemaType": request["schema"].get("type")})})
reply({"ok": True, "text": "echo:%s|%s" % (request.get("system", ""), prompt)})
