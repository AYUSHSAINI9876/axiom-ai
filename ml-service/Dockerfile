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
#
# libgomp1 is reinstalled *after* the purge on purpose: torch links against
# libgomp.so.1, but that library arrives as a dependency of gcc, so
# `--auto-remove` drops it along with build-essential and `import torch` then
# fails at runtime. Installing it afterwards marks it manually-required.
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    # sentence-transformers depends on torch, and the default PyPI torch wheel
    # bundles ~2.5GB of CUDA libraries that are dead weight in a CPU-only
    # container. Installing the CPU build first satisfies that dependency, so
    # the requirements install below leaves it alone. The +cpu local version
    # exists only on PyTorch's index, which is why this is --extra-index-url.
    && pip install --no-cache-dir \
         --extra-index-url https://download.pytorch.org/whl/cpu \
         torch==2.13.0+cpu \
    && pip install --no-cache-dir -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && apt-get install -y --no-install-recommends libgomp1 \
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
