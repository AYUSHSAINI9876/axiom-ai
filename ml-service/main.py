import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
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
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.vector_stores.qdrant import QdrantVectorStore
from pydantic import BaseModel
import qdrant_client

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("axiom")

app = FastAPI(title="Axiom ML Service")

# No CORSMiddleware here: the browser only ever talks to the Go gateway,
# which is the single origin allowed to set CORS headers. If this service
# also set Access-Control-Allow-Origin, the gateway's reverse proxy would
# forward both headers to the browser, which rejects responses with
# duplicate/conflicting CORS headers.

QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
DATA_DIR = os.getenv("DATA_DIR", "./data/docs")
PERSIST_DIR = os.getenv("PERSIST_DIR", "./storage")
COLLECTION_NAME = "axiom_docs"

LLM_BACKEND = "groq" if GROQ_API_KEY else "ollama"
EMBED_MODEL_NAME = "BAAI/bge-large-en-v1.5"

# Guarded so tests can import this module and inject MockEmbedding/MockLLM
# without downloading real model weights or requiring Ollama/Groq to be reachable.
if os.getenv("AXIOM_SKIP_MODEL_INIT") != "1":
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding
    from llama_index.llms.groq import Groq
    from llama_index.llms.ollama import Ollama

    logger.info("Initializing embedding model: %s", EMBED_MODEL_NAME)
    Settings.embed_model = HuggingFaceEmbedding(model_name=EMBED_MODEL_NAME)

    if GROQ_API_KEY:
        logger.info("Initializing LLM: Llama 3 via Groq")
        Settings.llm = Groq(model="llama3-8b-8192", api_key=GROQ_API_KEY)
    else:
        logger.info("Initializing LLM: Llama 3 via Ollama (%s)", OLLAMA_BASE_URL)
        Settings.llm = Ollama(model="llama3", base_url=OLLAMA_BASE_URL, request_timeout=120.0)

index: VectorStoreIndex | None = None

SYSTEM_PROMPT = (
    "You are Axiom AI, a high-level technical research assistant specializing in scientific literature. "
    "Use the provided context to answer the user's query with extreme precision. "
    "If the answer is not in the context, say 'I do not have enough information in the provided documentation.' "
    "Maintain a professional, scientific tone. Cite the document sections if possible."
)


def _qdrant_vector_store() -> QdrantVectorStore:
    client = qdrant_client.QdrantClient(url=QDRANT_URL)
    return QdrantVectorStore(client=client, collection_name=COLLECTION_NAME)


def get_or_build_index() -> VectorStoreIndex:
    """Attach to a persisted index if one exists, otherwise build fresh from DATA_DIR.

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
    has_files = any(Path(DATA_DIR).iterdir())

    if has_files:
        documents = SimpleDirectoryReader(DATA_DIR).load_data()
        index = VectorStoreIndex.from_documents(
            documents, storage_context=storage_context, store_nodes_override=True, show_progress=True
        )
        logger.info("Built new index from %d document(s) in %s", len(documents), DATA_DIR)
    else:
        index = VectorStoreIndex.from_documents([], storage_context=storage_context, store_nodes_override=True)
        logger.info("Built empty index (no documents in %s yet)", DATA_DIR)

    os.makedirs(PERSIST_DIR, exist_ok=True)
    storage_context.persist(persist_dir=PERSIST_DIR)
    return index


def ensure_index() -> VectorStoreIndex:
    global index
    if index is None:
        get_or_build_index()
    return index


def build_hybrid_query_engine(streaming: bool) -> RetrieverQueryEngine:
    idx = ensure_index()
    vector_retriever = idx.as_retriever(similarity_top_k=5)
    bm25_retriever = BM25Retriever.from_defaults(docstore=idx.docstore, similarity_top_k=5)
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


def doc_count() -> int:
    if not os.path.isdir(DATA_DIR):
        return 0
    return sum(1 for p in Path(DATA_DIR).iterdir() if p.is_file())


class ChatMessage(BaseModel):
    role: str
    content: str


class QueryRequest(BaseModel):
    query: str
    history: list[ChatMessage] = []


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "llm_backend": LLM_BACKEND,
        "embedding_model": EMBED_MODEL_NAME,
        "index_ready": index is not None,
        "doc_count": doc_count(),
    }


@app.get("/documents")
async def list_documents():
    os.makedirs(DATA_DIR, exist_ok=True)
    docs = []
    for p in sorted(Path(DATA_DIR).iterdir()):
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
async def upload_document(file: UploadFile = File(...)):
    os.makedirs(DATA_DIR, exist_ok=True)
    dest = Path(DATA_DIR) / os.path.basename(file.filename)
    contents = await file.read()
    dest.write_bytes(contents)

    idx = ensure_index()
    new_docs = SimpleDirectoryReader(input_files=[str(dest)]).load_data()
    for doc in new_docs:
        idx.insert(doc)
    os.makedirs(PERSIST_DIR, exist_ok=True)
    idx.storage_context.persist(persist_dir=PERSIST_DIR)

    return {"message": "Document indexed", "filename": dest.name, "chunks_indexed": len(new_docs)}


@app.post("/chat")
async def chat(request: QueryRequest):
    if doc_count() == 0:
        raise HTTPException(status_code=400, detail="No documents indexed yet. Upload a document first.")

    query_engine = build_hybrid_query_engine(streaming=False)
    apply_prompt(query_engine, request.history)
    response = query_engine.query(request.query)

    return {
        "response": str(response),
        "source_nodes": [
            {
                "text": node.node.get_content()[:300],
                "score": node.score,
                "file": node.node.metadata.get("file_name"),
            }
            for node in response.source_nodes
        ],
    }


@app.post("/chat/stream")
async def chat_stream(request: QueryRequest):
    if doc_count() == 0:
        raise HTTPException(status_code=400, detail="No documents indexed yet. Upload a document first.")

    query_engine = build_hybrid_query_engine(streaming=True)
    apply_prompt(query_engine, request.history)

    def event_stream():
        try:
            response = query_engine.query(request.query)
            sources = [
                {
                    "text": node.node.get_content()[:300],
                    "score": node.score,
                    "file": node.node.metadata.get("file_name"),
                }
                for node in response.source_nodes
            ]
            for token in response.response_gen:
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
            yield f"data: {json.dumps({'type': 'sources', 'sources': sources})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:  # headers are already sent, so this must surface as an SSE event
            logger.exception("Error while streaming chat response")
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
