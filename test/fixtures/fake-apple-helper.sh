#!/bin/sh
# Stand-in for the Swift helper, used by test/apple.test.js. Same protocol: JSON in on stdin,
# one JSON line out. Its MODE:… prompts probe the sandbox it runs in. It uses only /bin/sh and
# macOS's own tools, so it starts inside the sandbox on any Mac, CI included.
if [ "$1" = "--status" ]; then echo '{"ok":true,"available":true,"contextSize":4096}'; exit 0; fi
input=$(cat)
has() { case "$input" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
reply() { printf '{"ok":true,"text":"%s"}\n' "$1"; exit 0; }
field() { printf '%s' "$input" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

if has 'MODE:context'; then echo '{"ok":false,"error":"context","tokens":9000,"limit":4096}'; exit 1; fi
if has 'MODE:fit'; then
  # Like a small model: requests over 6000 characters don't fit.
  n=$(printf '%s' "$input" | wc -c | tr -d ' ')
  if [ "$n" -gt 6000 ]; then echo '{"ok":false,"error":"context","tokens":9000,"limit":4096}'; exit 1; fi
  printf '{"ok":true,"text":"## Goal\\n\\nrequest length %s"}\n' "$n"; exit 0
fi
if has 'MODE:unavailable'; then echo '{"ok":false,"error":"unavailable","reason":"appleIntelligenceNotEnabled"}'; exit 1; fi
if has 'MODE:garbage'; then echo 'not json'; exit 0; fi
if has 'MODE:sleep'; then sleep 60; fi
if has 'MODE:env'; then reply "$(env | cut -d= -f1 | sort | tr '\n' ' ')"; fi
if has 'MODE:argv'; then reply "$*"; fi
if has 'MODE:write:'; then
  target=$(field prompt | sed 's/.*MODE:write://')
  if (echo x > "$target") 2>/dev/null; then reply allowed; else reply blocked; fi
fi
if has 'MODE:net:'; then
  port=$(field prompt | sed 's/.*MODE:net://')
  if /usr/bin/nc -z -w 2 127.0.0.1 "$port" 2>/dev/null; then reply allowed; else reply blocked; fi
fi
if has 'MODE:readhome'; then if ls "$HOME" >/dev/null 2>&1; then reply allowed; else reply blocked; fi; fi
if has '"schema"'; then echo '{"ok":true,"json":"{\"schemaType\":\"object\"}"}'; exit 0; fi
reply "echo:$(field system)|$(field prompt)"
