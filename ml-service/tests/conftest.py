import os
import sys

# Ensure ml-service/ (the parent of this tests/ dir) is importable as "main",
# regardless of which directory `pytest` is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Must be set before `main` is imported anywhere: it guards the module-level
# HuggingFace/Ollama/Groq initialization so tests don't download real models
# or require a live Ollama/Groq endpoint.
os.environ.setdefault("AXIOM_SKIP_MODEL_INIT", "1")
