FROM python:3.12-slim

WORKDIR /app

# System deps for asyncpg + cryptography native wheels.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Build context is cloud/ (see docker-compose.yml), so paths are `api/...`
# and `migrations/...`.
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app ./app
COPY migrations ./migrations
# Cloud API needs the sibling Python SDK for the in-process MCP HTTP
# endpoint to proxy calls back to the REST layer. Install it into the
# same site-packages so `from smartnote_cloud import Client` resolves.
COPY sdk-py /opt/sdk-py
RUN pip install --no-cache-dir /opt/sdk-py

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
