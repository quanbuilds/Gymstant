#!/bin/zsh
clear
echo "GYMSTANT LIVE EXECUTION LOG"
echo "============================"
echo "Watching:"
echo "  • Gymstant conversation transcript"
echo "  • Hermes agent lifecycle"
echo "  • Hermes errors"
echo "  • Gymstant route and timing events"
echo
echo "Press Control-C to stop."
echo

mkdir -p "$HOME/Library/Application Support/gymstant/workflow-memory"
mkdir -p "$HOME/.hermes/profiles/gymstant/logs"
touch "$HOME/Library/Application Support/gymstant/workflow-memory/transcript.jsonl"
touch "$HOME/.hermes/profiles/gymstant/logs/agent.log"
touch "$HOME/.hermes/profiles/gymstant/logs/errors.log"
touch "$HOME/Library/Application Support/gymstant/workflow-memory/runtime.log"

tail -n 100 -F \
  "$HOME/Library/Application Support/gymstant/workflow-memory/transcript.jsonl" \
  "$HOME/.hermes/profiles/gymstant/logs/agent.log" \
  "$HOME/.hermes/profiles/gymstant/logs/errors.log" \
  "$HOME/Library/Application Support/gymstant/workflow-memory/runtime.log"
