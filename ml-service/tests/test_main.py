import pytest
import qdrant_client
from fastapi.testclient import TestClient
from llama_index.core import Settings
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.llms import MockLLM

import main


@pytest.fixture(autouse=True)
def isolated_environment(tmp_path, monkeypatch):
    """Give every test a private, in-memory index instead of the real
    HuggingFace/Qdrant/Ollama stack, so the suite is fast and hermetic."""
    Settings.embed_model = MockEmbedding(embed_dim=384)
    Settings.llm = MockLLM()

    data_dir = tmp_path / "docs"
    data_dir.mkdir()
    monkeypatch.setattr(main, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(main, "PERSIST_DIR", str(tmp_path / "storage"))
    monkeypatch.setattr(main, "index", None)

    # A single shared in-memory Qdrant client for the lifetime of the test, so
    # repeated calls to get_or_build_index() don't each spin up an empty store.
    shared_client = qdrant_client.QdrantClient(location=":memory:")
    monkeypatch.setattr(
        main,
        "_qdrant_vector_store",
        lambda: main.QdrantVectorStore(client=shared_client, collection_name=main.COLLECTION_NAME),
    )


@pytest.fixture
def client():
    return TestClient(main.app)


def test_health_reports_zero_documents_initially(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["doc_count"] == 0
    assert body["llm_backend"] in ("groq", "ollama")


def test_chat_without_documents_returns_400_not_500(client):
    resp = client.post("/chat", json={"query": "hello"})
    assert resp.status_code == 400


def test_upload_then_chat_retrieves_uploaded_content(client):
    """End-to-end regression test for the hybrid retriever: exercises the same
    BM25Retriever + QueryFusionRetriever code path added to fix the bug where
    hybrid search was built but never actually used."""
    content = (
        b"Axiom AI regression marker: the phrase QUARTZ-NINE-PROTOCOL only "
        b"appears in this test document and nowhere else in the corpus."
    )
    upload_resp = client.post("/upload", files={"file": ("marker.txt", content, "text/plain")})
    assert upload_resp.status_code == 200
    assert upload_resp.json()["filename"] == "marker.txt"

    docs_resp = client.get("/documents")
    assert docs_resp.status_code == 200
    assert "marker.txt" in [d["name"] for d in docs_resp.json()["documents"]]

    health_resp = client.get("/health")
    assert health_resp.json()["doc_count"] == 1

    chat_resp = client.post("/chat", json={"query": "QUARTZ-NINE-PROTOCOL"})
    assert chat_resp.status_code == 200
    body = chat_resp.json()
    assert len(body["source_nodes"]) > 0
    assert any("QUARTZ-NINE-PROTOCOL" in node["text"] for node in body["source_nodes"])
    assert any(node["file"] == "marker.txt" for node in body["source_nodes"])


def test_chat_stream_emits_token_sources_and_done_events(client):
    content = b"Streaming test document about the fictional element Unobtainium-42."
    client.post("/upload", files={"file": ("stream_doc.txt", content, "text/plain")})

    with client.stream("POST", "/chat/stream", json={"query": "Unobtainium-42"}) as resp:
        assert resp.status_code == 200
        raw = "".join(resp.iter_text())

    assert '"type": "sources"' in raw
    assert '"type": "done"' in raw
    assert "stream_doc.txt" in raw


def test_chat_history_is_included_without_crashing(client):
    content = b"Context document for a multi-turn conversation test."
    client.post("/upload", files={"file": ("history_doc.txt", content, "text/plain")})

    resp = client.post(
        "/chat",
        json={
            "query": "And what about that?",
            "history": [
                {"role": "user", "content": "Tell me about the context document."},
                {"role": "assistant", "content": "It's a short test document."},
            ],
        },
    )
    assert resp.status_code == 200
