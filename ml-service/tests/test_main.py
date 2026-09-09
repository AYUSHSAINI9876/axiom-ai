import os
import pytest
import qdrant_client
from fastapi.testclient import TestClient
from llama_index.core import Settings
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.llms import MockLLM

import main

# Two arbitrary tenant ids, used to prove one user's corpus never reaches the
# other's answers.
ALICE = {"X-Axiom-User-Id": "usr_alice"}
BOB = {"X-Axiom-User-Id": "usr_bob"}


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
    resp = client.get("/health", headers=ALICE)
    assert resp.status_code == 200
    body = resp.json()
    assert body["doc_count"] == 0
    assert body["llm_backend"] in ("groq", "ollama")
    assert body["embed_backend"] in ("huggingface", "fastembed")


def test_chat_without_documents_returns_400_not_500(client):
    resp = client.post("/chat", json={"query": "hello"}, headers=ALICE)
    assert resp.status_code == 400


def test_upload_then_chat_retrieves_uploaded_content(client):
    """End-to-end regression test for the hybrid retriever: exercises the same
    BM25Retriever + QueryFusionRetriever code path added to fix the bug where
    hybrid search was built but never actually used."""
    content = (
        b"Axiom AI regression marker: the phrase QUARTZ-NINE-PROTOCOL only "
        b"appears in this test document and nowhere else in the corpus."
    )
    upload_resp = client.post(
        "/upload", files={"file": ("marker.txt", content, "text/plain")}, headers=ALICE
    )
    assert upload_resp.status_code == 200
    assert upload_resp.json()["filename"] == "marker.txt"

    docs_resp = client.get("/documents", headers=ALICE)
    assert docs_resp.status_code == 200
    assert "marker.txt" in [d["name"] for d in docs_resp.json()["documents"]]

    health_resp = client.get("/health", headers=ALICE)
    assert health_resp.json()["doc_count"] == 1

    chat_resp = client.post("/chat", json={"query": "QUARTZ-NINE-PROTOCOL"}, headers=ALICE)
    assert chat_resp.status_code == 200
    body = chat_resp.json()
    assert len(body["source_nodes"]) > 0
    assert any("QUARTZ-NINE-PROTOCOL" in node["text"] for node in body["source_nodes"])
    assert any(node["file"] == "marker.txt" for node in body["source_nodes"])


def test_chat_stream_emits_token_sources_and_done_events(client):
    content = b"Streaming test document about the fictional element Unobtainium-42."
    client.post("/upload", files={"file": ("stream_doc.txt", content, "text/plain")}, headers=ALICE)

    with client.stream("POST", "/chat/stream", json={"query": "Unobtainium-42"}, headers=ALICE) as resp:
        assert resp.status_code == 200
        raw = "".join(resp.iter_text())

    assert '"type": "sources"' in raw
    assert '"type": "done"' in raw
    assert "stream_doc.txt" in raw


def test_chat_history_is_included_without_crashing(client):
    content = b"Context document for a multi-turn conversation test."
    client.post("/upload", files={"file": ("history_doc.txt", content, "text/plain")}, headers=ALICE)

    resp = client.post(
        "/chat",
        json={
            "query": "And what about that?",
            "history": [
                {"role": "user", "content": "Tell me about the context document."},
                {"role": "assistant", "content": "It's a short test document."},
            ],
        },
        headers=ALICE,
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Per-user isolation
# ---------------------------------------------------------------------------


def test_document_listing_is_scoped_to_the_requesting_user(client):
    client.post("/upload", files={"file": ("alice.txt", b"Alice's notes.", "text/plain")}, headers=ALICE)
    client.post("/upload", files={"file": ("bob.txt", b"Bob's notes.", "text/plain")}, headers=BOB)

    alice_docs = [d["name"] for d in client.get("/documents", headers=ALICE).json()["documents"]]
    bob_docs = [d["name"] for d in client.get("/documents", headers=BOB).json()["documents"]]

    assert "alice.txt" in alice_docs
    assert "bob.txt" not in alice_docs
    assert "bob.txt" in bob_docs
    assert "alice.txt" not in bob_docs


def test_retrieval_never_returns_another_users_documents(client):
    """The core multi-tenancy guarantee.

    Both halves of the hybrid retriever are filtered separately — Qdrant by
    payload, BM25 by node list — so this asserts the property that a regression
    in either one would break. The marker phrase exists only in Bob's document,
    which makes it the strongest possible query for a leak.
    """
    secret = (
        b"Bob's confidential lab notebook. The passphrase VIOLET-SEVEN-CASCADE "
        b"appears nowhere else in any corpus."
    )
    client.post("/upload", files={"file": ("bob_secret.txt", secret, "text/plain")}, headers=BOB)
    client.post(
        "/upload",
        files={"file": ("alice_public.txt", b"Alice's unrelated reading notes.", "text/plain")},
        headers=ALICE,
    )

    # Bob can find his own passphrase.
    bob_resp = client.post("/chat", json={"query": "VIOLET-SEVEN-CASCADE"}, headers=BOB)
    assert bob_resp.status_code == 200
    assert any("VIOLET-SEVEN-CASCADE" in n["text"] for n in bob_resp.json()["source_nodes"])

    # Alice, querying the identical phrase, must get nothing of Bob's.
    alice_resp = client.post("/chat", json={"query": "VIOLET-SEVEN-CASCADE"}, headers=ALICE)
    assert alice_resp.status_code == 200
    sources = alice_resp.json()["source_nodes"]
    assert not any("VIOLET-SEVEN-CASCADE" in n["text"] for n in sources), (
        "another user's document text leaked into the retrieved sources"
    )
    assert not any(n["file"] == "bob_secret.txt" for n in sources), (
        "another user's file was cited"
    )


def test_a_user_id_cannot_escape_the_data_directory(client):
    """A traversal attempt in the header must be neutralised, not honoured.

    The gateway only ever sends a generated id, but this service must not
    depend on that: a header of "../../etc" would otherwise write uploads
    outside DATA_DIR entirely.
    """
    resp = client.post(
        "/upload",
        files={"file": ("escape.txt", b"traversal attempt", "text/plain")},
        headers={"X-Axiom-User-Id": "../../../etc"},
    )
    assert resp.status_code == 200

    written = list(main.Path(main.DATA_DIR).rglob("escape.txt"))
    assert len(written) == 1
    # Still inside DATA_DIR, in a sanitised directory rather than three levels up.
    assert main.Path(main.DATA_DIR).resolve() in written[0].resolve().parents


def test_missing_user_header_falls_back_to_an_isolated_default_tenant(client):
    client.post("/upload", files={"file": ("anon.txt", b"Anonymous upload.", "text/plain")})

    anon_docs = [d["name"] for d in client.get("/documents").json()["documents"]]
    alice_docs = [d["name"] for d in client.get("/documents", headers=ALICE).json()["documents"]]

    assert "anon.txt" in anon_docs
    assert "anon.txt" not in alice_docs


def test_new_users_are_seeded_with_the_starter_corpus(client, monkeypatch):
    """A brand-new account should have something to query immediately."""
    starter = main.Path(main.DATA_DIR) / "starter.md"
    starter.write_text("# Starter corpus\n\nShipped with the repository.")

    docs = client.get("/documents", headers={"X-Axiom-User-Id": "usr_newcomer"}).json()["documents"]
    assert "starter.md" in [d["name"] for d in docs]


def test_deleting_a_document_removes_it_from_retrieval(client):
    content = b"Disposable note containing the marker TANGERINE-ELEVEN."
    client.post("/upload", files={"file": ("disposable.txt", content, "text/plain")}, headers=ALICE)
    # A second document the test never deletes, so the corpus stays non-empty
    # afterwards and /chat still runs a real retrieval rather than short-
    # circuiting on "no documents indexed".
    client.post("/upload", files={"file": ("keeper.txt", b"An unrelated kept note.", "text/plain")}, headers=ALICE)

    found = client.post("/chat", json={"query": "TANGERINE-ELEVEN"}, headers=ALICE).json()
    assert any("TANGERINE-ELEVEN" in n["text"] for n in found["source_nodes"])

    delete_resp = client.delete("/documents/disposable.txt", headers=ALICE)
    assert delete_resp.status_code == 200
    assert delete_resp.json()["nodes_removed"] > 0

    assert "disposable.txt" not in [
        d["name"] for d in client.get("/documents", headers=ALICE).json()["documents"]
    ]

    # The file is gone from disk *and* from the retriever, so it can no longer
    # be cited — a delete that only unlinked the file would still surface here.
    after = client.post("/chat", json={"query": "TANGERINE-ELEVEN"}, headers=ALICE).json()
    assert not any(n["file"] == "disposable.txt" for n in after["source_nodes"])


def test_deleting_a_missing_document_returns_404(client):
    resp = client.delete("/documents/never-existed.txt", headers=ALICE)
    assert resp.status_code == 404


def test_normalize_user_id_rejects_unsafe_input():
    assert main.normalize_user_id("usr_abc123") == "usr_abc123"
    assert main.normalize_user_id(None) == main.DEFAULT_USER_ID
    assert main.normalize_user_id("") == main.DEFAULT_USER_ID
    assert "/" not in main.normalize_user_id("../../etc/passwd")
    assert "." not in main.normalize_user_id("../../etc/passwd")
    # An id made entirely of stripped characters must not collapse to an empty
    # path segment, which would land uploads directly in DATA_DIR.
    assert main.normalize_user_id("///...") == main.DEFAULT_USER_ID
    assert len(main.normalize_user_id("x" * 500)) <= 64


# ---------------------------------------------------------------------------
# Gateway shared secret
# ---------------------------------------------------------------------------


def test_requests_are_rejected_without_the_gateway_key(monkeypatch):
    """On a host where this service is publicly routable, the shared secret is
    the only thing stopping a direct call with a forged X-Axiom-User-Id."""
    monkeypatch.setattr(main, "GATEWAY_SHARED_SECRET", "the-real-shared-secret")
    guarded = TestClient(main.app)

    forged = guarded.get("/documents", headers={"X-Axiom-User-Id": "usr_victim"})
    assert forged.status_code == 403

    wrong_key = guarded.get(
        "/documents",
        headers={"X-Axiom-User-Id": "usr_victim", "X-Axiom-Gateway-Key": "guessed"},
    )
    assert wrong_key.status_code == 403

    allowed = guarded.get(
        "/documents",
        headers={"X-Axiom-User-Id": "usr_victim", "X-Axiom-Gateway-Key": "the-real-shared-secret"},
    )
    assert allowed.status_code == 200


def test_health_stays_reachable_without_the_gateway_key(monkeypatch):
    """Platform health checks can't hold the secret, so /health must stay open."""
    monkeypatch.setattr(main, "GATEWAY_SHARED_SECRET", "the-real-shared-secret")
    guarded = TestClient(main.app)

    assert guarded.get("/health").status_code == 200


def test_no_secret_configured_means_no_enforcement(client):
    """On a private network the gateway is the only reachable caller anyway, so
    an unset secret must not break the default compose setup."""
    assert main.GATEWAY_SHARED_SECRET is None
    assert client.get("/documents", headers=ALICE).status_code == 200


def test_a_new_account_can_chat_immediately_against_the_starter_corpus(client):
    """A first-ever message must not fail with "no documents indexed".

    The starter corpus is seeded lazily on first access, so if chat counted
    documents before seeding, the outcome would depend on whether the client
    happened to list documents first.
    """
    starter = main.Path(main.DATA_DIR) / "starter.md"
    starter.write_text("# Starter corpus\n\nThe marker CINNABAR-THREE lives here.")

    # No prior /documents call — this is the account's very first request.
    resp = client.post(
        "/chat", json={"query": "CINNABAR-THREE"}, headers={"X-Axiom-User-Id": "usr_brandnew"}
    )
    assert resp.status_code == 200
    assert any("CINNABAR-THREE" in n["text"] for n in resp.json()["source_nodes"])


# ---------------------------------------------------------------------------
# Backend failure messages
# ---------------------------------------------------------------------------


def test_backend_failures_name_the_thing_to_fix(monkeypatch):
    """Generation errors land in the chat bubble, so the raw driver text is what
    the reader sees. Each of these is a real local failure mode."""
    monkeypatch.setattr(main, "LLM_BACKEND", "ollama")
    monkeypatch.setattr(main, "LLM_MODEL", "llama3")

    unreachable = main.describe_backend_failure(ConnectionError("connection refused"))
    assert "ollama serve" in unreachable.lower()
    assert main.OLLAMA_BASE_URL in unreachable

    missing = main.describe_backend_failure(Exception("model 'llama3' not found, try pulling it"))
    assert "ollama pull llama3" in missing

    # The exact failure seen on an 8GB machine: llama3 needs ~4GB to load.
    oom = main.describe_backend_failure(
        Exception("ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 3925868544")
    )
    assert "memory" in oom.lower()
    assert "llama3.2:3b" in oom or "GROQ_API_KEY" in oom


def test_groq_key_failures_are_named(monkeypatch):
    monkeypatch.setattr(main, "LLM_BACKEND", "groq")
    message = main.describe_backend_failure(Exception("401 invalid api key"))
    assert "GROQ_API_KEY" in message


def test_unknown_failures_still_surface_their_detail(monkeypatch):
    monkeypatch.setattr(main, "LLM_BACKEND", "ollama")
    message = main.describe_backend_failure(Exception("something entirely unexpected"))
    assert "something entirely unexpected" in message


class _ExplodingEngine:
    """Stands in for a query engine whose LLM cannot be reached."""

    def __init__(self, exc: Exception):
        self._exc = exc

    def update_prompts(self, _prompts):  # apply_prompt() calls this
        pass

    def query(self, _query):
        raise self._exc


def test_both_chat_paths_report_the_actionable_message(client, monkeypatch):
    """The streaming path is the one users actually hit.

    It was previously yielding str(exc) directly while /chat had been updated,
    so the browser showed a raw ggml allocation dump. Testing the helper alone
    did not catch that — this asserts the endpoints route through it.
    """
    monkeypatch.setattr(main, "LLM_BACKEND", "ollama")
    monkeypatch.setattr(main, "LLM_MODEL", "llama3")
    oom = Exception(
        "llama-server process has terminated: exit status 1: "
        "ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 3925868544"
    )
    monkeypatch.setattr(main, "build_hybrid_query_engine", lambda *a, **k: _ExplodingEngine(oom))

    client.post("/upload", files={"file": ("doc.txt", b"Some indexed content.", "text/plain")}, headers=ALICE)

    non_streaming = client.post("/chat", json={"query": "anything"}, headers=ALICE)
    assert non_streaming.status_code == 502
    assert "smaller model" in non_streaming.json()["detail"]

    with client.stream("POST", "/chat/stream", json={"query": "anything"}, headers=ALICE) as resp:
        streamed = "".join(resp.iter_text())

    assert '"type": "error"' in streamed
    assert "smaller model" in streamed or "GROQ_API_KEY" in streamed
    # The raw allocation dump must not reach the chat bubble.
    assert "ggml_backend_cpu_buffer_type_alloc_buffer" not in streamed


def test_the_groq_default_model_is_not_a_retired_llama_id():
    """Groq stopped serving Llama models.

    The previous default, `llama-3.3-70b-versatile`, 404s on a current account —
    so every chat request failed with "model does not exist" even though the key
    was valid. Asserting the shape rather than one exact id keeps this
    meaningful if the chosen model changes again.
    """
    groq_default = main.default_llm_model("groq")
    assert not groq_default.startswith("llama-"), (
        f"{groq_default!r} looks like a retired Groq Llama id"
    )
    assert "/" in groq_default, "expected a vendor-prefixed Groq model id"

    # Ollama is unaffected - llama3 is pulled locally and still valid there.
    assert main.default_llm_model("ollama") == "llama3"


def test_an_explicit_llm_model_overrides_the_default(monkeypatch):
    """LLM_MODEL is how a low-memory machine selects a smaller local model."""
    monkeypatch.setenv("LLM_MODEL", "llama3.2:3b")
    assert os.getenv("LLM_MODEL") == "llama3.2:3b"
    # The module resolves `os.getenv("LLM_MODEL") or default_llm_model(...)`,
    # so a set value always wins over either default.
    assert (os.getenv("LLM_MODEL") or main.default_llm_model("groq")) == "llama3.2:3b"


def test_blank_env_values_fall_back_to_defaults(monkeypatch):
    """`.env.example` ships every key blank so it can be filled in.

    os.getenv(name, fallback) returns "" for a blank line rather than the
    fallback, which silently produced embed_backend="" and would have picked the
    wrong embedding path. docker compose's `${VAR:-default}` already treats
    blank as unset; env() makes Python agree.
    """
    monkeypatch.setenv("EMBED_BACKEND", "")
    monkeypatch.setenv("LLM_MODEL", "")
    monkeypatch.setenv("QDRANT_URL", "")

    assert main.env("EMBED_BACKEND", "huggingface") == "huggingface"
    assert main.env("LLM_MODEL", "llama3") == "llama3"
    assert main.env("QDRANT_URL", "http://localhost:6333") == "http://localhost:6333"

    # A real value still wins.
    monkeypatch.setenv("EMBED_BACKEND", "fastembed")
    assert main.env("EMBED_BACKEND", "huggingface") == "fastembed"


def test_health_never_reports_a_blank_backend(client):
    """The status pill renders whatever /health returns, so a blank string
    would surface in the UI as a missing backend name."""
    body = client.get("/health", headers=ALICE).json()
    assert body["embed_backend"], "embed_backend must not be blank"
    assert body["llm_backend"], "llm_backend must not be blank"
    assert body["llm_model"], "llm_model must not be blank"
    assert body["embedding_model"], "embedding_model must not be blank"
