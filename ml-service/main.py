import hmac
import json
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from llama_index.core import (
    PromptTemplate,
    Settings,
    SimpleDirectoryReader,
    StorageContext,
    VectorStoreIndex,
    load_index_from_storage,
)
from llama_index.core.query_engine import RetrieverQueryEngine
from llama_index.core.retrievers import QueryFusionRetriever
from llama_index.core.vector_stores import (
    FilterOperator,
    MetadataFilter,
    MetadataFilters,
)
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.vector_stores.qdrant import QdrantVectorStore
from pydantic import BaseModel
import qdrant_client

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("axiom")

# ---------------------------------------------------------------------------
# Gateway authentication
# ---------------------------------------------------------------------------
#
# This service has no user authentication: it trusts the X-Axiom-User-Id header
# the gateway sets from a verified JWT. That is safe only while the gateway is
# the sole thing that can reach it.
#
# On a private network (docker compose, a VPC) that holds by construction, and
# GATEWAY_SHARED_SECRET can stay unset. But some hosts — Render's free tier
# among them — only offer publicly-routable services, and there the ML service
# gets its own internet-facing URL. Anyone could then call it directly with a
# forged X-Axiom-User-Id and read any user's corpus.
#
# Setting GATEWAY_SHARED_SECRET on both services closes that: every proxied
# request must carry the matching key, so a direct call is rejected.
GATEWAY_SHARED_SECRET = os.getenv("GATEWAY_SHARED_SECRET") or None
GATEWAY_KEY_HEADER = "X-Axiom-Gateway-Key"

# Health stays open so a platform health check (which can't hold the secret)
# still works, and so the gateway can report backend status while signed out.
PUBLIC_PATHS = {"/health"}


async def require_gateway(request: Request) -> None:
    if GATEWAY_SHARED_SECRET is None or request.url.path in PUBLIC_PATHS:
        return
    presented = request.headers.get(GATEWAY_KEY_HEADER, "")
    # compare_digest rather than == so a wrong key can't be recovered a byte at
    # a time from response timing.
    if not hmac.compare_digest(presented, GATEWAY_SHARED_SECRET):
        raise HTTPException(status_code=403, detail="This service is only reachable through the Axiom gateway.")


app = FastAPI(title="Axiom ML Service", dependencies=[Depends(require_gateway)])

# No CORSMiddleware here: the browser only ever talks to the Go gateway,
# which is the single origin allowed to set CORS headers. If this service
# also set Access-Control-Allow-Origin, the gateway's reverse proxy would
# forward both headers to the browser, which rejects responses with
# duplicate/conflicting CORS headers.

def env(name: str, fallback: str) -> str:
    """Read an env var, treating an empty value as unset.

    os.getenv(name, fallback) only applies the fallback when the variable is
    absent, so a `.env` line like `EMBED_BACKEND=` yields "" and silently
    defeats the default. Every key in .env.example ships blank precisely so it
    can be filled in, and docker compose's own `${VAR:-default}` already treats
    empty as unset — this keeps the Python side agreeing with both.
    """
    return os.getenv(name) or fallback


QDRANT_URL = env("QDRANT_URL", "http://localhost:6333")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None
OLLAMA_BASE_URL = env("OLLAMA_BASE_URL", "http://localhost:11434")
GROQ_API_KEY = os.getenv("GROQ_API_KEY") or None
DATA_DIR = env("DATA_DIR", "./data/docs")
PERSIST_DIR = env("PERSIST_DIR", "./storage")

LLM_BACKEND = "groq" if GROQ_API_KEY else "ollama"


def default_llm_model(backend: str) -> str:
    """The model to ask for when LLM_MODEL is not set.

    Groq retired its hosted Llama models, so a "llama-3.x" id 404s there on a
    current account — which presented as every chat failing despite a valid key.
    gpt-oss-120b is the strongest general model Groq still serves, with a 131k
    context window that suits stuffing retrieved chunks into the prompt.

    Ollama's default stays llama3: that one is pulled locally and still valid.
    """
    return "openai/gpt-oss-120b" if backend == "groq" else "llama3"


LLM_MODEL = env("LLM_MODEL", default_llm_model(LLM_BACKEND))

# Two embedding backends, because the best local model is too heavy to deploy:
#
#   huggingface — BAAI/bge-large-en-v1.5 through sentence-transformers/torch.
#                 1024-dim and the best retrieval quality, but ~1.3GB of weights
#                 on top of a torch runtime. Opt in with docker-compose.full.yml.
#   fastembed   — the same BGE family as quantized ONNX, run through
#                 onnxruntime with no torch at all. ~130MB and a few hundred MB
#                 of RSS, which is what both `docker compose up` and the Render
#                 blueprint use.
#
# This module default stays huggingface so a bare `python main.py` gets the
# better model; compose and Render set EMBED_BACKEND=fastembed explicitly.
EMBED_BACKEND = env("EMBED_BACKEND", "huggingface").lower()
if EMBED_BACKEND == "fastembed":
    EMBED_MODEL_NAME = env("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
else:
    EMBED_MODEL_NAME = env("EMBED_MODEL", "BAAI/bge-large-en-v1.5")


def _collection_name() -> str:
    """Qdrant collection name, keyed to the embedding model.

    Vector dimensionality is fixed per collection (1024 for bge-large, 384 for
    bge-small), so switching backends against a shared name would make every
    upsert fail on a dimension mismatch. Encoding the model in the name means
    the two simply never meet.
    """
    override = os.getenv("QDRANT_COLLECTION")
    if override:
        return override
    slug = re.sub(r"[^a-z0-9]+", "_", EMBED_MODEL_NAME.lower()).strip("_")
    return f"axiom_{slug}"


COLLECTION_NAME = _collection_name()

# Guarded so tests can import this module and inject MockEmbedding/MockLLM
# without downloading real model weights or requiring Ollama/Groq to be reachable.
if os.getenv("AXIOM_SKIP_MODEL_INIT") != "1":
    if EMBED_BACKEND == "fastembed":
        from llama_index.embeddings.fastembed import FastEmbedEmbedding

        logger.info("Initializing embedding model: %s (fastembed/ONNX)", EMBED_MODEL_NAME)
        Settings.embed_model = FastEmbedEmbedding(model_name=EMBED_MODEL_NAME)
    else:
        from llama_index.embeddings.huggingface import HuggingFaceEmbedding

        logger.info("Initializing embedding model: %s (sentence-transformers)", EMBED_MODEL_NAME)
        Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL_NAME)

    if GROQ_API_KEY:
        from llama_index.llms.groq import Groq

        logger.info("Initializing LLM: %s via Groq", LLM_MODEL)
        Settings.llm = Groq(model=LLM_MODEL, api_key=GROQ_API_KEY)
    else:
        from llama_index.llms.ollama import Ollama

        logger.info("Initializing LLM: %s via Ollama (%s)", LLM_MODEL, OLLAMA_BASE_URL)
        Settings.llm = Ollama(model=LLM_MODEL, base_url=OLLAMA_BASE_URL, request_timeout=120.0)

index: VectorStoreIndex | None = None

SYSTEM_PROMPT = (
    "You are Axiom AI, a high-level technical research assistant specializing in scientific literature. "
    "Use the provided context to answer the user's query with extreme precision. "
    "If the answer is not in the context, say 'I do not have enough information in the provided documentation.' "
    "Maintain a professional, scientific tone. Cite the document sections if possible."
)

# ---------------------------------------------------------------------------
# Per-user scoping
# ---------------------------------------------------------------------------
#
# This service has no authentication of its own. It trusts the X-Axiom-User-Id
# header because the Go gateway is the only thing that can reach it, and the
# gateway strips any client-supplied copy of that header before setting its own
# from a verified JWT. Never expose this service directly to the internet.

USER_ID_KEY = "axiom_user_id"

# Used when the header is absent — a direct call during local development or
# from the test suite. It is a normal, fully isolated tenant, not a bypass:
# requests without a header see only this tenant's documents.
DEFAULT_USER_ID = "_local"

# Non-empty, filesystem-safe, and bounded. The gateway only ever sends
# "usr_<32 hex>", but this service must not depend on that to stay safe from
# path traversal — a header of "../../etc" would otherwise escape DATA_DIR.
_SAFE_USER_ID = re.compile(r"[^A-Za-z0-9_-]")


def normalize_user_id(raw: str | None) -> str:
    if not raw:
        return DEFAULT_USER_ID
    cleaned = _SAFE_USER_ID.sub("", raw)[:64]
    return cleaned or DEFAULT_USER_ID


def user_dir(user_id: str) -> Path:
    """The corpus directory for one user, seeded on first use.

    Files sitting directly in DATA_DIR are the starter corpus shipped with the
    repo. Copying them into a new user's directory means every fresh account
    has something to ask about immediately, while still owning its own copy —
    so a delete or re-index by one user can't affect another.
    """
    root = Path(DATA_DIR)
    directory = root / user_id
    if directory.exists():
        return directory

    directory.mkdir(parents=True, exist_ok=True)
    if root.exists():
        for entry in root.iterdir():
            if entry.is_file() and not entry.name.startswith("."):
                shutil.copy2(entry, directory / entry.name)
        logger.info("Seeded starter corpus for %s", user_id)
    return directory


def _qdrant_vector_store() -> QdrantVectorStore:
    client = qdrant_client.QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
    return QdrantVectorStore(client=client, collection_name=COLLECTION_NAME)


def _tag_documents(documents: list, user_id: str) -> list:
    """Stamp ownership onto every document before it is indexed.

    The key is excluded from both the embedded text and the LLM prompt: it is a
    routing detail, and leaving it in would put an opaque id into every vector
    and every context window for no retrieval benefit.
    """
    for doc in documents:
        doc.metadata[USER_ID_KEY] = user_id
        doc.excluded_embed_metadata_keys = list(
            set(getattr(doc, "excluded_embed_metadata_keys", []) or []) | {USER_ID_KEY}
        )
        doc.excluded_llm_metadata_keys = list(
            set(getattr(doc, "excluded_llm_metadata_keys", []) or []) | {USER_ID_KEY}
        )
    return documents


def get_or_build_index() -> VectorStoreIndex:
    """Attach to a persisted index if one exists, otherwise build fresh.

    Re-attaching (instead of always rebuilding from DATA_DIR) is what stops the
    same documents from being re-embedded and re-inserted into the persisted
    Qdrant collection on every container restart. The local PERSIST_DIR holds the
    docstore/index_store (needed for BM25 + node lookups); the vectors themselves
    live in Qdrant.
    """
    global index
    vector_store = _qdrant_vector_store()

    # store_nodes_override=True is required in both branches below: Qdrant
    # already stores node text itself, so by default LlamaIndex skips writing
    # nodes into the local docstore too (it assumes that would be redundant).
    # But BM25Retriever reads its corpus from the local docstore, not from
    # Qdrant, so without this flag the BM25 side of the hybrid retriever
    # would silently see an empty corpus.
    if os.path.isdir(PERSIST_DIR) and os.listdir(PERSIST_DIR):
        storage_context = StorageContext.from_defaults(vector_store=vector_store, persist_dir=PERSIST_DIR)
        index = load_index_from_storage(storage_context, store_nodes_override=True)
        logger.info("Attached to existing persisted index at %s", PERSIST_DIR)
        return index

    storage_context = StorageContext.from_defaults(vector_store=vector_store)
    os.makedirs(DATA_DIR, exist_ok=True)

    index = VectorStoreIndex.from_documents([], storage_context=storage_context, store_nodes_override=True)
    logger.info("Built empty index; per-user corpora are indexed on first access")

    os.makedirs(PERSIST_DIR, exist_ok=True)
    storage_context.persist(persist_dir=PERSIST_DIR)
    return index


def ensure_index() -> VectorStoreIndex:
    global index
    if index is None:
        get_or_build_index()
    return index


def user_nodes(idx: VectorStoreIndex, user_id: str) -> list:
    return [
        node
        for node in idx.docstore.docs.values()
        if node.metadata.get(USER_ID_KEY) == user_id
    ]


def sync_user_corpus(user_id: str) -> int:
    """Index any of the user's files that aren't in the docstore yet.

    Covers two cases the upload endpoint doesn't: the starter corpus copied in
    for a brand-new account, and files dropped straight into the data volume.
    Comparing by file name against already-indexed nodes is what keeps a
    restart from re-embedding — and therefore duplicating — the whole corpus.
    """
    idx = ensure_index()
    directory = user_dir(user_id)

    indexed = {
        node.metadata.get("file_name")
        for node in user_nodes(idx, user_id)
        if node.metadata.get("file_name")
    }
    pending = [
        path for path in sorted(directory.iterdir())
        if path.is_file() and path.name not in indexed
    ]
    if not pending:
        return 0

    documents = _tag_documents(
        SimpleDirectoryReader(input_files=[str(p) for p in pending]).load_data(), user_id
    )
    for doc in documents:
        idx.insert(doc)

    os.makedirs(PERSIST_DIR, exist_ok=True)
    idx.storage_context.persist(persist_dir=PERSIST_DIR)
    logger.info("Indexed %d new document(s) for %s", len(documents), user_id)
    return len(documents)


def build_hybrid_query_engine(user_id: str, streaming: bool) -> RetrieverQueryEngine:
    """Hybrid retriever scoped to one user's documents.

    Both halves have to be filtered independently, and they filter in different
    places: the dense side pushes a payload filter down into Qdrant, while
    BM25Retriever has no filter support at all and is instead constructed over
    only this user's nodes. Filtering one but not the other would leak
    another user's text into the answer through the unfiltered half.
    """
    idx = ensure_index()

    ownership = MetadataFilters(
        filters=[MetadataFilter(key=USER_ID_KEY, value=user_id, operator=FilterOperator.EQ)]
    )
    vector_retriever = idx.as_retriever(similarity_top_k=5, filters=ownership)

    nodes = user_nodes(idx, user_id)
    if not nodes:
        # BM25Retriever raises on an empty corpus. The dense retriever alone is
        # the correct degenerate case — it will simply return nothing.
        return RetrieverQueryEngine.from_args(vector_retriever, streaming=streaming)

    bm25_retriever = BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=5)
    fusion_retriever = QueryFusionRetriever(
        [vector_retriever, bm25_retriever],
        similarity_top_k=5,
        # num_queries=1 disables LLM-based query expansion, keeping latency/cost predictable.
        num_queries=1,
        mode="reciprocal_rerank",
        use_async=False,
    )
    return RetrieverQueryEngine.from_args(fusion_retriever, streaming=streaming)


def apply_prompt(query_engine: RetrieverQueryEngine, history: list["ChatMessage"]) -> None:
    system_prompt = SYSTEM_PROMPT
    if history:
        recent = history[-6:]
        transcript = "\n".join(f"{m.role.capitalize()}: {m.content}" for m in recent)
        system_prompt += f"\n\nPrevious conversation:\n{transcript}"

    template = PromptTemplate(system_prompt + "\n\nContext:\n{context_str}\n\nQuery: {query_str}\n\nAnswer:")
    query_engine.update_prompts({"response_synthesizer:text_qa_template": template})


def describe_backend_failure(exc: Exception) -> str:
    """Turn a backend failure into something the reader can act on.

    Generation errors surface in the chat bubble, and the raw driver text
    ("failed to allocate CPU_REPACK buffer", a bare ConnectionError) reads as
    "the app is broken" rather than naming the one thing that needs fixing.
    These three account for essentially every local failure.
    """
    detail = str(exc)
    lowered = detail.lower()

    if LLM_BACKEND == "ollama":
        if any(k in lowered for k in ("connection", "connect", "refused", "timed out", "timeout")):
            return (
                f"Cannot reach Ollama at {OLLAMA_BASE_URL}. Start it with `ollama serve`, "
                f"or set GROQ_API_KEY to use a hosted model instead."
            )
        if "not found" in lowered or "no such model" in lowered or "pull" in lowered:
            return f"Ollama does not have the model '{LLM_MODEL}'. Run `ollama pull {LLM_MODEL}`."
        if any(k in lowered for k in ("memory", "allocate", "buffer", "oom")):
            return (
                f"Ollama could not load '{LLM_MODEL}' — not enough free memory. "
                f"Use a smaller model (set LLM_MODEL=llama3.2:3b and run "
                f"`ollama pull llama3.2:3b`), or set GROQ_API_KEY to offload generation."
            )
    elif "api" in lowered and ("key" in lowered or "auth" in lowered or "401" in lowered):
        return "Groq rejected the API key. Check GROQ_API_KEY."

    return f"The language model failed to respond: {detail}"


def doc_count(user_id: str) -> int:
    directory = Path(DATA_DIR) / user_id
    if not directory.is_dir():
        return 0
    return sum(1 for p in directory.iterdir() if p.is_file())


def _serialize_sources(response) -> list[dict]:
    return [
        {
            "text": node.node.get_content()[:300],
            "score": node.score,
            "file": node.node.metadata.get("file_name"),
        }
        for node in response.source_nodes
    ]


class ChatMessage(BaseModel):
    role: str
    content: str


class QueryRequest(BaseModel):
    query: str
    history: list[ChatMessage] = []


@app.get("/health")
async def health(x_axiom_user_id: str | None = Header(default=None)):
    user_id = normalize_user_id(x_axiom_user_id)
    # Touch the directory so a freshly-created account reports its seeded
    # starter corpus rather than 0 until something else triggers the seeding.
    user_dir(user_id)
    return {
        "status": "ok",
        "llm_backend": LLM_BACKEND,
        "llm_model": LLM_MODEL,
        "embedding_model": EMBED_MODEL_NAME,
        "embed_backend": EMBED_BACKEND,
        "index_ready": index is not None,
        "doc_count": doc_count(user_id),
    }


@app.get("/documents")
async def list_documents(x_axiom_user_id: str | None = Header(default=None)):
    user_id = normalize_user_id(x_axiom_user_id)
    directory = user_dir(user_id)

    docs = []
    for p in sorted(directory.iterdir()):
        if p.is_file():
            stat = p.stat()
            docs.append(
                {
                    "name": p.name,
                    "size_bytes": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )
    return {"documents": docs}


@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    x_axiom_user_id: str | None = Header(default=None),
):
    user_id = normalize_user_id(x_axiom_user_id)
    directory = user_dir(user_id)

    # basename strips any directory component in the client-supplied filename,
    # so "../../etc/passwd" writes to "passwd" inside the user's own directory.
    filename = os.path.basename(file.filename or "")
    if not filename:
        raise HTTPException(status_code=400, detail="A filename is required.")

    dest = directory / filename
    contents = await file.read()
    dest.write_bytes(contents)

    idx = ensure_index()
    new_docs = _tag_documents(SimpleDirectoryReader(input_files=[str(dest)]).load_data(), user_id)
    for doc in new_docs:
        idx.insert(doc)
    os.makedirs(PERSIST_DIR, exist_ok=True)
    idx.storage_context.persist(persist_dir=PERSIST_DIR)

    return {"message": "Document indexed", "filename": dest.name, "chunks_indexed": len(new_docs)}


@app.delete("/documents/{name}")
async def delete_document(name: str, x_axiom_user_id: str | None = Header(default=None)):
    user_id = normalize_user_id(x_axiom_user_id)
    directory = user_dir(user_id)

    target = directory / os.path.basename(name)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="No such document.")
    target.unlink()

    # Drop the file's nodes from Qdrant *and* the local docstore. delete_nodes
    # defaults to delete_from_docstore=False, which would clear the vectors but
    # leave the nodes in the docstore — and BM25Retriever reads its corpus from
    # exactly there, so the deleted file would keep coming back as a citation
    # through the keyword half of the hybrid retriever.
    idx = ensure_index()
    stale = [
        node.node_id
        for node in user_nodes(idx, user_id)
        if node.metadata.get("file_name") == target.name
    ]
    if stale:
        try:
            idx.delete_nodes(stale, delete_from_docstore=True)
        except Exception:  # noqa: BLE001 - the file is already gone; don't 500 the request
            logger.exception("Failed to delete nodes for %s", target.name)
        os.makedirs(PERSIST_DIR, exist_ok=True)
        idx.storage_context.persist(persist_dir=PERSIST_DIR)

    return {"message": "Document removed", "filename": target.name, "nodes_removed": len(stale)}


@app.post("/chat")
async def chat(request: QueryRequest, x_axiom_user_id: str | None = Header(default=None)):
    user_id = normalize_user_id(x_axiom_user_id)
    # Sync before counting: for a brand-new account this is what seeds the
    # starter corpus, so a first-ever message doesn't fail with "no documents"
    # depending on whether the client happened to list documents first.
    sync_user_corpus(user_id)
    if doc_count(user_id) == 0:
        raise HTTPException(status_code=400, detail="No documents indexed yet. Upload a document first.")

    query_engine = build_hybrid_query_engine(user_id, streaming=False)
    apply_prompt(query_engine, request.history)
    try:
        response = query_engine.query(request.query)
    except Exception as exc:  # noqa: BLE001 - reported to the caller, not swallowed
        logger.exception("Error while answering chat request")
        raise HTTPException(status_code=502, detail=describe_backend_failure(exc)) from exc

    return {"response": str(response), "source_nodes": _serialize_sources(response)}


@app.post("/chat/stream")
async def chat_stream(request: QueryRequest, x_axiom_user_id: str | None = Header(default=None)):
    user_id = normalize_user_id(x_axiom_user_id)
    # See the note in chat(): seeding has to happen before the count.
    sync_user_corpus(user_id)
    if doc_count(user_id) == 0:
        raise HTTPException(status_code=400, detail="No documents indexed yet. Upload a document first.")

    query_engine = build_hybrid_query_engine(user_id, streaming=True)
    apply_prompt(query_engine, request.history)

    def event_stream():
        try:
            response = query_engine.query(request.query)
            sources = _serialize_sources(response)
            for token in response.response_gen:
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:  # headers are already sent, so this must surface as an SSE event
            logger.exception("Error while streaming chat response")
            message = describe_backend_failure(exc)
            yield f"data: {json.dumps({'type': 'error', 'message': message})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
