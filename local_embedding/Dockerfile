FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Model is downloaded on first run into HF_HOME (mounted as a docker
# volume by compose) — NOT baked into the image. Trade-off: first
# `docker compose up` for a brand-new install spends ~30s pulling the
# model. Every later run, compose project switch, or model swap reuses
# the same on-disk cache. Bake-at-build-time blew up the image (2 GB
# for bge-m3) and re-downloaded on every cache miss.
ARG MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
ENV MODEL_NAME=${MODEL_NAME} \
    HF_HOME=/models \
    SENTENCE_TRANSFORMERS_HOME=/models \
    TRANSFORMERS_OFFLINE=0
VOLUME ["/models"]

COPY app.py /app/app.py

EXPOSE 8009

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8009"]
