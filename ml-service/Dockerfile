FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Cache HuggingFace weights inside the image/volume rather than a home dir
    # that the non-root user may not own.
    HF_HOME=/app/.cache/huggingface

WORKDIR /app

# build-essential is needed only while resolving/compiling wheels; it is purged
# in the same layer so it never reaches the final image.
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# uid 1000 matches the default first user on most Linux hosts, so a bind-mounted
# ./data directory stays writable without a chown on the host side.
RUN useradd --create-home --uid 1000 axiom \
    && mkdir -p /app/data/docs /app/storage /app/.cache/huggingface \
    && chown -R axiom:axiom /app

USER axiom

EXPOSE 8000

# urllib avoids installing curl just to answer a healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
